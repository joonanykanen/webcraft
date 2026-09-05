/**
 * Procedural world generation (WG-1 … WG-7).
 *
 * Pure + deterministic: given (seed, chunkX, chunkZ) the exact same voxel column is produced on
 * every browser and in every context (worker, main thread, tests). No Math.random(), no trig.
 */
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, SEA_LEVEL, blockIndex, clamp } from '../core/constants.js';
import { type BiomeId } from '../core/types.js';
import { fbm2, fbm3, makePerm, noise3, ridged2 } from '../core/noise.js';
import { BlockId } from './blocks.js';
import { hashInts, mulberry32 } from '../core/rng.js';

const OCEAN = 0 satisfies BiomeId;
const BEACH = 1 satisfies BiomeId;
const PLAINS = 2 satisfies BiomeId;
const FOREST = 3 satisfies BiomeId;
const DESERT = 4 satisfies BiomeId;
const MOUNTAINS = 5 satisfies BiomeId;
const SNOW = 6 satisfies BiomeId;

export interface ColumnInfo {
  h: number;
  biome: BiomeId;
  surface: number;
  subsoil: number;
  rock: number;
  /** 0..1 probability of tree/decoration for this column */
  fertility: number;
}

/** Cached per-seed noise contexts (permutation tables are expensive to rebuild per chunk). */
export class TerrainContext {
  readonly seed: number;
  readonly pBase: Uint8Array;
  readonly pDetail: Uint8Array;
  readonly pTemp: Uint8Array;
  readonly pHum: Uint8Array;
  readonly pCave: Uint8Array;
  readonly pCave2: Uint8Array;
  readonly pCave3: Uint8Array;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    // Mix the seed into every permutation table so a seed changes the whole world.
    const seeds = [0, 1, 2, 3, 4, 5, 6].map((i) => hashInts(i, this.seed, 0x51ab, 0x99e1, 0x2f0c));
    this.pBase = makePerm(seeds[0]);
    this.pDetail = makePerm(seeds[1]);
    this.pTemp = makePerm(seeds[2]);
    this.pHum = makePerm(seeds[3]);
    this.pCave = makePerm(seeds[4]);
    this.pCave2 = makePerm(seeds[5]);
    this.pCave3 = makePerm(seeds[6]);
  }

  /** temperature/humidity driven biome choice + terrain height (WG-3) */
  column(wx: number, wz: number): ColumnInfo {
    const base = fbm2(this.pBase, wx / 640, wz / 640, 4);
    const detail = fbm2(this.pDetail, wx / 165, wz / 165, 4);
    const ridge = ridged2(this.pBase, wx / 430, wz / 430, 4);
    const mountainMask = clamp((fbm2(this.pBase, (wx + 4200) / 900, (wz - 3100) / 900, 3) + 0.16) * 1.6, 0, 1);
    const warmth = (fbm2(this.pTemp, wx / 720, wz / 720, 3) + 1) * 0.5;
    const wet = (fbm2(this.pHum, wx / 560, wz / 560, 3) + 1) * 0.5;

    let h = SEA_LEVEL + 2 + base * 22 + detail * 6.5 + ridge * mountainMask * 42;

    // Oceans get a gentle basin so coastlines read clearly.
    if (base < -0.24) {
      const t = (-0.24 - base) * 3.2;
      h -= t * 14;
    }
    // Flatten the sea floor slightly near the shore for readable beaches.
    h = Math.floor(h + 0.5);
    h = clamp(h, 4, CHUNK_SY - 12);

    let biome: BiomeId;
    if (h <= SEA_LEVEL - 2) biome = OCEAN;
    else if (h <= SEA_LEVEL + 1) biome = BEACH;
    else if (mountainMask > 0.5 && h > SEA_LEVEL + 34) biome = MOUNTAINS;
    else if (warmth < 0.3) biome = SNOW;
    else if (warmth > 0.64 && wet < 0.4) biome = DESERT;
    else if (wet > 0.52) biome = FOREST;
    else biome = PLAINS;

    let surface: number;
    let subsoil: number;
    let rock: number = BlockId.STONE;
    switch (biome) {
      case OCEAN:
        surface = wet > 0.7 ? BlockId.GRAVEL : BlockId.SAND;
        subsoil = BlockId.SAND;
        break;
      case BEACH:
        surface = BlockId.SAND;
        subsoil = BlockId.SAND;
        break;
      case DESERT:
        surface = BlockId.SAND;
        subsoil = BlockId.SANDSTONE;
        break;
      case SNOW:
        surface = BlockId.SNOW;
        subsoil = BlockId.DIRT;
        break;
      case MOUNTAINS:
        surface = h > SEA_LEVEL + 52 ? BlockId.SNOW : BlockId.STONE;
        subsoil = BlockId.STONE;
        break;
      case FOREST:
      case PLAINS:
      default:
        surface = BlockId.GRASS;
        subsoil = BlockId.DIRT;
        break;
    }
    const fertility = biome === FOREST ? 0.4 : biome === PLAINS ? 0.09 : biome === SNOW ? 0.16 : biome === DESERT ? 0.06 : 0;
    return { h, biome, surface, subsoil, rock, fertility };
  }

  /** Caves: spaghetti tunnels + occasional caverns (WG-4). */
  isCave(wx: number, y: number, wz: number, depth: number): boolean {
    const sq = 0.052 + depth * 0.01;
    const a = noise3(this.pCave, wx / 62, y / 33, wz / 62);
    const b = noise3(this.pCave2, (wx + 1300) / 62, (y + 900) / 33, (wz - 700) / 62);
    if (a > -sq && a < sq && b > -sq && b < sq) return true;
    if (y < 4) return false;
    const blob = fbm3(this.pCave3, wx / 40, y / 30, wz / 40, 2);
    return blob > 0.58;
  }
}

const contexts = new Map<number, TerrainContext>();
export function terrainContext(seed: number): TerrainContext {
  const key = seed >>> 0;
  let ctx = contexts.get(key);
  if (!ctx) {
    ctx = new TerrainContext(key);
    contexts.set(key, ctx);
  }
  return ctx;
}

interface DecorTarget {
  blocks: Uint8Array;
  baseX: number;
  baseZ: number;
}

function paint(t: DecorTarget, wx: number, y: number, wz: number, id: number, onlyAir: boolean): void {
  const lx = wx - t.baseX;
  const lz = wz - t.baseZ;
  if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ || y < 0 || y >= CHUNK_SY) return;
  const i = blockIndex(lx, y, lz);
  if (onlyAir && t.blocks[i] !== BlockId.AIR && t.blocks[i] !== BlockId.WATER) return;
  t.blocks[i] = id;
}

/** Tree / cactus placement, deterministic from world coordinates (WG-5). */
function decorate(
  ctx: TerrainContext,
  blocks: Uint8Array,
  cx: number,
  cz: number,
  columnAt: (wx: number, wz: number) => ColumnInfo,
): void {
  const baseX = cx * CHUNK_SX;
  const baseZ = cz * CHUNK_SZ;
  const target: DecorTarget = { blocks, baseX, baseZ };
  const blockAtWorld = (wx: number, y: number, wz: number): number => {
    const lx = wx - baseX;
    const lz = wz - baseZ;
    if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ || y < 0 || y >= CHUNK_SY) return -1;
    return blocks[blockIndex(lx, y, lz)];
  };
  const CELL = 7;
  const x0 = Math.floor((baseX - 4) / CELL);
  const x1 = Math.floor((baseX + CHUNK_SX + 4) / CELL);
  const z0 = Math.floor((baseZ - 4) / CELL);
  const z1 = Math.floor((baseZ + CHUNK_SZ + 4) / CELL);

  for (let cellX = x0; cellX <= x1; cellX++) {
    for (let cellZ = z0; cellZ <= z1; cellZ++) {
      const h = hashInts(cellX, cellZ, ctx.seed, 0x77, 0x3ee7);
      const roll = (h >>> 8) / 16777216;
      const jx = h % CELL;
      const jz = (h >>> 4) % CELL;
      const wx = cellX * CELL + jx;
      const wz = cellZ * CELL + jz;
      const col = columnAt(wx, wz);
      if (roll > col.fertility) continue;
      if (col.h <= SEA_LEVEL + 1) continue; // nothing grows in water
      if (col.biome === OCEAN || col.biome === BEACH) continue;
      const surfY = col.h - 1;
      const existing = blockAtWorld(wx, surfY, wz);
      if (existing !== -1 && existing !== col.surface) continue;

      const r = mulberry32(hashInts(wx, wz, ctx.seed, 1, 2));
      if (col.biome === DESERT) {
        const tall = 2 + Math.floor(r() * 2.2);
        for (let i = 0; i < tall; i++) paint(target, wx, surfY + 1 + i, wz, BlockId.CACTUS, false);
        continue;
      }
      const spruce = col.biome === SNOW;
      const trunk = spruce ? 5 + Math.floor(r() * 4) : 4 + Math.floor(r() * 3);
      const topY = surfY + trunk;
      if (topY + 3 >= CHUNK_SY) continue;

      if (spruce) {
        // layered conical canopy
        for (let layer = 0; layer < 3; layer++) {
          const ly = topY - layer * 2;
          const rad = layer === 0 ? 1 : 2;
          for (let dx = -rad; dx <= rad; dx++) {
            for (let dz = -rad; dz <= rad; dz++) {
              if (dx === 0 && dz === 0) continue;
              if (Math.abs(dx) === rad && Math.abs(dz) === rad && r() < 0.7) continue;
              paint(target, wx + dx, ly, wz + dz, BlockId.LEAVES, true);
            }
          }
        }
        paint(target, wx, topY + 1, wz, BlockId.LEAVES, true);
      } else {
        const rad = 2;
        for (let dy = -2; dy <= 0; dy++) {
          const rr = dy === 0 ? 1 : rad;
          for (let dx = -rr; dx <= rr; dx++) {
            for (let dz = -rr; dz <= rr; dz++) {
              if (dx === 0 && dz === 0 && dy < 0) continue; // trunk continues
              if (Math.abs(dx) === rr && Math.abs(dz) === rr && r() < 0.55) continue;
              paint(target, wx + dx, topY + dy, wz + dz, BlockId.LEAVES, true);
            }
          }
        }
        paint(target, wx, topY + 1, wz, BlockId.LEAVES, true);
      }
      for (let y = 0; y <= trunk; y++) paint(target, wx, surfY + 1 + y, wz, BlockId.LOG, false);
    }
  }
}

/** Ore veins, depth-banded (WG-4). */
function placeOres(seed: number, cx: number, cz: number, blocks: Uint8Array, heights: Uint8Array): void {
  const rng = mulberry32(hashInts(cx, cz, seed, 0x0ff5, 0x1e3));

  const bands: { id: number; veins: number; max: number; size: number }[] = [
    { id: BlockId.COAL_ORE, veins: 22, max: 84, size: 7 },
    { id: BlockId.IRON_ORE, veins: 16, max: 64, size: 5 },
    { id: BlockId.GOLD_ORE, veins: 7, max: 34, size: 4 },
    { id: BlockId.GEM_ORE, veins: 5, max: 20, size: 3 },
  ];

  for (const band of bands) {
    for (let v = 0; v < band.veins; v++) {
      let x = Math.floor(rng() * CHUNK_SX);
      let z = Math.floor(rng() * CHUNK_SZ);
      let y = 4 + Math.floor(rng() * (band.max - 4));
      const len = 2 + Math.floor(rng() * band.size);
      for (let i = 0; i < len; i++) {
        const li = blockIndex(x, y, z);
        if (blocks[li] === BlockId.STONE) blocks[li] = band.id;
        const dir = Math.floor(rng() * 6);
        x += dir === 0 ? 1 : dir === 1 ? -1 : 0;
        z += dir === 2 ? 1 : dir === 3 ? -1 : 0;
        y += dir === 4 ? 1 : dir === 5 ? -1 : 0;
        if (x < 0 || x >= CHUNK_SX || z < 0 || z >= CHUNK_SZ) break;
        y = clamp(y, 2, CHUNK_SY - 2);
        if (y > heights[x * CHUNK_SZ + z]) break;
      }
    }
  }
}

/**
 * Generate the terrain of one chunk into pre-allocated typed arrays.
 * `blocks` must be CHUNK_VOL bytes; `biome`/`height` CHUNK_SX*CHUNK_SZ bytes.
 */
export function generateChunk(
  seed: number,
  cx: number,
  cz: number,
  blocks: Uint8Array,
  biome: Uint8Array,
  height: Uint8Array,
): void {
  const ctx = terrainContext(seed);
  const baseX = cx * CHUNK_SX;
  const baseZ = cz * CHUNK_SZ;

  // Column cache so decoration can ask about neighbour columns without recomputing noise
  // (and so the same value is always returned for a coordinate — required for seamlessness).
  const cache = new Map<number, ColumnInfo>();
  const columnAt = (wx: number, wz: number): ColumnInfo => {
    const k = (wx + 8388608) * 16777216 + (wz + 8388608);
    let c = cache.get(k);
    if (c === undefined) {
      c = ctx.column(wx, wz);
      cache.set(k, c);
    }
    return c;
  };

  const heightmap = new Uint8Array(CHUNK_SX * CHUNK_SZ);

  for (let x = 0; x < CHUNK_SX; x++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      const wx = baseX + x;
      const wz = baseZ + z;
      const col = columnAt(wx, wz);
      const { h, biome: b, surface, subsoil } = col;
      biome[x * CHUNK_SZ + z] = b;
      const base = (x * CHUNK_SZ + z) * CHUNK_SY;

      for (let y = 0; y <= h; y++) {
        let id: number;
        if (y === 0 || (y < 3 && (hashInts(wx, y * 7 + wz, seed, 3, 1) & 3) !== 0)) {
          id = BlockId.BEDROCK;
        } else if (y === h) {
          id = surface;
        } else if (y > h - 4) {
          id = subsoil;
        } else {
          id = BlockId.STONE;
        }
        // carve caves (never the surface block, never bedrock, never right under the skin)
        if (id === BlockId.STONE || (id === BlockId.SANDSTONE && y < h - 2)) {
          const depth = (h - y) / Math.max(1, h);
          if (y > 1 && y < h - 2 && ctx.isCave(wx, y, wz, depth)) id = BlockId.AIR;
        }
        blocks[base + y] = id;
      }

      if (h < SEA_LEVEL) {
        for (let y = h + 1; y <= SEA_LEVEL; y++) blocks[base + y] = BlockId.WATER;
      }
    }
  }

  placeOres(seed >>> 0, cx, cz, blocks, heightmapFromBlocks(blocks, heightmap));
  decorate(ctx, blocks, cx, cz, columnAt);

  // final column heights (used by lighting + meshing)
  for (let x = 0; x < CHUNK_SX; x++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      let hh = 0;
      const base = (x * CHUNK_SZ + z) * CHUNK_SY;
      for (let y = CHUNK_SY - 1; y >= 0; y--) {
        if (blocks[base + y] !== 0) {
          hh = y + 1;
          break;
        }
      }
      height[x * CHUNK_SZ + z] = hh;
    }
  }
}

function heightmapFromBlocks(blocks: Uint8Array, out: Uint8Array): Uint8Array {
  for (let i = 0; i < out.length; i++) {
    const base = i * CHUNK_SY;
    let h = 0;
    for (let y = CHUNK_SY - 1; y >= 0; y--) {
      if (blocks[base + y] !== 0) {
        h = y + 1;
        break;
      }
    }
    out[i] = h;
  }
  return out;
}

/** Find a safe spawn position on the surface for a fresh world (deterministic, integer-only search). */
export function findSpawn(seed: number): { x: number; y: number; z: number } {
  const ctx = terrainContext(seed);
  const dirs = [
    [8, 0],
    [8, 8],
    [0, 8],
    [-8, 8],
    [-8, 0],
    [-8, -8],
    [0, -8],
    [8, -8],
  ];
  const first = ctx.column(0, 0);
  if (first.h > SEA_LEVEL + 1 && first.biome !== 0) return { x: 0.5, y: first.h + 1.2, z: 0.5 };
  for (let r = 1; r < 96; r++) {
    for (const [dx, dz] of dirs) {
      const x = dx * r;
      const z = dz * r;
      const col = ctx.column(x, z);
      if (col.h > SEA_LEVEL + 1 && col.biome !== 0) {
        return { x: x + 0.5, y: col.h + 1.2, z: z + 0.5 };
      }
    }
  }
  return { x: 0.5, y: 90, z: 0.5 };
}
