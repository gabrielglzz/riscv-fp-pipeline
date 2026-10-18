// @ts-check
// User-interface tests in a real browser: loading, examples, modes, languages,
// errors, cycle-by-cycle mode and phone layout.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PAGE_URL = pathToFileURL(path.join(__dirname, '..', '..', 'index.html')).href;

/** Collects page errors (ignoring external fonts, which may fail to load without network access). */
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
}
async function open(page, lang = 'es') {
  await page.goto(PAGE_URL);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.goto(PAGE_URL);
  await page.click(`.lang button[data-lang="${lang}"]`);
  await expect(page.locator('#stats')).toContainText(/\d/);
}
async function loadExample(page, id) {
  await page.selectOption('#example', id);
  await page.click('#load-example');
}
/** Visible interface text (excluding code, instruction names and hidden areas). */
async function visibleUiText(page) {
  return page.evaluate(() => {
    const out = [], skip = new Set(['TEXTAREA', 'SCRIPT', 'STYLE', 'OPTION']);
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const p = w.currentNode.parentElement;
      if (!p || skip.has(p.tagName) || p.closest('[hidden], .lang, code, td.ins, .in, .minis-cap')) continue;
      const s = w.currentNode.textContent.trim(); if (s) out.push(s);
    }
    document.querySelectorAll('[title]').forEach(e => { if (!e.closest('[hidden], td.ins') && !e.matches('.stage, .mini')) out.push(e.getAttribute('title') || ''); });
    return out.map(s => s.replace(/«[^»]*»|“[^”]*”/g, '')).join('\n');
  });
}
const SPANISH = /[áéíóúñ¿]|\b(ciclos?|paradas?|espera|instrucci\w*|etiqueta|línea|anulad\w*|búsqueda|registros?|memoria|congela\w*|segmentad\w*|sumador|divisor|bucle)\b/i;
const ENGLISH = /\b(cycles?|waits?|waiting|fetched|squashed|stall cycles|line \d|label|registers?|memory|frozen|pipelined|adder|divider|multiplier|loop|instructions?)\b/i;
const ALLOWED = /Pipeline FP RISC-V|forwarding|Hennessy|\bstall\b|RV64IMFD|pipeline/gi;

test('loads without errors and shows the Chapter 3 loop', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page);
  await expect(page.locator('#example')).toHaveValue('loop');
  await expect(page.locator('#stats')).toContainText('87');   // defaults: branches resolved in EX
  await expect(page.locator('#diag table tbody tr').first()).toBeVisible();
  expect(errors).toEqual([]);
});

for (const lang of ['es', 'en']) {
  test(`no text from the other language and no errors (${lang})`, async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, lang);
    const other = lang === 'es' ? ENGLISH : SPANISH;
    const ids = await page.$$eval('#example option', os => os.map(o => /** @type {HTMLOptionElement} */ (o).value));
    const leaks = new Set();
    for (const id of ids) {
      for (const branch of ['pnt', 'freeze', 'delayed']) {
        await loadExample(page, id);
        await page.selectOption('#cfg-branch', branch);
        for (const mode of ['full', 'step']) {
          await page.click(`#mode-${mode}`);
          if (mode === 'step') for (let i = 0; i < 8; i++) await page.click('#st-next');
          for (const tab of ['stalls', 'regs', 'mem']) {
            await page.click(`#tab-${tab}`);
            for (const line of (await visibleUiText(page)).split('\n')) if (other.test(line.replace(ALLOWED, ''))) leaks.add(line.slice(0, 100));
          }
        }
        await page.click('#mode-full');
      }
    }
    expect([...leaks]).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('assembler error messages in both languages', async ({ page }) => {
  await open(page, 'es');
  await page.fill('#code', '.text\n add x1, x2, x40\n');
  await page.click('#run');
  await expect(page.locator('#error')).toHaveText('Línea 2: «x40» no es un registro entero (x0–x31)');
  await page.click('.lang button[data-lang="en"]');
  await expect(page.locator('#error')).toHaveText('Line 2: “x40” is not an integer register (x0–x31)');
  await expect(page.locator('#code')).toHaveValue(/x40/);   // user code is kept when switching language
});

test('switching language translates an unmodified example', async ({ page }) => {
  await open(page, 'es');
  await loadExample(page, 'swp');
  await expect(page.locator('#code')).toHaveValue(/segmentación software/);
  await page.click('.lang button[data-lang="en"]');
  await expect(page.locator('#code')).toHaveValue(/software pipelining/);
  await expect(page.locator('#code')).toHaveValue(/^loop:/m);
});

test('baseline and speedup', async ({ page }) => {
  await open(page, 'es');
  await loadExample(page, 'loop');
  await page.click('#set-ref');
  await loadExample(page, 'sched');
  await expect(page.locator('#ref')).toContainText('87');
  await expect(page.locator('#ref')).toContainText('79');
  await expect(page.locator('#ref')).toContainText('1.10×');
});

test('cycle-by-cycle mode: forward, back, last cycle and keyboard', async ({ page }) => {
  await open(page, 'es');
  await loadExample(page, 'raw');
  await page.click('#mode-step');
  await expect(page.locator('#pipe-panel')).toBeVisible();
  await expect(page.locator('#st-now')).toHaveText('Ciclo 1 / 21');
  for (let i = 0; i < 9; i++) await page.click('#st-next');
  await expect(page.locator('#st-now')).toHaveText('Ciclo 10 / 21');
  await expect(page.locator('#events')).toContainText('fadd.d f2, f0, f8');
  await page.click('#st-prev');
  await expect(page.locator('#st-now')).toHaveText('Ciclo 9 / 21');
  await page.click('#diag');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#st-now')).toHaveText('Ciclo 10 / 21');
  await page.click('#st-last');
  await expect(page.locator('#st-now')).toHaveText('Ciclo 21 / 21');
  await expect(page.locator('#st-next')).toBeDisabled();
});

test('pipelined divider: compact cells with several divisions in flight', async ({ page }) => {
  await open(page, 'es');
  await loadExample(page, 'divpip');
  await page.check('#pip-div');
  await page.click('#mode-step');
  await page.locator('#st-range').fill('15');
  await expect(page.locator('#pipe .mini')).toHaveCount(25);
  await expect(page.locator('#pipe .mini.on')).toHaveCount(3);
  await page.uncheck('#pip-div');
  await expect(page.locator('#pipe .mini')).toHaveCount(0);
  await expect(page.locator('#pipe')).toContainText('sin segmentar');
});

test('freeze with branches in EX: two control stalls before the next fetch', async ({ page }) => {
  await open(page, 'es');
  await loadExample(page, 'sched');
  await page.selectOption('#cfg-branch', 'freeze');
  await page.selectOption('#cfg-resolve', 'ex');
  const row = page.locator('#diag tbody tr').nth(10);           // second iteration: fld f0
  await expect(row.locator('td.ins')).toContainText('fld f0, 0(x1)');
  await expect(row.locator('span.k-control')).toHaveCount(2);
  await page.selectOption('#cfg-resolve', 'id');
  await expect(page.locator('#diag tbody tr').nth(10).locator('span.k-control')).toHaveCount(1);
});

test('out-of-range cycle counts are corrected and shown', async ({ page }) => {
  await open(page, 'es');
  for (const [typed, shown] of [['0', '1'], ['999', '60'], ['', '4']]) {
    await page.fill('#lat-add', typed);
    await page.locator('#lat-add').dispatchEvent('change');
    await expect(page.locator('#lat-add')).toHaveValue(shown);
  }
});

test('delayed branch: teaching-mode notice', async ({ page }) => {
  await open(page, 'es');
  await expect(page.locator('#branch-note')).toBeHidden();
  await loadExample(page, 'delayed');
  await expect(page.locator('#branch-note')).toBeVisible();
  await expect(page.locator('#branch-note')).toContainText('RISC-V no tiene salto retardado');
});

test('the last edited program is restored', async ({ page }) => {
  await open(page, 'es');
  await page.fill('#code', '.text\n li x5, 1\n addi x5, x5, 2\n');
  await page.click('#run');
  await page.reload();
  await expect(page.locator('#code')).toHaveValue(/addi x5, x5, 2/);
  await expect(page.locator('#example-note')).toContainText('recuperado');
});

test('no horizontal scrolling on phones', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-ES' });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(PAGE_URL);
  await page.click('#mode-step');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
  await context.close();
});

test('dark theme without errors', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark', locale: 'en-GB' });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(PAGE_URL);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');   // the browser language is the default
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe('rgb(237, 240, 243)');                           // not the light background
  expect(errors).toEqual([]);
  await context.close();
});
