'use strict';
// Loads the simulator engine straight from index.html, without a browser.
// The page script only starts the user interface when `document` exists, so in
// Node only the assembler and the simulator run.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// SIM_HTML lets the tests run against another copy of the simulator
// (for example, one with a deliberately injected bug).
const HTML_PATH = process.env.SIM_HTML || path.join(__dirname, '..', '..', 'index.html');

function loadSim() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('Cannot find the simulator <script> in index.html');
  const exportsCode = `
;globalThis.__sim = {
  assemble, simulate, rowCells, locate, stateAt,
  EXAMPLES, DEFAULT_CFG, AsmError, DATA_BASE, MEM_SIZE, LIMIT_DYN, I18N,
  setLang: l => { LANG = l; }, getLang: () => LANG,
};`;
  const context = vm.createContext({ console });
  vm.runInContext(m[1] + exportsCode, context, { filename: 'index.html' });
  return { sim: context.__sim, html };
}

module.exports = { loadSim, HTML_PATH };
