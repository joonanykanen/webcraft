// What does a mob's face actually look like on screen? Saves one large crop per species so a human can
// read it: muzzle, nostrils, eye whites — and whether they are the right way up.
//
// Deliberately statistics-free. An earlier version of this script tried to decide orientation by
// correlating the rendered head against the atlas tile's luminance profile; it was fragile in practice
// (pose drift, occlusion, shading, band alignment) and once printed "UPRIGHT" for a visibly inverted cow,
// which is worse than no test at all. Orientation of atlas art on block faces is asserted numerically
// where it can be — smoke's RD-3 step samples a real grass face, and tests/uv-orientation.test.ts pins the
// mesher/shader convention — and this script exists for the questions only a screenshot can settle.
//
//   npx vite build && node scripts/probe-mobface.mjs        (needs: npx vite preview --port 4173)
//   ENGINE=webkit node scripts/probe-mobface.mjs
import { chromium, webkit } from 'playwright-core';

const ENGINE = process.env.ENGINE ?? 'chrome';
const KINDS = process.env.KINDS ? process.env.KINDS.split(',') : ['pig', 'cow', 'sheep', 'zombie'];
const browser = await (ENGINE === 'webkit' ? webkit : chromium).launch({
  executablePath: ENGINE === 'webkit' ? undefined : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 560 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForFunction(() => !!document.querySelector('#screen-main.active'), null, { timeout: 20000 });
// Which build is this? Read it before believing anything about a bug report: the same issue has been filed
// more than once against a stale dist/ served on another port.
console.log('build:', await page.textContent('#build-stamp'));
await page.click('#btn-worlds');
await page.fill('#new-seed', 'face-probe');
await page.click('#btn-create');
await page.waitForFunction(() => !!window.webcraft?.game && !document.querySelector('.screen.active'), null, {
  timeout: 60000,
});
await page.waitForFunction(
  () => window.webcraft.game.renderer.info().drawCalls > 6 && window.webcraft.game.world.chunks.size > 20,
  null,
  { timeout: 60000 },
);

for (const kind of KINDS) {
  // Pose, mob and camera all in the same tick as the screenshot: setting them in an earlier call lets the
  // simulation move the player in between, and the crop lands on the floor instead of the face.
  const box = await page.evaluate(async (k) => {
    const g = window.webcraft.game;
    const B = window.webcraft.BlockId;
    g.setScreen('none');
    // The hotbar sits exactly where a low head lands; take the HUD out of the frame.
    document.getElementById('hud')?.classList.add('hidden');
    g.setTimeOfDay(0.25);
    g.input.setActive(false);
    g.mobs.clear();
    g.player.flying = true;
    g.player.onGround = false;
    g.player.vel = { x: 0, y: 0, z: 0 };
    const o = { x: Math.floor(g.player.pos.x), y: Math.floor(g.player.pos.y), z: Math.floor(g.player.pos.z) };
    for (let dx = -5; dx <= 5; dx++)
      for (let dz = -5; dz <= 4; dz++)
        for (let dy = -3; dy <= 6; dy++) g.world.setBlock(o.x + dx, o.y + dy, o.z + dz, dy < 0 ? B.STONE : 0);
    const mob = g.mobs.spawn(k, { x: o.x + 0.5, y: o.y, z: o.z }, g);
    mob.vel = { x: 0, y: 0, z: 0 };
    // The art lives on the cube's local -z face, and the camera sits at +z: yaw 0 would show the back of
    // the skull (a black box with two ear patches, which is what this script kept measuring). Half a turn
    // puts the painted face towards the camera.
    mob.yaw = Math.PI;
    g.player.pos = { x: o.x + 0.5, y: o.y + 1.05, z: o.z + 2.3 };

    const head = () => {
      mob.object.updateMatrixWorld(true);
      mob.vel = { x: 0, y: 0, z: 0 };
      mob.yaw = Math.PI;
      mob.walk = 0;
      let best = null;
      for (const child of mob.object.children) {
        if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
        const b = child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld);
        if (!best || b.max.y > best.max.y) best = b;
      }
      return best;
    };

    const project = (x, y, z) => {
      const V = g.renderer.camera.matrixWorldInverse.elements;
      const P = g.renderer.camera.projectionMatrix.elements;
      const mv = (m, px, py, pz) => [
        m[0] * px + m[4] * py + m[8] * pz + m[12],
        m[1] * px + m[5] * py + m[9] * pz + m[13],
        m[2] * px + m[6] * py + m[10] * pz + m[14],
        m[3] * px + m[7] * py + m[11] * pz + m[15],
      ];
      const v = mv(V, x, y, z);
      const c = mv(P, v[0], v[1], v[2]);
      const w = c[3] || 1;
      return [((c[0] / w + 1) / 2) * 800, ((1 - c[1] / w) / 2) * 560];
    };

    const step = async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    };

    // Telephoto, re-applied every round: the game recomputes fov each frame for the sprint kick.
    for (let i = 0; i < 4; i++) {
      const b = head();
      const cy = (b.min.y + b.max.y) / 2;
      const target = [
        (b.min.x + b.max.x) / 2,
        cy,
        (b.min.z + b.max.z) / 2,
      ];
      const d = target[2] - g.player.pos.z;
      g.player.yaw = Math.atan2(-(target[0] - g.player.pos.x), -d);
      // Aim slightly under the head: the game recomputes fov each frame (sprint kick), so the only way to
      // get the whole head clear of the hotbar is to place it above the frame's centre line.
      g.player.pitch = Math.atan2(target[1] - g.player.pos.y, Math.abs(d)) - 0.16;
      g.renderer.camera.fov = 20;
      g.renderer.camera.updateProjectionMatrix();
      await step();
    }
    const b = head();
    const pts = [];
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1])
          pts.push(project(b.min.x + (sx + 1) * 0.5 * (b.max.x - b.min.x), b.min.y + (sy + 1) * 0.5 * (b.max.y - b.min.y), b.min.z + (sz + 1) * 0.5 * (b.max.z - b.min.z)));
    const x0 = Math.min(...pts.map((p) => p[0]));
    const x1 = Math.max(...pts.map((p) => p[0]));
    const y0 = Math.min(...pts.map((p) => p[1]));
    const y1 = Math.max(...pts.map((p) => p[1]));
    return { box: [x0, y0, x1, y1], headTop: +b.max.y.toFixed(2), headBottom: +b.min.y.toFixed(2), fov: g.renderer.camera.fov };
  }, kind);

  const pad = 14;
  const clip = {
    x: Math.max(0, Math.round(box.box[0] - pad)),
    y: Math.max(0, Math.round(box.box[1] - pad)),
    width: Math.max(24, Math.min(800, Math.round(box.box[2] - box.box[0] + pad * 2))),
    height: Math.max(24, Math.min(560, Math.round(box.box[3] - box.box[1] + pad * 2))),
  };
  const shot = `smoke/face-${ENGINE}-${kind}.png`;
  if (clip.y + clip.height > 560) clip.y = Math.max(0, 560 - clip.height - 1);
  await page.screenshot({ path: shot, clip });
  console.log(
    `${kind.padEnd(7)} head y ${box.headBottom}…${box.headTop} · crop ${clip.width}x${clip.height} at ${clip.x},${clip.y} · fov ${box.fov} → ${shot}`,
  );
}
await browser.close();
if (errors.length) {
  console.log('errors: ' + errors.join('; '));
  process.exit(1);
}
