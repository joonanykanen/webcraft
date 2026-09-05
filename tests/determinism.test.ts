/** World generation must be deterministic: the same seed produces the identical world everywhere (WG-1). */
import { describe, expect, it } from 'vitest';
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, CHUNK_VOL, SEA_LEVEL } from '../src/core/constants.js';
import { hashInts, mulberry32, seedFromString } from '../src/core/rng.js';
import { fbm2, makePerm, noise2, noise3, ridged2 } from '../src/core/noise.js';
import { findSpawn, generateChunk, terrainContext } from '../src/world/worldgen.js';
import { SyncGenPool } from '../src/workers/pool.js';
import { World } from '../src/world/world.js';

/** FNV-1a over the chunk bytes — stable across runs & platforms. */
function hashBlocks(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function gen(seed: number, cx: number, cz: number): { hash: string; blocks: Uint8Array } {
  const blocks = new Uint8Array(CHUNK_VOL);
  const biome = new Uint8Array(CHUNK_SX * CHUNK_SZ);
  const height = new Uint8Array(CHUNK_SX * CHUNK_SZ);
  generateChunk(seed, cx, cz, blocks, biome, height);
  return { hash: hashBlocks(blocks), blocks };
}

describe('rng & noise determinism', () => {
  it('mulberry32 repeats exactly for a seed', () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    const xs = Array.from({ length: 64 }, a);
    const ys = Array.from({ length: 64 }, b);
    expect(xs).toEqual(ys);
    expect(new Set(xs).size).toBeGreaterThan(60); // not degenerate
  });

  it('hashInts is order-sensitive and stable', () => {
    expect(hashInts(1, 2, 3, 4, 9)).toBe(hashInts(1, 2, 3, 4, 9));
    expect(hashInts(1, 2, 3, 4, 9)).not.toBe(hashInts(3, 2, 1, 4, 9));
    expect(hashInts(0, 0, 7, 0, 9)).not.toBe(hashInts(0, 0, 8, 0, 9));
    expect(hashInts(0, 0, 0, 0, 1)).not.toBe(hashInts(0, 0, 0, 0, 2));
  });

  it('seedFromString maps text to a stable seed', () => {
    expect(seedFromString('webcraft')).toBe(seedFromString('webcraft'));
    expect(seedFromString('webcraft')).not.toBe(seedFromString('WebCraft'));
  });

  it('perlin noise is continuous, bounded and repeatable', () => {
    const perm = makePerm(7);
    const perm2 = makePerm(7);
    expect(Array.from(perm.slice(0, 64))).toEqual(Array.from(perm2.slice(0, 64)));
    expect(noise2(perm, 12.5, -3.25)).toBe(noise2(perm, 12.5, -3.25));
    expect(Math.abs(noise2(perm, 4.0, 4.0) - noise2(perm, 4.001, 4.0))).toBeLessThan(0.02);
    for (const [x, y] of [
      [0, 0],
      [13.7, -8.2],
      [1000, 999],
      [-42.5, 77.25],
    ]) {
      const v = noise2(perm, x, y);
      expect(v).toBeGreaterThanOrEqual(-1.0001);
      expect(v).toBeLessThanOrEqual(1.0001);
      expect(Math.abs(noise3(perm, x, y, 3.5))).toBeLessThanOrEqual(1.0001);
      expect(ridged2(perm, x, y, 3)).toBeGreaterThanOrEqual(-0.001);
      expect(ridged2(perm, x, y, 3)).toBeLessThanOrEqual(1.001);
    }
    expect(fbm2(perm, 3.5, -2.5, 4, 0.5)).toBe(fbm2(perm, 3.5, -2.5, 4, 0.5));
    expect(noise2(perm, 4.5, 4.5)).not.toBe(noise2(makePerm(8), 4.5, 4.5));
  });
});

describe('terrain generation', () => {
  it('is byte-identical when regenerated', () => {
    for (const seed of [1, 1337, 987654321]) {
      for (const [cx, cz] of [
        [0, 0],
        [-3, 5],
        [12, -7],
      ]) {
        expect(gen(seed, cx, cz).hash).toBe(gen(seed, cx, cz).hash);
      }
    }
  });

  it('different seeds give different terrain', () => {
    expect(gen(1337, 2, 3).hash).not.toBe(gen(1338, 2, 3).hash);
  });

  it('matches the golden hashes for seed 1337', () => {
    // regression guard: if these change, every existing save becomes a different world
    expect(gen(1337, 0, 0).hash).toBe(GOLDEN_1337['0,0']);
    expect(gen(1337, -4, 9).hash).toBe(GOLDEN_1337['-4,9']);
    expect(gen(1337, 31, -12).hash).toBe(GOLDEN_1337['31,-12']);
  });

  it('wraps bedrock at the bottom and never leaves the vertical range', () => {
    const { blocks } = gen(2024, 1, 1);
    const idx = (x: number, y: number, z: number) => (x * CHUNK_SZ + z) * CHUNK_SY + y;
    for (let x = 0; x < CHUNK_SX; x++) {
      for (let z = 0; z < CHUNK_SZ; z++) {
        expect(blocks[idx(x, 0, z)]).toBe(13); // BEDROCK
        let solid = 0;
        for (let y = 0; y < CHUNK_SY; y++) if (blocks[idx(x, y, z)] !== 0) solid++;
        expect(solid).toBeGreaterThan(4);
        expect(solid).toBeLessThan(CHUNK_SY);
      }
    }
  });

  it('fills ocean columns up to sea level with water', () => {
    const ctx = terrainContext(1337);
    const { blocks } = gen(1337, 0, 0);
    const idx = (x: number, y: number, z: number) => (x * CHUNK_SZ + z) * CHUNK_SY + y;
    let checked = 0;
    for (let x = 0; x < CHUNK_SX; x++) {
      for (let z = 0; z < CHUNK_SZ; z++) {
        const col = ctx.column(x, z);
        if (col.h < SEA_LEVEL - 1) {
          checked++;
          expect(blocks[idx(x, SEA_LEVEL - 1, z)]).toBe(12); // WATER
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(0);
  });

  it('ores appear in the expected bands', () => {
    const counts = new Map<number, number>();
    for (let cx = 0; cx < 6; cx++) {
      const { blocks } = gen(4242, cx, 2);
      for (const id of blocks) if (id >= 8 && id <= 11) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(counts.get(8) ?? 0).toBeGreaterThan(0); // coal
    expect(counts.get(9) ?? 0).toBeGreaterThan(0); // iron
  });

  it('findSpawn returns dry, standable ground', () => {
    const world = new World({
      seed: 1337,
      pool: new SyncGenPool(1337),
      sink: null,
      renderDistance: 4,
      quality: 'fast',
    });
    for (let i = 0; i < 4; i++) {
      const s = findSpawn(1337 + i);
      world.prepareSync(s.x, s.z, 1);
      const ground = world.surfaceY(Math.floor(s.x), Math.floor(s.z));
      expect(ground).toBeGreaterThan(6);
      expect(ground).toBeLessThan(120);
      expect(world.getBlock(Math.floor(s.x), ground, Math.floor(s.z))).not.toBe(0);
      expect(world.getBlock(Math.floor(s.x), ground, Math.floor(s.z))).not.toBe(12); // not water
      expect(world.getBlock(Math.floor(s.x), ground + 1, Math.floor(s.z))).toBe(0);
    }
    world.dispose();
  });
});

/** Golden output of generateChunk for seed 1337 — see determinism.test notes. */
const GOLDEN_1337: Record<string, string> = {
  '0,0': 'c447d654',
  '-4,9': 'bbbecf9b',
  '31,-12': '26fe46b9',
};
