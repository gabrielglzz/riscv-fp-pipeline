'use strict';
// Timing invariants and functional results, on the bundled examples and on
// seeded random programs (reproducible).
//   FUZZ_N    number of random programs (default 120)
//   FUZZ_SEED seed (default 20261018)
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('./load-sim');
const { makeRng, allConfigs, genProgram, checkSim, compareRef } = require('./checker');

const { sim: S } = loadSim();
const CONFIGS = allConfigs();
const FUZZ_N = Number(process.env.FUZZ_N || 120);
const FUZZ_SEED = Number(process.env.FUZZ_SEED || 20261018);

function report(fails, label) {
  if (fails.length) assert.fail(`${label}: ${fails.length} failures. First ones:\n  ${fails.slice(0, 8).join('\n  ')}`);
}

for (const lang of ['es', 'en']) {
  test(`bundled examples (${lang}) in every configuration`, () => {
    S.setLang(lang);
    const fails = [];
    for (const e of S.EXAMPLES) {
      const prog = S.assemble(e.code[lang]);
      for (const cfg of CONFIGS) {
        const tag = `${e.id} ${JSON.stringify(cfg)}`;
        const { sim, fails: f } = checkSim(S, prog, cfg);
        f.forEach(x => fails.push(`${tag} ${x}`));
        if (sim) { const d = compareRef(S, prog, sim, cfg); if (d) fails.push(`${tag} [ref] ${d}`); }
      }
    }
    report(fails, `examples (${lang})`);
  });
}

test(`random programs (n=${FUZZ_N}, seed=${FUZZ_SEED})`, () => {
  S.setLang('en');
  const rng = makeRng(FUZZ_SEED);
  const fails = [];
  for (let i = 0; i < FUZZ_N; i++) {
    const src = genProgram(rng);
    let prog;
    try { prog = S.assemble(src); } catch (e) { fails.push(`#${i} does not assemble: ${e.message}`); continue; }
    for (const cfg of CONFIGS) {
      if (rng() > 0.25) continue;
      const tag = `#${i} ${JSON.stringify(cfg)}`;
      const { sim, fails: f } = checkSim(S, prog, cfg);
      f.forEach(x => fails.push(`${tag} ${x}`));
      if (sim) { const d = compareRef(S, prog, sim, cfg); if (d) fails.push(`${tag} [ref] ${d}\n${src}`); }
    }
  }
  report(fails, 'random programs');
});
