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
| `Ctrl` + `W`, double-tap `W`, or `Caps Lock` | Sprint (uses more food). `Caps Lock` exists because macOS binds <kbd>Ctrl</kbd>+<kbd>Space</kbd> to input switching, and `Ctrl`+`W` closes the tab on Windows/Linux |
| `Space` | Jump · swim upward · hold while flying to rise (120 ms input buffer + coyote time, so a fast tap is never lost) |
| `Space` ×2 | Toggle flight (creative only) |
| `Shift` | Sneak (will not walk off an edge) · hold while flying to descend |
| `Mouse` | Look around (pointer lock; click the world to capture the mouse) |
| **LMB** (hold) | Mine the block under the crosshair / attack a mob |
| **RMB** | Place the held block, open a chest/crafting table, eat |
| **MMB** | Pick block (creative) |
| `1`–`9`, wheel | Select hotbar slot |
| `E` | Inventory + crafting (2×2 by hand, 3×3 next to a crafting table) |
| `Q` | Drop the selected stack |
| `Esc` | Pause (also releases the mouse); closes panels |
| `Enter` / `Esc` | Tutorial card: next step / dismiss (the card releases the mouse so its buttons are clickable) |
| `F3` | Debug overlay (FPS, chunk/mesh stats, light, target, stats) |
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
| UI | Main menu, world slots (play/export/delete, thumbnails), settings, pause, death screen, tutorial cards, toasts, HUD (hearts/food/air, hotbar, held item), F3 debug, colour-blind edge mode |
| Save | IndexedDB slots (10), sparse per-chunk diffs (varint + RLE + base64), checksummed payload, schema migration, `.webcraft.json` export/import, 30 s autosave |
| Audio | 100 % synthesised: footsteps per surface, mining/breaking/placing, jump/land/splash, eat, mob sounds, explosion, ambient pad that follows night/water/depth |

Stretch goals (multiplayer, redstone, biomes-specific mobs, mod loading, smelting UI)
are deliberately **not** implemented.

---

## Architecture

```
src/
  core/         constants, deterministic RNG + hashing, Perlin/FBM/ridged noise, shared types
  world/        tiles · blocks · items · recipes · worldgen · chunk · lighting · mesher · raycast · world
  workers/      chunk.worker.ts (terrain generation off-thread) + pool.ts (job queue, transfers)
  render/       atlas.ts (procedural texture), shaders.ts, renderer.ts (Three.js scene/streams), geometry.ts
  game/         input · physics · player · inventory · crafting · mining · entities · mobs · game.ts
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
* **`window.webcraft`** exposes the live `Game` for the console and the browser smoke test.

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
npm run test         # 170 vitest tests (12 files, ~10 s, Node environment)
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

### Golden world hashes

World generation is fully deterministic, so six chunk hashes for seed 1337 are pinned in
`tests/determinism.test.ts`. They are a *change detector*, not a spec: when you change worldgen
on purpose the goldens move. Regenerate and commit them together with the reason —
`npx vite-node scripts/gengolden.ts` prints the block to paste in, and the comment above the map
documents why each refresh happened (existing saves keep their own edits and simply pick up the
new generation in chunks nobody touched).

### Browser smoke test

```
npm run smoke     # vite preview + real Chrome (50 checks, ~2 min)
npm run verify    # check + smoke
```

`scripts/smoke.mjs` serves the production build and drives **system Chrome** headless on
SwiftShader WebGL2 (`playwright-core`, no browser download). Every section is a step, so one
broken feature cannot cascade into the rest, and the run fails on any uncaught page error.
It covers: capability probe → world creation form → terrain streaming → the tutorial card
releasing the cursor → HUD structure → live game state → trees near spawn have trunks →
`F3` overlay (>5 fps) → a mob spawned in front of the camera with finite transforms →
`W` locomotion → a real mouse move turning the camera → hold-LMB mining (polls for the
break, so it is not timing-fragile) → RMB placement + a planted crafting table → `E` panel
(9 + 27 slots, 2×2 or 3×3 depending on table range, 25-entry recipe book) → clicking a
recipe crafts it → torch block light (0 → 14) → pause stats → save → quit → **Play again**
(seed, mined count, inventory, dug cells, the placed table and `nearCraftingTable()` all
survive IndexedDB) → export to `.webcraft.json` → re-import and play the imported world →
delete a slot → creative flight + break → settings sliders applied to the live game → the
first-person arm actually changes the frame (screenshot diff with it hidden) → losing the pointer
pauses and `Resume` brings HUD + capture back → the night curve has a real twilight band.

**Always `npx vite build` before `npm run smoke`** — the suite serves `dist/`, so a stale build
produces a cascade of misleading failures (one broken frame-counter reset once produced 17/36).
`vite preview` also binds IPv6 only here, so probe scripts must use `http://localhost:PORT`,
not `127.0.0.1`.

**Look at the screenshots.** `smoke/*.png` are part of the test: assertions on numbers pass
while the frame is obviously wrong. Five real bugs were found that way or by probing what a
screenshot raised, and all are now covered:

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
* `nightFactor()` (mob spawning/burning) used a different day/night ramp than the renderer's
  sky, so darkness snapped on while the sky still looked like sunset. Both read
  `core/daynight.ts` now, and the smoke test asserts the twilight band is gradual;
* the loading gate never pumped `world.update()`, so the bar stuck at ~17 % and the world then
  popped in fully meshed — progress now reflects chunks generated *and* meshed around spawn;
* resuming from pause never restored `playing`/the HUD (blank screen after a tab switch), and a
  pointer-lock request that landed *after* the tutorial card opened captured the mouse behind the
  card — `Input.uiCapture` plus `releaseOnGrantUntil` makes a grant that is no longer wanted
  hand the cursor straight back.

Driving notes for whoever edits it next: gameplay is pointer-lock-free (the test sets
`input.locked`/`input.active` and the held `mining`/`placing` flags), negative `player.pitch`
looks *down*, `BlockId.TORCH` is 18 and `BlockId.CRAFTING_TABLE` is 20, and the in-game state
has no active `.screen` element (use `window.webcraft.game` to detect play). The tutorial card
captures the mouse and freezes input by design, so `startWorld()` dismisses it and
`dismissCards()` clears any card that pops mid-run (it also restores `locked`/`active`, because
a synthetic click carries no user activation and the browser will not re-enter pointer lock).

---

## Accessibility & preferences

Settings persist in `localStorage` under `webcraft.settings`: render distance, FOV, mouse
sensitivity (+ invert Y), master/ambient volume, quality (AO + greedy meshing on/off),
fall damage, hand view, touch controls, colour-blind block edges, debug overlay, and the
per-frame chunk budget. Panels are real buttons/inputs (tab-navigable, `aria-label`ed), the
debug overlay is plain text for screen readers, tutorial cards can always be skipped, and
`prefers-reduced-motion` disables HUD motion. If WebGL is unavailable the app says exactly
which capability was missing instead of showing a black canvas.

## Known limits

* Sky light is column-based (no horizontal sun spread), so caves need torches even next to
  an open shaft.
* No smelting/furnace: ore blocks drop their material directly (tier-gated).
* Blocks are unit cubes only — no slabs/stairs/fences, hence the 0.62-block step assist
  instead of full auto-step.
* Mobs do not path-find around obstacles; they walk, jump and bump like the reference game.
* Worlds are single-player and local; export (`*.webcraft.json`) is the only transfer path.
