'use strict';
// Regression against Hennessy and Patterson (7th edition, RISC-V).
// The textbook does not count the taken-branch penalty but the simulator does:
// 2 extra cycles per iteration with branches resolved in EX, 1 with branches in ID.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('./load-sim');

const { sim: S } = loadSim();
const C = S.DEFAULT_CFG;
const ex = id => S.EXAMPLES.find(e => e.id === id);
const plain = o => JSON.parse(JSON.stringify(o));   // objects from the simulator's context -> plain objects

// cycles between two consecutive fetches of the first loop instruction
function cyclesPerIteration(id, cfg) {
  const r = S.simulate(S.assemble(ex(id).code.en), cfg);
  const f = r.rows.filter(x => !x.flushed && x.ins.text.startsWith('fld f0, 0(x1)')).map(x => x.F);
  return f[1] - f[0];
}
function row(r, i, cfg) {
  const m = S.rowCells(r.rows[i], cfg), ks = [...m.keys()].sort((a, b) => a - b);
  return { first: ks[0], cells: ks.map(k => m.get(k).t).join(' ') };
}

test('defaults: Chapter 3 model, branches in EX, 4/7/25-cycle units', () => {
  assert.equal(C.model, 'ch3');
  assert.equal(C.resolve, 'ex');
  assert.deepEqual(plain(C.lat), { add: 4, mul: 7, div: 25 });
  assert.deepEqual(plain(C.pipelined), { add: true, mul: true, div: false });
});

test('x[i] = x[i] + s loop: textbook cycles per iteration plus the branch penalty', () => {
  const book = { loop: 8, sched: 7, unroll: 26, unrollsched: 14 };   // 7th edition (the text says 9 for the first one: erratum)
  for (const [id, n] of Object.entries(book)) {
    assert.equal(cyclesPerIteration(id, { ...C, resolve: 'ex' }), n + 2, `${id} with branches in EX`);
  }
  // MIPS editions: branch in ID, with 1 stall after the integer operation feeding the branch
  const mips = { loop: 9, sched: 7, unroll: 27, unrollsched: 14 };
  for (const [id, n] of Object.entries(mips)) {
    assert.equal(cyclesPerIteration(id, { ...C, resolve: 'id' }), n + 1, `${id} with branches in ID`);
  }
});

test('Chapter 3 latency table (stalls between producer and consumer)', () => {
  const stalls = src => {
    const r = S.simulate(S.assemble('.data\nv: .double 1, 2\n.text\n la x1, v\n fld f2, 8(x1)\n nop\n nop\n nop\n' + src), C);
    const last = r.rows[r.rows.length - 1];
    return last.stalls.reduce((a, s) => a + s.to - s.from, 0);
  };
  assert.equal(stalls(' fadd.d f4, f2, f2\n fadd.d f6, f4, f2\n'), 3, 'FP ALU -> FP ALU');
  assert.equal(stalls(' fadd.d f4, f2, f2\n fsd f4, 0(x1)\n'), 2, 'FP ALU -> store');
  assert.equal(stalls(' fld f4, 0(x1)\n fadd.d f6, f4, f2\n'), 1, 'load -> FP ALU');
  assert.equal(stalls(' fld f4, 0(x1)\n fsd f4, 8(x1)\n'), 0, 'load -> store');
});

test('Appendix C: FP RAW stall figure', () => {
  const cfg = { ...C, model: 'appc', stallFirst: true };
  const r = S.simulate(S.assemble(ex('raw').code.en), cfg);
  // rows 4..6: fmul.d, fadd.d, fsd after the loads
  const mul = row(r, 4, cfg), add = row(r, 5, cfg), sd = row(r, 6, cfg);
  assert.equal(mul.cells, 'IF stall ID M1 M2 M3 M4 M5 M6 M7 MEM WB');
  // 7th-edition convention: waits are drawn before the stage (1 in IF, 6 in ID)
  assert.equal(add.cells, 'stall IF stall stall stall stall stall stall ID A1 A2 A3 A4 MEM WB');
  assert.equal(sd.cells, 'stall stall stall stall stall stall IF ID stall stall stall EX MEM WB');
  const R = r.rows;
  assert.equal(R[5].X, R[4].M, 'the add starts when the multiply moves to MEM (forwarded value)');
  assert.equal(R[6].M, R[5].M + 1, 'the store enters MEM one cycle after the add');
});

test('Appendix C: divider with latency 24 and initiation interval 25', () => {
  const cfg = { ...C, model: 'appc' };
  const src = '.data\nv: .double 6, 3\n.text\n la x2, v\n fld f4, 0(x2)\n fld f6, 8(x2)\n fdiv.d f10, f4, f6\n fdiv.d f12, f6, f4\n';
  const r = S.simulate(S.assemble(src), cfg);
  const d1 = r.rows[3], d2 = r.rows[4];
  assert.equal(d1.M - d1.X, 25, '25 cycles in the divider');
  assert.equal(d2.X - d1.X, 25, 'initiation interval 25 when not pipelined');
  const r2 = S.simulate(S.assemble(src), { ...cfg, pipelined: { ...cfg.pipelined, div: true } });
  assert.equal(r2.rows[4].X - r2.rows[3].X, 1, 'pipelined: a new division every cycle');
});

test('branch penalty depending on where branches resolve and how they are handled', () => {
  const src = '.text\n li x1, 2\nl: addi x1, x1, -1\n bne x1, x0, l\n nop\n';
  const ctl = (branch, resolve) => S.simulate(S.assemble(src), { ...C, branch, resolve }).stats.control;
  assert.equal(ctl('pnt', 'ex'), 2, 'predict not taken, EX: 2 squashed instructions per taken branch');
  assert.equal(ctl('pnt', 'id'), 1, 'predict not taken, ID: 1');
  assert.equal(ctl('freeze', 'ex'), 4, 'freeze, EX: 2 cycles per branch (2 branches)');
  assert.equal(ctl('freeze', 'id'), 2, 'freeze, ID: 1 cycle per branch');
  assert.equal(ctl('delayed', 'id'), 0, 'delayed branch, ID: the slot covers the penalty');
  assert.equal(ctl('delayed', 'ex'), 2, 'delayed branch, EX: the slot covers only one of the two cycles');
});
