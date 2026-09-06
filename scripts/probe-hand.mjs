/** Crop the view model out of a live frame for a few held items. */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = 4391;
const BASE = `http://localhost:${PORT}`;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 880 }, deviceScaleFactor: 1 })).newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-worlds');
await page.waitForSelector('#screen-worlds.active');
await page.fill('#new-name', 'Hand');
await page.click('#btn-create');
await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, { timeout: 40000 });
await page.waitForTimeout(1500);
const g = (b) => page.evaluate(`(() => { const g = window.webcraft.game; ${b} })()`);
for (const [name, id] of [['empty', 0], ['dirt', 2], ['log', 4], ['pickaxe', 200], ['apple', 101], ['sword', 232]]) {
  await g(`g.inventory.setSlot(0, ${id ? `{ id: ${id}, count: 1 }` : 'null'}); g.inventory.select(0); g.renderer.setHeldItem(${id});`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `smoke/v3-${name}.png`, clip: { x: 700, y: 420, width: 700, height: 460 } });
}
await browser.close();
server.kill('SIGKILL');
