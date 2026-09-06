# WebCraft

A voxel sandbox that runs in the browser — no install, no account, no downloads.
TypeScript + Three.js (WebGL2), procedurally generated everything: terrain, textures,
icons, sounds. One `npm run dev` and you are punching trees.

```
npm install
npm run dev        # http://localhost:5173
```

Production build (≈55 kB of app code gzipped + Three.js):

```
npm run build      # tsc --noEmit && vite build → dist/
npm run preview
```

---

## Controls

| Key / button | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Alt` + `W`, double-tap `W`, `Caps Lock`, or `Ctrl` + `W` | Sprint (uses more food). Four aliases because the classic combo is not portable: on macOS <kbd>Ctrl</kbd>+<kbd>Space</kbd> is the system input-source switcher (the page never sees it) and <kbd>Ctrl</kbd>+<kbd>W</kbd> can close a tab — see [Keyboard shortcuts that browsers keep](#keyboard-shortcuts-that-browsers-keep) |
| `Space` | Jump · swim upward · hold while flying to rise (120 ms input buffer + coyote time, so a fast tap is never lost) |
| `Space` ×2 | Toggle flight (creative only) |
| `Shift` | Sneak (will not walk off an edge) · hold while flying to descend |
| `Mouse` | Look around. Click the world to grab the cursor: it is locked to the window, so look never runs out and cannot be spoiled by a second monitor. Menus, dialogs and `Esc` give it back. Settings → *Lock mouse while playing* switches to a free-cursor fallback — see [Mouse capture](#mouse-capture) |
| **LMB** (hold) | Mine the block under the crosshair / attack a mob (the arm punches on every click, including into air) |
| **RMB** | Place the held block, open a chest/crafting table, eat |
| **MMB** | Pick block (creative) |
| `1`–`9`, wheel | Select hotbar slot |
| `E` | Inventory + crafting (2×2 by hand, 3×3 next to a crafting table) |
| `Q` | Drop the selected stack |
| `Esc` | Pause — one press. Press again to resume. Closes panels back to the screen they came from |
| `Esc` → *Milestones* | Progression chain (21 goals, from the first log to a pickaxe of gems) |
| `Tab` | Pin the next-goal card so it stops fading out; press again to let it fade. It appears on its own when a goal changes, a milestone unlocks, or a panel closes |
| `F3` | Debug overlay (FPS, chunk/mesh stats, light, target, look input sources, stats) |
| `F` | Toggle the held-item view model |
| `R` | Return to the spawn point (creative) |

Touch devices get a virtual stick plus mine/place/jump/sneak/fly buttons (settings →
`Touch controls`), and the whole UI is keyboard- and screen-reader-friendly
(focusable buttons, `role`/`aria-label` on slots, `prefers-reduced-motion` respected).

---

## What is in the box

| Area | Feature |
| --- | --- |
| World | Infinite 16×128×16 chunks, seeded; 7 biomes (ocean, beach, plains, forest, desert, mountains, snow); Perlin/FBM terrain, ridged mountains, cave/carver systems, 4 ore bands, water at y=32, trees/cacti/tall-grass decoration |
| Rendering | Face-culled chunk meshing with run-merging, per-corner ambient occlusion, 8×8 procedurally-drawn 16 px atlas, exponential-ish fog, 10-minute day/night cycle with sun, moon, stars and sky gradient, alpha-blended water with wave displacement, block particles, block highlight + crack overlay |
| Physics | AABB swept collision against the voxel grid, 1.25-block jump, step assist, sprint/sneak/swim/float, flight, fall damage (toggleable), void safety net |
| Interaction | DDA voxel raycast (5-block reach), per-block break times with tool tiers, drop tables with tier gating, placement validity (support, player/mob overlap), water-aware targeting |
| Inventory | 9-slot hotbar + 27 slots, 64-stack limit, drag/merge/split/shift-click quick-move, tool durability with a wear bar, creative fill, drop/pick-up entities |
| Crafting | 25 recipes (shapeless + shaped, trimmed matching), 2×2 hand grid, 3×3 table grid, recipe book with live craftability + filter |
| Survival | 10 hearts, 10 food points with saturation, regeneration when well fed, drowning with air bubbles, starvation, sprinting hunger, respawn at the spawn point |
| Light | Column sky light with translucent filtering (leaves/water), BFS torch flood-fill, packed nibble storage, incremental relight + seam propagation |
| Entities | Sand/gravel falling and re-placing, primed TNT with 3 s fuse, chain reactions, blast radius damage + drops + knockback, item drops with magnet pickup and expiry |
| Mobs | Pigs, cows, sheep by day on lit grass; zombies at night/in dark caves (they burn in sunlight), wander/chase/attack AI, hurt flashes, loot drops, caps (10 passive / 20 hostile / 64 total) and 128-block despawn |
| UI | Main menu, world slots (play/export/delete, thumbnails), settings, pause, death screen, toasts, HUD (hearts/food/air, hotbar, held item, next-goal tracker), milestone panel, F3 debug, colour-blind edge mode |
| Progression | 21 milestones in a dependency chain (first log → crafting table → tools → coal/iron/diamond, plus swimming, a first night, a first death and building goals), unlocked by observed stats, saved with the world, shown as a HUD tracker + a Minecraft-style panel |
| Save | IndexedDB slots (10), sparse per-chunk diffs (varint + RLE + base64), checksummed payload, schema migration, `.webcraft.json` export/import, 30 s autosave |
| Audio | 100 % synthesised: footsteps per surface, mining/breaking/placing, jump/land/splash, eat, mob sounds, explosion, ambient pad that follows night/water/depth |

Stretch goals (multiplayer, redstone, biomes-specific mobs, mod loading, smelting UI)
are deliberately **not** implemented.

---

## Architecture

```
src/
  core/         constants, deterministic RNG + hashing, Perlin/FBM/ridged noise, daynight.ts (the
                single day/night curve shared by the sky and gameplay), shared types
  world/        tiles · blocks · items · recipes · worldgen · chunk · lighting · mesher · raycast · world
  workers/      chunk.worker.ts (terrain generation off-thread) + pool.ts (job queue, transfers)
  render/       atlas.ts (procedural texture), shaders.ts, renderer.ts (Three.js scene/streams),
                geometry.ts (voxel cubes for mobs + view model), viewmodel.ts (first-person arm)
  game/         input · physics · player · inventory · crafting · mining · entities · mobs ·
                achievements.ts (milestones) · game.ts
  save/         codec.ts (RLE/varint/checksum/migration/export), idb.ts (IndexedDB slots)
  ui/           menus.ts (all screens), hud.ts, inventory.ts (panels), icons.ts, pips.ts
  audio/        audio.ts (WebAudio synth)
  main.ts       app shell: capability probe, world lifecycle, HUD/panel wiring, autosave hooks
```

Boundaries that matter:

* **`world/` knows nothing about Three.js or the DOM.** `World` emits `MeshData`
  (`TypedArray` bundles) through a `sink` callback; `render/renderer.ts` turns those into
  `BufferGeometry`. That is what makes the mesher and lighting unit-testable in Node.
* **`game/game.ts` is the only orchestrator.** It owns the fixed-timestep simulation
  (20 Hz sim steps inside a variable-rate render loop), the day/night clock, and the
  `EntityHost` interface that entities/mobs use to reach the world, audio, inventory and
  effects — so those systems can be tested with a stub host.
* **Generation is pure.** `generateChunk(seed, cx, cz, blocks, biome, height)` has no state
  beyond its arguments; the worker pool is only a scheduling optimisation, and the same
  function runs inline in tests (`SyncGenPool`).
* **`window.webcraft`** exposes the live `Game` for the console and the browser smoke test, plus
  `build` (git sha + dirty flag + build time, also printed on the title screen and in the F3 overlay),
  `TILE` (atlas indices) and `auditUI()`, which sweeps the open inventory and reports — and repairs —
  any slot whose canvas paints something other than the item the slot holds.

### Deterministic world generation

`hashInts(a,b,c,d,seed)` (integer avalanche) feeds a mulberry32 stream and a permutation-
based Perlin/FBM/ridged-noise stack. Generation paths never call `Math.random`.
Because of that a seed is the world: `tests/determinism.test.ts` regenerates chunks twice
and compares bytes, and guards three "golden" FNV hashes (seeds `1337`, chunks
`0,0 / -4,9 / 31,-12`) so any change to the generator is a deliberate, reviewed one.

### Meshing

One padded 18×130×18 scratch volume per chunk is refilled from the chunk plus its four
neighbours, so faces on chunk seams are culled correctly. For each face we walk the run of
identical cells along the face's `u` tangent (up to 16 in `fast`, 1 in `fancy` so AO can
vary per vertex), emit one quad per run, and skip a face when its predecessor along `u`
already owns the run — each merged strip is emitted exactly once. Vertex attributes are
`position`, `aUV`, `aTile`, `aLight` (sky, block; normalized bytes) and `aTint`
(directional shade × corner AO). Light lives in the vertices, so day/night needs no
remeshing. Water goes into a second, alpha-blended pass.

### Lighting

Sky light is column-based: 15 at open sky, minus 2 per translucent (leaves/water) block, 0
below anything opaque — sunlight therefore travels straight down a shaft undimmed, exactly
like the reference game's vertical rule. Block light is a BFS from emitters (torch = 14),
one level per air cell, blocked by solids, seeded from neighbour-chunk borders so light
crosses seams. Both channels share one byte per voxel (`sky<<4 | block`).

### Save format

```jsonc
{ "format": "webcraft-world", "version": 1, "id": "...", "name": "Smoke Test", "seed": 1337,
  "mode": "survival", "createdAt": …, "lastPlayed": 1712345678901, "playtimeMs": …,
  "thumbnail": "data:image/png;base64,...", "checksum": "0a1b2c3d", "data": {
    "version": 1, "timeOfDay": 0.19, "player": { pos, vel, yaw, pitch, health, food, … },
    "inventory": [ 9 hotbar + 27 main slots ], "selected": 0, "mobs": [ ... ],
    "stats": { "blocksMined": 42, "blocksPlaced": 7, "distance": 311 },
    "chunks": { "0,1": "base64(rle(varint(idx,id,…)))", "-4,9": "..." } } }
```

Only edited voxels are stored: per chunk a flat `[index, id, index, id, …]` list becomes
delta-flush varints, then a run-length pass, then base64 — a heavily played world typically
sits in the tens of kilobytes, and unedited chunks cost nothing. `checksum` is an FNV-1a
digest over the payload written by `worldToFile`; `fileToWorld` verifies it **before**
migration and refuses files without the `webcraft-world` tag, with a non-finite seed, or with a
broken checksum (the world list then labels the slot *recovered* and rebuilds defaults via
`migrateSave`). Older schema versions are filled in field-by-field on load; newer files
load with a warning instead of throwing. Autosave runs every 30 s, on pause-quit, and when
the tab is hidden.

### Performance notes

* Terrain generation runs in a worker pool (one worker per core, capped at 4, with
  `Transferable` buffers so nothing is copied). `SyncGenPool` implements the same interface
  inline, which is what the tests (and worker-less browsers) use.
* Mesh uploads per frame are limited by both a 5 ms budget (`MESH_BUDGET_MS`) and
  `settings.maxChunksPerFrame`; far chunks stay in the queue, and `F3` shows `q`/`dirty`.
* Lighting rebuilds are queued and time-sliced too; a chunk is relit at most once per frame.
* Chunks unload beyond `renderDistance + 2` and their geometry is disposed immediately.
* Mobs are voxel-cube assemblies reusing the chunk material, re-shaded only when their
  light changes; ≤64 of them, and `EntityManager.cullFar` drops distant entities.
* The HUD repaints on a 100 ms interval instead of per frame; icons and heart/air pip
  images are cached data URLs generated once.
* Measured by the browser smoke test in software WebGL (SwiftShader, no GPU, 1280×800,
  default settings): **45–48 fps** with ~380 chunks loaded and ~82 k triangles per frame.

---

## Testing

```
npm run test         # 217 vitest tests (14 files, ~11 s, Node environment)
npm run typecheck    # strict TS, noUnusedLocals/Parameters, verbatimModuleSyntax
npm run check        # typecheck + tests + production build
npm run smoke        # real Chrome end-to-end (see below)
npm run verify       # everything
```

| Suite | Covers |
| --- | --- |
| `tests/determinism.test.ts` | RNG/hash/noise reproducibility, byte-identical regeneration, golden chunk hashes (6 chunks), bedrock/sea-level/ore-band invariants, `findSpawn` standability |
| `tests/mesher.test.ts` | face-culling parity against a naive reference (single block, touching blocks, random blob, enclosed shell), run-merge area conservation, water layer separation, AO differs from flat shading, vertex light bytes, attribute/index/tile bounds |
| `tests/lighting.test.ts` | sky column rules, translucent filtering, torch falloff, light blocked by solids, chunk-seam spread, relight dirty reporting, nibble packing, border signatures, behaviour inside a generated world |
| `tests/save.test.ts` | varint/RLE/base64 round-trips and compression, sparse diff round-trip (all ids, negative chunk keys, last voxel), edit replay into fresh chunks, checksum tamper detection, schema migration, file export/import losslessness, corrupt-file rejection |
| `tests/physics.test.ts` | landing, no-tunnelling on huge steps, wall/ceiling stops, step assist, water detection, DDA raycast normals/reach/fluids, break times & drop-tier gating, placement rules |
| `tests/gameplay.test.ts` | inventory stack/merge/quick-move/swap, tool wear & break, food selection, save round-trip, crafting grids (shapeless, trimmed shaped, table gating, consumption, resize, drain), recipe registry integrity, block/item registry consistency |
| `tests/entities.test.ts` | explosion radius & witnesses, indestructible/fluid survival, TNT chaining and fuse, diff recording, gravity blocks and re-placing, drop pickup/expiry, mob caps/despawn/loot/chase/creative-immunity, day-vs-night spawn rules, sunburn, mob save round-trip |
| `tests/survival.test.ts` | fall/landing/jump/walk/sprint/sneak speeds, jump input buffering + coyote time, fall damage + water + creative immunity, flight gating, breath & drowning & refill, hunger/starvation/regeneration/eating, damage window, respawn, void safety net |
| `tests/worldgen-structure.test.ts` | trees actually grow trunks (no floating canopies), trunk columns are contiguous and stand on solid ground, no bare log tip pokes through a canopy, cacti on desert sand, all 7 biomes occur in sane shares, snow reaches the surface |
| `tests/input.test.ts` | capture with and without pointer lock, Escape always reaches the app, menu ownership clears held keys, look only while the world owns the mouse, identical look with/without LMB held, per-event clamp + NaN rejection + implausible coordinate jumps, sprint aliases (Ctrl, Alt, Caps Lock, double-tap W), jump buffering + stale-tap expiry, touch merge, wheel |
| `tests/milestones.test.ts` | unlock from observed play, quantity counting, requirement gating + retroactive unlock, the whole 21-goal chain is completable, save/load round-trip with unknown ids dropped, `warmUp` stays silent during load, definition integrity (unique ids, declared-before-used requirements, non-empty goals) |
| `tests/geometry.test.ts` | face/tile mapping incl. the dedicated front face, centred vs cell-aligned bounds, non-uniform scale, per-face tints, the entity V-flip (mob faces) and UV corners staying strictly inside the `fract()` range |
| `tests/daynight.test.ts` | the shared day/night curve: day and night plateaux, a monotone twilight band, the brightest change happening *while the sun is at the horizon* and never exceeding 2 %/s, agreement with `Game.nightFactor()`, and the `DayClock`: exact rate, wrap, garbage frames ignored, and pinning to "the current time" being a no-op (the autosave jump) |
| `tests/uv-orientation.test.ts` | the vertical UV convention: the highest vertex of every face and every hand-built cross quad (torch, plants) carries the largest `aUV.y`, and the shader mirrors inside the tile rather than flipping the atlas |

### Golden world hashes

World generation is fully deterministic, so six chunk hashes for seed 1337 are pinned in
`tests/determinism.test.ts`. They are a *change detector*, not a spec: when you change worldgen
on purpose the goldens move. Regenerate and commit them together with the reason —
`npx vite-node scripts/gengolden.ts` prints the block to paste in, and the comment above the map
documents why each refresh happened (existing saves keep their own edits and simply pick up the
new generation in chunks nobody touched).

### Browser smoke test

```
npm run smoke     # vite preview + real Chrome (66 checks, ~3 min)
npm run verify    # check + smoke
```

`scripts/smoke.mjs` serves the production build and drives **system Chrome** headless on
SwiftShader WebGL2 (`playwright-core`, no browser download). Every section is a step, so one
broken feature cannot cascade into the rest, and the run fails on any uncaught page error.
It covers: capability probe → world creation form → terrain streaming → HUD structure (hearts and
hunger measured flush against the hotbar, on one shared baseline) → **the projection matching the
canvas box at three different window sizes** (the aspect bug below was invisible in a single
screenshot) → the milestone tracker showing the next goal → the
milestone panel (21 cards, requirement gating, `Esc` back to the pause menu, a log mined unlocks
the first one) → live game state → trees near spawn have trunks →
`F3` overlay (>5 fps) → a mob spawned in front of the camera with finite transforms →
`W` locomotion → a real mouse move turning the camera (asserting the mouse was actually grabbed, and
that rad/px is the same with LMB held as free) → hold-LMB mining (polls for the
break, so it is not timing-fragile) → RMB placement + a planted crafting table → `E` panel
(9 + 27 slots, 2×2 or 3×3 depending on table range, 25-entry recipe book) → clicking a
recipe crafts it → torch block light (0 → 14) → pause stats → save → quit → **Play again**
(seed, mined count, inventory, dug cells, the placed table and `nearCraftingTable()` all
survive IndexedDB) → export to `.webcraft.json` → re-import and play the imported world →
delete a slot → creative flight + break → settings sliders applied to the live game → the
first-person arm actually changes the frame (screenshot diff with it hidden) + the arm root sits
in the bottom-right of camera space → losing the pointer pauses and `Resume` brings HUD + capture
back with a visible cursor in menus → `Escape` releases the mouse and pauses in one press (and a
later, separate `Escape` pauses again rather than being swallowed) → the night curve has a real
twilight band in the model **and** in the rendered pixels (sky luminance is read back with
`readPixels` across a whole cycle and required to change by under 3 % of its range per second).

The runner refuses to call a shrunken suite a pass: it fails if fewer than `MIN_CHECKS` checks ran. "N/N
passed" on its own is silent about the checks that never executed, and a scripted edit in this repo's own
history deleted four steps (F3 fps, mob geometry, walking, the sprint-jump input buffer) while everything
that remained went green.

**Always `npx vite build` before `npm run smoke`** — the suite serves `dist/`, so a stale build
produces a cascade of misleading failures (one broken frame-counter reset once produced 17/36).
`vite preview` also binds IPv6 only here, so probe scripts must use `http://localhost:PORT`,
not `127.0.0.1`.

**Look at the screenshots.** `smoke/*.png` are part of the test: assertions on numbers pass
while the frame is obviously wrong. More than a dozen real bugs were found that way — or by
probing something a screenshot raised — and all are now covered:

* light bytes uploaded as normalized ubytes while the mesher wrote 0–15 → the whole world
  rendered nearly black (now scaled by `LIGHT_BYTE`);
* `input.active` was never enabled when a world started → `E`/`Q`/digits did nothing;
* `input.consumeLook()` had no caller → the mouse never turned the camera;
* the tree decorator planted trunks at `h` instead of the surface block `h-1`, rejecting every
  in-chunk candidate → worlds had floating canopy plates and *no trunks at all* (plus a second
  off-by-one that poked a bare log tip through each crown), and the biome thresholds were
  unreachable, so Desert/Snow essentially never appeared;
* `World.heightAt(x, z)` indexed the column array with *fractional* coordinates, so a float
  position returned NaN. A NaN spawn height reached the mob's mesh matrix and rendered as a
  screen-filling garbage triangle. Accessors now floor their input and `MobManager.spawn`
  refuses non-finite positions;
* `voxelCubeGeometry` wrote UV corners of exactly 1.0, and the chunk vertex shader wraps `aUV`
  with `fract()` (greedy runs need the wrap) — every entity face therefore sampled one texel.
  Mobs were flat-coloured blobs and mob faces could not show eyes at all; corners now stop just
  inside the range (`UV_MAX`), covered by a unit test;
* the sun, moon and stars were drawn with `depthTest: false`, so at night the sky appeared *in
  front of* hills and trees;
* the camera kept `aspect = 1` — `Renderer.resize()` was only reachable from a `window resize`
  event or the settings panel, never from constructing the renderer — so every fresh world rendered
  ~75 % too wide on a normal window until you happened to resize it. Fixed by measuring the canvas'
  own CSS box (`Renderer.resize()` + a `ResizeObserver`) and pinned by a smoke step that checks the
  aspect at three window sizes. Reproduced in headless WebKit (`scripts/probe-aspect.mjs`), which is
  how a "Safari only" report turned out to be every engine;
* the day/night ramp was centred on the *bottom* of the sun's arc, so the world was 86 % bright
  before the sun cleared the horizon and the last 14 % — the part anyone notices — landed in a 30 s
  window at the wrap of the cycle: "night suddenly jumps to late morning". The ramp is now centred on
  the horizon (`smoothstep(-0.62, 0.5, elev)`), and a unit test asserts the steepest change is under
  2 %/s *and* happens near a horizon crossing;
* hearts and hunger sat on two rows with different baselines, so the HUD looked misaligned no matter
  how the widths lined up; they are one flex line now, and the smoke asserts the two rows share a
  top and bottom exactly and never overlap;
* **every tile was drawn vertically mirrored on blocks** — the grass fringe grew from the bottom of
  the dirt, a torch's flame sat at the base of the stick. The mesher gives `aUV.y = 1` to the top
  vertex of each face (cross blocks included, measured from the emitted geometry), the atlas art is
  painted top-down on a canvas, and the atlas was uploaded with `flipY = false` — so `v = 1` sampled
  the *bottom* row of the tile. Setting `flipY = true` is the obvious fix and it is wrong: the shader
  picks a tile as `(aTile % 8, floor(aTile / 8))`, a row counted down the canvas, so a whole-texture
  flip resolves every tile to its mirrored row (photographed: a magenta checkerboard). The mirror now
  happens inside the tile — `fv = (1.0 - aUV.y) * 0.9375 + 0.03125` — with the same 1/32 px inset that
  keeps `fract()` tiling from bleeding. Covered from both ends: `tests/uv-orientation.test.ts` on the
  geometry, and a smoke step that floats a grass block in open sky, projects its face to pixels and
  requires the top of it green and the bottom dirt; the entity/mob path is separate and unaffected;
* **the world clock jumped forward by the whole play session, once per autosave.** `timeOfDay` was
  computed as `record.data.timeOfDay + timeMs / DAY_LENGTH_MS` — reading the origin *live from the save
  record* — while `save()` writes the current `timeOfDay` into that record and `timeMs` keeps growing.
  Every 30 s (`AUTOSAVE_MS`) the origin moved to now and the clock leapt by the elapsed session: after
  five minutes that is half a cycle in one frame, which is exactly what "evening suddenly jumps a
  quarter of the way into the night, same for late-night to morning" described. My earlier day/night
  tests could not see it, because they *set* the time (i.e. they recreated the post-save state) instead
  of letting the clock run. The origin is now a private field behind `DayClock.advance()/pin()`;
  `Game.setTimeOfDay()` is the only way to move it, unit tests assert that pinning to the current time
  is a no-op, and a smoke step ages the session five minutes, saves, and requires the jump to be under
  0.2 % of a cycle;
* **the mouse really did get more sensitive while the left button was held, and the earlier "pointer
  lock" explanation was wrong.** `Menus.wireTouch()` installs a drag-to-look handler for touch screens;
  it was gated only on `input.touch.enabled` (which a touch-screen laptop, or Settings → *Touch
  controls*, turns on) and on `pointerdown` — i.e. it started on the mining click — and then integrated
  `clientX/clientY` deltas multiplied by 5 *as radians* (~286°/px) on top of `Input`'s own
  `movementX/movementY`. Measured with `scripts/probe-lookgain.mjs`: 0.0175 rad/px free, **0.0224 rad/px
  with LMB held**, plus 1000 rad of phantom `drag` input in one 200 px swipe. It now requires
  `pointerType === 'touch'`, refuses to run while pointer lock is held (a locked cursor has no
  `clientX` to integrate), uses the same `LOOK_PER_PIXEL * sensitivity` scale as the mouse and clamps
  per event; `Input` books every look contribution by source, `F3` shows `mouse … moves · rad · drag …
  rad`, touch UI auto-enables only on a genuinely coarse pointer (`matchMedia('(pointer: coarse)')`),
  and a smoke step asserts free-vs-held gain is identical with touch controls on and that a mouse
  pointer never feeds the drag source;
* `nightFactor()` (mob spawning/burning) used a different day/night ramp than the renderer's
  sky, so darkness snapped on while the sky still looked like sunset. Both read
  `core/daynight.ts` now, and the smoke test asserts the twilight band is gradual;
* the loading gate never pumped `world.update()`, so the bar stuck at ~17 % and the world then
  popped in fully meshed — progress now reflects chunks generated *and* meshed around spawn;
* resuming from pause never restored `playing`/the HUD (blank screen after a tab switch);
* the first-person arm was built *inside-out* — the skin segment was nearest the eye and the sleeve
  far away, so it read as a floating plank; the hand was then hidden entirely behind any held block,
  because the grip sat past a fist too small to poke out. The limb now runs elbow-near / hand-far,
  the fist is nearly as wide as a carried block and the grip overlaps the knuckles, so the skin stays
  in front of whatever is held. Held art is no longer skewed in 3D either: a 16 px sprite rotated in
  perspective staircases its own pixels (the pickaxe read as a broken zig-zag);
* mob heads rendered upside-down — **twice, the second time because of my own fix.** `voxelCubeGeometry`
  gives a face's top vertex `v = 1`, which on a `flipY = false` atlas samples the bottom of the tile, so
  mob faces originally needed a vertical flip in the geometry. Then RD-3 (below) added the mirror to the
  chunk *shader* instead — and mob cubes are drawn with that same material (`Renderer.entityCube()` reuses
  `opaqueMat`), so the geometry flip became a second mirror: muzzle on the forehead, eyes at the chin.
  `flipV` is gone; one mirror, in the shader, for everything that samples the atlas.
  The process lesson is in `scripts/probe-mobface.mjs`: an earlier version of that script "verified" the
  faces were upright by colour-classifying a 130 px crop, and the classification matched horn and sky
  pixels instead of eyes and muzzle. Orientation is now asserted where it can be asserted honestly — the
  mesher/shader pairing in `tests/uv-orientation.test.ts`, rendered block pixels in smoke RD-3 — and a
  screenshot of a whole head is what settles the mob question. Claims of "verified fixed" that are not
  backed by one of those two things are not verification;
* Escape needed double presses and the mouse felt "spiky" when a refocus delivered one huge delta —
  Pointer Lock is the primary path again (see [Mouse capture](#mouse-capture)), the cursor is
  re-centred under it so a second monitor cannot spoil the deltas, a single `mousemove` may never turn
  the camera further than `MAX_LOOK_PER_EVENT`, and movement inside `LOCK_SETTLE_MS` of the lock being
  granted is discarded (that is the re-centring warp, not the player);
* the next-goal card was bolted to the bottom-left for the entire session, covering the world. It now
  fades after `MILESTONE_FOCUS_MS` and comes back only when it is worth reading: the goal changed, a
  milestone unlocked, a panel closed (and picking up the 4th log of 12 is *not* a goal change), or the
  player presses `Tab` to pin it. One rule, driven from `onScreen()`, so no path can leave it stuck on;
* **ghost items in the inventory and under the cursor**: painted canvases that no longer matched the model.
  Slots committed their cache signature *before* drawing, so an icon that failed to draw was never drawn
  again and the slot kept showing whatever it held before; empty slots were hidden rather than cleared, so
  one stray `visibility: visible` re-exposed the old art. And the stack that rides the cursor was refreshed
  only on `onInventoryChanged`, while several paths move `inventory.cursor` directly (right-click split,
  taking a craft result, quick-move, dying, closing the panel with it in hand) — miss the notification and a
  crafted icon is glued to the pointer. Now: paint-then-commit, clear-when-empty, the cursor stack is
  re-synced from the model on every HUD tick, and the panel audits its own pixels when it opens
  (`webcraft.auditUI()`, asserted in smoke UI-7 by painting a slot solid magenta and requiring detection);
* **a stale build being debugged as a bug.** The title screen, the F3 overlay and `webcraft.build` now
  report the git sha, a dirty flag and the build time. That is not decoration: "still broken" reports have
  been traced to a `dist/` served from another port, and there was previously no way to tell in-game;
* passive mob heads were sunk *inside* their bodies (a cow's head occupied 0.89…1.35 while its body's top
  was 1.24, so the face was mostly buried), which is why screenshots read as a coloured block instead of
  an animal. Heads now sit on the body with a little overlap, like a neck;
* a non-finite `movementX` (the first event after a focus change) went straight into `Player.look`,
  making yaw/pitch NaN and therefore *every* coordinate NaN — an empty world. Input sanitises deltas
  and the player rejects non-finite look input.

Driving notes for whoever edits it next: the world owns the mouse through `Input.capture()` /
`release()` (`input.locked` means "the world has the cursor", not browser pointer lock), the test
sets `input.active` and the `mining`/`placing` flags directly, negative `player.pitch` looks *down*,
`BlockId.TORCH` is 18 and `BlockId.CRAFTING_TABLE` is 20, and the in-game state has no active
`.screen` element (use `window.webcraft.game` to detect play). Menu screens set
`input.expectUnlock` before taking the cursor, so an intentional hand-over is not mistaken for focus
loss and does not pause the world again. `document.pointerLockElement` is the truth about pointer
lock, and `input.usingLock` mirrors it; `input.locked` is broader — lock *or* fallback.

If the look ever feels wrong, `F3` answers it without a debugger: the `look` line prints how many
`mousemove` events arrived, how many radians they produced (`rad/move` — per *event*, and an event can
carry any number of pixels), and how much came from the touch drag source. The drag number must stay 0
under a mouse. `scripts/probe-lookgain.mjs` is the same question turned into a matrix: it dispatches
synthetic events with known pixel deltas and requires every cell — pointer lock or free cursor, touch
controls on or off, button held or not — to agree on radians-per-pixel within 15 %.

Synthetic events are *untrusted*, so they cannot exercise pointer lock. `probe-lookdrag.mjs` covers what
they cannot: real `mouse.down / mouse.move / mouse.up` through CDP and WebKit, comparing look gain while
the button is held against the same gesture free. The `look` line also splits by branch — how many events
were measured from `movementX/Y` versus `clientX/Y`, and how many frames had to be clamped. Look is capped
twice on purpose: `MAX_LOOK_PER_EVENT` rejects one absurd delta (a refocus warp), and `MAX_LOOK_PER_FRAME`
rejects a *pile* of ordinary ones, which is the other shape "sensitivity jumps while I hold the button" can
take — a hitch, a backgrounded tab, an engine that queues input while a button is down. Both discards are
counted, so a clamp hiding a real bug is itself visible.

One experiment in this area was wrong and is recorded as such: selecting the measurement source by capture
state ("locked means `movement`, free means `client`") was tried, and three existing tests failed
immediately — it throws away the exact measurement in the cursor-hidden fallback and makes the gain depend
on what an engine happens to fill in. `movementX/Y` is the measurement; `clientX/Y` is only a fallback for
events that carry none.

For anything the assertions cannot express — does the arm *look* right, is that pig's face upright,
are the hearts really flush with the hotbar — there are small one-purpose probes that boot
`vite preview`, drive the real page and write cropped PNGs into `smoke/` for a human to read:
`probe-visual2.mjs` (capture, HUD, punch, look, Esc, milestone panel, mining), `probe-hand.mjs`
(held empty hand / block / tool / food), `probe-mobface.mjs` (large crops of each mob's face, for the eye
check that statistics cannot replace), `probe-pips.mjs`
(HUD geometry at two viewport sizes, including whether the two rows really share a baseline),
`probe-orient.mjs` (a shelf of grass/log/torch/bench/furnace photographed close-up, to see whether
asymmetric tiles land the right way up on block faces), `probe-slots.mjs` (every inventory slot's box and its icon's
bounding box, at several viewport sizes and in both engines — the shape a "ghost item outside its slot"
report would leave behind), `probe-goals.mjs` (the next-goal card's
fade/return/pin cycle), `probe-polish.mjs` (full-screen HUD, punch, unlock toast, pause) and
`probe-lookgain.mjs`, which dispatches synthetic pointer+mouse events with *known* pixel deltas and
prints radians-per-pixel for every combination of pointer lock, free cursor, touch controls and
left-button-held — the matrix that found the sensitivity bug below. Run them after `npx vite build`
and open the images.

`probe-aspect.mjs` is the one that runs in **two engines** — Chrome and Playwright's WebKit, i.e.
Safari's layout engine (`npx playwright install webkit`) — and prints `camera.aspect` against the
canvas' CSS box plus how many screen pixels one world block spans horizontally vs vertically. That
combination is what catches a stretched frame, and it is how a Safari-only report was shown to be a
bug in every engine.

---

## Mouse capture

Clicking the world asks the browser for the cursor with the Pointer Lock API; every menu, panel,
dialog and `Esc` gives it back. Locking is the only model that survives the way people actually play:
two monitors, click-and-hold mining, dragging past the edge of the window. The old cursor-hidden
mode (raw `movementX/Y`, nothing grabbed) is still there as an automatic fallback when the request is
refused — and as a setting, *Lock mouse while playing*, for anyone who would rather keep the cursor.

Three things had to be true before locking could be the default, and all three are covered by tests:

* **One `Escape` still pauses.** The browser consumes the `Escape` that exits the lock and the page
  may or may not also see the keydown. `Game` records the pause caused by losing the mouse and
  ignores an `Escape` within 500 ms of it (`sameKeypressAsLockLoss()`), so the game can never toggle
  itself back out of the pause in the same key press — and a later, genuinely separate `Escape` still
  pauses again.
* **No sensitivity spike on lock.** Granting the lock re-centres the cursor, and that warp arrives
  as one enormous delta. `Input` drops movement for `LOCK_SETTLE_MS` after the grant and caps every
  event at `MAX_LOOK_PER_EVENT` (~20°). Holding the left mouse button changes nothing: the smoke
  suite measures rad/px with the button free and held and requires them to agree.
* **A refusal is not fatal.** `requestPointerLock()` can reject (wrong document state, a locked-down
  embedder). The promise is caught, `pointerlockerror` is handled, and a 400 ms watchdog drops to the
  cursor-hidden path, so the worst case is a playable game with a slightly different feel.

* **A lock that is not really holding is abandoned.** On macOS a pointer lock is implemented by hiding the
  cursor and pinning it. In some engines a button-held drag hands the mouse stream to the browser's own drag
  machinery, where that pinning and the raw-delta substitution stop applying — and the page is never told,
  because `pointerlockchange` stays quiet and `pointerLockElement` stays set. `movementX` becomes cursor
  travel with the OS's acceleration curve on it, accumulating, because nothing is recentring any more. That would
  explain the report — *"it doesn't matter what mouse button I press — RMB, MMB, whatever, even MOUSE4 and 5 — holding it down makes
  the sensitivity skyrocket"* — including why the buttons' bindings turned out to be irrelevant (the trigger is
  the press, not the action) and why nothing done to the numbers helped: **no ceiling applied to a lie feels
  right.** **Status: open.** Neither measure described below changed what the player experiences, and the
  affected browser's `F3` has not been captured since, so the mechanism above is a guarded hypothesis rather
  than a confirmed diagnosis. See *Known limits* for what to capture next time; Chrome is the reference for
  this game's mouse handling.

  So `Input` watches for the one thing that cannot happen under a real lock: the page's own coordinates advancing while the cursor is supposedly pinned.
  A *sustained run* of it (6 consecutive events) means the cursor is running; one large step does not, because
  browsers re-centre the cursor when the lock is granted, modals shift the page's coordinates, and a refocus
  hands the pointer back. On that verdict the game exits pointer lock, **stays in the world instead of pausing**
  (this is our correction, not the player's `Escape`), carries on with the cursor-hidden path, and does not ask
  for the lock again that session — while the setting is written off and a one-time toast says why, because a
  control feel that changes silently is a bug of its own. Turning *Lock mouse while playing* back on is allowed
  and re-arms the detection. The press also `preventDefault()`s now so the browser's drag/selection session —
  the reroute that starts the whole thing — never begins, and `#viewport` sets `-webkit-user-drag: none` for the
  same reason. Detection rather than user-agent sniffing, because it is a behaviour and not a version: Safari
  shows this, Chrome does not, and an engine that gets fixed in an update should stop degrading on its own.
  Smoke drives it deliberately (`a pointer lock that lets the cursor move is abandoned…`), since CI Chrome is
  not Safari: claim the lock, make the cursor run, then require that the lock is dropped, the world keeps
  playing, no pause happens, no further lock is requested, and F3 says which path is live.

While the world owns the cursor, `body.mouse-captured` hides it; on `window.blur` or `mouseleave`
`Input` clears every held key and stops actions, which is also what fixes the classic *"my player is
still sprinting after alt-tab"* bug. Chrome still paints its *"mouse pointer is now hidden"* notice
for a second or two on lock — that is the browser's, not the page's, and it is the reason the
setting exists.

## Keyboard shortcuts that browsers keep

The PRD asked for sprint on <kbd>Ctrl</kbd>+<kbd>Space</kbd>. **On macOS that combination is owned by
the system** (*Select Previous Input Source*), so the page never receives it — no web game can use
it, and remapping it is a system-settings change outside the game. <kbd>Ctrl</kbd>+<kbd>W</kbd> is
worse on macOS Chrome (it closes the tab). So sprint answers to four aliases, and the first two work
on every platform because they are page-side state only:

1. double-tap `W`;
2. `Caps Lock`;
3. `Alt`/`Option` + `W` (free on macOS; `Alt` combos are preventDefaulted elsewhere);
4. `Ctrl` + `W` (works on Windows/Linux, may be swallowed by the browser on macOS).

---

## Accessibility & preferences

Settings persist in `localStorage` under `webcraft.settings`: render distance, FOV, mouse
sensitivity (+ invert Y; the default is ~1°/px — `LOOK_PER_PIXEL = 0.0176`, doubled twice on
request from the original 0.0044), master/ambient volume,
quality (AO + greedy meshing on/off), fall damage, hand view, touch controls, colour-blind block
edges, debug overlay, and the per-frame chunk budget. Panels are real buttons/inputs
(tab-navigable, `aria-label`ed), the debug overlay is plain text for screen readers, milestone goals
are plain text in the panel, and `prefers-reduced-motion` disables HUD motion. If WebGL is
unavailable the app says exactly which capability was missing instead of showing a black canvas.

## Known limits

* Sky light is column-based (no horizontal sun spread), so caves need torches even next to
  an open shaft.
* No smelting/furnace: ore blocks drop their material directly (tier-gated).
* Blocks are unit cubes only — no slabs/stairs/fences, hence the 0.62-block step assist
  instead of full auto-step.
* Mobs do not path-find around obstacles; they walk, jump and bump like the reference game.
* Worlds are single-player and local; export (`*.webcraft.json`) is the only transfer path.
* **Pointer-lock look misbehaves in some non-Chrome browsers — open, workaround: play in Chrome.** Reported
  in Safari on macOS: while *any* mouse button is held — left, right, middle, even the mouse's back/forward
  buttons — look becomes wildly over-sensitive, and releasing the button puts it back. Chrome has never shown
  it, and the mouse handling here is tuned against Chrome. The candidate mechanism is that macOS pointer lock
  is implemented by hiding and pinning the cursor and substituting raw device deltas, and a button-held drag
  can move the mouse stream onto the browser's drag path, where that substitution stops applying — with the
  page never told, because `pointerlockchange` stays quiet and `pointerLockElement` stays set. Everything
  observable from the page then looks correct, down to radians-per-count, which equals the shipped constant by
  construction; that is why the two mitigations shipped here (`preventDefault()` on the press, so the browser's
  drag session never begins, and giving up on a lock that lets the cursor drift) changed nothing the player
  could feel. **The cause is therefore unconfirmed.** Leading explanations left: the engine inflating
  `movementX` even while it keeps the cursor pinned — invisible from the page, and beyond any clamp we own — or
  a pointer utility (SteadyMouse, Mos, LinearMouse, Logi Options) treating button-held drags differently. To
  pick it up again, capture from the misbehaving browser: `F3`'s `lock` row (`pointer lock held · drift 0px`
  alongside a reported spike means the inflation is upstream of anything observable, and the honest fix is then
  to not use pointer lock on that engine at all) and the `look` line — a rising `rad/move` proves the events
  themselves carry more counts. Settings → *Lock mouse while playing* off bypasses the grab entirely and is
  worth trying, though nobody has tested it against this report.

---

## How this was made

WebCraft was implemented end to end — world generation, meshing, lighting, physics, gameplay, UI,
procedural textures and audio, saves, tests and the browser smoke harness — by
[Intel/Qwen3.8-Flash-Next-W4A16-AutoRound](https://huggingface.co/Intel/Qwen3.8-Flash-Next-W4A16-AutoRound)
running in the [pi](https://pi.dev) coding-agent harness. Design direction, bug reports, playtest
verdicts and the "no, that is still wrong" callouts came from a human playing the game.

| | |
| --- | --- |
| Tokens used | ↑ 188 M prompt · ↓ 1.7 M completion |
| Average throughput | ~60 tok/s decode |
| What it produced | 12 commits, ~15.8 k lines of TypeScript, 217 unit tests, 35 real-browser smoke steps (66 checks) |

188 M input tokens is a lot for a project this size, and most of it went on verifying rather than
writing: build, run the game in a real browser, read the screenshots, run the suite again — plus two
long stretches spent on a mouse-look bug that turned out to live in another browser's pointer-lock
implementation and is still open (see *Known limits*). It is also worth recording that the failure
mode of an agent that edits by exact text splice is deleting code it did not mention: four smoke
steps and a helper function disappeared this way, which is why the suite now fails when fewer checks
run than it expects. Decode alone accounts for roughly 8 wall-clock hours at 60 tok/s.
