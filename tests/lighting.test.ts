/** Lighting: column sky light + flood-filled block light (§8, AM-1). */
import { describe, expect, it } from 'vitest';
import { CHUNK_SX, CHUNK_SZ, MAX_LIGHT, blockIndex, chunkKey } from '../src/core/constants.js';
import { Chunk } from '../src/world/chunk.js';
import { borderSignature, rebuildBlockLight, relightChunk, relightSkyChunk, relightSkyColumn, type LightWorld } from '../src/world/lighting.js';
import { BlockId } from '../src/world/blocks.js';
import { World } from '../src/world/world.js';
import { SyncGenPool } from '../src/workers/pool.js';

function stubWorld(...chunks: Chunk[]): LightWorld {
  const map = new Map(chunks.map((c) => [c.key, c]));
  return { getChunk: (cx, cz) => map.get(chunkKey(cx, cz)), markDirty: () => {} };
}

function carve(chunk: Chunk, fill: number): void {
  chunk.blocks.fill(fill);
  chunk.light.fill(0);
}

describe('sky light', () => {
  it('is full brightness under open sky and zero under stone', () => {
    const c = new Chunk(0, 0);
    carve(c, 0);
    for (let x = 0; x < CHUNK_SX; x++)
      for (let z = 0; z < CHUNK_SZ; z++) for (let y = 0; y <= 40; y++) c.blocks[blockIndex(x, y, z)] = BlockId.STONE;
    relightSkyChunk(c);
    expect(c.skyAt(4, 64, 4)).toBe(MAX_LIGHT);
    expect(c.skyAt(4, 41, 4)).toBe(MAX_LIGHT); // one above the surface
    expect(c.skyAt(4, 40, 4)).toBe(0); // inside the surface block
    expect(c.skyAt(4, 20, 4)).toBe(0); // deep underground
  });

  it('filters through leaves and water but not through stone', () => {
    const c = new Chunk(0, 0);
    carve(c, 0);
    c.blocks[blockIndex(4, 60, 4)] = BlockId.LEAVES;
    c.blocks[blockIndex(8, 60, 8)] = BlockId.WATER;
    c.blocks[blockIndex(12, 60, 12)] = BlockId.STONE;
    relightSkyChunk(c);
    expect(c.skyAt(4, 61, 4)).toBe(MAX_LIGHT); // above the leaves
    expect(c.skyAt(4, 60, 4)).toBe(MAX_LIGHT - 2); // leaves absorb 2
    expect(c.skyAt(4, 59, 4)).toBe(MAX_LIGHT - 2); // sunlight then falls undimmed down the column
    expect(c.skyAt(8, 60, 8)).toBe(MAX_LIGHT - 2); // water absorbs 2 as well
    expect(c.skyAt(8, 59, 8)).toBe(MAX_LIGHT - 2);
    expect(c.skyAt(12, 60, 12)).toBe(0); // stone blocks it entirely
    expect(c.skyAt(12, 59, 12)).toBe(0);
  });

  it('only one column is recomputed per edit', () => {
    const c = new Chunk(0, 0);
    carve(c, 0);
    relightSkyColumn(c, 3, 3);
    expect(c.skyAt(3, 70, 3)).toBe(MAX_LIGHT);
    expect(c.light[blockIndex(4, 70, 4)]).toBe(0); // untouched neighbour column
  });
});

describe('block light (torch flood fill)', () => {
  it('falls off one level per block of air', () => {
    const c = new Chunk(0, 0);
    carve(c, 0);
    c.blocks[blockIndex(8, 40, 8)] = BlockId.TORCH;
    rebuildBlockLight(stubWorld(c), c);
    expect(c.blockAt(8, 40, 8)).toBe(14); // the torch itself
    expect(c.blockAt(9, 40, 8)).toBe(13);
    expect(c.blockAt(10, 40, 8)).toBe(12);
    expect(c.blockAt(8, 45, 8)).toBe(9); // straight up
    expect(c.blockAt(8, 35, 8)).toBe(9); // and down
    expect(c.blockAt(0, 40, 0)).toBe(0); // out of range
  });

  it('does not travel through solid blocks', () => {
    const c = new Chunk(0, 0);
    carve(c, BlockId.STONE);
    // a 5×5×5 air room centred on (8,40,8)
    for (let x = 6; x <= 10; x++) for (let y = 38; y <= 42; y++) for (let z = 6; z <= 10; z++) c.blocks[blockIndex(x, y, z)] = 0;
    for (let x = 6; x <= 10; x++) for (let y = 38; y <= 42; y++) for (let z = 6; z <= 10; z++) c.light[blockIndex(x, y, z)] = 0;
    rebuildBlockLight(stubWorld(c), c);
    for (let y = 38; y <= 42; y++) expect(c.blockAt(8, y, 8)).toBe(0); // dark room

    c.blocks[blockIndex(8, 40, 8)] = BlockId.TORCH;
    rebuildBlockLight(stubWorld(c), c);
    expect(c.blockAt(8, 40, 8)).toBe(14);
    expect(c.blockAt(9, 40, 8)).toBe(13);
    expect(c.blockAt(6, 40, 8)).toBe(12); // across the room
    expect(c.blockAt(8, 42, 8)).toBe(12);
    expect(c.blockAt(5, 40, 8)).toBe(0); // inside the wall
    expect(c.blockAt(0, 40, 0)).toBe(0);
  });

  it('light leaks across a chunk seam', () => {
    const a = new Chunk(0, 0);
    const b = new Chunk(1, 0);
    carve(a, 0);
    carve(b, 0);
    a.blocks[blockIndex(CHUNK_SX - 1, 40, 4)] = BlockId.TORCH;
    rebuildBlockLight(stubWorld(a, b), a);
    const before = b.light.slice();
    rebuildBlockLight(stubWorld(a, b), b); // b picks up a's border light
    expect(b.blockAt(0, 40, 4)).toBe(13);
    expect(b.blockAt(3, 40, 4)).toBe(10);
    expect(b.blockAt(10, 40, 4)).toBe(3); // 14 − 11 blocks from the torch
    expect(b.blockAt(0, 70, 4)).toBe(0); // too far away
    expect(Array.from(b.light)).not.toEqual(Array.from(before));
  });

  it('relightChunk reports border changes so neighbours can be refreshed', () => {
    const c = new Chunk(0, 0);
    carve(c, 0);
    const world = stubWorld(c);
    relightChunk(world, c);
    expect(relightChunk(world, c)).toBe(false); // nothing changed
    c.blocks[blockIndex(0, 40, 0)] = BlockId.TORCH; // right on the border
    expect(relightChunk(world, c)).toBe(true);
    expect(c.needsLight).toBe(false);
  });

  it('keeps sky and block light in separate nibbles', () => {
    const c = new Chunk(0, 0);
    carve(c, 0);
    c.blocks[blockIndex(4, 20, 4)] = BlockId.TORCH;
    relightChunk(stubWorld(c), c);
    const packed = c.getLight(4, 20, 4);
    expect(packed >> 4).toBe(c.skyAt(4, 20, 4));
    expect(packed & 15).toBe(c.blockAt(4, 20, 4));
    expect(packed).toBe((c.skyAt(4, 20, 4) << 4) | 14);
    expect(c.blockAt(4, 21, 4)).toBe(13);
  });

  it('borderSignature only watches the rim', () => {
    const c = new Chunk(0, 0);
    carve(c, 0);
    const before = borderSignature(c);
    c.light[blockIndex(8, 40, 8)] = 0xff; // interior
    expect(borderSignature(c)).toBe(before);
    c.light[blockIndex(0, 40, 0)] = 0xff; // rim
    expect(borderSignature(c)).not.toBe(before);
  });
});

describe('lighting inside a generated world', () => {
  const mk = (seed: number): World =>
    new World({ seed, pool: new SyncGenPool(seed), sink: null, renderDistance: 3, quality: 'fast' });

  it('the surface is sunlit and the depths are not', () => {
    const seed = 5150;
    const w = mk(seed);
    w.prepareSync(0, 0, 1);
    const y = w.surfaceY(4, 4);
    expect(w.getLight(4, y + 2, 4).sky).toBe(MAX_LIGHT);
    expect(w.getLight(4, y - 12, 4).sky).toBe(0);
    w.dispose();
  });

  it('a shaft carries daylight straight down (column sky light)', () => {
    const seed = 5151;
    const w = mk(seed);
    w.prepareSync(0, 0, 1);
    const y = w.surfaceY(4, 4);
    for (let i = 0; i <= 8; i++) w.setBlock(4, y - i, 4, 0); // break the surface, then dig down
    w.flushLightAround(4, 4, 1);
    for (const dy of [1, 4, 8]) expect(w.getLight(4, y - dy, 4).sky).toBe(MAX_LIGHT); // down the shaft
    expect(w.getLight(5, y - 8, 4).sky).toBe(0); // the stone beside it stays dark
    expect(w.getLight(4, y - 9, 4).sky).toBe(0); // and stops at the floor
    w.dispose();
  });

  it('a placed torch lights the cave around it', () => {
    const seed = 5152;
    const w = mk(seed);
    w.prepareSync(0, 0, 1);
    const y = w.surfaceY(6, 6);
    // carve a small chamber and light it
    for (let x = 4; x <= 8; x++) for (let yy = y - 5; yy <= y - 3; yy++) for (let z = 4; z <= 8; z++) w.setBlock(x, yy, z, 0);
    w.setBlock(6, y - 4, 6, BlockId.TORCH);
    w.flushLightAround(6, 6, 1);
    expect(w.getLight(6, y - 4, 6).blockLight).toBe(14);
    expect(w.getLight(7, y - 4, 6).blockLight).toBe(13);
    expect(w.getLight(6, y - 4, 4).blockLight).toBe(12);
    expect(w.getLight(6, y - 2, 6).sky).toBe(0); // still underground
    w.dispose();
  });

  it('water and leaves dim the light that passes through them', () => {
    const seed = 5153;
    const w = mk(seed);
    w.prepareSync(0, 0, 1);
    const y = w.surfaceY(2, 2);
    w.setBlock(2, y + 1, 2, BlockId.LEAVES);
    w.flushLightAround(2, 2, 1);
    expect(w.getLight(2, y + 1, 2).sky).toBe(MAX_LIGHT - 2);
    w.setBlock(2, y + 1, 2, BlockId.STONE);
    w.flushLightAround(2, 2, 1);
    expect(w.getLight(2, y, 2).sky).toBe(0);
    w.dispose();
  });
});
