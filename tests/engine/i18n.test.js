'use strict';
// Translations: same keys and same placeholders in both languages, and every
// key used by the page is defined.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('./load-sim');

const { sim: S, html } = loadSim();
const es = S.I18N.es, en = S.I18N.en;
const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();

test('Spanish and English have the same keys', () => {
  assert.deepEqual(Object.keys(es).filter(k => !(k in en)), [], 'Spanish only');
  assert.deepEqual(Object.keys(en).filter(k => !(k in es)), [], 'English only');
});

test('{…} placeholders match in both translations', () => {
  assert.deepEqual(Object.keys(es).filter(k => placeholders(es[k]) !== placeholders(en[k])), []);
});

test('every key used by the page is defined', () => {
  const used = new Set();
  for (const m of html.matchAll(/data-i18n(?:-html|-title|-aria)?="([\w.]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]);
  for (const m of html.matchAll(/'([a-z]+\.[\w.]+)'/g)) {
    if (/^(err|why|cell|ev|sum|model|resolve|branch|stat|bd|ref|w|diag|pager|pipe|stage|lane|det|regs|mem|leg|unit|type|st|lat|units|u|tab|mode|modes)\./.test(m[1])) used.add(m[1]);
  }
  const missing = [...used].filter(k => !(k in es) && !/\.$/.test(k));
  assert.deepEqual(missing, []);
});

test('every example has a name, note and code in both languages, and assembles', () => {
  for (const e of S.EXAMPLES) {
    for (const l of ['es', 'en']) {
      assert.ok(e.name[l] && e.note[l] && e.code[l], `${e.id} (${l})`);
      S.setLang(l);
      assert.doesNotThrow(() => S.assemble(e.code[l]), `${e.id} (${l}) assembles`);
    }
  }
});
