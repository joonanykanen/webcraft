/**
 * Real (trusted) input through the browser's own event pipeline, free vs left-button-held, in two
 * engines. The earlier probe dispatched synthetic events — which are *untrusted*, so the browser
 * refuses pointer lock from them and the measurement never exercised the locked path. This one drives
 * the mouse with Playwright's input, which is a genuine user gesture.
 *
 *   npx vite build && node scripts/probe-lookdrag.mjs
 */
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';

const PORT = 4411;
const BASE = `http://localhost:${PORT}`;
const STEP = 20; // px per move
const STEPS = 12;

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(BASE + '/')).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const SNAP = `(() => { const g = window.webcraft.game, i = g.input;
  return { yaw: g.player.yaw, moves: i.movesSeen, look: i.sessionLookFromMouse,
           fromMove: i.movesFromMovement, fromClient: i.movesFromClient,
           locked: i.locked, usingLock: i.usingLock, lockMouse: i.lockMouse, active: i.active }; })()`;

async function run(label, browser, opts = {}) {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-worlds');
  await page.waitForSelector('#screen-worlds.active');
  await page.fill('#new-name', 'Drag_' + label);
  await page.click('#btn-create');
  await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, {
    timeout: 90000,
  });
  if (opts.freeCursor) {
    await page.evaluate(() => window.webcraft.game.input.setLockMouse(false));
    await page.waitForTimeout(300);
  }
  // A trusted click on the canvas: this is what asks the engine for the mouse.
  await page.mouse.move(500, 320);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(700);

  const sweep = async (held) => {
    const a = await page.evaluate(SNAP);
    await page.mouse.move(500, 320);
    await page.waitForTimeout(80);
    if (held) await page.mouse.down();
    for (let i = 1; i <= STEPS; i++) {
      await page.mouse.move(500 + i * STEP, 320);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(150);
    const b = await page.evaluate(SNAP);
    if (held) await page.mouse.up();
    await page.waitForTimeout(120);
    const px = STEPS * STEP;
    return {
      dYaw: Math.abs(b.yaw - a.yaw),
      radPerPx: Math.abs(b.yaw - a.yaw) / px,
      moves: b.moves - a.moves,
      look: b.look - a.look,
      branch: `${b.fromMove - a.fromMove} movement / ${b.fromClient - a.fromClient} clientXY`,
      locked: b.locked,
      usingLock: b.usingLock,
    };
  };

  const free = await sweep(false);
  const held = await sweep(true);
  console.log(
    `\n=== ${label}${opts.freeCursor ? ' (cursor-hidden fallback)' : ' (lock requested)'} ===\n` +
      `  state: locked=${free.locked} usingLock=${free.usingLock} sensitivity-lock=${free.locked ? 'yes' : 'no'}\n` +
      `  free   Δyaw ${free.dYaw.toFixed(4)} over ${STEPS * STEP} px → ${free.radPerPx.toFixed(5)} rad/px ` +
      `(${free.moves} moves, ${free.branch})\n` +
      `  held   Δyaw ${held.dYaw.toFixed(4)} over ${STEPS * STEP} px → ${held.radPerPx.toFixed(5)} rad/px ` +
      `(${held.moves} moves, ${held.branch})\n` +
      `  ratio held/free = ${(held.radPerPx / Math.max(free.radPerPx, 1e-9)).toFixed(2)}×` +
      `${errs.length ? '\n  errors: ' + errs.join(' | ') : ''}`,
  );
  await page.context().close();
}

const chrome = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
await run('Chrome', chrome);
await run('Chrome', chrome, { freeCursor: true });
await chrome.close();

try {
  const wk = await webkit.launch();
  await run('WebKit/Safari', wk);
  await run('WebKit/Safari', wk, { freeCursor: true });
  await wk.close();
} catch (e) {
  console.log('\nWebKit unavailable:', e.message.split('\n')[0]);
}

server.kill('SIGKILL');
