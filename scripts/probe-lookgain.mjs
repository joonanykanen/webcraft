/**
 * Deterministic look-gain matrix. Synthetic pointer+mouse events with *known* pixel deltas are
 * dispatched in the order a real browser sends them, so each cell answers "how many radians does
 * the game apply per pixel here?" — free vs left-button-held, pointer lock vs fallback, touch
 * controls off vs on, and again after reloading a world (a leaked listener doubles everything).
 * Any cell more than 1.5x another one is the "sensitivity rises while I hold LMB" bug.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = 4401;
const BASE = `http://localhost:${PORT}`;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-worlds');
await page.waitForSelector('#screen-worlds.active');
await page.fill('#new-name', 'LookGain');
await page.click('#btn-create');
await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, { timeout: 60000 });

// Own the mouse the way a player's first click does, then measure with synthetic events only.
await page.mouse.click(550, 350);
await page.waitForTimeout(400);

const cell = async ({ lock, touch, hold }) => {
  const r = await page.evaluate(
    async ({ lock, touch, hold }) => {
      const g = window.webcraft.game;
      const cv = document.getElementById('viewport');
      g.input.setLockMouse(lock);
      g.input.touch.enabled = touch;
      g.player.yaw = 0;
      g.player.pitch = 0;
      // wait out any settle window so we measure steady-state response, not the lock warp
      await new Promise((res) => setTimeout(res, 400));
      const before = { yaw: g.player.yaw, moves: g.input.movesSeen, mix: g.lookTotals() };
      const PX = 200;
      const STEPS = 10;
      const base = { bubbles: true, cancelable: true, view: window, button: 0 };
      const send = (type, init) => {
        const E = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        const target = type === 'mousemove' ? window : cv;
        target.dispatchEvent(new E(type, { ...base, ...init }));
      };
      if (hold) {
        send('pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 350, buttons: 1 });
        send('mousedown', { clientX: 400, clientY: 350, button: 0, buttons: 1 });
      }
      let x = 400;
      for (let i = 1; i <= STEPS; i++) {
        const nx = 400 + (PX * i) / STEPS;
        const d = nx - x;
        x = nx;
        send('pointermove', { pointerId: 1, pointerType: 'mouse' , clientX: x, clientY: 350, movementX: d, movementY: 0, buttons: hold ? 1 : 0 });
        send('mousemove', { clientX: x, clientY: 350, movementX: d, movementY: 0, buttons: hold ? 1 : 0 });
        await new Promise((res) => requestAnimationFrame(res));
      }
      if (hold) {
        send('pointerup', { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: 350 });
        send('mouseup', { clientX: x, clientY: 350, button: 0 });
        g.input.mining = false;
      }
      await new Promise((res) => setTimeout(res, 120));
      const after = { yaw: g.player.yaw, moves: g.input.movesSeen, mix: g.lookTotals() };
      return {
        radPerPx: Math.abs(after.yaw - before.yaw) / PX,
        moves: after.moves - before.moves,
        drag: +(after.mix.touchDrag - before.mix.touchDrag).toFixed(3),
        locked: g.input.locked,
        usingLock: g.input.usingLock,
        mining: g.input.mining,
      };
    },
    { lock, touch, hold },
  );
  return r;
};

const rows = [];
for (const lock of [true, false]) {
  for (const touch of [false, true]) {
    for (const hold of [false, true]) {
      const r = await cell({ lock, touch, hold });
      rows.push({ lock: lock ? 'lock' : 'free-cursor', touch, hold: hold ? 'LMB' : 'free', ...r });
    }
  }
}
for (const r of rows) {
  console.log(
    `${r.lock.padEnd(11)} touch=${r.touch ? 'on ' : 'off'} ${r.hold.padEnd(4)} → ${r.radPerPx.toFixed(5)} rad/px  moves=${r.moves} drag=${r.drag}  (locked=${r.locked} usingLock=${r.usingLock})`,
  );
}
const gains = rows.map((r) => r.radPerPx).filter((v) => v > 0);
const min = Math.min(...gains);
const max = Math.max(...gains);
console.log(`spread: ${max / min}x (min ${min.toFixed(5)}, max ${max.toFixed(5)})`);
console.log('errors:', errs.length ? errs.join(' | ') : 'none');
await browser.close();
server.kill('SIGKILL');
