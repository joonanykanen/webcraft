/** Visual verification of the ten fixes (2672x1522 like the player's display). */
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const PORT = 4388;
const BASE = `http://localhost:${PORT}`;
const OUT = 'smoke';
mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const stop = () => { try { server.kill('SIGKILL'); } catch {} };
process.on('exit', stop);
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${BASE}/`);
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 2672, height: 1522 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('favicon') && errors.push(m.text()));

await page.goto(BASE, { waitUntil: 'networkidle' });
// Spy on the Pointer Lock API before any click: Chrome's "pointer is hidden" banner only appears
// through it, so "never called" is the assertion for issue #1.
await page.evaluate(`
  (() => {
    let calls = 0;
    Element.prototype.requestPointerLock = function () { calls++; return undefined; };
    window.__lockCalls = () => calls;
  })()
`);
await page.click('#btn-worlds');
await page.waitForSelector('#screen-worlds.active', { timeout: 5000 });
await page.fill('#new-name', 'Visual QA');
await page.click('#btn-create');
await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, { timeout: 40000 });
await page.mouse.move(1336, 761);
const settle = (ms = 700) => page.waitForTimeout(ms);
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}: ${String(e).split('\n')[0]}`);
  }
};
await settle(1400);
const look = async (dx, dy) => {
  await page.mouse.move(1336 + dx, 761 + dy);
  await settle(80);
};

/** Run a snippet with `g` bound to the Game; snippets must `return` a value. */
const g = (body) => page.evaluate(`(() => { const g = window.webcraft.game; ${body} })()`);

console.log('== visual checks ==');
await step('playing with the mouse captured, pointer lock never used', async () => {
  await page.mouse.click(1336, 761); // first click into the world captures the mouse
  await settle(200);
  const state = await g('return { locked: g.input.locked, pl: !!document.pointerLockElement, calls: window.__lockCalls(), screen: g.screen };');
  console.log(`       ${JSON.stringify(state)}`);
  if (!state.locked) throw new Error('mouse not captured');
  if (state.calls !== 0) throw new Error(`requestPointerLock called ${state.calls}x`);
});

await step('hud + milestone tracker + aligned pips', async () => {
  await g(`
    g.inventory.setSlot(0, { id: 2, count: 40 });
    g.inventory.setSlot(1, { id: 200, count: 1 });
    g.inventory.select(0);
    const m = g.hudModel();
    m.health = 14; m.food = 12;
    g.renderer.setHeldItem(2);
  `);
  await page.waitForTimeout(500); // the hud loop runs at 100ms
  const box = await page.evaluate(`(() => {
    const r = (id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), b: Math.round(b.bottom) }; };
    return { hot: r('hotbar'), health: r('health-row'), hunger: r('hunger-row'), tracker: !document.getElementById('milestone-tracker').classList.contains('hidden') };
  })()`);
  console.log(`       ${JSON.stringify(box)}`);
  if (Math.abs(box.health.l - box.hot.l) > 4) throw new Error('hearts not flush with the hotbar');
  if (Math.abs(box.hunger.r - box.hot.r) > 4) throw new Error('hunger not flush with the hotbar');
  if (!box.tracker) throw new Error('milestone tracker hidden');
  await shot('v2-hud');
});

await step('first-person hand (empty / block / tool)', async () => {
  const clip = { x: 1500, y: 900, width: 1172, height: 622 };
  const set = async (id) => {
    await g(`g.inventory.setSlot(0, ${id ? `{ id: ${id}, count: 1 }` : 'null'}); g.inventory.select(0); g.renderer.setHeldItem(${id});`);
    await settle(250);
  };
  await set(0);
  await shot('v2-hand-empty');
  await set(2);
  await shot('v2-hand-block');
  await set(200);
  await shot('v2-hand-tool');
  await set(101);
  await shot('v2-hand-food');
  await set(2);
});

await step('LMB triggers the punch animation and the punch moves the arm', async () => {
  // (a) wiring: a real left-click must ask the view model to swing
  await page.evaluate(`(() => { const h = window.webcraft.game.renderer.hand; window.__sw = 0; h.swing = () => { window.__sw++; }; })()`);
  await page.mouse.down();
  await settle(150);
  const calls = await page.evaluate(`window.__sw`);
  await page.mouse.up();
  console.log(`       swing() calls from one LMB hold: ${calls}`);
  if (calls < 1) throw new Error('LMB did not trigger a swing');

  // (b) animation: stepping the view model by fixed dt must move the limb (frame-rate independent)
  const travel = await page.evaluate(`(() => {
    const h = window.webcraft.game.renderer.hand;
    delete h.swing; // restore the real method
    const rest = h.limbPosition;
    h.swing();
    let max = 0;
    for (let i = 0; i < 12; i++) {
      h.update(0.02, 0, 1);
      const p = h.limbPosition;
      max = Math.max(max, Math.hypot(p[0] - rest[0], p[1] - rest[1], p[2] - rest[2]));
    }
    return max;
  })()`);
  console.log(`       punch travel ${travel.toFixed(3)}`);
  if (travel < 0.15) throw new Error('arm did not move during the swing');
  await page.evaluate(`(() => { const h = window.webcraft.game.renderer.hand; h.swing(); h.update(0.09, 0, 1); })()`);
  await shot('v2-punch');
});

await step('look: no spike while LMB is held, sensitivity as configured', async () => {
  const measure = async (mine) => {
    await page.mouse.move(1336, 761);
    await settle(120);
    if (mine) await page.mouse.down();
    const before = await g('return g.player.yaw');
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(1336 + i * 10, 761);
      await page.waitForTimeout(30);
    }
    const after = await g('return g.player.yaw');
    const diag = await g('return { locked: g.input.locked, active: g.input.active, screen: g.screen, mining: g.input.mining };');
    if (mine) await page.mouse.up();
    console.log(`       ${mine ? 'mining' : 'free '} diag=${JSON.stringify(diag)}`);
    return Math.abs(after - before);
  };
  const free = await measure(false);
  const held = await measure(true);
  console.log(`       100px → ${free.toFixed(3)} rad free, ${held.toFixed(3)} rad while mining (ratio ${(held / Math.max(free, 1e-6)).toFixed(2)})`);
  if (free < 0.4) throw new Error('look too slow');
  if (Math.abs(held / free - 1) > 0.2) throw new Error('look changed while mining');
});

await step('mob faces are right side up', async () => {
  // park a pig two blocks in front and look straight at its head
  await g(`
    const p = g.player.pos;
    const yaw = g.player.yaw;
    const fx = p.x - Math.sin(yaw) * 1.9, fz = p.z - Math.cos(yaw) * 1.9;
    const mob = g.mobs.spawn('pig', { x: fx, y: p.y + 0.05, z: fz }, g);
    mob.yaw = Math.atan2(-(p.x - mob.pos.x), -(p.z - mob.pos.z));
    g.player.pitch = -0.42;
  `);
  await settle(900);
  await page.screenshot({ path: `${OUT}/v2-mob.png`, clip: { x: 1100, y: 620, width: 500, height: 400 } });
});

await step('Esc pauses, Esc resumes (single presses)', async () => {
  await page.keyboard.press('Escape');
  await settle(250);
  const paused = await g('return g.screen');
  const cursorHidden = await page.evaluate(`document.body.classList.contains('mouse-captured')`);
  await shot('v2-pause');
  await page.keyboard.press('Escape');
  await settle(250);
  const resumed = await g('return g.screen');
  const back = await page.evaluate(`!document.getElementById('hud').classList.contains('hidden')`);
  console.log(`       screen=${paused} → ${resumed}, cursor hidden while paused=${cursorHidden}`);
  if (paused !== 'pause') throw new Error('first Esc did not pause');
  if (cursorHidden) throw new Error('cursor still hidden in the pause menu');
  if (resumed !== 'none') throw new Error('second Esc did not resume');
  if (!back) throw new Error('HUD did not come back');
});

await step('milestone panel opens from the pause menu', async () => {
  await page.keyboard.press('Escape');
  await settle(200);
  await page.click('#btn-milestones');
  await settle(400);
  const cards = await page.locator('.ms-card').count();
  const unlocked = await page.locator('.ms-card.unlocked').count();
  const visible = await page.isVisible('#screen-milestones');
  console.log(`       ${cards} cards (${unlocked} unlocked), visible=${visible}`);
  if (!visible || cards < 12) throw new Error('milestone panel missing');
  await shot('v2-milestones');
  await page.keyboard.press('Escape');
  await settle(200);
  const backToPause = await page.evaluate(`window.webcraft.game.screen + '/' + (document.getElementById('screen-pause').classList.contains('active') ? 'pause' : '?')`);
  console.log(`       after Esc: ${backToPause}`);
});

await step('mining a block still works after all of this', async () => {
  if ((await g('return g.screen')) !== 'none') {
    await settle(150);
    await page.click('#btn-resume');
  }
  await settle(300);
  await g('g.player.pitch = -1.05; g.player.yaw = 0.4;');
  await page.mouse.move(1336, 761);
  await page.mouse.down();
  await page.waitForTimeout(700);
  console.log(`       mid: ${JSON.stringify(await g('return { mining: g.input.mining, target: !!g.target, screen: g.screen, running: g.running, hudMined: g.hudModel().stats.blocksMined }'))}`);
  await page.waitForTimeout(1700);
  await page.mouse.up();
  const broke = await g('return g.hudModel().stats.blocksMined');
  console.log(`       blocksMined=${broke}`);
  if (broke < 1) throw new Error('nothing was mined');
});

console.log('\nerrors:', errors.length ? errors.slice(0, 4) : 'none');
await browser.close();
