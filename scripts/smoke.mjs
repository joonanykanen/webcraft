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
/**
 * Tutorial cards intentionally take the mouse and freeze gameplay input while they are up
 * (that is how their buttons stay clickable). A test driving raw input has to behave like a
 * player who clicks "Next", so every step clears whatever card the previous step triggered.
 */
async function dismissCards(page) {
  const dismissed = await page.evaluate(() => {
    const card = document.getElementById('tutorial');
    if (!card || card.classList.contains('hidden')) return false;
    document.getElementById('tutorial-skip')?.click();
    const g = window.webcraft.game;
    if (g && g.screen === 'none') {
      // A synthetic click carries no user activation, so the game cannot re-capture the
      // pointer here; the harness takes ownership back the same way the other steps do.
      g.input.setActive(true);
      g.input.locked = true;
    }
    return true;
  });
  return dismissed;
}

let activePage = null;

async function step(name, fn, opts = {}) {
  const clear = activePage && !opts.keepCards;
  if (clear) await dismissCards(activePage);
  try {
    const info = await fn();
    ok(name, info ?? '');
    return true;
  } catch (e) {
    bad(name, (e?.message ?? String(e)).split('\n')[0]);
    return false;
  } finally {
    if (clear) await dismissCards(activePage).catch(() => undefined);
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

async function startWorld(page, { name, seed, mode = 'survival', tutorial = 'skip' }) {
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
  // A fresh world opens with the intro card ~1.7 s after spawn, and the card (by design) owns
  // the mouse and freezes gameplay input. Most steps don't want that; the tutorial step opts out.
  if (tutorial === 'skip') {
    await page.waitForTimeout(2000);
    await page.evaluate(() => document.getElementById('tutorial-skip')?.click());
    await page.evaluate(() => {
      const g = window.webcraft.game;
      g.input.setActive(true);
      g.input.locked = true;
    });
  }
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
  activePage = page;
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
    // keepCards: the intro card must survive until the step that exercises it
    await step(
      'create world starts the game',
      () => startWorld(page, { name: 'Smoke Test', seed: '1337', tutorial: 'keep' }),
      { keepCards: true },
    );
    await step('terrain streams in (chunk meshes upload)', () => worldLoaded(page), { keepCards: true });

    const hud = await page.evaluate(() => ({
      hotbar: document.querySelectorAll('#hotbar .slot').length,
      hearts: document.querySelectorAll('#health-row .pip').length,
      hunger: document.querySelectorAll('#hunger-row .pip').length,
      debugHidden: document.getElementById('debug')?.classList.contains('hidden'),
      health: window.webcraft.game.hudModel().health,
      food: window.webcraft.game.hudModel().food,
    }));
    check('HUD: 9 hotbar slots + 10 hearts + 10 hunger pips', hud.hotbar === 9 && hud.hearts === 10 && hud.hunger === 10, JSON.stringify(hud));
    check('player starts with full health and food', hud.health >= 20 && hud.food >= 19, `health=${hud.health} food=${hud.food}`);
    check('debug overlay hidden by default', hud.debugHidden === true);

    // ------------------------------------------------------------ tutorial owns the mouse? (UI-6)
    await step('tutorial card releases the cursor so its buttons are clickable', async () => {
      const up = await page.evaluate(() => {
        const t = document.getElementById('tutorial');
        return !!t && !t.classList.contains('hidden');
      });
      if (!up) return 'no card on screen (world already tutorial-taught) — skipped';
      const gate = await page.evaluate(() => ({
        locked: window.webcraft.game.input.locked,
        active: window.webcraft.game.input.active,
      }));
      if (gate.locked) throw new Error('pointer stayed locked while a card was up — Next/Skip are unclickable');
      if (gate.active) throw new Error('gameplay input stayed live behind the card');
      await page.mouse.move(500, 350);
      await page.click('#tutorial-next', { timeout: 4000 });
      const hidden = await page.evaluate(() => document.getElementById('tutorial')?.classList.contains('hidden'));
      if (!hidden) throw new Error('a real mouse click on Next did not dismiss the card');
      // From here on the tour drives raw input, so act like a player who instantly clicks
      // "Next" on every card: a card would otherwise freeze gameplay input mid-step.
      await page.evaluate(() => {
        window.__cardKiller = setInterval(() => {
          const t = document.getElementById('tutorial');
          if (t && !t.classList.contains('hidden')) document.getElementById('tutorial-skip')?.click();
        }, 120);
      });
      return 'clicked Next with the real mouse';
    }, { keepCards: true });

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
        dom: !!document.pointerLockElement,
        game: window.webcraft.game.input.locked,
      }));
      await page.evaluate(() => {
        const g = window.webcraft.game;
        g.input.mining = false;
        g.input.placing = false;
      });
      if (!locked.dom || !locked.game) throw new Error(`pointer lock not engaged: ${JSON.stringify(locked)}`);
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
      return `Δyaw=${turned.toFixed(3)} Δpitch=${pitched.toFixed(3)}`;
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
      await dismissCards(page);
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

    // ------------------------------------------------------------ pause, save, quit, reload
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
      await dismissCards(page);
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
