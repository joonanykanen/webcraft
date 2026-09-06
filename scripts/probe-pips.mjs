import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = 4394;
const BASE = `http://localhost:${PORT}`;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
for (const vp of [{ width: 1280, height: 800 }, { width: 2672, height: 1522 }]) {
  const page = await (await browser.newContext({ viewport: vp })).newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-worlds');
  await page.waitForSelector('#screen-worlds.active');
  await page.fill('#new-name', 'Pips');
  await page.click('#btn-create');
  await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, { timeout: 40000 });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const el = (id) => document.getElementById(id);
    const box = (id) => { const b = el(id).getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; };
    return {
      inlineWidth: el('stat-rows').style.width,
      hot: box('hotbar'), health: box('health-row'), hunger: box('hunger-row'),
      tracker: { hidden: el('milestone-tracker').classList.contains('hidden'), text: el('milestone-tracker').textContent.slice(0, 70), display: getComputedStyle(el('milestone-tracker')).display },
    };
  });
  const verdict = {
    leftGap: r.health.l - r.hot.l,
    rightGap: r.hot.r - r.hunger.r,
    baselineDiff: Math.abs(r.health.b - r.hunger.b),
    sameRow: Math.abs(r.health.t - r.hunger.t) <= 2,
    overlap: r.health.r > r.hunger.l ? r.health.r - r.hunger.l : 0,
    hotTopAbovePips: r.hot.t - r.health.b,
  };
  console.log(vp.width, JSON.stringify(verdict), 'inline=' + r.inlineWidth);
  await page.screenshot({ path: `smoke/pips-${vp.width}.png`, clip: { x: r.hot.l - 40, y: r.health.t - 16, width: r.hot.r - r.hot.l + 80, height: r.hot.b - r.health.t + 32 } });
  await page.close();
}
await browser.close();
server.kill('SIGKILL');
