/** Global tuning constants (PRD: chunk 16×128×16, sea level y=32, 20 TPS, 10-min day). */

// ---- world / chunks (WG-1) ----
export const CHUNK_SX = 16;
export const CHUNK_SY = 128;
export const CHUNK_SZ = 16;
export const CHUNK_AREA = CHUNK_SX * CHUNK_SZ;
export const CHUNK_VOL = CHUNK_AREA * CHUNK_SY;
export const SEA_LEVEL = 32; // WG-6
export const WORLD_MIN_Y = 0;
export const WORLD_MAX_Y = CHUNK_SY - 1;

// ---- time ----
export const TICK_RATE = 20; // simulation ticks per second (Appendix A "Tick")
export const TICK_MS = 1000 / TICK_RATE;
export const DAY_LENGTH_MS = 10 * 60 * 1000; // RD-5: full cycle = 10 minutes

// ---- input ----
/**
 * Radians of look per raw mouse pixel at sensitivity 1.0 — about one degree per pixel, i.e. a
 * comfortable 90-degree turn in ~125 px. The settings slider multiplies this.
 */
export const LOOK_PER_PIXEL = 0.0176;
/**
 * One mousemove may never turn more than this (radians, ~20 degrees). Real events are a handful of
 * pixels, so this only ever fires on a synthetic/refocus jump — which is what used to read as the
 * sensitivity "rising" while the left mouse button was held.
 */
export const MAX_LOOK_PER_EVENT = 0.35;
/** After the browser grants pointer lock it re-centres the cursor; that warp is reported as one
 * enormous delta, so movement is ignored for this long. */
export const LOCK_SETTLE_MS = 150;
/** A coordinate jump larger than this between two events is the cursor teleporting (focus change,
 * another monitor), not the player moving the mouse. */
export const MAX_CLIENT_JUMP = 260;
/**
 * Cursor travel, in CSS px, that still counts as "the cursor is pinned" under pointer lock. Under a real
 * lock the pointer cannot move, so this stays at 0-1 (browsers occasionally re-report the same position a
 * pixel off). Anything beyond it while we believe we are locked means the browser is letting the cursor
 * run, and `movementX` is then accelerated cursor travel rather than device counts — see Input's fake-lock
 * detector and the `drift` figure on F3.
 */
export const LOCK_DRIFT_PX = 3;
/**
 * One frame may never turn the camera more than this (radians, ~29 degrees — 1 700 deg/s at 60 FPS).
 * `MAX_LOOK_PER_EVENT` guards a single event; this guards the *sum* of everything that arrived between
 * two frames, which is the number that decides what the player actually sees. It exists because the
 * look input can arrive from more than one measurement source and from coalesced bursts: when a browser
 * delivers three events of 300 px instead of sixty of 15 px (which is what happens while a button is
 * held and the frame loop is busy mining), each event passes the per-event cap and the frame still
 * rotates by a kilometre. A ceiling per frame turns that into "the flick saturated" instead of "the
 * camera is spinning", and the surplus is dropped rather than accumulated, so it can never come back as
 * a delayed lurch.
 */
export const MAX_LOOK_PER_FRAME = 0.5;

// ---- physics (PH-2, PH-3) ----
export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.62;
export const PLAYER_REACH = 5; // BI-1 max reach
export const GRAVITY = 32;
export const JUMP_SPEED = 9.0; // -> 1.266 block clearance (PH-2 ≈1.25)
export const JUMP_BUFFER_S = 0.12; // a jump tap stays "wanted" this long (60 Hz sampling)
export const COYOTE_S = 0.08; // grace period after walking off a ledge
export const TERMINAL_VELOCITY = 60;
export const WALK_SPEED = 4.317;
export const SPRINT_SPEED = 5.7;
export const SNEAK_SPEED = 1.45;
export const FLY_SPEED = 12;
export const FLY_SPRINT_SPEED = 26;
export const STEP_HEIGHT = 0.55; // auto step up onto 0.5-high ledges is handled as 1-block climb
export const FALL_SAFE_BLOCKS = 3; // PH-5
export const AIR_DRAIN = 0.5; // breath units per second while submerged → ~20 s of air (PH-4)
export const MOB_GRAVITY = 22;

// ---- lighting (AM-1) ----
export const MAX_LIGHT = 15;
export const TORCH_LIGHT = 14;
export const SKY_LIGHT = 15;

// ---- rendering (RD-*) ----
export const DEFAULT_RENDER_DISTANCE = 8; // chunks
export const MIN_RENDER_DISTANCE = 4; // SV-6
export const MAX_RENDER_DISTANCE = 16;
export const CHUNK_UNLOAD_MARGIN = 2; // evict beyond renderDistance + margin
export const ATLAS_TILES = 8; // 8×8 tile atlas
export const TILE_PX = 16; // RD-3
export const ATLAS_PX = ATLAS_TILES * TILE_PX;

// ---- gameplay ----
export const MAX_STACK = 64; // IN-2
export const HOTBAR_SLOTS = 9; // IN-1
export const INV_SLOTS = 27; // IN-1
export const INVENTORY_TOTAL = HOTBAR_SLOTS + INV_SLOTS;
export const MAX_HEARTS = 10;
export const MAX_FOOD = 10;
export const MAX_AIR = 10;
export const MAX_WORLD_SLOTS = 10; // SV-2 (min 5)
export const AUTOSAVE_MS = 30_000; // SV-1
/** How long the "next goal" card stays on screen before tucking itself away (UI-6). It comes back
 * when the goal changes, when a milestone unlocks, while a panel is open, and on Tab. */
export const MILESTONE_FOCUS_MS = 12_000;
export const SCHEMA_VERSION = 1;

// ---- budgets (§8.3) ----
export const MESH_BUDGET_MS = 5.0; // per frame, main-thread meshing
export const GEN_BATCH = 2; // ≤2 chunks generated per frame equivalent (concurrent worker jobs)
export const MAX_MOBS = 12;
/** Chunk radius that must be loaded *and meshed* before the player gets control (WG-6). */
export const READY_RADIUS = 3;

/** Pack a signed chunk coordinate pair into a single integer map key. */
export function chunkKey(cx: number, cz: number): number {
  return ((cx + 32768) << 16) | (cz + 32768);
}
export function keyToChunk(key: number): [number, number] {
  return [(key >>> 16) - 32768, (key & 0xffff) - 32768];
}
export function blockIndex(x: number, y: number, z: number): number {
  return (x * CHUNK_SZ + z) * CHUNK_SY + y;
}
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Hermite smoothstep: 0 at/below e0, 1 at/above e1, smooth in between. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}
