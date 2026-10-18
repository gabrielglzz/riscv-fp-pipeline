'use strict';
// Engine verification tools:
//  - refRun: sequential reference interpreter, written independently of the
//    simulator, used to check that final registers and memory are correct.
//  - checkSim: timing invariants that any run of an in-order pipeline must satisfy
//    (stage order, hazards, occupancy, diagram consistency...).
//  - genProgram: seeded random program generator.

/* ---------- reproducible pseudo-random generator (mulberry32) ---------- */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- configurations under test ---------- */
function allConfigs() {
  const out = [];
  for (const resolve of ['ex', 'id'])
    for (const model of ['ch3', 'appc'])
      for (const forwarding of [true, false])
        for (const branch of ['pnt', 'freeze', 'delayed'])
          for (const pip of [[true, true, false], [false, false, false], [true, true, true]])
            for (const lat of [[4, 7, 25], [2, 3, 5], [1, 1, 1]])
              out.push({ resolve, model, forwarding, branch, stallFirst: true,
                lat: { add: lat[0], mul: lat[1], div: lat[2] },
                pipelined: { add: pip[0], mul: pip[1], div: pip[2] } });
  return out;
}

/* ---------- reference interpreter ---------- */
function refRun(prog, delayed, DATA_BASE) {
  const x = new Array(32).fill(0n), f = new Float64Array(32);
  const dv = new DataView(prog.memInit.slice(0));
  const S = v => BigInt.asIntN(64, v), U = v => BigInt.asUintN(64, v);
  const rne = v => { const fl = Math.floor(v), d = v - fl; return d > 0.5 ? fl + 1 : d < 0.5 ? fl : (fl % 2 === 0 ? fl : fl + 1); };
  const toB = (v, bits) => {
    const hi = 2n ** BigInt(bits - 1) - 1n, lo = -(2n ** BigInt(bits - 1));
    if (v !== v || v === Infinity) return hi;
    if (v === -Infinity) return lo;
    const b = BigInt(rne(v)); return b > hi ? hi : b < lo ? lo : b;
  };
  let pc = 0, steps = 0, slot = null;
  const n = prog.instrs.length;
  const gx = r => r.n === 0 ? 0n : x[r.n];
  const sx = (r, v) => { if (r && !r.f && r.n !== 0) x[r.n] = S(v); };
  while (pc >= 0 && pc < n && steps < 4000) {
    const I = prog.instrs[pc]; steps++;
    let next = pc + 1, ctl = false;
    const A = I.a ? (I.a.f ? f[I.a.n] : gx(I.a)) : 0n;
    const B = I.b ? (I.b.f ? f[I.b.n] : gx(I.b)) : (I.imm !== undefined ? BigInt(I.imm) : 0n);
    switch (I.kind) {
      case 'alu': {
        let v;
        switch (I.fn) {
          case 'add': v = A + B; break; case 'sub': v = A - B; break; case 'mul': v = A * B; break;
          case 'and': v = A & B; break; case 'or': v = A | B; break; case 'xor': v = A ^ B; break;
          case 'slt': v = A < B ? 1n : 0n; break; case 'sltu': v = U(A) < U(B) ? 1n : 0n; break;
          case 'sll': v = A << (B & 63n); break; case 'srl': v = U(A) >> (B & 63n); break; case 'sra': v = S(A) >> (B & 63n); break;
          case 'div': v = B === 0n ? -1n : A / B; break; case 'rem': v = B === 0n ? A : A % B; break;
        }
        sx(I.rd, v); break;
      }
      case 'load': {
        const o = Number(gx(I.base)) + I.off - DATA_BASE;
        if (I.rd.f) f[I.rd.n] = I.size === 8 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
        else sx(I.rd, I.size === 8 ? dv.getBigInt64(o, true) : BigInt(dv.getInt32(o, true)));
        break;
      }
      case 'store': {
        const o = Number(gx(I.base)) + I.off - DATA_BASE;
        if (I.data.f) { if (I.size === 8) dv.setFloat64(o, f[I.data.n], true); else dv.setFloat32(o, f[I.data.n], true); }
        else { const v = gx(I.data); if (I.size === 8) dv.setBigInt64(o, v, true); else dv.setInt32(o, Number(BigInt.asIntN(32, v)), true); }
        break;
      }
      case 'branch': {
        const a = gx(I.a), b = gx(I.b);
        const tk = { beq: a === b, bne: a !== b, blt: a < b, bge: a >= b, bltu: U(a) < U(b), bgeu: U(a) >= U(b) }[I.cmp];
        ctl = true; if (tk) next = I.target; break;
      }
      case 'jump': sx(I.rd, BigInt((pc + 1) * 4)); ctl = true; next = I.target; break;
      case 'jalr': ctl = true; next = Number(gx(I.a)) / 4 | 0; break;
      case 'fp': {
        const a = f[I.a.n], b = I.b ? f[I.b.n] : 0;
        let v = { add: a + b, sub: a - b, mul: a * b, div: a / b, sqrt: Math.sqrt(a), min: Math.min(a, b), max: Math.max(a, b) }[I.op];
        if (I.single) v = Math.fround(v);
        f[I.rd.n] = v; break;
      }
      case 'fpint': {
        if (I.op === 'i2f') { const v = Number(I.w32 ? BigInt.asIntN(32, gx(I.a)) : gx(I.a)); f[I.rd.n] = I.single ? Math.fround(v) : v; break; }
        const a = f[I.a.n], b = I.b ? f[I.b.n] : 0;
        if (I.op === 'f2i') { sx(I.rd, toB(a, I.w32 ? 32 : 64)); break; }
        const v = { mv: a, neg: -a, abs: Math.abs(a), ceq: a === b ? 1 : 0, clt: a < b ? 1 : 0, cle: a <= b ? 1 : 0 }[I.op];
        if (I.rd.f) f[I.rd.n] = I.single ? Math.fround(v) : v; else sx(I.rd, BigInt(v));
        break;
      }
      case 'halt': return { x, f, dv, steps };
    }
    if (slot !== null) { pc = slot; slot = null; continue; }
    if (ctl && delayed && pc + 1 < n) { slot = next; pc = pc + 1; continue; }
    pc = next;
  }
  return { x, f, dv, steps };
}

/* ---------- random programs ---------- */
function genProgram(rng) {
  const rnd = n => Math.floor(rng() * n), pick = a => a[rnd(a.length)];
  const fr = () => 'f' + rnd(8), xr = () => 'x' + (1 + rnd(4));
  const L = ['.data', 'arr: .double 1.5, 2.0, -3.0, 4.25, 0.5, 6.0, 7.0, 8.0', 'ints: .dword 3, -7, 12, 5', 'out: .space 64', '.text',
    '  la x10, arr', '  la x11, ints', '  la x12, out', '  addi x5, x0, 3'];
  const body = [];
  const nBody = 4 + rnd(10);
  for (let i = 0; i < nBody; i++) {
    const k = rnd(13);
    if (k === 0) body.push(`  fld ${fr()}, ${8 * rnd(8)}(x10)`);
    else if (k === 1) body.push(`  fsd ${fr()}, ${8 * rnd(8)}(x12)`);
    else if (k === 2) body.push(`  fadd.d ${fr()}, ${fr()}, ${fr()}`);
    else if (k === 3) body.push(`  fsub.d ${fr()}, ${fr()}, ${fr()}`);
    else if (k === 4) body.push(`  fmul.d ${fr()}, ${fr()}, ${fr()}`);
    else if (k === 5) body.push(`  fdiv.d ${fr()}, ${fr()}, ${fr()}`);
    else if (k === 6) body.push(`  ld ${xr()}, ${8 * rnd(4)}(x11)`);
    else if (k === 7) body.push(`  sd ${xr()}, ${8 * rnd(8)}(x12)`);
    else if (k === 8) body.push(`  add ${xr()}, ${xr()}, ${xr()}`);
    else if (k === 9) body.push(`  addi ${xr()}, ${xr()}, ${rnd(20) - 10}`);
    else if (k === 10) body.push(`  mul ${xr()}, ${xr()}, ${xr()}`);
    else if (k === 11) body.push(pick([
      `  fmv.d ${fr()}, ${fr()}`, `  fneg.d ${fr()}, ${fr()}`, `  fabs.d ${fr()}, ${fr()}`, `  fsqrt.d ${fr()}, ${fr()}`,
      `  fmin.d ${fr()}, ${fr()}, ${fr()}`, `  fmax.d ${fr()}, ${fr()}, ${fr()}`, `  feq.d ${xr()}, ${fr()}, ${fr()}`,
      `  flt.d ${xr()}, ${fr()}, ${fr()}`, `  fle.d ${xr()}, ${fr()}, ${fr()}`, `  fcvt.d.w ${fr()}, ${xr()}`,
      `  fcvt.w.d ${xr()}, ${fr()}`, `  fcvt.l.d ${xr()}, ${fr()}`, `  fcvt.s.w ${fr()}, ${xr()}`, `  fadd.s ${fr()}, ${fr()}, ${fr()}`,
      `  fneg.s ${fr()}, ${fr()}`, `  sub ${xr()}, ${xr()}, ${xr()}`, `  and ${xr()}, ${xr()}, ${xr()}`, `  or ${xr()}, ${xr()}, ${xr()}`,
      `  xor ${xr()}, ${xr()}, ${xr()}`, `  slt ${xr()}, ${xr()}, ${xr()}`, `  sltu ${xr()}, ${xr()}, ${xr()}`,
      `  sll ${xr()}, ${xr()}, ${xr()}`, `  srl ${xr()}, ${xr()}, ${xr()}`, `  sra ${xr()}, ${xr()}, ${xr()}`,
      `  slli ${xr()}, ${xr()}, ${rnd(8)}`, `  slli ${xr()}, ${xr()}, ${30 + rnd(30)}`, `  srai ${xr()}, ${xr()}, ${rnd(8)}`,
      `  sltiu ${xr()}, ${xr()}, ${rnd(9) - 4}`, `  div ${xr()}, ${xr()}, ${xr()}`, `  rem ${xr()}, ${xr()}, ${xr()}`,
      `  lw ${xr()}, ${4 * rnd(8)}(x11)`, `  sw ${xr()}, ${4 * rnd(16)}(x12)`, `  flw ${fr()}, ${4 * rnd(16)}(x10)`,
      `  fsw ${fr()}, ${4 * rnd(16)}(x12)`, `  li ${xr()}, ${rnd(200) - 100}`, `  mv ${xr()}, ${xr()}`,
      `  li ${xr()}, ${pick(['0x7fffffff', '-0x80000000', '4000000000', '-0x1'])}`]));
    else body.push(`  ${pick(['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu'])} ${xr()}, ${xr()}, skip${i}`, '  addi x6, x6, 1', `skip${i}:`);
  }
  L.push('loop:', ...body, '  addi x5, x5, -1', '  bne x5, x0, loop', '  nop', '  fsd f1, 0(x12)');
  return L.join('\n');
}

/* ---------- timing invariants ---------- */
const CTL = ['branch', 'jump', 'jalr'];

function checkSim(S, prog, cfg) {
  const fails = [];
  const ok = (cond, tag, msg) => { if (!cond) fails.push(`[${tag}] ${msg()}`); };
  let sim;
  try { sim = S.simulate(prog, cfg); }
  catch (e) { fails.push(`[crash] ${e.message}`); return { sim: null, fails }; }

  const rows = sim.rows, real = rows.filter(r => !r.flushed);
  const detailed = cfg.model !== 'ch3', fwd = cfg.forwarding;
  const latOf = u => u === 'int' ? 1 : cfg.lat[u];
  const lastWriter = {}, lastWB = {}, Ms = new Map();
  const unitBusy = { add: [], mul: [], div: [], int: [] };
  let prev = null, prevAny = null, stR = 0, stS = 0, stW = 0;

  for (const r of rows) {
    if (prevAny) {
      ok(r.F >= prevAny.F + 1, 'IF.order', () => `${r.ins.text}: two fetches in cycle ${r.F}`);
      ok(r.F >= prevAny.D, 'IF.single', () => `${r.ins.text}: IF holds two instructions in cycle ${r.F}`);
    }
    prevAny = r;
    if (r.flushed) { ok(r.D > r.F, 'flush.shape', () => 'malformed squashed row'); continue; }
    const I = r.ins;
    ok(r.F < r.D && r.D < r.X && r.X <= r.M && r.W === r.M + 1, 'shape', () => `${I.text} F=${r.F} D=${r.D} X=${r.X} M=${r.M} W=${r.W}`);
    if (I.unit !== 'int') ok(r.M - r.X === latOf(I.unit), 'fp.lat', () => `${I.text}: ${r.M - r.X} execution cycles, expected ${latOf(I.unit)}`);
    else if (I.kind !== 'store' || !detailed) ok(r.M === r.X + 1, 'int.lat', () => `${I.text}: M-X=${r.M - r.X}`);
    if (prev) {
      ok(r.D >= prev.D + 1, 'ID.order', () => `${I.text}: ID out of order`);
      ok(r.X >= prev.X + 1, 'issue.order', () => `${I.text}: issue out of order`);
      ok(r.D >= prev.X, 'ID.single', () => `${I.text}: ID holds two instructions`);
    }
    // every waiting cycle has a cause, with no gaps or overlaps
    const idWait = r.X - r.D - 1, sumId = r.stalls.reduce((a, s) => a + (s.to - s.from), 0);
    ok(idWait === sumId, 'ID.account', () => `${I.text}: waits ${idWait} in ID but the causes add up to ${sumId}`);
    let cov = r.D + 1;
    for (const s of r.stalls) { ok(s.from === cov && s.to > s.from, 'ID.contig', () => `${I.text}: non-contiguous stalls`); cov = s.to; }
    if (I.unit === 'int') {
      const exWait = r.M - r.X - 1, sumEx = r.exStalls.reduce((a, s) => a + (s.to - s.from), 0);
      ok(exWait === sumEx, 'EX.account', () => `${I.text}: waits ${exWait} in EX but the causes add up to ${sumEx}`);
    }
    for (const s of r.stalls.concat(r.exStalls)) {
      if (s.type === 'raw') stR += s.to - s.from; else if (s.type === 'struct') stS += s.to - s.from; else if (s.type === 'waw') stW += s.to - s.from;
    }
    // RAW: a value is never read before it is available
    const isBr = I.kind === 'branch' || I.kind === 'jalr';
    for (const s of I.srcs) {
      const p = lastWriter[(s.f ? 'f' : 'x') + s.n]; if (!p) continue;
      const L = p.ins.kind === 'load' ? p.M : p.M - 1;
      const need = fwd ? (isBr && cfg.resolve === 'id' ? L + 2 : L + 1) : p.W + 1;
      ok(r.X >= need, 'RAW', () => `${I.text} reads ${s.f ? 'f' : 'x'}${s.n} in cycle ${r.X}, before ${need} (producer ${p.ins.text})`);
    }
    if (I.dataSrc) {
      const p = lastWriter[(I.dataSrc.f ? 'f' : 'x') + I.dataSrc.n];
      if (p) {
        const L = p.ins.kind === 'load' ? p.M : p.M - 1;
        if (!fwd) ok(r.X >= p.W + 1, 'RAW.store', () => `${I.text}: data read too early without forwarding`);
        else ok(r.M >= L + 1, 'RAW.storeM', () => `${I.text}: uses the data in MEM=${r.M} before it is ready (${L + 1})`);
      }
    }
    // WAW: writes to the same register complete in order
    if (I.rd && !(I.rd.n === 0 && !I.rd.f)) {
      const k = (I.rd.f ? 'f' : 'x') + I.rd.n;
      if (lastWB[k] !== undefined) ok(r.W > lastWB[k], 'WAW', () => `${I.text} writes ${k} in cycle ${r.W}, before an earlier instruction (${lastWB[k]})`);
      lastWB[k] = r.W; lastWriter[k] = r;
    }
    if (detailed) { ok(!Ms.has(r.M), 'MEM.single', () => `two instructions in MEM in cycle ${r.M}`); Ms.set(r.M, I.text); }
    const u = I.unit;
    if (u === 'int') unitBusy.int.push([r.X, r.M, I.text]);
    else unitBusy[u].push(cfg.pipelined[u] ? [r.X, r.X + 1, I.text] : [r.X, r.X + latOf(u), I.text]);
    prev = r;
  }
  for (const u in unitBusy) {
    const iv = unitBusy[u].slice().sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < iv.length; i++) ok(iv[i][0] >= iv[i - 1][1], 'unit.overlap', () => `${u} used at the same time by ${iv[i - 1][2]} and ${iv[i][2]}`);
  }
  ok(sim.stats.raw === stR && sim.stats.struct === stS && sim.stats.waw === stW, 'stats', () => `statistics ${JSON.stringify(sim.stats)} vs ${stR}/${stS}/${stW}`);

  // control: counted cycles match the drawn ones, and a target is never fetched before its branch is resolved
  const expCtl = rows.filter(r => r.flushed).length + rows.reduce((a, r) => a + (r.pre ? r.pre.lost : 0), 0);
  ok(sim.stats.control === expCtl, 'stats.control', () => `control=${sim.stats.control}, drawn ${expCtl}`);
  rows.forEach((r, i) => {
    if (r.flushed) return;
    const p = rows.slice(0, i).reverse().find(q => !q.flushed);
    if (!p) return;
    const pi = rows.indexOf(p);
    const br = CTL.includes(p.ins.kind) ? p : (p.slot ? rows.slice(0, pi).reverse().find(q => !q.flushed) : null);
    if (br && CTL.includes(br.ins.kind) && (br.taken || br.ins.kind !== 'branch') && (cfg.branch !== 'delayed' || p.slot)) {
      const at = cfg.resolve === 'id' ? br.X : br.X + 1;
      ok(r.F >= at, 'fetch.early', () => `${r.ins.text} fetched in cycle ${r.F}, before ${br.ins.text} is resolved (${at})`);
    }
  });
  if (cfg.branch === 'freeze') rows.forEach((r, i) => {
    const p = rows[i - 1];
    if (!p || !CTL.includes(p.ins.kind)) return;
    const m = S.rowCells(r, cfg), L = cfg.resolve === 'id' ? 1 : 2;
    let okc = r.pre && r.pre.lost === L && m.get(r.F).t === 'IF';
    for (let k = 1; k <= L; k++) okc = okc && m.get(r.F - k) && m.get(r.F - k).k === 'control';
    ok(okc, 'freeze.cell', () => `missing control stalls before ${r.ins.text}`);
  });
  ok(sim.cycles === Math.max(...real.map(r => r.W)), 'cycles', () => 'wrong total cycle count');
  ok(Math.abs(sim.cpi - sim.cycles / sim.count) < 1e-9, 'cpi', () => 'wrong CPI');

  // diagram: one cell per cycle, no gaps, stages in order, with both drawing conventions
  for (const stallFirst of [true, false]) {
    const c2 = { ...cfg, stallFirst };
    for (const r of rows) {
      const m = S.rowCells(r, c2), ks = [...m.keys()].sort((a, b) => a - b);
      const start = r.pre ? r.pre.from : r.F, end = r.flushed ? r.D : r.W;
      ok(ks[0] === start && ks[ks.length - 1] === end && ks.length === end - start + 1, 'cells.cover',
        () => `cells of ${r.ins.text} [${ks}], expected ${start}..${end} (stallFirst=${stallFirst})`);
      if (r.flushed) continue;
      const seq = ks.map(k => m.get(k)).filter(c => c.t !== 'stall').map(c => c.t);
      const u = r.ins.unit, P = { add: 'A', mul: 'M', div: 'D' }[u];
      const exp = ['IF', 'ID', ...(u === 'int' ? ['EX'] : Array.from({ length: r.M - r.X }, (_, i) => P + (i + 1))), 'MEM', 'WB'];
      ok(seq.join() === exp.join(), 'cells.seq', () => `stages of ${r.ins.text}: ${seq} (stallFirst=${stallFirst})`);
      for (const k of ks) {
        const c = m.get(k);
        if (c.t === 'stall') ok(!!c.why && !/undefined/.test(c.why), 'cells.why', () => `stall without an explanation in ${r.ins.text}, cycle ${k}`);
      }
    }
  }

  // cycle-by-cycle mode: at most one instruction per stage (the Chapter 3 model does not arbitrate MEM/WB)
  for (let c = 1; c <= sim.cycles; c++) {
    const occ = {};
    for (const r of rows) {
      const loc = S.locate(r, c); if (!loc) continue;
      const k = ['add', 'mul', 'div'].includes(loc.st) ? (cfg.pipelined[loc.st] ? loc.st + loc.idx : loc.st) : loc.st;
      occ[k] = (occ[k] || 0) + 1;
    }
    if (!detailed) { delete occ.MEM; delete occ.WB; }
    for (const k in occ) ok(occ[k] <= 1, 'occ', () => `${occ[k]} instructions in ${k} in cycle ${c}`);
  }

  // the state rebuilt at the last cycle matches the final state
  const st = S.stateAt(sim, prog, sim.cycles);
  let same = true;
  for (let i = 0; i < 32; i++) { if (st.x[i] !== sim.xr[i]) same = false; if (!Object.is(st.f[i], sim.fr[i])) same = false; }
  for (let o = 0; o < S.MEM_SIZE; o += 8) if (st.dv.getBigInt64(o, true) !== sim.dv.getBigInt64(o, true)) { same = false; break; }
  ok(same, 'stateAt', () => 'the state at the last cycle does not match the final state');
  return { sim, fails };
}

function compareRef(S, prog, sim, cfg) {
  const ref = refRun(prog, cfg.branch === 'delayed', S.DATA_BASE);
  for (let i = 1; i < 32; i++) if (sim.xr[i] !== ref.x[i]) return `x${i}: simulator=${sim.xr[i]} reference=${ref.x[i]}`;
  for (let i = 0; i < 32; i++) if (!Object.is(sim.fr[i], ref.f[i]) && !(Number.isNaN(sim.fr[i]) && Number.isNaN(ref.f[i]))) return `f${i}: simulator=${sim.fr[i]} reference=${ref.f[i]}`;
  for (let o = 0; o < 0x400; o += 8) if (sim.dv.getBigInt64(o, true) !== ref.dv.getBigInt64(o, true)) return `memory 0x${(S.DATA_BASE + o).toString(16)}`;
  return null;
}

module.exports = { makeRng, allConfigs, refRun, genProgram, checkSim, compareRef };
