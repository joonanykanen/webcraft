/**
 * Captures the README hero shot.
 *
 * Nothing in smoke/ was *framed* — those are debug artifacts at whatever size a probe happened to
 * need, most with an F3 overlay and a toast in the corner. This drives the same production build
 * through the same path a player uses (menu → create world → stream chunks), then stages a camera:
 * the terrain is scored from the world generator before anything is rendered, so the vantage is
 * chosen rather than stumbled on, and the light is pinned to the moment the sun is still above the
 * water.
 *
 *   npm run build                      # it photographs dist/, not a dev overlay
 *   node scripts/hero.mjs search                    # score terrain, sweep headings → smoke/hero-*.png
 *   node scripts/hero.mjs final <seed> <yaw>        # re-shoot one framing full-size, HUD on + off
 *
 * Two facts about the light this depends on (both read out of the source, not guessed):
 *   · dayNightCurve uses elev = sin(2πt) with 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight.
 *     0.75 — a tempting "golden hour" number — is midnight.
 *   · the sun sits at (cos 2πt, elev, 0.28), so at t≈0.47 it is toward −X/+Z, which for the player's
 *     forward = (−sin yaw, ·, −cos yaw) means yaw ≈ 1.84 rad to have it in frame.
 * The clock advances every frame (a cycle is 10 real minutes, so 1 % of t is 6 s), which is why the
 * pin is re-applied right up to the pixel — drift of 15 s is 2.5 % of the cycle and visibly darker.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 4417);
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'smoke');
mkdirSync(OUT, { recursive: true });
const MODE = process.argv[2] ?? 'search';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const GOLDEN = 0.49; // elev = sin(2π·0.49) ≈ 0.03: the sun sitting *on* the water, deepest orange
/** Which light to shoot. TIME=0.49 (default) is sunset; TIME=0.2 is bright mid-morning, which is
 *  the framing that shows biome variety — dusk washes everything toward one warm tone. */
const TIME = Number(process.env.TIME ?? GOLDEN);
const SUN_YAW = 1.84; // heading that puts the setting sun in frame (see header)
const SEEDS = ['webcraft', 'long-dusk', 'saltvale', 'highlands'];
const SCAN_RADIUS = 1700; // blocks around spawn to score
const LIFT = 22; // hover height above the vantage column

const cfg = MODE === 'final'
  ? { width: 1600, height: 900, dsf: 2, rd: 16, seeds: (process.argv[3] ?? 'webcraft').split(','), yaws: (process.argv[4] ?? String(SUN_YAW)).split(',').map(Number) }
  : { width: 960, height: 540, dsf: 1, rd: 14, seeds: SEEDS };

/**
 * How to stand. Height 14 sits in the canopy and reads like a view a player could actually reach;
 * 22 is the postcard. The hand is honest but a blue sleeve in the corner of a publicity frame is a
 * distraction, and the HUD is noise unless the point is "this is a game with hearts and a hotbar".
 */
const VARIANTS_ALL = [
  { tag: 'a', lift: 14, pitch: -0.08, hud: true, hand: true },
  { tag: 'b', lift: 14, pitch: -0.08, hud: true, hand: false },
  { tag: 'c', lift: 22, pitch: -0.08, hud: false, hand: false },
  { tag: 'd', lift: 14, pitch: -0.08, hud: false, hand: false },
];
/** VARIANTS=b,d picks a subset — a full-size frame costs a world's worth of meshing. */
const VARIANTS = (process.env.VARIANTS ?? 'a,b,c,d').split(',').map((t) => VARIANTS_ALL.find((v) => v.tag === t.trim()));

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[preview] ' + d));
const BASE = `http://localhost:${PORT}`;
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(BASE + '/')).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height }, deviceScaleFactor: cfg.dsf });
// Fancy quality = ambient occlusion on. maxChunksPerFrame is left modest so streaming does not
// stall the frame we are about to photograph.
await ctx.addInitScript((rd) => {
  localStorage.setItem('webcraft.settings', JSON.stringify({
    renderDistance: rd, fov: 74, sensitivity: 1, volume: 0, ambientVolume: 0,
    quality: 'fancy', invertY: false, lockMouse: true, showHand: true, fallDamage: true,
    showTouchControls: false, colorblindEdges: false, debugOverlay: false, maxChunksPerFrame: 6,
  }));
}, cfg.rd);

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).split('\n')[0]));
await page.goto(BASE, { waitUntil: 'networkidle' });

async function newWorld(seed) {
  // A fresh load lands on the main menu. There is no supported "drop this world, open the
  // browser-level world picker" from the page object, and re-loading is the same path a player
  // takes when they open the tab, so it tests more honestly than poking at menu internals.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-worlds');
  await page.waitForSelector('#screen-worlds.active', { timeout: 20000 });
  await page.fill('#new-name', 'Hero');
  await page.fill('#new-seed', seed);
  await page.click('#new-mode button[data-mode="creative"]');
  await page.click('#btn-create');
  await page.waitForFunction(() => {
    const g = window.webcraft?.game;
    return !!g && g.running && g.screen === 'none';
  }, null, { timeout: 180000 });
}

/**
 * Rank vantage points from the generator alone: heightAt/biomeAt fall back to pure worldgen for
 * unloaded columns, so this reads the whole map without meshing a single chunk. What makes a good
 * publicity frame is relief (something to look down on), water in view, green trees, and a drop
 * *along the sun ray* so the camera looks out over a coast instead of into a hillside.
 */
async function bestVantage() {
  return page.evaluate(({ R, sunYaw }) => {
    const g = window.webcraft.game;
    const w = g.world;
    const SEA = 32;
    const ox = Math.round(g.player.spawn.x), oz = Math.round(g.player.spawn.z);
    const step = 96;
    let best = null;
    for (let x = ox - R; x <= ox + R; x += step) {
      for (let z = oz - R; z <= oz + R; z += step) {
        const h = w.heightAt(x, z);
        if (h < SEA + 6) continue; // do not stand in the sea
        // local relief + how much of it is water, sampled on a ring
        let lo = 999, hi = -999, water = 0, green = 0, alpine = 0, n = 0;
        for (let a = 0; a < 8; a++) {
          for (const d of [80, 170, 260]) {
            const bx = x + Math.cos((a / 8) * 6.283) * d, bz = z + Math.sin((a / 8) * 6.283) * d;
            const bh = w.heightAt(bx, bz);
            lo = Math.min(lo, bh); hi = Math.max(hi, bh);
            if (bh <= SEA) water++;
            const b = w.biomeAt(bx, bz);
            if (b === 2 || b === 3) green++; // plains, forest
            if (b === 5 || b === 6) alpine++; // mountains, snow — peaks in the distance
            n++;
          }
        }
        // drop along the heading we would be shooting
        let along = 0, m = 0;
        for (const d of [120, 200, 280]) {
          along += h - w.heightAt(x - Math.sin(sunYaw) * d, z - Math.cos(sunYaw) * d); m++;
        }
        const relief = hi - lo;
        // Relief carries the frame: a 40-block drop in front of the camera is what reads as depth.
        // Water is worth having (it catches the light) but a vantage that is mostly sea looks like a
        // dome of fog from 22 blocks up, so both are bonuses inside a band and penalties outside it.
        // Penalising rather than skipping keeps a ranking even on a seed with no ideal vantage.
        const wf = water / n, gf = green / n, af = alpine / n;
        let score = relief * 1.1 + (1 - Math.abs(wf - 0.3) * 2) * 60 + gf * 70 + af * 90 + Math.max(0, along / m) * 1.5;
        if (relief < 34) score -= (34 - relief) * 4;
        if (wf < 0.05) score -= 60;
        if (wf > 0.6) score -= (wf - 0.6) * 200;
        if (!best || score > best.score) best = { x, z, h, score: +score.toFixed(1), relief, water: +wf.toFixed(2), green: +gf.toFixed(2), alpine: +af.toFixed(2) };
      }
    }
    return best;
  }, { R: SCAN_RADIUS, sunYaw: SUN_YAW });
}

/** Hover the camera over a column, pinned to golden hour, with the world fully streamed and lit. */
async function stage(v, yaw, pitch = -0.08, lift = LIFT) {
  const out = await page.evaluate(async ({ v, yaw, pitch, t, lift }) => {
    const g = window.webcraft.game;
    const p = g.player;
    p.mode = 'creative';
    p.teleport({ x: v.x, y: v.h + lift, z: v.z });
    p.flying = true;
    p.yaw = yaw;
    p.pitch = pitch;
    g.setTimeOfDay(t);
    for (let i = 0; i < 600; i++) { // stream → light → mesh, then the queue has to drain
      g.setTimeOfDay(t);
      await new Promise((r) => requestAnimationFrame(r));
      if (g.world.stats.genQueue === 0 && g.world.stats.dirty === 0) break;
    }
    for (let i = 0; i < 25; i++) { g.setTimeOfDay(t); await new Promise((r) => requestAnimationFrame(r)); }
    return { chunks: g.world.chunks.size, t: +g.timeOfDay.toFixed(3) };
  }, { v, yaw, pitch, t: TIME, lift });
  return out;
}

/** Chrome a player stops seeing and a hero frame cannot afford: crosshair, toasts, goal card, F3. */
async function stripChrome({ hud = false } = {}) {
  await page.evaluate((hideHud) => {
    for (const id of ['debug', 'toasts', 'milestone-tracker', 'tooltip', 'cursor-stack', 'touch-ui', 'crosshair']) {
      const n = document.getElementById(id);
      if (n) n.style.display = 'none';
    }
    document.getElementById('hud').style.display = hideHud ? 'none' : '';
  }, hud);
}

const table = [];
for (const seed of cfg.seeds) {
  await newWorld(seed);
  const v = await bestVantage();
  console.log(`\n${seed}: vantage (${v.x}, ${v.z}) h=${v.h} score=${v.score} relief=${v.relief} water=${v.water} green=${v.green} alpine=${v.alpine}`);
  // The sun heading first, then what is to either side of it, then behind: six framings of one place.
  const headings = MODE === 'final' ? cfg.yaws : [SUN_YAW, SUN_YAW - 0.55, SUN_YAW + 0.55, SUN_YAW - 1.1, SUN_YAW + 1.1, SUN_YAW + Math.PI];
  for (const yaw of headings) {
    for (const v2 of MODE === 'final' ? VARIANTS : [{ tag: 's', lift: LIFT, pitch: -0.08, hud: true, hand: true }]) {
      const st = await stage(v, yaw, v2.pitch, v2.lift);
      // The hand is a setting (it is drawn in the WebGL scene, not the DOM), the HUD is DOM.
      await page.evaluate((showHand) => {
        const g = window.webcraft.game;
        g.setSettings({ ...g.settings, showHand });
      }, v2.hand);
      await stripChrome({ hud: v2.hud ? false : true });
      const tag = `${seed}-${yaw.toFixed(2)}-t${TIME.toFixed(2)}-${v2.tag}`;
      const file = join(OUT, `hero-${tag}.png`);
      // Pin once more immediately before the capture: the clock runs, and the frame we photograph is
      // the frame we lit.
      await page.evaluate((t) => window.webcraft.game.setTimeOfDay(t), TIME);
      await page.screenshot({ path: file });
      table.push({ seed, yaw: +yaw.toFixed(3), variant: v2.tag, file: file.replace(ROOT + '/'), ...st, ...v });
      console.log(`  shot ${tag}  t=${st.t} chunks=${st.chunks}`);
    }
  }
}
writeFileSync(join(OUT, 'hero.json'), JSON.stringify(table, null, 2));
await browser.close();
server.kill('SIGTERM');
console.log(`\n${table.length} frames → ${OUT} (index: smoke/hero.json)`);
