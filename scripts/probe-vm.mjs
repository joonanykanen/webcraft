// Visual check of the first-person view model: empty hand, block, tool, food.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 4195;
const ROOT = process.cwd();
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT });
server.stderr.on('data', (d) => process.stdout.write('[preview!] ' + d));
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
  } catch {
    /* wait */
  }
  await new Promise((r) => setTimeout(r, 400));
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.webcraft);
await page.click('#btn-worlds');
await page.fill('#new-name', 'VM');
await page.fill('#new-seed', '1337');
await page.click('#btn-create');
await page.waitForFunction(() => !!window.webcraft?.game, null, { timeout: 90000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.getElementById('tutorial-skip')?.click());
await page.waitForTimeout(400);

const cases = [
  ['empty', 0],
  ['block', 3], // stone
  ['tool', 200], // wooden pickaxe
  ['food', 101], // apple
];
for (const [name, id] of cases) {
  await page.evaluate((itemId) => {
    const g = window.webcraft.game;
    g.input.setActive(true);
    g.player.pos.y = 44;
    g.player.pitch = 0;
    g.player.yaw = 0.6;
    g.inventory.setSlot(0, itemId ? { id: itemId, count: 1 } : null);
    g.inventory.select(0);
  }, id);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `smoke/vm-${name}.png` });
  const held = await page.evaluate(() => window.webcraft.game.renderer.info && window.webcraft.game.inventory.heldId());
  console.log(`vm-${name}.png held=${held}`);
}

// swing frame
await page.evaluate(() => window.webcraft.game.renderer.swingHand());
await page.waitForTimeout(90);
await page.screenshot({ path: 'smoke/vm-swing.png' });

await browser.close();
server.kill('SIGTERM');
