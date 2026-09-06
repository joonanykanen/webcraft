// Scratch probe: boot a world in Chrome and dump the live renderer/world/player state.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 4191;
const ROOT = process.cwd();
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT });
server.stdout.on('data', (d) => process.stdout.write('[preview] ' + d));
server.stderr.on('data', (d) => process.stdout.write('[preview!] ' + d));
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`http://localhost:${PORT}/`);
    if (res.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE', m.text());
});

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.webcraft);
await page.click('#btn-worlds');
await page.fill('#new-name', 'Probe');
await page.fill('#new-seed', '1337');
await page.click('#btn-create');
await page.waitForFunction(() => !!window.webcraft?.game, null, { timeout: 90000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.getElementById('tutorial-skip')?.click());
await page.evaluate(() => {
  const g = window.webcraft.game;
  g.input.setActive(true);
  g.input.locked = true;
});
await page.waitForTimeout(3000);

const dump = await page.evaluate(() => {
  const g = window.webcraft.game;
  const r = g.renderer;
  let meshes = 0;
  let visible = 0;
  let tris = 0;
  r.scene.traverse((o) => {
    if (o.isMesh || o.isPoints || o.isLine) {
      meshes++;
      if (o.visible) visible++;
      const idx = o.geometry?.index;
      const pos = o.geometry?.attributes?.position;
      tris += idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
    }
  });
  return {
    screen: g.screen,
    playing: !g.paused,
    info: r.info(),
    sceneMeshes: meshes,
    sceneVisible: visible,
    sceneTris: Math.round(tris),
    chunks: g.world.chunks.size,
    dirty: g.world.stats?.dirty,
    meshedLast: g.world.stats?.meshedLast,
    handVisible: r.hand.visible,
    handChildren: r.hand.scene.children.length,
    health: g.player.health,
    food: g.player.food,
    pos: [g.player.pos.x.toFixed(2), g.player.pos.y.toFixed(2), g.player.pos.z.toFixed(2)],
    onGround: g.player.onGround,
    timeOfDay: g.timeOfDay,
    night: g.nightFactor(),
    mobs: g.mobs.mobs.length,
    hostiles: g.mobs.hostiles,
    settings: { sens: g.settings.sensitivity, showHand: g.settings.showHand },
  };
});
console.log(JSON.stringify(dump, null, 2));
await page.screenshot({ path: 'smoke/probe-state.png' });

await browser.close();
server.kill('SIGTERM');
