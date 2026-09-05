/**
 * Lighting (AM-1 + §8 "Lighting"):
 *  • sky light: column-based (15 at open sky, attenuated by translucent blocks, 0 under opaque)
 *  • block light: BFS flood fill from emitters (torches), level 0..15
 *  • incremental: only the changed chunk (+ border-touching neighbours) is rebuilt
 * Light is packed into each chunk's `light` array: high nibble = sky, low nibble = block.
 */
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, MAX_LIGHT, blockIndex } from '../core/constants.js';
import type { Chunk } from './chunk.js';
import { blockLight as emitterLevel, isOpaque } from './blocks.js';

export interface LightWorld {
  getChunk(cx: number, cz: number): Chunk | undefined;
  markDirty(cx: number, cz: number): void;
}

const WATER = 12;
const LEAVES = 6;

function attenuationFor(id: number): number {
  if (id === 0) return 1;
  if (isOpaque(id)) return MAX_LIGHT + 1;
  if (id === WATER || id === LEAVES) return 2;
  return 1;
}

/** Sky light for one column, written into the high nibble. */
export function relightSkyColumn(chunk: Chunk, lx: number, lz: number): void {
  const base = (lx * CHUNK_SZ + lz) * CHUNK_SY;
  let level = MAX_LIGHT;
  for (let y = CHUNK_SY - 1; y >= 0; y--) {
    const b = chunk.blocks[base + y];
    if (b !== 0) {
      const att = attenuationFor(b);
      level = att > MAX_LIGHT ? 0 : Math.max(0, level - att);
    }
    chunk.light[base + y] = (level << 4) | (chunk.light[base + y] & 15);
  }
}

export function relightSkyChunk(chunk: Chunk): void {
  for (let x = 0; x < CHUNK_SX; x++) for (let z = 0; z < CHUNK_SZ; z++) relightSkyColumn(chunk, x, z);
}

const QUEUE_CAP = CHUNK_SX * CHUNK_SZ * CHUNK_SY;
const queue = new Int32Array(QUEUE_CAP);

/**
 * Rebuild block light inside one chunk. Seeded with local emitters plus the neighbouring
 * chunks' border values, so light crosses chunk seams without needing a global solver.
 */
export function rebuildBlockLight(world: LightWorld, chunk: Chunk): void {
  const { blocks, light } = chunk;
  for (let i = 0; i < light.length; i++) light[i] = light[i] & 0xf0;

  let head = 0;
  let tail = 0;

  for (let x = 0; x < CHUNK_SX; x++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      const base = (x * CHUNK_SZ + z) * CHUNK_SY;
      for (let y = 0; y < CHUNK_SY; y++) {
        const emit = emitterLevel(blocks[base + y]);
        if (emit > 0) {
          light[base + y] = (light[base + y] & 0xf0) | emit;
          if (tail < QUEUE_CAP) queue[tail++] = base + y;
        }
      }
    }
  }

  const seedLine = (n: Chunk, ourX: number, ourZ: number, nX: number, nZ: number): void => {
    const nbase = (nX * CHUNK_SZ + nZ) * CHUNK_SY;
    for (let y = 0; y < CHUNK_SY; y++) {
      const v = n.light[nbase + y] & 15;
      if (v <= 1) continue;
      const i = blockIndex(ourX, y, ourZ);
      if (isOpaque(blocks[i])) continue;
      const nv = v - 1;
      if (nv > (light[i] & 15)) {
        light[i] = (light[i] & 0xf0) | nv;
        if (tail < QUEUE_CAP) queue[tail++] = i;
      }
    }
  };

  const cx = chunk.cx;
  const cz = chunk.cz;
  let n = world.getChunk(cx - 1, cz);
  if (n) for (let z = 0; z < CHUNK_SZ; z++) seedLine(n, 0, z, CHUNK_SX - 1, z);
  n = world.getChunk(cx + 1, cz);
  if (n) for (let z = 0; z < CHUNK_SZ; z++) seedLine(n, CHUNK_SX - 1, z, 0, z);
  n = world.getChunk(cx, cz - 1);
  if (n) for (let x = 0; x < CHUNK_SX; x++) seedLine(n, x, 0, x, CHUNK_SZ - 1);
  n = world.getChunk(cx, cz + 1);
  if (n) for (let x = 0; x < CHUNK_SX; x++) seedLine(n, x, CHUNK_SZ - 1, x, 0);

  const spread = (j: number, fromLevel: number): void => {
    const att = attenuationFor(blocks[j]);
    if (att > MAX_LIGHT) return;
    const nv = fromLevel - att;
    if (nv <= (light[j] & 15)) return;
    light[j] = (light[j] & 0xf0) | nv;
    if (tail < QUEUE_CAP) queue[tail++] = j;
  };

  while (head < tail) {
    const i = queue[head++];
    const y = i % CHUNK_SY;
    const rest = (i - y) / CHUNK_SY;
    const z = rest % CHUNK_SZ;
    const x = (rest - z) / CHUNK_SZ;
    const v = light[i] & 15;
    if (v <= 1) continue;
    if (y + 1 < CHUNK_SY) spread(i + 1, v);
    if (y > 0) spread(i - 1, v);
    if (z + 1 < CHUNK_SZ) spread(i + CHUNK_SY, v);
    if (z > 0) spread(i - CHUNK_SY, v);
    if (x + 1 < CHUNK_SX) spread(i + CHUNK_SZ * CHUNK_SY, v);
    if (x > 0) spread(i - CHUNK_SZ * CHUNK_SY, v);
  }
}

/** Signature of every border cell's packed light — detects light leaking across seams. */
export function borderSignature(chunk: Chunk): number {
  let h = 0x811c9dc5;
  const feed = (i: number): void => {
    h = Math.imul(h ^ (chunk.light[i] & 0xff), 0x01000193) >>> 0;
  };
  for (let x = 0; x < CHUNK_SX; x++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      if (x !== 0 && x !== CHUNK_SX - 1 && z !== 0 && z !== CHUNK_SZ - 1) continue;
      const base = (x * CHUNK_SZ + z) * CHUNK_SY;
      for (let y = 0; y < CHUNK_SY; y += 1) feed(base + y);
    }
  }
  return h >>> 0;
}

/** Full relight (sky + block) for a chunk; returns true when the border changed. */
export function relightChunk(world: LightWorld, chunk: Chunk): boolean {
  const before = borderSignature(chunk);
  relightSkyChunk(chunk);
  rebuildBlockLight(world, chunk);
  chunk.needsLight = false;
  chunk.dirty = true;
  return borderSignature(chunk) !== before;
}
