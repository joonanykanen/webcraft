/**
 * Does the built game survive being served from a subpath? That is the one thing GitHub Pages
 * changes about the deployment: the site lives at /webcraft/, not at /, so every URL has to be
 * relative — the entry script, the stylesheet, and above all the chunk worker, which is resolved
 * from `import.meta.url` and will silently 404 on a wrongly-based build (the menu appears, the
 * world never generates, and nothing in the console says "path").
 *
 * So this does not read the bundle. It copies dist/ into a nested folder, serves it the way Pages
 * serves it, and *plays* it: load → create world → wait for the worker to fill the world and the
 * renderer to draw → save → reload → the world must still be there.
 *
 *   npm run build && node scripts/pages-check.mjs
 *   node scripts/pages-check.mjs https://joonanykanen.github.io/webcraft/ 16ed1d5
 *
 * With a URL it checks that deployment instead of a local copy — same checks, real network, and an
 * optional commit SHA to confirm the artifact being served was built from the commit you think it
 * was (the game prints its own build id, which is exactly why that stamp exists).
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4431;
const SUBPATH = 'webcraft'; // Pages serves a project site under /<repo>/
const ROOT = new URL('..', import.meta.url).pathname;
const REMOTE = process.argv[2] ?? null;
const EXPECT_SHA = process.argv[3] ?? null;
let BASE = REMOTE ? REMOTE.replace(/\/$/, '') + '/' : `http://localhost:${PORT}/${SUBPATH}/`;
let server = null;
let site = null;

if (REMOTE) {
  console.log(`checking the deployment at ${BASE}`);
} else if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
} else {
  // A nested directory, not the dist folder itself: the URL has to have path segments in it.
  site = mkdtempSync(join(tmpdir(), 'pages-sim-'));
  cpSync(join(ROOT, 'dist'), join(site, SUBPATH), { recursive: true });
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: site, stdio: ['ignore', 'ignore', 'ignore'],
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

// A 404 on the worker is the bug this exists to catch; it arrives as a failed request, not an error.
const missing = [];
const errors = [];
page.on('response', (r) => { if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => missing.push(`FAILED ${r.url()}`));
page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const results = [];
const check = (name, pass, info = '') => {
  results.push([name, pass, info]);
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${info ? ' — ' + info : ''}`);
};

console.log(`playing ${BASE}\n`);
await page.goto(BASE, { waitUntil: 'networkidle' });

const assetUrls = await page.evaluate(() => ({
  script: document.querySelector('script[src]')?.src,
  css: document.querySelector('link[rel=stylesheet]')?.href,
}));
check('entry script + CSS resolved under the subpath',
  assetUrls.script?.startsWith(`${BASE}assets/`) && assetUrls.css?.startsWith(`${BASE}assets/`),
  assetUrls.script ?? 'no script tag');

await page.waitForFunction(() => !!window.webcraft, null, { timeout: 30000 });
const menuActive = await page.evaluate(() => document.querySelector('#screen-main')?.classList.contains('active') ?? false);
check('main menu booted', menuActive);
if (EXPECT_SHA) {
  // The game prints which build it is for exactly this reason: "still broken" is answered by the
  // stamp before anything else is.
  const stamp = await page.evaluate(() => window.webcraft.build ?? '');
  check('the artifact being served was built from that commit', stamp.startsWith(EXPECT_SHA), stamp);
}
if (!menuActive) {
  // The capability probe has its own screen; if it fired, that is the whole answer.
  const unsupported = await page.evaluate(() => [...document.querySelectorAll('#support-list li')].map((n) => n.textContent));
  check('browser capability probe', false, unsupported.join(', ') || 'no menu, no probe screen');
}

await page.click('#btn-worlds');
await page.waitForSelector('#screen-worlds.active');
await page.fill('#new-name', 'Pages check');
await page.fill('#new-seed', 'pages');
await page.click('#btn-create');
await page.waitForFunction(() => {
  const g = window.webcraft?.game;
  return !!g && g.running && g.screen === 'none';
}, null, { timeout: 120000 });

// The worker is the thing a subpath breaks: chunks only exist if the worker module was fetched and
// answered. Meshes on top of that, so a partially working pipeline does not pass.
let chunks = 0, draws = 0;
for (let i = 0; i < 120 && chunks < 24; i++) {
  await page.waitForTimeout(500);
  ({ chunks, draws } = await page.evaluate(() => ({
    chunks: window.webcraft.game.world.chunks.size,
    draws: window.webcraft.game.renderer.info().drawCalls,
  })));
}
check('chunk worker loaded and generated the world', chunks >= 24, `${chunks} chunks`);
check('renderer is drawing the world', draws > 6, `${draws} draw calls`);

// Saves are IndexedDB, i.e. per-origin — and Pages is a different origin than localhost:5173.
await page.evaluate(async () => {
  const g = window.webcraft.game;
  g.player.mode = 'creative'; // no death, no hunger while the check runs
  await g.save(true);        // manual save: writes the slot to IndexedDB now
});
const saved = true;
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.webcraft, null, { timeout: 30000 });
await page.click('#btn-worlds');
await page.waitForSelector('#screen-worlds.active');
const listed = await page.locator('#world-list [data-name], #world-list .world-row, #world-list *').allInnerTexts();
check('world survived a reload (IndexedDB on the Pages origin)',
  saved && listed.join(' ').includes('Pages check'), listed.join(' ').split('\n').slice(0, 2).join(' / '));

check('nothing 404ed', missing.length === 0, missing.slice(0, 3).join(', '));
check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
if (server) server.kill('SIGTERM');
if (site) rmSync(site, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('a game served from a subpath is a different deployment than one served from / — fix the base before pushing to Pages');
process.exit(failed.length ? 1 : 0);
