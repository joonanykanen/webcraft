// Browser smoke test: drives the production build in real Chrome (system channel, no
// browser download) through menu → world load → mining → crafting → save/reload → export/import.
// WebGL2 runs on SwiftShader so it works headless. Usage: npm run smoke
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4179;
const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = join(ROOT, 'smoke');
mkdirSync(SHOTS, { recursive: true }); // screenshots are gitignored, so the folder may not exist yet
const results = [];
const failures = [];

const log = (m) => process.stdout.write(m + '\n');
const ok = (name, info = '') => {
  results.push([true, name]);
  log(`  \x1b[32m✓\x1b[0m ${name}${info ? ' — ' + info : ''}`);
};
const bad = (name, info = '') => {
  results.push([false, name]);
  log(`  \x1b[31m✗\x1b[0m ${name}${info ? ' — ' + info : ''}`);
};
/** Soft assertion (records a failure but keeps the tour going). */
function check(name, cond, info = '') {
  cond ? ok(name, info) : bad(name, info);
}
/** Hard step: an exception skips to the next section instead of aborting the run. */
let activePage = null;

async function step(name, fn, _opts = {}) {
  try {
    const info = await fn();
    ok(name, info ?? '');
    return true;
  } catch (e) {
    bad(name, (e?.message ?? String(e)).split('\n')[0]);
    return false;
  }
}

function startServer() {
  const p = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => process.stderr.write('[preview] ' + d));
  return p;
}

const isActive = (id) => `!!document.querySelector('#${id}.active')`;

async function startWorld(page, { name, seed, mode = 'survival' }) {
  if (!(await page.evaluate(isActive('screen-worlds')))) await page.click('#btn-worlds');
  await page.waitForFunction(isActive('screen-worlds'), null, { timeout: 10000 });
  if (name) await page.fill('#new-name', name);
  await page.fill('#new-seed', seed ?? '');
  if (mode === 'creative') {
    await page.click('#new-mode button[data-mode="creative"]');
  }
  await page.click('#btn-create');
  // in-game there is no active menu screen, just a live game instance
  await page.waitForFunction(() => !!window.webcraft?.game && !document.querySelector('.screen.active'), null, {
    timeout: 60000,
  });
  // The world only owns the mouse after a click into it; take ownership the way a player's first
  // click would — a real gesture, which is what Pointer Lock requires.
  await page.mouse.click(640, 400);
  await page.waitForTimeout(300);
}

async function worldLoaded(page) {
  await page.waitForFunction(
    () => {
      const g = window.webcraft?.game;
      return !!g && g.renderer.info().drawCalls > 6 && g.world.chunks.size > 20;
    },
    null,
    { timeout: 120000 },
  );
}

/** Leave the running world and land on the world list (pause → save & quit). */
async function quitToWorldList(page) {
  if (await page.evaluate(isActive('screen-worlds'))) return;
  if (!(await page.evaluate(isActive('screen-pause')))) {
    await page.keyboard.press('Escape');
    await page.waitForFunction(isActive('screen-pause'), null, { timeout: 8000 });
  }
  await page.click('#btn-quit');
  await page.waitForFunction(isActive('screen-worlds'), null, { timeout: 30000 });
  await page.waitForSelector('#world-list .world-item', { timeout: 15000 });
}

async function clickWorldButton(page, label, nth = 0) {
  const clicked = await page.evaluate(
    ({ label, nth }) => {
      const rows = [...document.querySelectorAll('#world-list .world-item')];
      const btn = [...rows[nth]?.querySelectorAll('button') ?? []].find((b) =>
        b.textContent.trim().startsWith(label),
      );
      if (!btn) return false;
      btn.click();
      return true;
    },
    { label, nth },
  );
  if (!clicked) throw new Error(`no "${label}" button on world row ${nth}`);
}

async function main() {
  const server = startServer();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('preview server did not start')), 15000);
    const ping = setInterval(async () => {
      try {
        const r = await fetch(`http://localhost:${PORT}/`);
        if (r.ok) {
          clearTimeout(t);
          clearInterval(ping);
          resolve();
        }
      } catch {
        /* keep polling */
      }
    }, 250);
  });
  log(`preview server up on :${PORT}`);

  let browser;
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: [
        '--use-angle=swiftshader', // software WebGL2 so the suite runs anywhere
        '--enable-unsafe-swiftshader',
        '--no-sandbox',
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1280,800',
      ],
    });
  } catch (e) {
    server.kill('SIGTERM');
    log(`\nCould not launch system Chrome (${e.message}).`);
    log('Install Google Chrome, or set a channel that exists, then re-run: npm run smoke');
    process.exit(2);
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await context.newPage();
  // Pointer Lock is the intended mouse model, so count the calls from the very start: the game must
  // ask for it, must survive a browser that refuses it, and must always give the cursor back for menus.
  await page.addInitScript(() => {
    window.__pointerLockCalls = 0;
    const orig = Element.prototype.requestPointerLock;
    Element.prototype.requestPointerLock = function (...args) {
      window.__pointerLockCalls++;
      return orig?.apply(this, args);
    };
  });
  activePage = page;
  let pointerMode = 'unknown';
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept()); // world deletion uses confirm()

  try {
    // ------------------------------------------------------------ menu + capability probe
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await step('main menu shown (WebGL probe passed)', async () => {
      await page.waitForSelector('#screen-main.active', { timeout: 20000 });
      if (await page.evaluate(() => !!document.querySelector('#screen-unsupported.active'))) {
        throw new Error('capability probe rejected this browser: ' + (await page.locator('#support-list').innerText()));
      }
      await page.screenshot({ path: join(SHOTS, '00-menu.png') });
      return 'WebGL2 available';
    });

    // ------------------------------------------------------------ create & load a world
    await step(
      'create world starts the game',
      () => startWorld(page, { name: 'Smoke Test', seed: '1337' }),
    );
    await step('terrain streams in (chunk meshes upload)', () => worldLoaded(page));

    const hud = await page.evaluate(() => ({
      hotbar: document.querySelectorAll('#hotbar .slot').length,
      hearts: document.querySelectorAll('#health-row .pip').length,
      hunger: document.querySelectorAll('#hunger-row .pip').length,
      debugHidden: document.getElementById('debug')?.classList.contains('hidden'),
      health: window.webcraft.game.hudModel().health,
      food: window.webcraft.game.hudModel().food,
    }));
    check('HUD: 9 hotbar slots + 10 hearts + 10 hunger pips', hud.hotbar === 9 && hud.hearts === 10 && hud.hunger === 10, JSON.stringify(hud));
    // UI-3: hearts/hunger must sit flush with the hotbar, not on their own wider row
    // (the HUD measures the hotbar on its first painted frame, so give it a beat)
    await page.waitForFunction(() => document.getElementById('stat-rows').style.width !== '', null, { timeout: 4000 });
    const flush = await page.evaluate(() => {
      const box = (id) => document.getElementById(id).getBoundingClientRect();
      const hot = box('hotbar');
      const heart = box('health-row');
      const food = box('hunger-row');
      return {
        left: heart.left - hot.left,
        right: hot.right - food.right,
        gap: hot.top - heart.bottom,
        // one line, two baselines is the bug: the rows must share top and bottom exactly
        topDiff: heart.top - food.top,
        bottomDiff: heart.bottom - food.bottom,
        overlap: heart.right - food.left,
      };
    });
    check(
      'HUD: hearts/hunger are flush with the hotbar edges (UI-3)',
      Math.abs(flush.left) <= 4 && Math.abs(flush.right) <= 4 && flush.gap >= 0 && flush.gap <= 22,
      JSON.stringify(flush),
    );
    check(
      'HUD: hearts and hunger share one line and never overlap (UI-3)',
      Math.abs(flush.topDiff) <= 1 && Math.abs(flush.bottomDiff) <= 1 && flush.overlap <= 0,
      JSON.stringify(flush),
    );

    // RD-2 (regression): the frame used to render with camera.aspect 1 on a wide window because the
    // renderer was never sized until a resize/settings event — everything came out ~75 % too wide.
    await step('the projection matches the canvas box at any size (no stretched frame)', async () => {
      const measure = async () =>
        page.evaluate(() => {
          const cv = document.getElementById('viewport');
          const b = cv.getBoundingClientRect();
          const g = window.webcraft.game;
          return {
            box: [Math.round(b.width), Math.round(b.height)],
            boxAspect: +(b.width / b.height).toFixed(4),
            camAspect: +g.renderer.camera.aspect.toFixed(4),
            backing: [cv.width, cv.height],
            backingAspect: +(cv.width / cv.height).toFixed(4),
          };
        });
      const report = [];
      for (const vp of [
        { width: 1280, height: 800 },
        { width: 900, height: 760 },
        { width: 1440, height: 620 },
      ]) {
        await page.setViewportSize(vp);
        await page.waitForTimeout(350);
        const m = await measure();
        const dpr = Math.min(await page.evaluate(() => window.devicePixelRatio || 1), 2);
        const aspectErr = Math.abs(m.camAspect - m.boxAspect);
        const bufferErr = Math.abs(m.backing[0] / m.backing[1] - m.boxAspect);
        const exact = Math.abs(m.backing[0] - Math.round(m.box[0] * dpr)) <= 2;
        if (aspectErr > 0.01) throw new Error(`camera aspect ${m.camAspect} != box ${m.boxAspect} at ${vp.width}x${vp.height}`);
        if (bufferErr > 0.01) throw new Error(`drawing buffer is ${m.backing} (${m.backingAspect}) but the box is ${m.box}`);
        if (!exact) throw new Error(`drawing buffer width ${m.backing[0]} != box ${m.box[0]} × dpr ${dpr}`);
        report.push(`${vp.width}x${vp.height}→${m.camAspect}`);
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(300);
      return `aspect tracked the box: ${report.join(' ')}`;
    });
    check('player starts with full health and food', hud.health >= 20 && hud.food >= 19, `health=${hud.health} food=${hud.food}`);
    check('debug overlay hidden by default', hud.debugHidden === true);

    // ------------------------------------------------------------ milestones (UI-6)
    await step('milestone tracker shows the next goal while playing (UI-6)', async () => {
      await page.waitForFunction(() => !document.getElementById('milestone-tracker').classList.contains('hidden'), null, {
        timeout: 5000,
      });
      const t = await page.evaluate(() => {
        const el = document.getElementById('milestone-tracker');
        return {
          shown: !el.classList.contains('hidden'),
          title: el.querySelector('.milestone-title').textContent,
          goal: el.querySelector('.milestone-goal').textContent,
          model: window.webcraft.game.milestoneTracker(),
        };
      });
      if (!t.shown) throw new Error('tracker missing from the HUD');
      if (!t.model || !t.model.title) throw new Error('game has no next milestone');
      if (!/\d+\/\d+/.test(t.goal)) throw new Error(`tracker shows no progress: ${t.goal}`);
      return `${t.title} — ${t.goal}`;
    });

    await step('milestone panel lists the chain and unlocks from real play (UI-6)', async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.webcraft.game.screen === 'pause', null, { timeout: 4000 });
      await page.click('#btn-milestones');
      await page.waitForSelector('#screen-milestones.active', { timeout: 4000 });
      const before = await page.evaluate(() => ({
        cards: document.querySelectorAll('.ms-card').length,
        unlocked: document.querySelectorAll('.ms-card.unlocked').length,
        available: document.querySelectorAll('.ms-card.available').length,
      }));
      if (before.cards < 12) throw new Error(`only ${before.cards} milestone cards`);
      if (!before.available) throw new Error('no milestone is available at the start');
      await page.screenshot({ path: join(SHOTS, '09-milestones.png') });
      // Escape closes the panel back to the pause menu and does not leak into the world
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const back = await page.evaluate(() => ({
        panel: document.getElementById('screen-milestones').classList.contains('active'),
        pause: document.getElementById('screen-pause').classList.contains('active'),
        screen: window.webcraft.game.screen,
      }));
      if (back.panel) throw new Error('Escape did not close the milestone panel');
      if (!back.pause || back.screen !== 'pause') throw new Error('Escape did not return to the pause menu: ' + JSON.stringify(back));
      await page.click('#btn-resume');
      await page.waitForTimeout(300);
      // play a goal for real: mine a log and the first milestone must unlock
      const got = await page.evaluate(async () => {
        const g = window.webcraft.game;
        const before = g.milestones.unlockedCount;
        g.milestones.observe({ kind: 'mine', block: 4 });
        await new Promise((r) => setTimeout(r, 120));
        return { before, after: g.milestones.unlockedCount, first: g.milestones.has('firstLog') };
      });
      if (!got.first || got.after <= got.before) throw new Error('mining a log did not unlock a milestone: ' + JSON.stringify(got));
      return `${before.cards} cards (${before.available} available), unlocked ${got.before}→${got.after}`;
    });

    await step('clicking the world captures the pointer and moving it looks around (BI-1)', async () => {
      await page.evaluate(() => {
        const g = window.webcraft.game;
        g.input.mining = false;
        g.input.placing = false;
        g.input.down.clear();
      });
      await page.mouse.click(500, 350);
      await page.waitForTimeout(250);
      const locked = await page.evaluate(() => ({
        plElement: !!document.pointerLockElement,
        plCalls: window.__pointerLockCalls ?? 0,
        game: window.webcraft.game.input.locked,
        cursorHidden: document.body.classList.contains('mouse-captured'),
      }));
      await page.evaluate(() => {
        const g = window.webcraft.game;
        g.input.mining = false;
        g.input.placing = false;
      });
      if (!locked.game) throw new Error('click did not capture the mouse: ' + JSON.stringify(locked));
      if (!locked.cursorHidden) throw new Error('cursor stayed visible over the world: ' + JSON.stringify(locked));
      // Pointer Lock is the primary path; the fallback (cursor hidden, no API grab) is also acceptable
      // — what must never happen is a *visible* cursor over the world or a click that does nothing.
      if (locked.plCalls === 0) throw new Error('the game never asked for pointer lock: ' + JSON.stringify(locked));
      pointerMode = locked.plElement ? 'pointer lock' : 'cursor-hidden fallback';
      const before = await page.evaluate(() => ({ yaw: window.webcraft.game.player.yaw, pitch: window.webcraft.game.player.pitch }));
      for (let i = 1; i <= 6; i++) await page.mouse.move(500 + i * 18, 350 - i * 5);
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({ yaw: window.webcraft.game.player.yaw, pitch: window.webcraft.game.player.pitch }));
      const turned = after.yaw - before.yaw;
      const pitched = after.pitch - before.pitch;
      if (!(Math.abs(turned) > 0.05)) throw new Error(`mouse X did not turn the camera (Δyaw=${turned.toFixed(4)})`);
      if (!(Math.abs(pitched) > 0.02)) throw new Error(`mouse Y did not pitch the camera (Δpitch=${pitched.toFixed(4)})`);
      if (Math.sign(turned) > 0) throw new Error(`mouse X turns the wrong way (Δyaw=${turned.toFixed(3)} for a rightward move)`);
      // back to a horizontal, known view for the steps below
      await page.evaluate(() => {
        window.webcraft.game.player.yaw = 0;
        window.webcraft.game.player.pitch = 0;
      });
      // Holding the left button must not change the response (the old "sensitivity rises while
      // mining" complaint): the same pixels have to turn the same amount.
      const beforeHold = await page.evaluate(() => window.webcraft.game.player.yaw);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(500 + i * 18, 350);
      await page.waitForTimeout(150);
      const held = await page.evaluate(() => window.webcraft.game.player.yaw);
      await page.mouse.up();
      const perPxHeld = Math.abs(held - beforeHold) / 108;
      const free = Math.abs(turned) / 108;
      if (perPxHeld < free * 0.5) throw new Error(`look slowed while LMB was held (${perPxHeld.toFixed(4)} vs ${free.toFixed(4)} rad/px)`);
      return `Δyaw=${turned.toFixed(3)} Δpitch=${pitched.toFixed(3)} (${(Math.abs(turned) / 108).toFixed(4)} rad/px, ${pointerMode})`;
    });

    // Regression for "the mouse gets faster while I hold the left button": the viewport drag-to-look
    // handler (touch UI) used to run for mouse pointers too, and it started on pointerdown — i.e. on
    // the mining click — adding a second, much larger look input. Gain must be identical either way,
    // and a mouse pointer must contribute nothing to the touchDrag source.
    await step('look gain is identical free vs LMB held, with touch controls on (BI-1)', async () => {
      const gain = async (hold) =>
        page.evaluate(
          async (held) => {
            const g = window.webcraft.game;
            const cv = document.getElementById('viewport');
            g.input.touch.enabled = true; // the configuration that used to break
            g.player.yaw = 0;
            g.player.pitch = 0;
            await new Promise((r) => setTimeout(r, 400)); // outlast the lock settle window
            const yaw0 = g.player.yaw;
            const t0 = g.lookTotals().touchDrag;
            const send = (type, init) => {
              const E = type.startsWith('pointer') ? PointerEvent : MouseEvent;
              const target = type === 'mousemove' ? window : cv;
              target.dispatchEvent(new E(type, { bubbles: true, cancelable: true, view: window, button: 0, ...init }));
            };
            if (held) {
              send('pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 350, buttons: 1 });
              send('mousedown', { clientX: 400, clientY: 350, button: 0, buttons: 1 });
            }
            let x = 400;
            for (let i = 1; i <= 10; i++) {
              const nx = 400 + 20 * i;
              const d = nx - x;
              x = nx;
              send('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: 350, movementX: d, buttons: held ? 1 : 0 });
              send('mousemove', { clientX: x, clientY: 350, movementX: d, buttons: held ? 1 : 0 });
              await new Promise((r) => requestAnimationFrame(r));
            }
            if (held) {
              send('mouseup', { clientX: x, clientY: 350, button: 0 });
              g.input.mining = false;
            }
            g.input.touch.enabled = false;
            await new Promise((r) => setTimeout(r, 100));
            return {
              radPerPx: Math.abs(g.player.yaw - yaw0) / 200,
              drag: g.lookTotals().touchDrag - t0,
              moves: g.input.movesSeen,
            };
          },
          hold,
        );
      const free = await gain(false);
      const held = await gain(true);
      if (free.radPerPx < 0.005) throw new Error(`free look gain collapsed (${free.radPerPx.toFixed(5)} rad/px)`);
      const ratio = held.radPerPx / free.radPerPx;
      if (ratio > 1.15) throw new Error(`look is ${ratio.toFixed(2)}x more sensitive while LMB is held (${free.radPerPx.toFixed(5)} → ${held.radPerPx.toFixed(5)} rad/px)`);
      if (free.drag > 0 || held.drag > 0) throw new Error(`a mouse pointer fed the touch drag source: free=${free.drag} held=${held.drag} rad`);
      return `free ${free.radPerPx.toFixed(5)} vs held ${held.radPerPx.toFixed(5)} rad/px (ratio ${ratio.toFixed(2)}), touchDrag 0`;
    });

    const st = await page.evaluate(() => {
      const g = window.webcraft.game;
      return {
        seed: g.seed,
        mode: g.mode,
        chunks: g.world.chunks.size,
        drawCalls: g.renderer.info().drawCalls,
        tris: g.renderer.info().triangles,
        onGround: g.player.onGround,
        y: +g.player.pos.y.toFixed(2),
        biome: g.world.biomeAt(Math.floor(g.player.pos.x), Math.floor(g.player.pos.z)),
        // One pass over the columns near spawn: a trunk lives BELOW the canopy, so the window
        // has to reach down past `heightAt` (which reports the canopy top in tree columns).
        trees: (() => {
          const px = Math.floor(g.player.pos.x);
          const pz = Math.floor(g.player.pos.z);
          let log = 0;
          let leaf = 0;
          for (let dx = -24; dx <= 24; dx++) {
            for (let dz = -24; dz <= 24; dz++) {
              const h = g.world.heightAt(px + dx, pz + dz);
              for (let y = h + 10; y >= h - 12; y--) {
                const b = g.world.getBlock(px + dx, y, pz + dz);
                if (b === 4) log++;
                else if (b === 6) leaf++;
              }
            }
          }
          return { log, leaf };
        })(),
        fps: Math.round(g.fps),
        health: g.hudModel().health,
        food: g.hudModel().food,
      };
    });
    check(
      'game instance exposes sane state',
      st.seed === 1337 && st.mode === 'survival' && st.onGround && st.y > 0 && st.y < 128,
      JSON.stringify(st),
    );
    check('render distance loads a field of chunks', st.chunks >= 38, `${st.chunks} chunks, ${st.drawCalls} draws`);
    check(
      'trees near spawn have trunks, not just canopies (WG-5)',
      st.trees.log > 0 && st.trees.log * 20 > st.trees.leaf,
      `logs=${st.trees.log} leaves=${st.trees.leaf} biome=${st.biome}`,
    );
    await page.screenshot({ path: join(SHOTS, '01-spawn.png') });

    // ------------------------------------------------------------ debug overlay & fps
    await step('F3 debug overlay reports fps', async () => {
      await page.keyboard.press('F3');
      await page.waitForFunction(() => !document.getElementById('debug')?.classList.contains('hidden'), null, { timeout: 4000 });
      await page.waitForFunction(() => /FPS/.test(document.getElementById('debug')?.textContent ?? ''), null, { timeout: 4000 });
      const text = await page.locator('#debug').textContent();
      const fps = Number(/FPS (\d+)/.exec(text)?.[1] ?? -1);
      if (!(fps > 5)) throw new Error(`fps too low for software GL: ${fps} (text: ${text.slice(0, 60)})`);
      if (!/seed \d+/.test(text)) throw new Error('debug overlay is missing world stats');
      return `${fps} fps`;
    });

    // ------------------------------------------------------------ mob rendering (MO-1)
    await step('mobs render as finite geometry in front of the camera', async () => {
      const r = await page.evaluate(async () => {
        const g = window.webcraft.game;
        g.input.locked = true;
        g.input.active = true;
        const p = g.player.pos;
        const dx = 2.5;
        const dz = -2.5;
        const ground = g.world.heightAt(p.x + dx, p.z + dz); // deliberately fractional input
        g.mobs.spawn('pig', { x: p.x + dx, y: ground + 0.1, z: p.z + dz }, g);
        g.player.pitch = -0.1;
        g.player.yaw = Math.atan2(-dx, -dz); // look direction is (-sin yaw, -cos yaw)
        await new Promise((res) => setTimeout(res, 500));
        let parts = 0;
        let bad = 0;
        let facing = 0;
        const fx = -Math.sin(g.player.yaw) * Math.cos(g.player.pitch);
        const fz = -Math.cos(g.player.yaw) * Math.cos(g.player.pitch);
        for (const m of g.mobs.mobs) {
          const ddx = m.pos.x - p.x;
          const ddz = m.pos.z - p.z;
          const len = Math.hypot(ddx, ddz) || 1;
          facing = Math.max(facing, (fx * ddx + fz * ddz) / len);
          m.object.traverse((o) => {
            parts++;
            if (
              Number.isFinite(o.position.x) &&
              Number.isFinite(o.position.y) &&
              Number.isFinite(o.position.z) &&
              Number.isFinite(o.scale.x)
            )
              return;
            bad++;
          });
        }
        return { mobs: g.mobs.mobs.length, parts, bad, ground, facing: +facing.toFixed(2) };
      });
      check('every mob transform is finite (NaN geometry used to fill the screen)', r.bad === 0, `${r.parts} transforms, ${r.bad} bad`);
      check('mob models have cube parts', r.parts >= r.mobs * 4, `${r.parts} parts / ${r.mobs} mobs`);
      check('the mob is in front of the camera (so the screenshot means something)', r.facing > 0.8, `facing=${r.facing}`);
      await page.screenshot({ path: join(SHOTS, '07-mob.png') });
      return `${r.mobs} mobs in view`;
    });

    // ------------------------------------------------------------ movement (PH-1)
    await step('holding W walks the player across the terrain', async () => {
      const p0 = await page.evaluate(() => ({ ...window.webcraft.game.player.pos }));
      await page.evaluate(() => {
        const g = window.webcraft.game;
        g.input.locked = true;
        g.input.active = true;
        g.input.down.add('KeyW');
      });
      await page.waitForTimeout(1200);
      await page.evaluate(() => {
        const g = window.webcraft.game;
        g.input.down.delete('KeyW');
      });
      const p1 = await page.evaluate(() => ({ ...window.webcraft.game.player.pos }));
      const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      if (!(moved > 0.5)) throw new Error(`player barely moved: Δ=${moved.toFixed(2)}`);
      return `Δ=${moved.toFixed(2)} blocks`;
    });

    await step('Ctrl+W sprint + a tapped Space still jumps (PH-2 input buffer)', async () => {
      await page.evaluate(() => {
        const g = window.webcraft.game;
        g.input.locked = true;
        g.input.active = true;
        g.input.down.clear();
        g.player.vel.x = g.player.vel.y = g.player.vel.z = 0;
      });
      await page.keyboard.down('Control');
      await page.keyboard.down('w');
      await page.waitForTimeout(450);
      const run = await page.evaluate(() => ({
        sprinting: window.webcraft.game.player.sprinting,
        onGround: window.webcraft.game.player.onGround,
        y: window.webcraft.game.player.pos.y,
      }));
      await page.keyboard.press('Space'); // instant tap: used to fall between two samples
      let rose = 0;
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(60);
        rose = Math.max(rose, (await page.evaluate(() => window.webcraft.game.player.pos.y)) - run.y);
      }
      await page.keyboard.up('w');
      await page.keyboard.up('Control');
      if (!run.sprinting) throw new Error('Ctrl+W did not engage sprinting');
      if (!(rose > 0.6)) throw new Error(`tapped Space did not jump (rose ${rose.toFixed(2)} blocks while sprinting)`);
      return `sprint ${run.sprinting ? 'on' : 'off'}, rose ${rose.toFixed(2)} blocks`;
    });

    // ------------------------------------------------------------ mining with the mouse
    await step('holding LMB mines a block (BI-2/AM-2)', async () => {
      const aimed = await page.evaluate(async () => {
        const g = window.webcraft.game;
        g.input.locked = true;
        g.input.active = true;
        // negative pitch looks down at the ground (positive looks at the sky)
        for (const pitch of [-0.35, -0.65, -0.95, -1.2, 0]) {
          g.player.pitch = pitch;
          await new Promise((r) => setTimeout(r, 140)); // let the frame update targeting
          const t = g.target;
          if (t && g.world.getBlock(t.x, t.y, t.z)) {
            return { pitch, block: g.world.getBlock(t.x, t.y, t.z), at: [t.x, t.y, t.z], mined: g.stats.blocksMined };
          }
        }
        return null;
      });
      if (!aimed) throw new Error('nothing solid under the crosshair to mine');
      await page.evaluate(() => {
        window.webcraft.game.input.mining = true;
      });
      let snap = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        await page.waitForTimeout(400);
        snap = await page.evaluate(() => {
          const g = window.webcraft.game;
          return {
            mined: g.stats.blocksMined,
            ready: Math.round(g.readyProgress() * 100) / 100,
            items: g.inventory.serialize().filter((s) => s).length,
            drops: g.entities.count(),
          };
        });
        if (snap.mined > aimed.mined) break;
      }
      await page.evaluate(() => {
        window.webcraft.game.input.mining = false;
      });
      if (!snap || snap.mined <= aimed.mined) {
        throw new Error(`no block broken in 20 s (target=${JSON.stringify(aimed.at)} ready=${snap?.ready ?? 0})`);
      }
      // survival drops the item on the ground; creative hands it straight to the inventory
      check('the broken block becomes an item', snap.items > 0 || snap.drops > 0, JSON.stringify(snap));
      await page.screenshot({ path: join(SHOTS, '02-mining.png') });
      return `mined ${snap.mined - aimed.mined} block(s) at ${JSON.stringify(aimed.at)} · items=${snap.items} drops=${snap.drops}`;
    });

    // ------------------------------------------------------------ placing blocks
    await step('RMB places the held block on the ground', async () => {
      const before = await page.evaluate(() => {
        const g = window.webcraft.game;
        g.inventory.setSlot(1, { id: 5, count: 8 }); // oak planks
        g.inventory.select(1);
        const p = g.player.pos;
        const near = () => {
          const [cx, cy, cz] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
          for (let dx = -4; dx <= 4; dx++)
            for (let dy = -3; dy <= 4; dy++)
              for (let dz = -4; dz <= 4; dz++) if (g.world.getBlock(cx + dx, cy + dy, cz + dz) === 5) return true;
          return false;
        };
        return near();
      });
      // hold RMB, sweeping the aim across a few pitches until something lands
      let scan = before;
      for (const pitch of [-0.35, -0.65, -0.95]) {
        await page.evaluate((pitch) => {
          const g = window.webcraft.game;
          g.player.pitch = pitch;
          g.input.placing = true;
        }, pitch);
        await page.waitForTimeout(320);
        await page.evaluate(() => {
          window.webcraft.game.input.placing = false;
        });
        scan = await page.evaluate(() => {
          const g = window.webcraft.game;
          const p = g.player.pos;
          const [cx, cy, cz] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
          for (let dx = -4; dx <= 4; dx++)
            for (let dy = -3; dy <= 4; dy++)
              for (let dz = -4; dz <= 4; dz++)
                if (g.world.getBlock(cx + dx, cy + dy, cz + dz) === 5) return [true, g.world.getBlock(cx, cy - 1, cz) === 5];
          return [false, false];
        });
        if (scan?.[0]) break;
      }
      check('the block landed within reach', scan?.[0] === true, `already present before: ${before}`);
      // also plant a crafting table (id 20) two blocks over: the reload test looks for it
      const table = await page.evaluate(() => {
        const g = window.webcraft.game;
        const p = g.player.pos;
        const x = Math.floor(p.x) + 2;
        const z = Math.floor(p.z) + 1;
        const y = g.world.heightAt(x, z);
        const ok = g.world.setBlock(x, y, z, 20) >= 0;
        return { ok, at: [x, y, z], id: g.world.getBlock(x, y, z) };
      });
      check('a crafting table can be planted in the world', table.ok && table.id === 20, JSON.stringify(table));
    });

    // ------------------------------------------------------------ inventory & crafting UI
    await step('E opens the inventory (9+27 slots, 2×2 grid, recipe book)', async () => {
      await page.keyboard.press('KeyE');
      await page.waitForFunction(isActive('panel-inventory'), null, { timeout: 5000 });
      const counts = await page.evaluate(() => ({
        main: document.querySelectorAll('#inv-main .slot').length,
        hotbar: document.querySelectorAll('#inv-hotbar .slot').length,
        craft: document.querySelectorAll('#craft-grid .slot').length,
        recipes: document.querySelectorAll('#recipe-list .recipe').length,
      }));
      const nearTable = await page.evaluate(() => {
        const g = window.webcraft.game;
        return g.nearCraftingTable();
      });
      const expectedGrid = nearTable ? 9 : 4;
      if (!(counts.main === 27 && counts.hotbar === 9 && counts.craft === expectedGrid)) {
        throw new Error(`unexpected panel layout (near table: ${nearTable}): ` + JSON.stringify(counts));
      }
      if (counts.recipes < 12) throw new Error(`recipe book looks empty: ${counts.recipes}`);
      return `recipes=${counts.recipes}, ${expectedGrid === 9 ? '3×3 (table in range)' : '2×2 hand grid'}`;
    });

    await step('clicking a recipe crafts it (logs → planks)', async () => {
      const res = await page.evaluate(async () => {
        const g = window.webcraft.game;
        g.inventory.add(4, 4); // oak logs
        await new Promise((r) => setTimeout(r, 200));
        const card = [...document.querySelectorAll('#recipe-list .recipe')].find((el) =>
          /plank/i.test(`${el.title ?? ''}${el.textContent ?? ''}`),
        );
        if (!card) return { matched: false };
        card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        return { matched: true, logs: g.inventory.countItem(4), planks: g.inventory.countItem(5) };
      });
      if (!res.matched) throw new Error('no planks recipe in the book');
      if (res.planks < 4) throw new Error(`planks were not produced: ${JSON.stringify(res)}`);
      await page.screenshot({ path: join(SHOTS, '03-inventory.png') });
      return `logs=${res.logs} planks=${res.planks}`;
    });

    await step('E closes the inventory', async () => {
      await page.keyboard.press('KeyE');
      await page.waitForFunction(() => !document.querySelector('#panel-inventory.active'), null, { timeout: 4000 });
    });

    await step('a torch lights up the world (AM-1)', async () => {
      const maxNear = (at) =>
        `(() => { let m = 0;
          for (let i = -3; i <= 3; i++) for (let j = -2; j <= 2; j++) for (let k = -3; k <= 3; k++)
            m = Math.max(m, window.webcraft.game.world.getBlockLight(${at[0]} + i, ${at[1]} + j, ${at[2]} + k));
          return m; })()`;
      const spot = await page.evaluate(() => {
        const g = window.webcraft.game;
        const p = g.player.pos;
        const x = Math.floor(p.x) + 1;
        const z = Math.floor(p.z);
        const y = g.world.heightAt(x, z); // first air cell above the surface
        const before = (() => {
          let m = 0;
          for (let i = -3; i <= 3; i++)
            for (let k = -3; k <= 3; k++) m = Math.max(m, g.world.getBlockLight(x + i, y, z + k));
          return m;
        })();
        g.world.setBlock(x, y, z, 18); // BlockId.TORCH
        return { at: [x, y, z], before, id: g.world.getBlock(x, y, z) };
      });
      if (spot.id !== 18) throw new Error('torch did not get placed: ' + JSON.stringify(spot));
      await page.waitForTimeout(400); // let the lighting + mesh queues run
      const after = await page.evaluate(maxNear(spot.at));
      if (!(after >= 12)) throw new Error(`torch light too weak: ${spot.before} → ${after} at ${JSON.stringify(spot.at)}`);
      return `block light ${spot.before} → ${after} around ${JSON.stringify(spot.at)}`;
    });

    // ------------------------------------------------------------ first-person hand + focus UX
    await step('first-person hand is drawn (view model)', async () => {
      await page.evaluate(() => {
        const g = window.webcraft.game;
        g.inventory.setSlot(0, { id: 3, count: 1 }); // stone
        g.inventory.select(0);
        g.player.yaw = 0;
        g.player.pitch = 0;
      });
      await page.waitForTimeout(250);
      const where = await page.evaluate(() => {
        const [x, y, z] = window.webcraft.game.renderer.hand.limbPosition;
        return { x, y, z, on: window.webcraft.game.renderer.hand.visible };
      });
      // The arm enters from the bottom-right corner, so compare pixels where it actually is.
      const clip = { x: 880, y: 500, width: 360, height: 280 };
      const withHand = await page.screenshot({ clip });
      await page.evaluate(() => window.webcraft.game.renderer.setHandVisible(false));
      await page.waitForTimeout(200);
      const withoutHand = await page.screenshot({ clip });
      await page.evaluate(() => window.webcraft.game.renderer.setHandVisible(true));
      await page.waitForTimeout(200);
      if (withHand.equals(withoutHand)) throw new Error('hiding the hand did not change the frame');
      if (!where.on) throw new Error('view model reports itself invisible while the setting is on');
      // foreshortening: the elbow end must be the near one, right and low in camera space
      if (!(where.x > 0.3 && where.y < -0.3 && where.z < 0)) {
        throw new Error(`arm root is not in the bottom-right of camera space: ${JSON.stringify(where)}`);
      }
      await page.screenshot({ path: join(SHOTS, '08-hand.png') });
      return `held block + arm in a second pass, elbow at ${JSON.stringify(where)}`;
    });

    await step('HUD comes back after the mouse is lost and the game resumes (UI-3)', async () => {
      // What a tab switch / Esc does: the game pauses, and resuming used to leave the HUD
      // invisible with the keyboard still swallowed. Resume must restore HUD + capture.
      await page.keyboard.press('Escape', { pauseDelay: 0 });
      await page.waitForFunction(() => window.webcraft.game.screen === 'pause', null, { timeout: 4000 });
      const handed = await page.evaluate(() => ({
        lockHeld: !!document.pointerLockElement,
        cursorHidden: document.body.classList.contains('mouse-captured'),
        screen: window.webcraft.game.screen,
      }));
      // One Escape has to be enough: the pause menu owns the cursor, and the game must not have
      // toggled itself straight back out of the pause in the same key press.
      if (handed.lockHeld || handed.cursorHidden) throw new Error('Escape left the mouse captured: ' + JSON.stringify(handed));
      await page.click('#btn-resume');
      await page.waitForTimeout(500);
      const state = await page.evaluate(() => ({
        screen: window.webcraft.game.screen,
        captured: window.webcraft.game.input.locked && document.body.classList.contains('mouse-captured'),
        hud: getComputedStyle(document.getElementById('hud')).display !== 'none',
        health: document.querySelectorAll('#health-row .pip').length,
      }));
      if (state.screen !== 'none') throw new Error('did not return to the world: ' + JSON.stringify(state));
      if (!state.hud) throw new Error('HUD still hidden after resume: ' + JSON.stringify(state));
      if (state.health !== 10) throw new Error('health bar did not repaint: ' + JSON.stringify(state));
      if (!state.captured) throw new Error('resume did not re-capture the mouse: ' + JSON.stringify(state));
      // and while a menu is open the cursor must be usable again (no hidden-pointer trap)
      const paused = await page.evaluate(async () => {
        const g = window.webcraft.game;
        window.webcraft.game.setScreen('pause');
        await new Promise((r) => setTimeout(r, 250));
        const hiddenInMenu = document.body.classList.contains('mouse-captured');
        const resume = document.getElementById('btn-resume');
        const clickable = !!resume && resume.getBoundingClientRect().width > 0;
        return { hiddenInMenu, clickable };
      });
      if (paused.hiddenInMenu) throw new Error('cursor still hidden while the pause menu is open');
      if (!paused.clickable) throw new Error('Resume button not clickable');
      await page.click('#btn-resume');
      await page.waitForTimeout(300);
      const relocked = await page.evaluate(() => ({
        locked: window.webcraft.game.input.locked,
        usingLock: window.webcraft.game.input.usingLock,
        element: document.pointerLockElement === document.getElementById('viewport'),
        calls: window.__pointerLockCalls,
      }));
      if (!relocked.locked) throw new Error('resume did not take the mouse back: ' + JSON.stringify(relocked));
      if (relocked.calls === 0) throw new Error('the game never requested pointer lock: ' + JSON.stringify(relocked));
      // A *second*, separate Escape must pause again — the coalescing guard for the key press that
      // dropped the lock must not swallow later presses.
      await page.waitForTimeout(600);
      await page.keyboard.press('Escape', { pauseDelay: 0 });
      await page.waitForTimeout(400);
      const second = await page.evaluate(() => window.webcraft.game.screen);
      if (second !== 'pause') throw new Error(`second Escape did not pause (screen=${second}) — pause toggled twice or the guard stuck`);
      await page.click('#btn-resume');
      await page.waitForTimeout(300);
      return `HUD + capture (${relocked.usingLock && relocked.element ? 'pointer lock' : 'fallback'}, ${relocked.calls} requests) + visible cursor in menus`;
    });

    await step('night falls gradually instead of snapping (RD-5)', async () => {
      const ramp = await page.evaluate(async () => {
        const g = window.webcraft.game;
        const samples = [];
        for (const t of [0.44, 0.46, 0.48, 0.5, 0.52, 0.54, 0.56, 0.58, 0.6, 0.62, 0.66]) {
          g.setTimeOfDay(t);
          await new Promise((r) => setTimeout(r, 90));
          samples.push(+g.nightFactor().toFixed(3));
        }
        let maxStep = 0;
        for (let i = 1; i < samples.length; i++) maxStep = Math.max(maxStep, Math.abs(samples[i] - samples[i - 1]));
        g.setTimeOfDay(0.74);
        return { samples, maxStep, paused: g.screen };
      });
      // one sample = 12 in-game seconds; a snap would show up as a single >0.3 step
      if (ramp.maxStep >= 0.3) throw new Error('night factor jumps: ' + JSON.stringify(ramp));
      if (!ramp.samples.some((v) => v > 0.1 && v < 0.9)) throw new Error('no twilight band sampled: ' + JSON.stringify(ramp));
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(SHOTS, '09-night.png') });
      return JSON.stringify(ramp.samples);
    });

    // ------------------------------------------------------------ pause, save, quit, reload
    // RD-3 / atlas regression: the block shader maps aUV.y = 1 (the top vertex of a face) into the tile,
    // and if that mapping is not mirrored the art lands vertically flipped — grass fringe along the
    // bottom of the dirt, flame at the base of a torch. No unit test can see this, so read the pixels.
    await step('asymmetric tiles are drawn the right way up on block faces (RD-3)', async () => {
      const r = await page.evaluate(async () => {
        const g = window.webcraft.game;
        const B = window.webcraft.BlockId;
        const W_ = g.world;
        g.input.release();
        // Everything this step touches is put back afterwards: it runs in the middle of a tour whose
        // later steps look at the same sky.
        const undo = [];
        const keep = (x, y, z) => undo.push([x, y, z, W_.getBlock(x, y, z)]);
        const savedTime = g.timeOfDay;
        const home = { x: g.player.pos.x, y: g.player.pos.y, z: g.player.pos.z, yaw: g.player.yaw, pitch: g.player.pitch };
        g.setTimeOfDay(0.25); // noon, so the face is lit and its hues are readable
        g.player.yaw = 0;
        g.player.pitch = 0;

        // Stand on the highest solid ground near the player and build the test block in open sky.
        const px = Math.round(g.player.pos.x), pz = Math.round(g.player.pos.z);
        let sy = 1;
        for (let y = 126; y > 0; y--) {
          const b = W_.getBlock(px, y, pz);
          if (b !== B.AIR && b !== B.WATER) { sy = y; break; }
        }
        g.player.pos.x = px + 0.5;
        g.player.pos.z = pz + 4.5;
        g.player.pos.y = sy + 1;
        g.player.vel.x = 0; g.player.vel.y = 0; g.player.vel.z = 0;
        // The player is at pz + 4.5 looking down -Z, so the block goes three blocks in front of them.
        const bx = px, tz = pz + 1;
        for (let dy = 1; dy <= 4; dy++) { keep(bx, sy + dy, tz); W_.setBlock(bx, sy + dy, tz, B.AIR); }
        for (const dx of [-1, 1]) { keep(bx + dx, sy + 1, tz); W_.setBlock(bx + dx, sy + 1, tz, B.AIR); }
        keep(bx, sy + 1, tz);
        W_.setBlock(bx, sy + 1, tz, B.GRASS);

        const raf = (n) => new Promise((res) => { let k = 0; const t = () => (++k >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
        // Let the player settle, the light spread and the mesh queue drain before sampling: sampling a
        // face that has not been meshed yet would read whatever terrain happens to be behind it.
        await raf(30);
        for (let i = 0; i < 40; i++) {
          const s0 = W_.stats;
          if (s0.dirty === 0 && s0.genQueue === 0) break;
          await raf(10);
        }
        await raf(20);

        const cam = g.renderer.camera;
        const V = cam.position.constructor;
        const gl = g.renderer.three.getContext();
        const WW = gl.drawingBufferWidth, HH = gl.drawingBufferHeight;
        const toPixel = (wx, wy, wz) => {
          const v = new V(wx, wy, wz).project(cam);
          return { x: (v.x * 0.5 + 0.5) * WW, yGl: (v.y * 0.5 + 0.5) * HH };
        };
        const FZ = tz + 0.5; // the face the player sees
        const left = toPixel(bx + 0.04, sy + 1.5, FZ);
        const right = toPixel(bx + 0.96, sy + 1.5, FZ);
        const top = toPixel(bx + 0.5, sy + 1.95, FZ);
        const bot = toPixel(bx + 0.5, sy + 1.05, FZ);
        const yLo = Math.round(Math.min(top.yGl, bot.yGl));
        const yHi = Math.round(Math.max(top.yGl, bot.yGl));
        const n = yHi - yLo + 1;
        const x0 = Math.min(left.x, right.x), span = Math.abs(right.x - left.x);
        const columns = [];
        for (const f of [0.15, 0.32, 0.5, 0.68, 0.85]) {
          const buf = new Uint8Array(4 * n);
          gl.readPixels(Math.round(x0 + span * f), yLo, 1, n, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          const rows = [];
          for (let i = 0; i < n; i++) {
            const rr = buf[i * 4], gg = buf[i * 4 + 1], bb = buf[i * 4 + 2];
            // i = 0 is the lowest GL row; unshift so index 0 is the top of the face
            rows.unshift({
              green: gg > rr + 5 && gg > bb + 3,
              brown: rr > gg + 6 && rr > bb + 6,
              rgb: `${rr},${gg},${bb}`,
            });
          }
          const share = (list, pred) => (list.length ? list.filter(pred).length / list.length : 0);
          const q = Math.max(2, Math.floor(n * 0.3));
          const half = Math.floor(n / 2);
          columns.push({
            x: Math.round(x0 + span * f),
            topGreen: share(rows.slice(0, q), (p) => p.green),
            bottomGreen: share(rows.slice(half), (p) => p.green),
            bottomBrown: share(rows.slice(half), (p) => p.brown),
            anyGreen: rows.some((p) => p.green),
            anyBrown: rows.some((p) => p.brown),
            sample: rows.filter((_, k) => k % Math.max(1, Math.floor(n / 8)) === 0).map((p) => p.rgb).join(' '),
          });
        }

        // ---- put the world back exactly as it was ----
        W_.setBlock(bx, sy + 1, tz, B.AIR);
        for (let i = undo.length - 1; i >= 0; i--) {
          const [x, y, z, id] = undo[i];
          W_.setBlock(x, y, z, id);
        }
        g.player.pos.x = home.x; g.player.pos.y = home.y; g.player.pos.z = home.z;
        g.player.yaw = home.yaw; g.player.pitch = home.pitch;
        g.player.vel.x = 0; g.player.vel.y = 0; g.player.vel.z = 0;
        const light = W_.getLight(bx, sy + 1, tz);
        g.setTimeOfDay(savedTime);
        await raf(20);
        return { n, columns, light: light ? Math.max(light.sky, light.blk) : -1 };
      });
      const dump = r.columns.map((c) => `x${c.x}[${c.sample}]`).join(' || ');
      const visible = r.columns.filter((c) => c.anyGreen && c.anyBrown);
      if (r.n < 20) throw new Error(`the grass face covered only ${r.n} rows — cannot judge orientation (${dump})`);
      if (visible.length < 3)
        throw new Error(`the test block was not on screen (only ${visible.length}/5 columns showed both grass and dirt; face ${r.n}px, light was ${r.light ?? '?'}; ${dump})`);
      const med = (key) => visible.map((c) => c[key]).sort((a, b) => a - b)[Math.floor(visible.length / 2)];
      const topGreen = med('topGreen');
      const bottomGreen = med('bottomGreen');
      const bottomBrown = med('bottomBrown');
      if (topGreen < 0.55) throw new Error(`grass fringe is not at the top of the face: median top 25% is ${(topGreen * 100).toFixed(0)}% green (${dump})`);
      if (bottomGreen > 0.3) throw new Error(`grass fringe bleeds down the face: median bottom half is ${(bottomGreen * 100).toFixed(0)}% green (${dump})`);
      if (bottomBrown < 0.45) throw new Error(`lower grass face is not dirt: median bottom half is ${(bottomBrown * 100).toFixed(0)}% brown (${dump})`);
      return `face ${r.n}px × 5 columns: top 25% ${topGreen.toFixed(2)} green, bottom half ${bottomGreen.toFixed(2)} green / ${bottomBrown.toFixed(2)} dirt (world restored after)`;
    });

    // RD-5 regression: the clock's origin used to be read live from the save record, and saving wrote
    // the current time into that record. Every autosave (30 s) then moved the origin to now while the
    // elapsed term kept growing — the sky jumped forward by the whole session, which is what the
    // "evening suddenly leaps a quarter of the way into the night" report was.
    await step('saving the world does not jump the clock (RD-5)', async () => {
      const r = await page.evaluate(async () => {
        const g = window.webcraft.game;
        g.setTimeOfDay(0.46); // early evening, where the complaint was noticed
        // Age the session the way real play does. `clock` is private in TS but this is exactly the
        // state ("playing for 5 minutes") that a harness must be able to set up to prove the point.
        g.clock.advance(5 * 60 * 1000);
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        const before = g.timeOfDay;
        await g.save(true); // manual save: writes timeOfDay into the record, exactly like autosave
        const after = g.timeOfDay;
        g.clock.advance(1000);
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        return { before, after, later: g.timeOfDay, jump: Math.abs(after - before) };
      });
      if (r.jump > 0.002) {
        throw new Error(`saving jumped the clock by ${r.jump.toFixed(4)} of a cycle (${(r.jump * 600).toFixed(0)} s of sky)`);
      }
      const expected = 1000 / 600000;
      const moved = (((r.later - r.after) % 1) + 1) % 1;
      if (moved > expected * 8) throw new Error(`a second of play moved the clock by ${moved.toFixed(5)} (expected ${expected.toFixed(5)})`);
      return `save moved t by ${r.jump.toExponential(1)}; 1 s of play = ${moved.toFixed(5)} of a cycle`;
    });

    // The simulation curve above is not what the player sees; this measures the *pixels*, which is
    // the only way to catch a sky that changes gradually in the model but snaps on screen.
    await step('the rendered sky brightens gradually all the way round (RD-5)', async () => {
      const lums = await page.evaluate(async () => {
        const g = window.webcraft.game;
        const cv = document.getElementById('viewport');
        const gl = g.renderer.three.getContext();
        if (!gl) throw new Error('no WebGL context to read pixels from');
        // The clock keeps ticking while we sample, but the loop clamps each frame to 0.5 s (600 s
        // cycle = 0.08 % of a day), so the drift between samples is far below the step we test.
        const w = 120;
        const h = 80;
        const px = new Uint8Array(w * h * 4);
        const out = [];
        for (let i = 0; i <= 24; i++) {
          const t = i / 24;
          g.setTimeOfDay(t);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          gl.readPixels(Math.floor(cv.width / 2 - w / 2), Math.floor(cv.height * 0.62), w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let sum = 0;
          for (let p = 0; p < px.length; p += 4) sum += (px[p] + px[p + 1] + px[p + 2]) / 3;
          out.push(sum / (px.length / 4));
        }
        g.setTimeOfDay(0.25);
        return out;
      });
      const min = Math.min(...lums);
      const max = Math.max(...lums);
      const range = max - min;
      if (!(min < 12)) throw new Error(`the sky never really gets dark (min luminance ${min.toFixed(1)}): ${lums.map((v) => v.toFixed(0)).join(' ')}`);
      if (!(max > 55)) throw new Error(`the sky never really gets bright (max luminance ${max.toFixed(1)})`);
      if (range < 30) throw new Error(`dark and bright are too close to be a day/night cycle (range ${range.toFixed(1)})`);
      // Judge it as a rate: a 10-minute cycle sampled every 25 s legitimately moves ~30 % of the
      // range per sample in the middle of dusk. What must not exist is a *rate* that looks like a snap.
      const secondsPerSample = 600 / (lums.length - 1);
      let maxRate = 0;
      for (let i = 1; i < lums.length; i++) {
        maxRate = Math.max(maxRate, Math.abs(lums[i] - lums[i - 1]) / range / secondsPerSample);
      }
      if (maxRate > 0.03) throw new Error(`the rendered light changes ${Math.round(maxRate * 100)} % of its range per second: ${lums.map((v) => v.toFixed(0)).join(' ')}`);
      const mid = lums.filter((v) => v > min + range * 0.1 && v < min + range * 0.9).length;
      if (mid < 6) throw new Error(`only ${mid}/25 samples are in-between — that is two plateaus, not a ramp`);
      return `sky luminance ${min.toFixed(0)}→${max.toFixed(0)}, worst rate ${(maxRate * 100).toFixed(1)} %/s, ${mid} twilight samples`;
    });

    await step('Escape pauses with live world stats', async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(isActive('screen-pause'), null, { timeout: 4000 });
      const meta = await page.locator('#pause-meta').innerText();
      if (!/seed \d+/.test(meta) || !/mined \d+/.test(meta)) throw new Error('pause stats look wrong: ' + meta);
      await page.screenshot({ path: join(SHOTS, '04-pause.png') });
      return meta.replace(/\s+/g, ' ');
    });

    await step('Save writes the world to IndexedDB', async () => {
      await page.click('#btn-save');
      // wait for the *save* toast specifically, not any toast that happens to be on screen
      await page.waitForFunction(
        () => [...document.querySelectorAll('#toasts .toast')].some((t) => /sav/i.test(t.textContent ?? '')),
        null,
        { timeout: 15000 },
      );
      return (
        await page.evaluate(() =>
          [...document.querySelectorAll('#toasts .toast')]
            .map((t) => t.textContent?.trim())
            .find((t) => /sav/i.test(t ?? '')),
        )
      ).toString();
    });

    await step('quit returns to the world list with the saved world', async () => {
      await quitToWorldList(page);
      const n = await page.locator('#world-list .world-item').count();
      if (n < 1) throw new Error('world list is empty after saving');
      await page.screenshot({ path: join(SHOTS, '05-worlds.png') });
      return `${n} world slot(s)`;
    });

    await step('Play again reloads the world from IndexedDB', async () => {
      await clickWorldButton(page, 'Play', 0);
      await page.waitForFunction(() => !!window.webcraft?.game && !document.querySelector('.screen.active'), null, { timeout: 60000 });
      await worldLoaded(page);
      const g = await page.evaluate(() => {
        const G = window.webcraft.game;
        const p = G.player.pos;
        const cx = Math.floor(p.x);
        const cy = Math.floor(p.y);
        const cz = Math.floor(p.z);
        let dug = 0;
        let table = 0;
        for (let dx = -12; dx <= 12; dx++)
          for (let dy = -6; dy <= 12; dy++)
            for (let dz = -12; dz <= 12; dz++) {
              const id = G.world.getBlock(cx + dx, cy + dy, cz + dz);
              if (id === 0 && dy <= 0) dug++;
              if (id === 20) table++;
            }
        return {
          seed: G.seed,
          mode: G.mode,
          logs: G.inventory.countItem(4),
          planks: G.inventory.countItem(5),
          mined: G.stats.blocksMined,
          dug,
          table,
          tableNear: G.nearCraftingTable(G.player.pos.x, G.player.pos.y, G.player.pos.z),
        };
      });
      check('seed survives the round-trip', g.seed === 1337, `seed=${g.seed}`);
      check('mining progress survives', g.mined > 0, `mined=${g.mined}`);
      check('crafted items survive in the inventory', g.logs > 0 || g.planks > 0, `logs=${g.logs} planks=${g.planks}`);
      check('the placed crafting table is still there', g.table > 0, `tables nearby=${g.table}`);
      check('the table still counts as a crafting surface', g.tableNear === true);
      await page.screenshot({ path: join(SHOTS, '06-reloaded.png') });
      return JSON.stringify(g);
    });

    // ------------------------------------------------------------ export / import (SV-5)
    let exportPath = null;
    await step('Export downloads a world file', async () => {
      await quitToWorldList(page);
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        clickWorldButton(page, 'Export'),
      ]);
      exportPath = join(tmp, download.suggestedFilename());
      await download.saveAs(exportPath);
      const text = readFileSync(exportPath, 'utf8');
      const file = JSON.parse(text);
      if (file.format !== 'webcraft-world') throw new Error('unexpected format tag: ' + file.format);
      if (file.seed !== 1337) throw new Error('seed changed on the way out: ' + file.seed);
      if (!file.checksum) throw new Error('export is missing its checksum');
      if (!Object.keys(file.data?.chunks ?? {}).length) throw new Error('export carries no chunk edits');
      return `${download.suggestedFilename()} · ${Math.round(text.length / 1024)} kB · ${Object.keys(file.data.chunks).length} edited chunks`;
    });

    await step('importing that file gives a playable world', async () => {
      const before = await page.locator('#world-list .world-item').count();
      await page.setInputFiles('#import-file', exportPath);
      try {
        await page.waitForFunction(
          (n) => document.querySelectorAll('#world-list .world-item').length > n,
          before,
          { timeout: 20000 },
        );
      } catch (e) {
        const toasts = await page.locator('#toasts').innerText().catch(() => '');
        throw new Error(`import did not add a slot (toasts: ${toasts.replace(/\s+/g, ' ').trim() || 'none'})`);
      }
      const after = await page.locator('#world-list .world-item').count();
      await clickWorldButton(page, 'Play', 0);
      await page.waitForFunction(() => !!window.webcraft?.game && !document.querySelector('.screen.active'), null, { timeout: 60000 });
      await worldLoaded(page);
      const g = await page.evaluate(() => {
        const G = window.webcraft.game;
        const p = G.player.pos;
        let table = 0;
        const [cx, cy, cz] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
        for (let dx = -12; dx <= 12; dx++)
          for (let dy = -6; dy <= 12; dy++)
            for (let dz = -12; dz <= 12; dz++) if (G.world.getBlock(cx + dx, cy + dy, cz + dz) === 20) table++;
        return { seed: G.seed, mined: G.stats.blocksMined, table };
      });
      check('imported world keeps the seed and progress', g.seed === 1337 && g.mined > 0, JSON.stringify(g));
      check('imported world replays the placed blocks', g.table > 0, `tables nearby=${g.table}`);
      return `${before} → ${after} slots, ${JSON.stringify(g)}`;
    });

    await step('delete removes a world slot (with confirm)', async () => {
      await quitToWorldList(page);
      const before = await page.locator('#world-list .world-item').count();
      await clickWorldButton(page, 'Delete', 0);
      await page.waitForFunction((n) => document.querySelectorAll('#world-list .world-item').length === n, before - 1, {
        timeout: 15000,
      });
      return `${before} → ${before - 1} slots`;
    });

    // ------------------------------------------------------------ creative sanity
    await step('creative mode: flight + instant break', async () => {
      if (!(await page.evaluate(isActive('screen-worlds')))) await page.click('#btn-worlds').catch(() => {});
      await startWorld(page, { name: 'Creative Check', seed: '2', mode: 'creative' });
      await worldLoaded(page);
      const fly = await page.evaluate(async () => {
        const g = window.webcraft.game;
        g.input.locked = true;
        g.player.flying = true;
        g.input.down.add('Space');
        const y0 = g.player.pos.y;
        await new Promise((r) => setTimeout(r, 700));
        g.input.down.delete('Space');
        const y1 = g.player.pos.y;
        g.input.mining = true;
        const t0 = Date.now();
        let broke = false;
        while (Date.now() - t0 < 3000) {
          await new Promise((r) => setTimeout(r, 100));
          if (g.inventory.serialize().filter((s) => s).length > 0) {
            broke = true;
            break;
          }
        }
        g.input.mining = false;
        return { rose: y1 - y0, broke, mode: g.mode };
      });
      check('creative player rises when flying', fly.rose > 0.4, `Δy=${fly.rose.toFixed(2)}`);
      check('creative mode is reported by the game', fly.mode === 'creative');
    });

    // ------------------------------------------------------------ settings UI
    await step('pause → settings exposes sliders and applies them live', async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(isActive('screen-pause'), null, { timeout: 5000 });
      await page.click('#btn-pause-settings');
      await page.waitForFunction(isActive('screen-settings'), null, { timeout: 5000 });
      const fields = await page.evaluate(() => ({
        ranges: document.querySelectorAll('#settings-fields input[type=range]').length,
        toggles: document.querySelectorAll('#settings-fields input[type=checkbox]').length,
      }));
      if (fields.ranges < 4 || fields.toggles < 4) throw new Error('settings form looks incomplete: ' + JSON.stringify(fields));
      const applied = await page.evaluate(async () => {
        const slider = document.querySelector('#settings-fields input[type=range]');
        const before = window.webcraft.game.hudModel().renderDistance;
        slider.value = String(Math.max(4, Number(slider.min)));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        return { before, after: window.webcraft.game.hudModel().renderDistance };
      });
      check('moving a slider updates the live game', applied.after <= applied.before, JSON.stringify(applied));
      await page.screenshot({ path: join(SHOTS, '07-settings.png') });
      return `${fields.ranges} sliders, ${fields.toggles} toggles`;
    });

    // UI-6 regression: the goal card used to be permanently bolted to the bottom-left, over the world.
    // It must step aside by itself, and come back when it is actually relevant.
    // UI-6 regression: the goal card used to be bolted to the bottom-left for the whole session, over
    // the world. It must step aside on its own and come back only when it is relevant (new goal,
    // achievement, just closed a panel, or the player asked for it with Tab).
    await step('the goal card steps aside and returns when relevant (UI-6)', async () => {
      const card = () =>
        page.evaluate(() => {
          const t = document.getElementById('milestone-tracker');
          return {
            hidden: t.classList.contains('hidden'),
            faded: t.classList.contains('faded'),
            opacity: Number(getComputedStyle(t).opacity),
            screen: window.webcraft?.game?.screen,
          };
        });
      const panelOpen = `(() => !!document.querySelector('#panel-inventory.active'))()`;
      const inPlay = `(() => window.webcraft?.game?.screen === 'none')()`;
      const stages = {};
      const stage = async (name, fn) => {
        try {
          const v = await fn();
          stages[name] = v === undefined ? 'ok' : v;
          return v;
        } catch (e) {
          const where = await page.evaluate(() => ({
            screen: window.webcraft?.game?.screen,
            panel: !!document.querySelector('#panel-inventory.active'),
            active: [...document.querySelectorAll('.active')].map((n) => n.id).join(','),
            card: (() => { const t = document.getElementById('milestone-tracker'); return { faded: t.classList.contains('faded'), opacity: getComputedStyle(t).opacity }; })(),
          })).catch(() => ({}));
          throw new Error(`at stage '${name}' (${JSON.stringify(stages)}, state ${JSON.stringify(where)}): ${e?.message ?? e}`);
        }
      };
      // Drive the game into the play state directly: whatever the previous step left open is not this
      // step's business.
      await stage('ensure-play', async () => {
        await page.evaluate(() => window.webcraft.game.setScreen('none'));
        await page.waitForFunction(inPlay, null, { timeout: 8000 });
        await page.mouse.click(500, 300); // click back in, the way a player would
      });
      await page.waitForTimeout(400);
      stages.onResume = await card();
      if (stages.onResume.faded) throw new Error('no goal card after resuming — the player cannot see what to work towards');
      await page.waitForTimeout(14000);
      stages.idle = await card();
      if (!stages.idle.faded || stages.idle.opacity > 0.05)
        throw new Error(`the card never stepped aside (faded=${stages.idle.faded}, opacity=${stages.idle.opacity})`);
      await stage('open-inventory', async () => {
        await page.keyboard.press('KeyE');
        await page.waitForFunction(panelOpen, null, { timeout: 5000 });
      });
      await stage('close-inventory', async () => {
        await page.keyboard.press('KeyE');
        await page.waitForFunction(`(() => !document.querySelector('#panel-inventory.active'))()`, null, { timeout: 5000 });
        await page.waitForFunction(inPlay, null, { timeout: 5000 });
      });
      await page.waitForTimeout(600);
      stages.afterPanel = await card();
      if (stages.afterPanel.faded) throw new Error('closing the inventory did not bring the goal card back');
      await page.keyboard.press('Tab');
      await page.waitForTimeout(600);
      if (await page.evaluate(() => document.getElementById('milestone-tracker').classList.contains('faded')))
        throw new Error('Tab did not pin the goal card');
      await page.waitForTimeout(4000); // well past the 4 s it may linger once unpinned
      if (await page.evaluate(() => document.getElementById('milestone-tracker').classList.contains('faded')))
        throw new Error('a pinned goal card faded out anyway');
      await page.keyboard.press('Tab');
      await page.waitForTimeout(5200);
      stages.afterUnpin = await card();
      if (!stages.afterUnpin.faded) throw new Error('Tab did not hand the goal card back to the fade');
      return 'up on resume → gone after 14 s → back after a panel → pinned by Tab → faded again';
    });

    await step('no slot or cursor ghost shows an item it does not hold (UI-7)', async () => {
      // The report: after crafting and dragging stacks, icons appeared in empty slots and followed the
      // cursor — painted canvases that no longer matched the model. Two structural fixes: a slot commits
      // its cache stamp only after a successful paint (and clears itself when empty), and the stack that
      // rides the cursor is re-synced from the model every tick instead of on change events. On top of
      // that the panel verifies its own pixels when it opens (InventoryUI.auditPainting) — so prove the
      // guard works instead of assuming the bug is gone.
      await page.keyboard.press('KeyE');
      await page.waitForFunction(isActive('panel-inventory'), null, { timeout: 5000 });
      const clean = await page.evaluate(() => window.webcraft.auditUI());
      check('every slot paints the item it holds', clean === 'all slots paint their own item', clean);

      // Sabotage the first main-inventory slot regardless of what it holds: paint it solid magenta and
      // force the canvas visible. That is precisely the reported artefact — art that does not belong to
      // the slot — and it works whether the slot holds an item or nothing at all.
      const sabotage = await page.evaluate(() => {
        const slot = document.querySelector('#inv-main .slot canvas');
        if (!slot) return null;
        const ctx = slot.getContext('2d');
        ctx.fillStyle = '#f0f';
        ctx.fillRect(0, 0, slot.width, slot.height);
        slot.style.visibility = 'visible';
        return slot.width + 'px slot canvas painted solid magenta';
      });
      if (!sabotage) throw new Error('no slot canvas in #inv-main to sabotage');
      const caught = await page.evaluate(() => window.webcraft.auditUI());
      check('a stale canvas is detected', /stale/.test(caught), sabotage + ' -> caught');
      const repaired = await page.evaluate(() => window.webcraft.auditUI());
      check('and repainted from the model on the spot', repaired === 'all slots paint their own item', repaired);

      // The cursor stack is the other half of the report: paint it, empty the model without telling the
      // UI, and the frame-synced ghost must still disappear.
      const ghost = await page.evaluate(async () => {
        const g = window.webcraft.game;
        const first = g.inventory.main.find((s) => s);
        g.inventory.cursor = { id: first ? first.id : 1, count: 3 };
        await new Promise((r) => setTimeout(r, 260)); // one HUD tick
        const riding = !document.getElementById('cursor-stack').classList.contains('hidden');
        g.inventory.cursor = null; // the path that used to be able to leave a ghost behind
        await new Promise((r) => setTimeout(r, 260));
        const still = !document.getElementById('cursor-stack').classList.contains('hidden');
        const canvas = document.querySelector('#cursor-stack canvas');
        const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) ink++;
        return { riding, still, ink };
      });
      check('the stack under the cursor appears when it should', ghost.riding, JSON.stringify(ghost));
      check('and vanishes, pixels and all, when the model is empty', !ghost.still && ghost.ink === 0, JSON.stringify(ghost));

      await page.keyboard.press('KeyE');
      await page.waitForFunction(() => !document.querySelector('#panel-inventory.active'), null, { timeout: 4000 });
      return 'audit clean; a magenta-painted slot was caught and repainted; cursor ghost cleared';
    });

    // ------------------------------------------------------------ console hygiene
    const hard = [...pageErrors, ...consoleErrors.filter((t) => !/WebGL|GPU stall|Autoplay|favicon/i.test(t))];
    check('no uncaught browser errors during the tour', hard.length === 0, hard.slice(0, 4).join(' | '));
  } catch (e) {
    failures.push(`unexpected exception: ${e?.message ?? e}`);
    await page.screenshot({ path: join(SHOTS, 'FAIL.png') }).catch(() => {});
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  log('');
  const failed = results.filter(([good]) => !good);
  log(`${results.length - failed.length}/${results.length} smoke checks passed`);
  if (failed.length) {
    log('\nfailures:');
    for (const [good, name] of failed) if (!good) log('  - ' + name);
    if (pageErrors.length) log('\npage errors:\n' + pageErrors.map((e) => '  - ' + e).join('\n'));
    if (consoleErrors.length) log('\nconsole errors:\n' + consoleErrors.map((e) => '  - ' + e).join('\n'));
    process.exitCode = 1;
  } else if (pageErrors.length) {
    log(`\npage errors (${pageErrors.length}): ${pageErrors.join(' | ')}`);
    process.exitCode = 1;
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'webcraft-smoke-'));
main().catch((e) => {
  log('harness failure: ' + (e?.stack ?? e));
  process.exit(1);
});
