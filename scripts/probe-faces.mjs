/** Put each mob's face dead-centre and shoot it (verifies the entity V-flip). */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = 4393;
const BASE = `http://localhost:${PORT}`;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 })).newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-worlds');
await page.waitForSelector('#screen-worlds.active');
await page.fill('#new-name', 'Faces');
await page.click('#btn-create');
await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, { timeout: 40000 });
await page.waitForTimeout(1200);
const g = (b) => page.evaluate(`(() => { const g = window.webcraft.game; ${b} })()`);
for (const kind of ['pig']) {
  const info = await g(`
    g.mobs.clear();
    const p = g.player.pos;
    const mob = g.mobs.spawn('${kind}', { x: p.x, y: p.y + 0.05, z: p.z - 1.6 }, g);
    // eye level with the head, straight down -z (yaw 0 = looking -z), so the face fills the crosshair
    g.player.flying = true;
    g.player.vel.y = 0;
    mob.yaw = Math.PI; // turn it to face us
    return { kind: mob.kind, headY: mob.pos.y, yaw: mob.yaw };
  `);
  // re-assert the pose right before the shot: mobs wander, and a drifting face tells us nothing
  for (let i = 0; i < 5; i++) {
    await g(`
      const m = g.mobs.mobs[0];
      m.pos.x = g.player.pos.x; m.pos.y = g.player.pos.y + 0.05; m.pos.z = g.player.pos.z - 2.6; m.vel.x = 0; m.vel.y = 0; m.vel.z = 0;
      m.yaw = Math.PI; m.group.rotation.y = Math.PI; m.onGround = true;
      g.player.yaw = 0; g.player.pitch = -0.3; g.player.vel.y = 0;
    `);
    await page.waitForTimeout(90);
  }
  await page.screenshot({ path: `smoke/v4-${kind}.png`, clip: { x: 300, y: 170, width: 300, height: 300 } });
  console.log(kind, JSON.stringify(info));
}
await browser.close();
server.kill('SIGKILL');
