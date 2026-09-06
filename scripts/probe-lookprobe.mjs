// Does the BI-2 look probe actually show up in game, and do the F7/F8 dials do anything? An instrument
// nobody can read is not a diagnostic. Feeds mousemove events with known movementX in both button states,
// then checks the F3 lines, the console surface (webcraft.lookStats), and the two keys.
//
//   npx vite build && node scripts/probe-lookprobe.mjs      (needs: npx vite preview --port 4173)
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForFunction(() => !!document.querySelector('#screen-main.active'), null, { timeout: 20000 });
console.log('build:', await page.textContent('#build-stamp'));
await page.click('#btn-worlds');
await page.fill('#new-seed', 'lookprobe');
await page.click('#btn-create');
await page.waitForFunction(() => !!window.webcraft?.game && !document.querySelector('.screen.active'), null, {
  timeout: 60000,
});
await page.waitForFunction(() => window.webcraft.game.world.chunks.size > 20, null, { timeout: 60000 });

// Movement deltas are not settable through MouseEvent's init dict, so define them on the event itself.
// Both states are fed into the SAME counters (no reset in between): the point of the probe is that
// identical input must produce identical rad/ct whether or not a button is held, and that comparison
// needs both windows populated.
const feed = async (counts, buttons, n) => {
  await page.evaluate(
    `(() => {
      const g = window.webcraft.game;
      g.input.setActive(true);
        g.input.capture();        // without this the world does not own the mouse: every event is discarded
        g.input.lockSettledAt = -1e9;  // a re-granted lock would otherwise swallow the whole batch
      for (let i = 0; i < ${n}; i++) {
        const e = new MouseEvent('mousemove', { clientX: 400, clientY: 300, buttons: ${buttons}, bubbles: true });
        Object.defineProperty(e, 'movementX', { value: ${counts} });
        Object.defineProperty(e, 'movementY', { value: 0 });
        window.dispatchEvent(e);
      }
    })()`,
  );
};

// A real click, so pointer lock is actually granted: lock needs a trusted gesture, and until the mouse
// is ours every event is measured-but-discarded — the free window would read zero look for harness
// reasons rather than game reasons, which is precisely the kind of artefact this file exists to avoid.
await page.mouse.click(500, 320);
await page.waitForFunction(() => window.webcraft.game.input.locked, null, { timeout: 15000 });
console.log('capture:', await page.evaluate(() => ({ locked: window.webcraft.game.input.locked, usingLock: window.webcraft.game.input.usingLock })));
// Sit out the settle window (LOCK_SETTLE_MS = 150): look arriving right after a grant is discarded on
// purpose, and this harness must not confuse that with the thing it is measuring. F3's `settle-drop`
// counter is what would show the same pattern in a real game.
await page.waitForTimeout(400);
await page.evaluate(() => {
  window.webcraft.game.input.lockSettledAt = -1e9;
  window.webcraft.lookStats(true);
});
await feed(5, 0, 40);
const free = await page.evaluate(() => window.webcraft.lookStats());
await feed(5, 1, 40);
const held = await page.evaluate(() => window.webcraft.lookStats());

console.log('free:', JSON.stringify(free.rad), 'events', free.stats.free.events, 'counts', free.stats.free.counts);
console.log('held:', JSON.stringify(held.rad), 'events', held.stats.held.events, 'counts', held.stats.held.counts);
const symmetric = Math.abs(held.radPerCount.held - free.radPerCount.free) < 1e-12;
console.log(`symmetric free vs held: ${symmetric ? 'YES (baseline is honest)' : 'NO — instrument is lying'}`);

// F3 lines, as the player will read them.
const lines = await page.evaluate(async () => {
  const g = window.webcraft.game;
  const model = g.hudModel();
  return { look: model.look, free: model.lookFree, held: model.lookHeld, probe: model.lookProbe };
});
console.log('\nF3 rows:');
for (const [k, v] of Object.entries(lines)) console.log(`  ${k.padEnd(5)} ${v}`);

// Losing capture mid-drag is one of the candidate mechanisms, so prove the row that reports it appears.
await page.evaluate(() => {
  const g = window.webcraft.game;
  g.input.setActive(false); // the world stops owning the mouse, exactly as if the lock had dropped
  for (let i = 0; i < 5; i++) {
    const e = new MouseEvent('mousemove', { clientX: 400, clientY: 300, buttons: 1, bubbles: true });
    Object.defineProperty(e, 'movementX', { value: 4 });
    Object.defineProperty(e, 'movementY', { value: 0 });
    window.dispatchEvent(e);
  }
  g.input.setActive(true);
});
const lost = await page.evaluate(() => window.webcraft.game.hudModel().lookHeld);
console.log(`\ncapture loss reported: ${lost.includes('no-capture') ? 'YES' : 'NO'} — ${lost}`);

// The rows must actually be in the DOM (the overlay builds them from hudModel).
// F3 for real: the overlay's rows are only repainted while the debug flag is on.
await page.keyboard.press('F3');
await page.waitForTimeout(400);
const dom = await page.evaluate(() => {
  const text = document.getElementById('debug')?.textContent ?? '';
  return { hasFree: text.includes('rad/ct'), hasHeld: text.includes('ratio'), hasProbe: text.includes('F7 mode'), visible: !!document.getElementById('debug')?.offsetHeight };
});
console.log('\nF3 overlay contains the new rows:', JSON.stringify(dom));
await page.screenshot({ path: 'smoke/lookprobe-f3.png', clip: { x: 0, y: 0, width: 1000, height: 320 } });

// F7 / F8: the dials must move, and say so on screen (Safari users may not have devtools handy).
const dials = await page.evaluate(async () => {
  const g = window.webcraft.game;
  const out = [];
  const before = { mode: g.input.lookMode, comp: g.input.dragComp };
  for (const code of ['F7', 'F7', 'F7', 'F8', 'F8', 'F8', 'F9']) {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const toast = [...document.querySelectorAll('#toasts *')].pop()?.textContent ?? '';
    out.push(
      `${code} -> mode ${g.input.lookMode} drag×${g.input.dragComp} ev ${g.input.lookStats.free.events + g.input.lookStats.held.events} toast "${toast}"`,
    );
  }
  return { before, out };
});
console.log('\ndials:');
for (const l of dials.out) console.log('  ' + l);
console.log('  before:', JSON.stringify(dials.before));

await page.evaluate(() => {
  window.webcraft.setLookMode('session');
  window.webcraft.setDragComp(1);
});
const restored = await page.evaluate(() => ({
  mode: window.webcraft.setLookMode('session'),
  comp: window.webcraft.setDragComp(1),
}));
console.log('  console surface:', JSON.stringify(restored));

await browser.close();
const problems = [
  ...errors.map((e) => `page error: ${e}`),
  ...(symmetric ? [] : ['free vs held rad/ct differ for identical input']),
  ...(dom.hasFree && dom.hasHeld && dom.hasProbe ? [] : ['F3 rows missing from the overlay']),
  ...(!dials.out.some((l) => l.includes('mode adaptive')) ? ['F7 did not reach adaptive'] : []),
  ...(!dials.out.some((l) => l.includes('drag×0.5')) ? ['F8 did not reach 0.5'] : []),
  ...(lost.includes('no-capture') ? [] : ['capture loss mid-drag is not reported on F3']),
  ...(!dials.out.some((l) => l.startsWith('F9') && l.includes('ev 0 ')) ? ['F9 did not clear the counters'] : []),
];
console.log(problems.length ? '\nPROBLEMS:\n  ' + problems.join('\n  ') : '\nprobe clean');
process.exit(problems.length ? 1 : 0);
