/**
 * Is the projection stretched? Compares the camera aspect with the canvas' CSS box and measures
 * how many screen pixels one world unit occupies horizontally vs vertically (must be ~1:1).
 * Runs in both engines: WebKit (Safari's engine, which reported the stretch) and Chrome.
 */
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';
const PORT = 4398;
const BASE = `http://localhost:${PORT}`;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

const probe = async (label, browser, opts) => {
  const page = await (await browser.newContext(opts)).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-worlds');
  await page.waitForSelector('#screen-worlds.active');
  await page.fill('#new-name', 'Aspect');
  await page.click('#btn-create');
  await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, { timeout: 60000 });
  await page.waitForTimeout(1800);
  const m = await page.evaluate(`(() => {
    const g = window.webcraft.game;
    const cv = document.getElementById('viewport');
    const box = cv.getBoundingClientRect();
    const cam = g.renderer.camera;
    const px = (v) => { const p = v.clone().project(cam); return [(p.x * 0.5 + 0.5) * box.width, (0.5 - p.y * 0.5) * box.height]; };
    // a 1x1 world square straight ahead: how many CSS px does one block span each way?
    const fwd = new (cam.position.constructor)();
    cam.getWorldDirection(fwd);
    const up = new (cam.position.constructor)(0, 1, 0);
    const right = new (cam.position.constructor)();
    right.crossVectors(up, fwd).normalize().multiplyScalar(-1);
    const o = cam.position.clone().addScaledVector(fwd, 8);
    const c = px(o);
    const cx = px(o.clone().addScaledVector(right, 1));
    const cy = px(o.clone().addScaledVector(up, 1));
    const db = g.renderer.three?.getDrawingBufferSize?.(new (cam.position.constructor)());
    return {
      dpr: window.devicePixelRatio,
      inner: [window.innerWidth, window.innerHeight],
      box: [Math.round(box.width), Math.round(box.height)],
      backing: [cv.width, cv.height],
      drawingBuffer: db ? [db.x, db.y] : null,
      css: [getComputedStyle(cv).width, getComputedStyle(cv).height, getComputedStyle(cv).position],
      camAspect: +cam.aspect.toFixed(4),
      boxAspect: +(box.width / box.height).toFixed(4),
      backingAspect: +(cv.width / cv.height).toFixed(4),
      pxPerBlock: [Math.hypot(cx[0] - c[0], cx[1] - c[1]).toFixed(2), Math.hypot(cx[0] - c[0] + (cy[0] - c[0]) * 0, cy[1] - c[1]).toFixed(2)],
      stretch: +(Math.hypot(cx[0] - c[0], cx[1] - c[1]) / Math.abs(cy[1] - c[1])).toFixed(3),
      fov: cam.fov,
    };
  })()`);
  await page.screenshot({ path: `smoke/aspect-${label}.png` });
  console.log(label.padEnd(7), JSON.stringify(m), errs.length ? 'ERRORS: ' + errs.join('|') : '');
  await page.close();
};

const chrome = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
await probe('chrome', chrome, { viewport: { width: 1336, height: 761 }, deviceScaleFactor: 2 });
await chrome.close();

const wk = await webkit.launch();
await probe('webkit', wk, { viewport: { width: 1336, height: 761 }, deviceScaleFactor: 2 });
await wk.close();
server.kill('SIGKILL');
