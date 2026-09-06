/**
 * Slot/icon overflow across viewport sizes, Chrome vs WebKit. The reported symptom (icons bleeding out
 * of their cells into the neighbours) is size-dependent, so this boots one world per engine and then
 * resizes, re-auditing every slot: cell box vs icon box, and the panel's proportions.
 *
 *   npx vite build && node scripts/probe-slots.mjs
 */
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';

const PORT = 4415;
const BASE = `http://localhost:${PORT}`;
const SIZES = [
  [1400, 800],
  [1336, 761],
  [1280, 720],
  [1152, 648],
  [1024, 700],
  [900, 620],
];

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(BASE + '/')).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const AUDIT = `(() => {
  const card = document.querySelector('#panel-inventory > *') || document.getElementById('panel-inventory');
  const cr = card.getBoundingClientRect();
  let worst = null, overflow = 0, n = 0;
  for (const slot of document.querySelectorAll('#panel-inventory .slot')) {
    const c = slot.querySelector('canvas');
    if (!c) continue;
    n++;
    const sr = slot.getBoundingClientRect(), ir = c.getBoundingClientRect();
    const spill = Math.max(0, sr.left - ir.left, ir.right - sr.right, sr.top - ir.top, ir.bottom - sr.bottom);
    if (spill > 1) {
      overflow++;
      if (!worst || spill > worst.spill) worst = { spill: +spill.toFixed(1), cell: +sr.width.toFixed(1), icon: +ir.width.toFixed(1) };
    }
  }
  const row = document.querySelector('#panel-inventory .hotbar');
  return {
    dpr: devicePixelRatio, vw: innerWidth, card: +cr.width.toFixed(0),
    rowPerCard: row ? +(row.getBoundingClientRect().width / cr.width).toFixed(3) : null,
    slots: n, overflow, worst,
  };
})()`;

async function run(label, browser, dsf, shotAt) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: dsf });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-worlds');
  await page.waitForSelector('#screen-worlds.active');
  await page.fill('#new-name', `Slots_${label}_${dsf}`);
  await page.click('#btn-create');
  await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, { timeout: 90000 });
  await page.evaluate(() => {
    const inv = window.webcraft.game.inventory;
    inv.add(1, 1);
    for (let i = 0; i < 4; i++) inv.add(2, 15);
  });
  await page.keyboard.press('KeyE');
  await page.waitForSelector('#panel-inventory.active');
  console.log(`\n=== ${label} (deviceScaleFactor ${dsf}) ===`);
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    const a = await page.evaluate(AUDIT);
    console.log(
      `  ${String(w).padStart(4)}×${h}: card ${String(a.card).padStart(4)}px · row/card ${a.rowPerCard} · ` +
        `slots ${a.slots} · ** overflow ${a.overflow} **` +
        (a.worst ? ` (cell ${a.worst.cell}px, icon ${a.worst.icon}px, ${a.worst.spill}px outside)` : ''),
    );
    if (shotAt && w === shotAt[0] && h === shotAt[1]) await page.locator('#panel-inventory .inv-layout').screenshot({ path: `smoke/slots-${label}-${w}x${h}.png` });
  }
  if (errs.length) console.log('  errors: ' + errs.join(' | '));
  await ctx.close();
}

const chrome = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
await run('chrome', chrome, 2, [1336, 761]);
await chrome.close();

try {
  const wk = await webkit.launch();
  await run('webkit', wk, 2, [1336, 761]);
  await wk.close();
} catch (e) {
  console.log('\nWebKit unavailable:', e.message.split('\n')[0]);
}

server.kill('SIGKILL');
