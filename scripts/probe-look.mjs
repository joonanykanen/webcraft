// Scratch visual probe: hand/view model, night stars, mob faces, mining swing.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 4193;
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
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.webcraft);
await page.click('#btn-worlds');
await page.fill('#new-name', 'Visual');
await page.fill('#new-seed', '1337');
await page.click('#btn-create');
await page.waitForFunction(() => !!window.webcraft?.game, null, { timeout: 90000 });
await page.waitForTimeout(2200);
await page.evaluate(() => document.getElementById('tutorial-skip')?.click());
await page.evaluate(() => {
  const g = window.webcraft.game;
  g.input.setActive(true);
  g.input.locked = true;
  g.settings.showTouchControls = false;
  const ui = document.getElementById('touch-ui');
  if (ui) ui.classList.add('hidden');
  g.inventory.setSlot(0, { id: 3, count: 10 });
  g.inventory.setSlot(1, { id: 200, count: 1, durabilityLeft: 60 });
  g.inventory.setSlot(2, { id: 101, count: 3 });
  g.inventory.setSlot(3, { id: 6, count: 12 });
  g.inventory.select(0);
  g.player.teleport({ x: g.player.pos.x, y: g.player.pos.y + 1, z: g.player.pos.z });
});
await page.waitForTimeout(1500);

const crop = { x: 440, y: 200, width: 660, height: 500 };

// 1. held block
await page.screenshot({ path: 'smoke/vm-block.png', clip: crop });
// 2. held tool
await page.evaluate(() => window.webcraft.game.inventory.select(1));
await page.waitForTimeout(400);
await page.screenshot({ path: 'smoke/vm-tool.png', clip: crop });
// 3. held food (non-block item sprite)
await page.evaluate(() => window.webcraft.game.inventory.select(2));
await page.waitForTimeout(400);
await page.screenshot({ path: 'smoke/vm-food.png', clip: crop });
// 4. empty hand
await page.evaluate(() => {
  const g = window.webcraft.game;
  g.inventory.setSlot(2, null);
  g.inventory.select(2);
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'smoke/vm-empty.png', clip: crop });

// 5. mining swing (hold LMB through the input layer)
await page.evaluate(() => {
  const g = window.webcraft.game;
  g.inventory.setSlot(2, { id: 3, count: 10 });
  g.inventory.select(2);
  g.player.pitch = -0.5;
  g.input.mining = true;
});
await page.waitForTimeout(220);
await page.screenshot({ path: 'smoke/vm-swing.png' });
await page.evaluate(() => {
  window.webcraft.game.input.mining = false;
});

// 6. mob face close-up
const mobInfo = await page.evaluate(() => {
  const g = window.webcraft.game;
  g.player.pitch = 0;
  const p = g.player.pos;
  const mob = g.mobs.spawn('pig', { x: p.x + 1.9, y: p.y, z: p.z - 1.9 }, g) || g.mobs.mobs.at(-1);
  // pin it in place: the wander loop would otherwise pick a new heading before we look
  mob.wanderTimer = 1e6;
  mob.hp = 10;
  const facePlayer = () => {
    const pp = g.player.pos;
    mob.yaw = Math.atan2(-(pp.x - mob.pos.x), -(pp.z - mob.pos.z));
    mob.group.rotation.y = mob.yaw;
  };
  facePlayer();
  const dx = mob.pos.x - p.x;
  const dz = mob.pos.z - p.z;
  g.player.yaw = Math.atan2(-dx, -dz);
  g.player.pitch = 0.08;
  window.__facePlayer = facePlayer;
  return { kind: mob.kind, yaw: mob.yaw, hp: mob.hp, parts: mob.object.children.length };
});
console.log('mob', JSON.stringify(mobInfo));
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => window.__facePlayer());
  await page.waitForTimeout(100);
}
await page.screenshot({ path: 'smoke/vm-eyes.png' });
await page.screenshot({ path: 'smoke/vm-eyes-zoom.png', clip: { x: 330, y: 330, width: 440, height: 330 } });

// 7. night: stars must hide behind the terrain
await page.evaluate(() => {
  const g = window.webcraft.game;
  g.player.pitch = 0.35; // look up at the sky
  g.record.data.timeOfDay = 0.74;
  g.timeMs = 0;
});
await page.waitForTimeout(900);
const night = await page.evaluate(() => {
  const g = window.webcraft.game;
  return { time: g.timeOfDay, night: g.nightFactor() };
});
console.log('night', JSON.stringify(night));
await page.screenshot({ path: 'smoke/vm-night.png' });

// 8. dusk (transition must be visible, not a snap)
await page.evaluate(() => {
  const g = window.webcraft.game;
  g.record.data.timeOfDay = 0.56;
  g.timeMs = 0;
  g.player.pitch = 0.1;
});
await page.waitForTimeout(700);
const dusk = await page.evaluate(() => ({ time: window.webcraft.game.timeOfDay, night: window.webcraft.game.nightFactor() }));
console.log('dusk', JSON.stringify(dusk));
await page.screenshot({ path: 'smoke/vm-dusk.png' });

const stats = await page.evaluate(() => {
  const g = window.webcraft.game;
  return { info: g.renderer.info(), hudVisible: !document.getElementById('hud').classList.contains('hidden') };
});
console.log('stats', JSON.stringify(stats));

await browser.close();
server.kill('SIGTERM');
