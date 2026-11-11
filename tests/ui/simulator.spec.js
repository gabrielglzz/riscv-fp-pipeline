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

test('integer sums are shown in decimal; only addresses in hexadecimal', async ({ page }) => {
  await open(page, 'es');
  await page.fill('#code', '.data\nv: .double 1\n.text\n la x1, v\n li x2, 70000\n addi x3, x2, 1000\n add x4, x3, x2\n');
  await page.click('#run');
  await page.click('#tab-regs');
  const reg = n => page.locator(`#det-regs .state-grid div:has(> span:text-is("x${n}"))`);
  await expect(reg(1)).toContainText('0x10000');
  await expect(reg(3)).toContainText('71000');
  await expect(reg(4)).toContainText('141000');
  await expect(page.locator('#det-regs')).not.toContainText('0x11558');   // 71000 used to be shown in hex
  await page.click('#mode-step');
  await page.click('#st-last');
  await expect(reg(4)).toContainText('141000');
});

test('MEM/WB conflicts are an option, off by default', async ({ page }) => {
  await open(page, 'es');
  await expect(page.locator('#cfg-appc')).not.toBeChecked();
  await expect(page.locator('#cfg-summary')).not.toContainText('MEM/WB');
  await loadExample(page, 'struct');                      // the example turns it on
  await expect(page.locator('#cfg-appc')).toBeChecked();
  await expect(page.locator('#cfg-summary')).toContainText('conflictos MEM/WB');
  await page.uncheck('#cfg-appc');
  await expect(page.locator('#model-note')).toContainText('no hay conflictos en MEM/WB');
});

test('delayed branch in EX: two slots, no lost cycles', async ({ page }) => {
  await open(page, 'es');
  await loadExample(page, 'delayed');
  await page.selectOption('#cfg-resolve', 'ex');
  await expect(page.locator('#diag tbody tr').nth(9).locator('td.ins')).toContainText('fsd f4, 8(x1)');
  await expect(page.locator('#diag tbody tr').nth(10).locator('td.ins')).toContainText('nop');
  await expect(page.locator('#diag tbody tr').nth(10).locator('.slot')).toHaveCount(1);
  await expect(page.locator('#breakdown')).toContainText('Control (saltos): 0');
  await page.selectOption('#cfg-resolve', 'id');
  await expect(page.locator('#diag tbody tr').nth(10).locator('td.ins')).toContainText('fld f0, 0(x1)');
});

test('cycle-by-cycle mode beyond the first page: sliding window, page kept and no freeze', async ({ page }) => {
  await open(page, 'es');
  await loadExample(page, 'loop');                         // 42 instructions + squashed ones: 2 pages
  await page.click('#pg-next');
  await expect(page.locator('#pager')).toContainText('Instrucciones 41–');
  // entering step mode keeps the place: it starts at the first cycle of the page being viewed
  await page.click('#mode-step');
  const now = async () => Number((await page.locator('#st-now').textContent()).match(/\d+/)[0]);
  const start = await now();
  expect(start).toBeGreaterThan(40);
  // the window always ends at the instruction fetched last and never shrinks to a few rows
  await expect(page.locator('#diag tbody tr')).toHaveCount(40);
  for (let i = 0; i < 6; i++) await page.click('#st-prev');
  // the old pages left only a few rows here; the window keeps every row fetched so far (up to 40)
  expect(await page.locator('#diag tbody tr').count()).toBeGreaterThan(30);
  await expect(page.locator('#diag th.now')).toHaveText(String(start - 6));
  // a held arrow key: many steps, drawn without blocking the page
  await page.click('#diag');
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft', { delay: 0 });
  await expect(page.locator('#diag th.now')).toHaveText(String(start - 36));
  expect(Date.now() - t0).toBeLessThan(5000);
  // leaving step mode shows the page of the current cycle
  await page.click('#mode-full');
  await expect(page.locator('#pager')).toContainText('Instrucciones 1–40');
});

test('code editor: font size, height and column width are adjustable and remembered', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, 'es');
  const fsOf = () => page.locator('#code').evaluate(el => getComputedStyle(el).fontSize);
  await expect(page.locator('#fs-val')).toHaveText('13');
  for (let i = 0; i < 3; i++) await page.click('#fs-up');
  await expect(page.locator('#fs-val')).toHaveText('16');
  expect(await fsOf()).toBe('16px');
  // the line numbers stay aligned with the code
  const lh = await page.evaluate(() => [getComputedStyle(document.getElementById('code')).lineHeight, getComputedStyle(document.getElementById('gutter')).lineHeight]);
  expect(lh[0]).toBe(lh[1]);
  // limits
  for (let i = 0; i < 20; i++) if (await page.locator('#fs-up').isEnabled()) await page.click('#fs-up');
  await expect(page.locator('#fs-val')).toHaveText('24');
  await expect(page.locator('#fs-up')).toBeDisabled();
  for (let i = 0; i < 8; i++) await page.click('#fs-down');
  // taller editor (by keyboard on the drag bar) and a wider program column
  await page.focus('#editor-grip');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');   // 440 + 6 × 40 = 680
  const colW = () => page.locator('.layout > .col').first().evaluate(el => Math.round(el.getBoundingClientRect().width));
  const w0 = await colW();
  await page.focus('#splitter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  expect(await colW()).toBe(w0 + 40);
  // the splitter keys do not change the cycle in step mode
  await page.click('#mode-step');
  await page.focus('#splitter');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#st-now')).toHaveText(/^Ciclo 1 \//);
  // everything is remembered after a reload
  await page.reload();
  await expect(page.locator('#fs-val')).toHaveText('16');
  expect(await fsOf()).toBe('16px');
  expect(Math.round(await page.locator('#editor').evaluate(el => el.getBoundingClientRect().height))).toBe(680);
  expect(await colW()).toBe(w0 + 60);
  // double click: default width
  await page.dblclick('#splitter');
  expect(await colW()).toBe(w0);
  expect(errors).toEqual([]);
});

test('my programs: explicit save, unsaved mark, new program, confirmations and delete', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, 'es');
  await expect(page.locator('#prog-del')).toBeDisabled();
  // save a first program, with its processor settings
  await page.fill('#code', '.text\n li x5, 1\n');
  await page.uncheck('#cfg-fwd');
  await page.click('#prog-save');
  await page.fill('#prog-name', 'Práctica 1');
  await page.click('#prog-ok');
  await expect(page.locator('#prog-list')).toHaveValue('Práctica 1');
  await expect(page.locator('#example-note')).toContainText('está guardado');
  await expect(page.locator('#prog-store')).toBeDisabled();             // nothing to save
  // editing does not save: the program is marked and Save becomes available
  await page.locator('#code').press('End');
  await page.locator('#code').type(' # cambio');
  await expect(page.locator('#prog-list option:checked')).toHaveText('Práctica 1 •');
  await expect(page.locator('#example-note')).toContainText('cambios sin guardar');
  await expect(page.locator('#prog-store')).toBeEnabled();
  // Save as… creates a second program and leaves the first one as it was
  await page.click('#prog-save');
  await page.fill('#prog-name', 'Práctica 2');
  await page.click('#prog-ok');
  await expect(page.locator('#prog-list')).toHaveValue('Práctica 2');
  await page.selectOption('#prog-list', 'Práctica 1');
  await expect(page.locator('#code')).not.toHaveValue(/# cambio/);
  await expect(page.locator('#cfg-fwd')).not.toBeChecked();
  // a processor change also counts, and Save stores it in the open program
  await page.check('#cfg-fwd');
  await expect(page.locator('#prog-list option:checked')).toHaveText('Práctica 1 •');
  await page.click('#prog-store');
  await expect(page.locator('#prog-list option:checked')).toHaveText('Práctica 1');
  // switching with unsaved changes asks first; cancelling keeps everything
  await page.locator('#code').type('\n nop');
  page.once('dialog', d => d.dismiss());
  await page.selectOption('#prog-list', 'Práctica 2');
  await expect(page.locator('#prog-list')).toHaveValue('Práctica 1');
  await expect(page.locator('#code')).toHaveValue(/nop$/);
  // ... and accepting discards them
  page.once('dialog', d => d.accept());
  await page.selectOption('#prog-list', 'Práctica 2');
  await expect(page.locator('#code')).toHaveValue(/# cambio/);
  await page.selectOption('#prog-list', 'Práctica 1');
  await expect(page.locator('#code')).not.toHaveValue(/nop$/);
  await expect(page.locator('#cfg-fwd')).toBeChecked();
  // New: an empty program that is not saved anywhere; Save asks for a name
  await page.click('#prog-new');
  await expect(page.locator('#prog-list')).toHaveValue('');
  await expect(page.locator('#example-note')).toContainText('Programa nuevo');
  await page.locator('#code').type(' # otro');
  await page.click('#prog-store');
  await expect(page.locator('#prog-form')).toBeVisible();
  await expect(page.locator('#prog-name')).toHaveValue('');
  await page.click('#prog-cancel');
  // loading an example with unsaved changes asks too
  page.once('dialog', d => d.dismiss());
  await loadExample(page, 'raw');
  await expect(page.locator('#code')).toHaveValue(/# otro/);
  // a name like "__proto__" is just a name
  await page.click('#prog-save');
  await page.fill('#prog-name', '__proto__');
  await page.click('#prog-ok');
  await expect(page.locator('#prog-list option')).toHaveCount(4);
  // unsaved changes survive a reload and are still marked
  await page.locator('#code').type(' # sin guardar');
  await page.reload();
  await expect(page.locator('#prog-list')).toHaveValue('__proto__');
  await expect(page.locator('#code')).toHaveValue(/# sin guardar/);
  await expect(page.locator('#prog-list option:checked')).toHaveText('__proto__ •');
  // delete
  page.once('dialog', d => d.accept());
  await page.click('#prog-del');
  await expect(page.locator('#prog-list option')).toHaveCount(3);
  await expect(page.locator('#prog-list')).toHaveValue('');
  await expect(page.locator('#code')).toHaveValue(/# sin guardar/);   // the code stays in the editor
  expect(errors).toEqual([]);
});

test('editor height: drag bar works with a short program, by keyboard, and is remembered', async ({ page }) => {
  await open(page, 'es');
  await page.fill('#code', '.text\n nop\n');
  const h = () => page.locator('#editor').evaluate(el => Math.round(el.getBoundingClientRect().height));
  const h0 = await h();
  await page.setViewportSize({ width: 1280, height: 1100 });            // room to drag inside the window
  const g = await page.locator('#editor-grip').boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + 200, { steps: 5 });
  await page.mouse.up();
  expect(await h()).toBe(h0 + 200);
  await page.focus('#editor-grip');
  await page.keyboard.press('ArrowUp');
  expect(await h()).toBe(h0 + 160);
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowUp');
  expect(await h()).toBe(160);                                       // minimum
  await page.keyboard.press('ArrowDown');
  await page.reload();
  expect(await h()).toBe(200);
  await page.dblclick('#editor-grip');
  expect(await h()).toBe(h0);
});
