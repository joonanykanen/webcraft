/** Builds a wall of grass/planks/crafting-table/torch/furnace in front of the player and photographs
 * it at 2x, to check that asymmetric tiles land the right way up on block faces (grass fringe, torch
 * flame, bench front). */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = 4402;
const BASE = `http://localhost:${PORT}`;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-worlds');
await page.waitForSelector('#screen-worlds.active');
await page.fill('#new-name', 'Orient');
await page.click('#btn-create');
await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, { timeout: 60000 });
await page.waitForTimeout(1000);

const built = await page.evaluate(() => {
  const g = window.webcraft.game;
  const B = window.webcraft.BlockId;
  g.input.release();
  g.player.vel.x = 0; g.player.vel.y = 0; g.player.vel.z = 0;
  const px = Math.floor(g.player.pos.x), py = Math.floor(g.player.pos.y), pz = Math.floor(g.player.pos.z);
  const d = [Math.sin(g.player.yaw), 0, -Math.cos(g.player.yaw)];
  const right = [Math.cos(g.player.yaw), 0, Math.sin(g.player.yaw)];
  const shelf = py; // one block below the eye line: a mantelpiece to inspect
  const at = (i, id, dy = 0) => {
    const bx = px + Math.round(d[0] * 4 + right[0] * i);
    const bz = pz + Math.round(d[2] * 4 + right[2] * i);
    g.world.setBlock(bx, shelf + dy, bz, id);
    return [bx, shelf + dy, bz];
  };
  for (let i = -3; i <= 3; i++) at(i, B.PLANKS, -1);          // the shelf itself
  const placed = {
    grass: at(-3, B.GRASS),
    log: at(-2, B.LOG),
    torch: at(0, B.TORCH),
    bench: at(1, B.CRAFTING_TABLE),
    furnace: at(2, B.FURNACE),
    grass2: at(3, B.GRASS),
  };
  g.player.pitch = -0.38; // look down at the shelf 4 blocks away
  return { shelf, placed };
});
await page.waitForTimeout(2500);
await page.screenshot({ path: 'smoke/orient-full.png' });
// Zoom by narrowing the FOV, then clip the centre: an honest close-up without image libraries.
await page.evaluate(() => {
  const g = window.webcraft.game;
  g.setSettings({ ...g.settings, fov: 38 });
});
await page.waitForTimeout(1200);
await page.screenshot({ path: 'smoke/orient-zoom.png', clip: { x: 200, y: 150, width: 700, height: 400 } });
console.log('built at y =', built.y, '→ smoke/orient-full.png, smoke/orient-zoom.png');
await browser.close();
server.kill('SIGKILL');
