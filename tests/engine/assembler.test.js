'use strict';
// Assembler: error messages in both languages, and runtime edge cases.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('./load-sim');

const { sim: S } = loadSim();
const C = S.DEFAULT_CFG;

function errorOf(src, lang) {
  S.setLang(lang);
  try { S.simulate(S.assemble(src), C); }
  catch (e) {
    assert.ok(e instanceof S.AsmError, `must be an assembler error, not “${e.message}”`);
    return { line: e.line, msg: e.message };
  }
  return null;
}

// [name, source, line, Spanish message, English message]
const CASES = [
  ['invalid integer register', '.text\n add x1, x2, x40\n', 2, /x40/, /x40/],
  ['invalid FP register', '.text\n fadd.d f1, f2, x3\n', 2, /coma flotante/, /floating-point/],
  ['unknown instruction', '.text\n fmadd.d f1, f2, f3, f4\n', 2, /desconocida/, /Unknown/],
  ['operand count', '.text\n add x1, x2\n', 2, /3 operandos/, /3 operands/],
  ['invalid immediate', '.text\n addi x1, x2, abc\n', 2, /inmediato/, /immediate/],
  ['invalid memory operand', '.text\n ld x1, x2\n', 2, /memoria/, /memory operand/],
  ['undefined code label', '.text\n j missing\n', 2, /código «missing»/, /Code label/],
  ['undefined data label', '.text\n la x1, missing\n', 2, /datos «missing»/, /Data label/],
  ['duplicate label', '.text\na: nop\na: nop\n', 3, /dos veces/, /twice/],
  ['directive outside .data', '.text\n .double 1.0\n', 2, /\.data/, /\.data/],
  ['unsupported directive', '.data\n .string "hello"\n', 2, /no admitida/, /Unsupported/],
  ['non-numeric value', '.data\n v: .double hello\n', 2, /numérico/, /number/],
  ['instruction in .data', '.data\n add x1, x2, x3\n', 2, /\.text/, /\.text/],
  ['negative .space', '.data\n v: .space -3\n', 2, /\.space/, /\.space/],
  ['data too large', '.data\n v: .space 70000\n.text\n nop\n', 2, /64 KiB/, /64 KiB/],
  ['empty program', '', 1, /No hay instrucciones/, /no instructions/],
  ['access outside the data segment', '.text\n ld x5, 0(x0)\n', 2, /fuera del segmento/, /outside the data segment/],
  ['misaligned access', '.data\nv: .dword 1\n.text\n la x1, v\n ld x5, 4(x1)\n', 5, /desalineado/, /Misaligned/],
];

for (const [name, src, line, es, en] of CASES) {
  test(`error: ${name}`, () => {
    const a = errorOf(src, 'es'), b = errorOf(src, 'en');
    assert.ok(a && b, 'must raise an error');
    assert.equal(a.line, line); assert.equal(b.line, line);
    assert.match(a.msg, es); assert.match(b.msg, en);
  });
}

test('error: branch inside a delay slot', () => {
  S.setLang('en');
  assert.throws(() => S.simulate(S.assemble('.text\n beq x0,x0,a\n beq x0,x0,a\na: nop\n'), { ...C, branch: 'delayed' }), /delay slot/);
});

const run = (src, cfg = C) => S.simulate(S.assemble(src), cfg);

test('exact 64-bit integer arithmetic', () => {
  const r = run('.text\n li x1, 4000000000\n mul x5, x1, x1\n li x2, -1\n srli x6, x2, 1\n');
  assert.equal(r.xr[5], -2446744073709551616n);
  assert.equal(r.xr[6], 9223372036854775807n);
});

test('integer division by zero as in RISC-V', () => {
  const r = run('.text\n li x1, 7\n div x5, x1, x0\n rem x6, x1, x0\n');
  assert.equal(r.xr[5], -1n); assert.equal(r.xr[6], 7n);
});

test('fcvt.w.d: round to nearest even and saturation', () => {
  const r = run('.data\nv: .double 2.5, -3.5, 1e30, -4.0, 0.0\n.text\n la x9, v\n fld f1, 0(x9)\n fld f2, 8(x9)\n fld f3, 16(x9)\n fld f4, 24(x9)\n fld f5, 32(x9)\n'
    + ' fcvt.w.d x1, f1\n fcvt.w.d x2, f2\n fcvt.w.d x3, f3\n fsqrt.d f6, f4\n fcvt.w.d x4, f6\n fdiv.d f7, f4, f5\n fcvt.w.d x5, f7\n fcvt.l.d x6, f3\n');
  assert.equal(r.xr[1], 2n, '2.5 -> 2');
  assert.equal(r.xr[2], -4n, '-3.5 -> -4');
  assert.equal(r.xr[3], 2147483647n, '1e30 saturates');
  assert.equal(r.xr[4], 2147483647n, 'NaN -> maximum');
  assert.equal(r.xr[5], -2147483648n, '-inf -> minimum');
  assert.equal(r.xr[6], 9223372036854775807n, 'fcvt.l.d saturates to 64 bits');
});

test('signed hexadecimal and binary immediates, ABI names and upper case', () => {
  const r = run('.text\n li x5, 0x10\n addi x6, x5, -0x1\n LI A0, 0b101\n mv t2, a0\n');
  assert.equal(r.xr[5], 16n); assert.equal(r.xr[6], 15n); assert.equal(r.xr[10], 5n); assert.equal(r.xr[7], 5n, 't2 = x7');
});

test('jal / ret and ecall', () => {
  const r = run('.text\n jal f\n li x6, 9\n ecall\nf: li x5, 1\n ret\n');
  assert.equal(r.xr[5], 1n); assert.equal(r.xr[6], 9n);
});

test('infinite loop: stops with a warning', () => {
  S.setLang('en');
  const r = run('.text\nl: j l\n');
  assert.equal(r.count, S.LIMIT_DYN);
  assert.match(r.warning, /infinite loop/);
});
