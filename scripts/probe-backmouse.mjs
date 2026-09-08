/**
 * Probe for the two menu/mouse reports, in one short tour instead of the whole smoke suite:
 *
 *   1. "Main menu → Select World → Back does nothing."
 *   2. "A new world never takes the mouse — I can't look around, not even after clicking; only
 *       Escape-and-resume fixes it."
 *
 * Every check starts from a fresh main menu (a reload), because the bug being tested can be exactly
 * "the UI cannot get back to the main menu": a probe that navigated with the UI would be stuck in the
 * broken screen and report nothing about the rest. Checks are recorded, not thrown, so one failure
 * still lets the others answer.
 *
 * Run against a production build: npm run build && node scripts/probe-backmouse.mjs
 * Pass --headed to watch it. Any browser Playwright can launch works; SMOKE_CHANNEL=chrome uses the
 * system Chrome, which is what `npm run smoke` asks for.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const PORT = 4411;
const ROOT = new URL('..', import.meta.url).pathname;
const BASE = `http://localhost:${PORT}`;
const isActive = (id) => `!!document.querySelector('#${id}.active')`;
const fail = [];
const say = (pass, msg, info = '') => {
  if (!pass) fail.push(msg);
  console.log(`${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${msg}${info ? ' — ' + info : ''}`);
};

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
});
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(BASE + '/')).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({
  ...(process.env.SMOKE_CHANNEL ? { channel: process.env.SMOKE_CHANNEL } : {}),
  headless: !process.argv.includes('--headed'),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-sandbox'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

/** Screens currently showing ("none" when the world has the screen to itself). */
const active = () =>
  page.evaluate(() => [...document.querySelectorAll('.screen.active')].map((n) => n.id).join(',') || 'none');
const onMain = async (ms = 4000) => {
  try {
    await page.waitForFunction(isActive('screen-main'), null, { timeout: ms });
    return true;
  } catch {
    return false;
  }
};

/** Fresh main menu — the one state every check starts from, whatever the UI is stuck on. */
const toMainMenu = async () => {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#screen-main.active', { timeout: 30000 });
};

// ------------------------------------------------------------ (1) Back from the menu screens
// The world list is the reported one; the rest ride the same return-target rule, and the second trip
// to the world list catches a return target that gets consumed on the first.
const navChecks = [
  ['#btn-worlds', 'screen-worlds', 'Back returns from the world list (Select World) to the main menu'],
  ['#btn-worlds', 'screen-worlds', '…and does so again on a second trip (target not consumed)'],
  ['#btn-help', 'screen-help', 'Back returns from Help'],
  ['#btn-about', 'screen-about', 'Back returns from About'],
  ['#btn-settings', 'screen-settings', 'Back returns from Settings'],
];
for (const [open, screen, what] of navChecks) {
  await toMainMenu();
  await page.click(open);
  await page.waitForFunction(isActive(screen), null, { timeout: 10000 });
  await page.click(`#${screen} button[data-back]`); // a real click, the way the player does it
  const home = await onMain();
  say(home, what, `screens showing: ${await active()}`);
}

// ------------------------------------------------------------ (2) the mouse in a fresh world
await toMainMenu();
await page.click('#btn-worlds');
await page.fill('#new-name', 'Probe');
await page.fill('#new-seed', '1337');
await page.click('#btn-create');
await page.waitForFunction(() => !!window.webcraft?.game && !document.querySelector('.screen.active'), null, {
  timeout: 90000,
});
await page.waitForTimeout(600);

const preClick = await page.evaluate(() => {
  const i = window.webcraft.game.input;
  return {
    locked: i.locked,
    wantCapture: i.wantCapture,
    active: i.active,
    cursorHidden: document.body.classList.contains('mouse-captured'),
  };
});
say(
  !preClick.locked && preClick.wantCapture && preClick.active,
  'the loaded world is waiting for a gesture, not dead',
  JSON.stringify(preClick),
);

await page.mouse.click(640, 400); // the way a player's first click would
await page.waitForTimeout(400);
const postClick = await page.evaluate(() => {
  const i = window.webcraft.game.input;
  return {
    locked: i.locked,
    wantCapture: i.wantCapture,
    usingLock: i.usingLock,
    cursorHidden: document.body.classList.contains('mouse-captured'),
    mining: i.mining,
  };
});
say(
  postClick.locked && postClick.cursorHidden,
  'the first click into the world takes the mouse',
  JSON.stringify(postClick),
);

const yaw0 = await page.evaluate(() => window.webcraft.game.player.yaw);
for (let i = 1; i <= 6; i++) await page.mouse.move(500 + i * 20, 400);
await page.waitForTimeout(250);
const turned = (await page.evaluate(() => window.webcraft.game.player.yaw)) - yaw0;
say(Math.abs(turned) > 0.05, 'moving the mouse turns the camera (no Escape-and-resume involved)', `Δyaw=${turned.toFixed(3)}`);

// ------------------------------------------------------------ (3) Back after quitting
let quitNav = 'skipped: still in the world';
const paused = await (async () => {
  await page.keyboard.press('Escape');
  try {
    await page.waitForFunction(isActive('screen-pause'), null, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
})();
if (paused) {
  await page.click('#btn-quit');
  await page.waitForFunction(isActive('screen-worlds'), null, { timeout: 30000 });
  await page.click('#screen-worlds button[data-back]');
  const home = await onMain(5000);
  const orphanPause = await page.evaluate(() => !!document.querySelector('#screen-pause.active'));
  // "Save & quit" detaches the game, so the pause screen recorded while playing is gone: Back has to
  // land on the main menu, not on a panel with no world behind it.
  say(home && !orphanPause, 'Back from the world list after quitting lands on the main menu', `screens: ${await active()}`);
  quitNav = 'checked';
} else {
  say(false, 'Escape paused the game (needed for the quit-navigation check)', quitNav);
}

say(pageErrors.length === 0, 'no page errors', pageErrors.join(' | '));
await browser.close();
server.kill('SIGKILL');
console.log(fail.length ? `\n\x1b[31m${fail.length} failed:\x1b[0m ${fail.join(' | ')}` : '\nall checks passed');
process.exit(fail.length ? 1 : 0);
