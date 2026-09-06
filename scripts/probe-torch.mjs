/** Probe: are torches drawn? Places a torch row in front of the player and inspects geometry + atlas. */
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const PORT = 4391;
const BASE = `http://localhost:${PORT}`;
const OUT = 'smoke';
mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const stop = () => {
  try {
    server.kill('SIGKILL');
  } catch {}
};
process.on('exit', stop);
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`${BASE}/`);
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('favicon') && errors.push(m.text()));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-worlds');
await page.waitForSelector('#screen-worlds.active', { timeout: 10000 });
await page.fill('#new-name', 'Torch probe');
await page.fill('#new-seed', 'torchprobe');
await page.click('#btn-create');
await page.waitForFunction(
  () => !!window.webcraft?.game && !document.querySelector('.screen.active'),
  null,
  { timeout: 90000 },
);
await page.mouse.click(450, 300);
await page.waitForFunction(
  () => {
    const g = window.webcraft?.game;
    return !!g && g.renderer.info().drawCalls > 6 && g.world.chunks.size > 20;
  },
  null,
  { timeout: 120000 },
);

const g = (body) => page.evaluate(`(() => { const g = window.webcraft.game; ${body} })()`);

// ---- atlas: dump the torch tile straight out of the live GPU texture's source canvas ----
const atlasDump = await g(`
  const tex = g.renderer.uniforms.uMap.value;
  const src = tex.image;
  const ctx2 = src.getContext('2d');
  const T = window.webcraft.TILE.TORCH;
  const col = T % 8, row = (T / 8) | 0;
  const d = ctx2.getImageData(col * 16, row * 16, 16, 16).data;
  const rows = [];
  let opaque = 0;
  for (let y = 0; y < 16; y++) {
    let s = '';
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      const a = d[i + 3];
      if (a > 200) { opaque++; s += '#'; }
      else if (a > 0) s += '+';
      else s += '.';
    }
    rows.push(s);
  }
  return { tile: T, opaque, rows };
`);
console.log(`== atlas tile ${atlasDump.tile} (${atlasDump.opaque} opaque px) ==`);
atlasDump.rows.forEach((r, i) => console.log(`  ${String(i).padStart(2)} ${r}`));

// ---- stamp a row of torches on the ground ----
const placed = await g(`
  const p = g.player.pos;
  const out = [];
  const B = window.webcraft.BlockId;
  const bx = Math.floor(p.x), bz = Math.floor(p.z);
  const column = [];
  for (let d = 2; d <= 5; d++) {
    const x = bx - d, z = bz;
    let y = -1;
    for (let yy = Math.floor(p.y) + 8; yy >= Math.floor(p.y) - 8; yy--) {
      if (g.world.getBlock(x, yy, z) === 0 && g.world.getBlock(x, yy - 1, z) !== 0) { y = yy; break; }
    }
    if (y < 0) { column.push([x, z, 'no spot']); continue; }
    const prev = g.world.getBlock(x, y, z);
    const code = g.world.setBlock(x, y, z, B.TORCH);
    out.push({ x, y, z, prev, below: g.world.getBlock(x, y - 1, z), after: g.world.getBlock(x, y, z), code });
  }
  g.player.mode = 'creative';
  g.player.flying = true;
  g.player.yaw = Math.PI / 2;   // look along -X
  g.player.pitch = -0.05;
  return { out, column, ground: g.world.getBlock(bx, Math.floor(p.y) - 1, bz), feet: g.world.getBlock(bx, Math.floor(p.y), bz), p };
`);
console.log('== placed torches ==', JSON.stringify(placed));
await page.waitForTimeout(3000);

const info = await g(`
  const B = window.webcraft.BlockId, T = window.webcraft.TILE.TORCH;
  let vox = 0;
  const p = g.player.pos;
  for (let d = -10; d <= 10; d++) for (let e = -10; e <= 10; e++)
    for (let y = Math.floor(p.y) - 6; y < Math.floor(p.y) + 6; y++)
      if (g.world.getBlock(Math.floor(p.x) + d, y, Math.floor(p.z) + e) === B.TORCH) vox++;
  let torchVerts = 0, chunkMeshes = 0, torchTris = 0;
  const samples = [];
  g.renderer.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes?.aTile) return;
    chunkMeshes++;
    const t = o.geometry.attributes.aTile;
    for (let i = 0; i < t.count; i++)
      if (t.getX(i) === T) {
        torchVerts++;
        if (samples.length < 8) {
          const pos = o.geometry.attributes.position, uv = o.geometry.attributes.uv ?? o.geometry.attributes.aUV;
          const lg = o.geometry.attributes.aLight, tn = o.geometry.attributes.aTint;
          samples.push({
            p: [pos.getX(i), pos.getY(i), pos.getZ(i)],
            uv: [uv.getX(i), uv.getY(i)],
            light: [lg.getX(i), lg.getY(i)],
            tint: tn.getX(i),
            visible: o.visible,
          });
        }
      }
  });
  return { vox, chunkMeshes, torchVerts, samples };
`);
console.log('== world/geometry ==', JSON.stringify(info, null, 1));

await page.screenshot({ path: `${OUT}/torch-row.png` });

if (placed.out.length) {
  const [t] = placed.out;
  await g(`
    const t = ${JSON.stringify(t)};
    g.player.pos.x = t.x + 2.2; g.player.pos.y = t.y + 0.2; g.player.pos.z = t.z + 0.4;
    if (g.player.vel) { g.player.vel.x = 0; g.player.vel.y = 0; g.player.vel.z = 0; }
    g.player.yaw = Math.PI / 2; g.player.pitch = -0.55;
  `);
  await page.waitForTimeout(1200);
  const pix = await page.evaluate(`(async () => {
    const g = window.webcraft.game;
    const raf = (n) => new Promise((res) => { let k = 0; const t = () => (++k >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
    const t = ${JSON.stringify(t)};
    await raf(20);
    const cam = g.renderer.camera;
    const gl = g.renderer.three.getContext();
    const V = cam.position.constructor;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const proj = (x, y, z) => { const v = new V(x, y, z).project(cam); return { x: (v.x * .5 + .5) * W, yGl: (v.y * .5 + .5) * H }; };
    const c = proj(t.x + 0.5, t.y + 0.5, t.z + 0.5);
    const n = 48;
    const buf = new Uint8Array(4 * n * n);
    gl.readPixels(Math.round(c.x - n / 2), Math.round(c.yGl - n / 2), n, n, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let notGrass = 0, torchLike = 0;
    const hist = {};
    const sample = [];
    for (let i = 0; i < n * n; i++) {
      const r = buf[i * 4], gg = buf[i * 4 + 1], b = buf[i * 4 + 2];
      const grass = gg > r + 5 && gg > b + 3;
      if (!grass) notGrass++;
      if (r > gg && gg >= b && r > 60) torchLike++;
      const k = r > gg + 10 ? 'warm' : grass ? 'grass' : 'other';
      hist[k] = (hist[k] || 0) + 1;
      if (sample.length < 10 && !grass) sample.push([r, gg, b]);
    }
    return { c: { x: Math.round(c.x), y: Math.round(c.yGl) }, notGrass, torchLike, hist, sample };
  })()`);
  console.log('== pixels at the torch cell ==', JSON.stringify(pix));
  await page.screenshot({ path: `${OUT}/torch-closeup.png`, clip: { x: Math.max(0, pix.c.x - 120), y: Math.max(0, 600 - pix.c.y - 120), width: 240, height: 240 } });
  await page.screenshot({ path: `${OUT}/torch-full.png` });
}

console.log('errors', errors.slice(0, 5));
await browser.close();
