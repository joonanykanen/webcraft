/** Final visual review: HUD + tracker, punch mid-swing, unlock toast, pause cursor. */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = 4396;
const BASE = `http://localhost:${PORT}`;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-worlds');
await page.waitForSelector('#screen-worlds.active');
await page.fill('#new-name', 'Polish');
await page.click('#btn-create');
await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, { timeout: 40000 });
await page.waitForTimeout(1500);
const g = (b) => page.evaluate(`(() => { const g = window.webcraft.game; ${b} })()`);

// aim at a block so the punch has something to hit
await g(`
  const p = g.player.pos;
  g.player.yaw = 0; g.player.pitch = -0.5;
  g.player.flying = false;
`);
await page.screenshot({ path: 'smoke/v5-hud.png' });

// hold LMB and catch the swing at its peak
const idle = await g(`return { pos: g.renderer.hand.limbPosition, swinging: g.renderer.hand.swinging };`);
console.log('idle:', JSON.stringify(idle));
await g(`g.input.mining = true;`);
await page.waitForTimeout(120);
await page.screenshot({ path: 'smoke/v5-punch.png', clip: { x: 700, y: 380, width: 560, height: 420 } });
const swing = await g(`const h = g.renderer.hand; return { pos: h.limbPosition, swinging: h.swinging };`);
await g(`g.input.mining = false;`);
console.log('swing:', JSON.stringify(swing));

// first milestone unlock → toast + tracker bump
const unlock = await g(`
  g.milestones.observe({ kind: 'mine', block: 4 });
  return { unlocked: g.milestones.unlockedCount, tracker: document.getElementById('milestone-tracker').textContent.replace(/\\s+/g,' ').trim() };
`);
await page.waitForTimeout(400);
await page.screenshot({ path: 'smoke/v5-unlock.png', clip: { x: 340, y: 480, width: 600, height: 300 } });
console.log('unlock:', JSON.stringify(unlock));

// Esc pauses and hands the cursor back
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const pause = await page.evaluate(() => ({
  screen: window.webcraft.game.screen,
  cursorHidden: document.body.classList.contains('mouse-captured'),
  resume: getComputedStyle(document.getElementById('btn-resume')).visibility,
}));
await page.screenshot({ path: 'smoke/v5-pause.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const resumed = await page.evaluate(() => ({
  screen: window.webcraft.game.screen,
  cursorHidden: document.body.classList.contains('mouse-captured'),
}));
console.log('pause:', JSON.stringify(pause), 'resumed:', JSON.stringify(resumed));
console.log('pageerrors:', errs.length ? errs.join(' | ') : 'none');
await browser.close();
server.kill('SIGKILL');
