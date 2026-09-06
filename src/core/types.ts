/** Shared types across world / render / ui / save layers. */

export type GameMode = 'survival' | 'creative';

export type BiomeId = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const BIOME_NAMES = ['Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Mountains', 'Snow'] as const;
export const BIOME_COLORS = ['#2f6fb0', '#dccf94', '#79b34a', '#3f7d3a', '#dcc069', '#8d8f93', '#eef4fb'];

export interface ItemStack {
  /** Item or block id (see blocks.ts / items.ts). 0 = empty. */
  id: number;
  count: number;
  /** Tools only: 0 hand · 1 wood · 2 stone · 3 iron · 4 gem. */
  durabilityLeft?: number;
}

export type Slot = ItemStack | null;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayerState {
  pos: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  food: number;
  saturation: number;
  air: number;
  onGround: boolean;
  flying: boolean;
  spawn: Vec3;
  deaths: number;
}

export interface Settings {
  renderDistance: number; // 4..16 chunks (SV-6)
  fov: number; // 60..100
  sensitivity: number; // 0.2..3
  volume: number; // 0..1
  ambientVolume: number; // 0..1
  quality: 'fancy' | 'fast'; // AO on/off + greedy meshing
  invertY: boolean;
  /** Grab the cursor with the Pointer Lock API (default). Off = cursor-hidden fallback. */
  lockMouse: boolean;
  showHand: boolean;
  fallDamage: boolean; // PH-5 toggleable
  showTouchControls: boolean;
  colorblindEdges: boolean; // §9 accessibility
  debugOverlay: boolean; // F3 debug text (UI-5)
  maxChunksPerFrame: number;
}

export const DEFAULT_SETTINGS: Settings = {
  renderDistance: 8,
  fov: 75,
  sensitivity: 1,
  volume: 0.7,
  ambientVolume: 0.45,
  quality: 'fancy',
  invertY: false,
  lockMouse: true,
  showHand: true,
  fallDamage: true,
  showTouchControls: false,
  colorblindEdges: false,
  debugOverlay: false,
  maxChunksPerFrame: 2,
};

/** One record in the world list (SV-2). */
export interface WorldRecord {
  id: string;
  name: string;
  seed: number;
  seedLabel: string;
  mode: GameMode;
  difficulty?: 'peaceful' | 'normal';
  deaths?: number;
  version: number;
  createdAt: number;
  lastPlayed: number;
  playtimeMs: number;
  thumbnail: string; // data URL
  data: SaveData;
  checksum: string;
}

export interface MobState {
  id: number;
  kind: string;
  pos: Vec3;
  yaw: number;
  hp: number;
}

/** Payload of a save (SV-1 / SV-3). */
export interface SaveData {
  version: number;
  timeOfDay: number; // 0..1 through the day
  player: PlayerState;
  inventory: Slot[]; // 36 entries (27 + 9)
  selected: number;
  /** chunkKey -> base64 of RLE-compressed (varint index-delta, blockId) pairs. */
  chunks: Record<string, string>;
  /** "x,y,z" -> 27 item slots */
  chests: Record<string, Slot[]>;
  /** mobs near the player (MO-1 … MO-4) */
  mobs?: MobState[];
  nextMobId: number;
  stats: { blocksMined: number; blocksPlaced: number; distance: number };
  /** UI-6 milestone progression (replaces the old tutorial cards). */
  milestones?: MilestoneSave;
}

/** Milestone (UI-6) progression: unlocked ids plus the gameplay counters they are measured from. */
export interface MilestoneSave {
  unlocked: string[];
  stats?: unknown;
}

/** Geometry produced by the mesher, ready for GPU upload. */
export interface MeshData {
  position: Float32Array;
  /** (u in tile units along the face tangent, v in tile units) */
  uv: Float32Array;
  /** atlas tile index per vertex */
  tile: Float32Array;
  light: Uint8Array; // per vertex: sky, block (0..15)
  tint: Uint8Array; // per vertex: face shade × AO (0..255)
  index: Uint32Array;
}

export interface GenRequest {
  type: 'gen';
  jobId: number;
  cx: number;
  cz: number;
  seed: number;
  /** flat [index, blockId, index, blockId, ...] player edits for this chunk */
  diff: number[];
}

export interface GenResponse {
  type: 'data';
  jobId: number;
  cx: number;
  cz: number;
  blocks: ArrayBuffer;
  biome: ArrayBuffer;
  height: ArrayBuffer;
  ms: number;
}

export interface WorkerError {
  type: 'error';
  jobId: number;
  message: string;
}
