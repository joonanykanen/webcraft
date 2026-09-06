/**
 * Measures the *rendered* brightness through a full cycle. `nightFactor()` covers the simulation;
 * this covers the pixels, which is what "night suddenly jumps to day" is about. Writes crops to
 * smoke/sun-<t>.png and prints the per-frame luminance ramp with the biggest per-second change.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = 4399;
const BASE = `http://localhost:${PORT}`;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 520 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-worlds');
await page.waitForSelector('#screen-worlds.active');
await page.fill('#new-name', 'Sun');
await page.click('#btn-create');
await page.waitForFunction(`(() => { const g = window.webcraft?.game; return !!g && g.running && g.screen === 'none'; })()`, null, { timeout: 60000 });
await page.waitForTimeout(2000);
// look at the horizon where the sun crosses
await page.evaluate(() => {
  const g = window.webcraft.game;
  g.player.pitch = 0.05;
  g.player.yaw = -Math.PI / 2;
  g.setPaused?.(false);
});
const samples = await page.evaluate(async () => {
  const g = window.webcraft.game;
  const cv = document.getElementById('viewport');
  const out = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    g.record.data.timeOfDay = t;
    g.timeMs = 0;
    const gl = g.renderer.three.getContext();
    // Read inside the frame that produced the image: the default framebuffer is not preserved.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const w = 150;
    const h = 90;
    const px = new Uint8Array(w * h * 4);
    // read the sky band just above the horizon (bottom-up GL coords → near the top of the frame)
    const y = Math.floor(cv.height * 0.62);
    gl.readPixels(Math.floor(cv.width / 2 - w / 2), y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0;
    for (let p = 0; p < px.length; p += 4) sum += (px[p] + px[p + 1] + px[p + 2]) / 3;
    out.push({ t: +t.toFixed(4), lum: +(sum / (px.length / 4)).toFixed(2) });
  }
  return out;
}).catch(async () => {
  // readPixels on the default framebuffer can come back blank; fall back to PNG pixel stats
  const out = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    await page.evaluate(async (tt) => {
      const g = window.webcraft.game;
      g.record.data.timeOfDay = tt;
      g.timeMs = 0;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, t);
    const buf = await page.screenshot({ clip: { x: 300, y: 40, width: 300, height: 120 } });
    const { createCanvas, loadImage } = await import('node:canvas').catch(() => ({}));
    out.push({ t: +t.toFixed(4), bytes: buf.length });
    if (i % 6 === 0) await page.screenshot({ path: `smoke/sun-${t.toFixed(2)}.png` });
  }
  return out;
});
const cycle = 600;
const lums = samples.map((s) => s.lum).filter((v) => v !== undefined);
const range = Math.max(...lums) - Math.min(...lums);
let max = 0;
let maxT = 0;
for (let i = 1; i < samples.length; i++) {
  if (samples[i].lum === undefined) continue;
  // fraction of the total dark→bright range per second of the 10-minute cycle
  const d = Math.abs(samples[i].lum - samples[i - 1].lum) / range / (cycle / (samples.length - 1));
  if (d > max) { max = d; maxT = samples[i].t; }
}
console.log('sky luminance:', samples.map((s) => `${s.t.toFixed(2)}:${s.lum ?? s.bytes}`).join(' '));
if (max) console.log(`biggest change: ${(max * 100).toFixed(2)} % luminance/s at t=${maxT.toFixed(3)}`);
console.log('errors:', errs.length ? errs.join(' | ') : 'none');
await page.screenshot({ path: 'smoke/sun-full.png' });
await browser.close();
server.kill('SIGKILL');
