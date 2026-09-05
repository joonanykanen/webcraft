/** Face-culled + run-merged chunk meshing: geometry must cover exactly the exposed surface (RE-1, RE-2). */
import { describe, expect, it } from 'vitest';
import { ATLAS_TILES, CHUNK_SX, CHUNK_SZ, CHUNK_SY, blockIndex } from '../src/core/constants.js';
import { Chunk } from '../src/world/chunk.js';
import { BlockId, isOpaque } from '../src/world/blocks.js';
import { buildChunkMesh } from '../src/world/mesher.js';
import { relightChunk } from '../src/world/lighting.js';

const STONE = BlockId.STONE;

function chunkWith(paint: (x: number, y: number, z: number) => number): Chunk {
  const c = new Chunk(0, 0);
  for (let x = 0; x < CHUNK_SX; x++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let y = 0; y < CHUNK_SY; y++) {
        const id = paint(x, y, z);
        if (id) c.blocks[blockIndex(x, y, z)] = id;
      }
    }
  }
  c.recomputeHeights();
  relightChunk({ getChunk: (cx, cz) => (cx === 0 && cz === 0 ? c : undefined), markDirty: () => {} }, c);
  return c;
}

/** Exposed surface area per axis, computed the naive way (one face per neighbour check). */
function naiveArea(paint: (x: number, y: number, z: number) => number): [number, number, number] {
  const solid = (x: number, y: number, z: number): boolean => (y < 0 ? true : isOpaque(paint(x, y, z)));
  const area: [number, number, number] = [0, 0, 0];
  for (let x = 0; x < CHUNK_SX; x++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let y = 0; y < CHUNK_SY; y++) {
        if (!isOpaque(paint(x, y, z))) continue;
        if (!solid(x - 1, y, z)) area[0]++;
        if (!solid(x + 1, y, z)) area[0]++;
        if (!solid(x, y - 1, z)) area[1]++;
        if (!solid(x, y + 1, z)) area[1]++;
        if (!solid(x, y, z - 1)) area[2]++;
        if (!solid(x, y, z + 1)) area[2]++;
      }
    }
  }
  return area;
}

/** Area per axis derived from the emitted triangles (run-merge invariant). */
function meshArea(position: Float32Array, index: Uint32Array): [number, number, number] {
  const area: [number, number, number] = [0, 0, 0];
  for (let t = 0; t + 2 < index.length; t += 3) {
    const ax = position[index[t] * 3];
    const ay = position[index[t] * 3 + 1];
    const az = position[index[t] * 3 + 2];
    const bx = position[index[t + 1] * 3];
    const by = position[index[t + 1] * 3 + 1];
    const bz = position[index[t + 1] * 3 + 2];
    const cx = position[index[t + 2] * 3];
    const cy = position[index[t + 2] * 3 + 1];
    const cz = position[index[t + 2] * 3 + 2];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const cross = Math.hypot(nx, ny, nz);
    // two triangles per quad, each cross product = parallelogram area
    if (nx !== 0) area[0] += cross / 2;
    if (ny !== 0) area[1] += cross / 2;
    if (nz !== 0) area[2] += cross / 2;
  }
  return [Math.round(area[0]), Math.round(area[1]), Math.round(area[2])];
}

function quads(index: Uint32Array): number {
  return index.length / 6;
}

function validate(mesh: ReturnType<typeof buildChunkMesh>): void {
  for (const data of [mesh.opaque, mesh.water]) {
    if (!data) continue;
    const verts = data.position.length / 3;
    expect(data.uv.length).toBe(verts * 2);
    expect(data.tile.length).toBe(verts);
    expect(data.light.length).toBe(verts * 2);
    expect(data.tint.length).toBe(verts);
    expect(data.index.length % 6).toBe(0);
    for (const i of data.index) expect(i).toBeLessThan(verts);
    for (const t of data.tile) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(ATLAS_TILES * ATLAS_TILES);
    }
    for (const l of data.light) expect(l).toBeLessThanOrEqual(255); // normalized bytes
  }
}

describe('chunk meshing', () => {
  it('emits exactly the exposed surface for a single block', () => {
    const paint = (x: number, y: number, z: number): number => (x === 4 && y === 40 && z === 4 ? STONE : 0);
    const mesh = buildChunkMesh({ getChunk: () => undefined }, chunkWith(paint), 'fast');
    validate(mesh);
    expect(mesh.opaque).not.toBeNull();
    const got = meshArea(mesh.opaque!.position, mesh.opaque!.index);
    expect(got).toEqual(naiveArea(paint));
    expect(quads(mesh.opaque!.index)).toBe(6);
  });

  it('culls faces between touching blocks', () => {
    const paint = (x: number, y: number, z: number): number => ((x === 4 || x === 5) && y === 40 && z === 4 ? STONE : 0);
    const mesh = buildChunkMesh({ getChunk: () => undefined }, chunkWith(paint), 'fast');
    const got = meshArea(mesh.opaque!.position, mesh.opaque!.index);
    expect(got).toEqual(naiveArea(paint));
    expect(got[0]).toBe(2); // the shared interface is gone
    expect(got[1]).toBe(4);
    expect(got[2]).toBe(4);
  });

  it('matches naive face culling for a random blob', () => {
    let s = 0x1234;
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const map = new Map<string, number>();
    for (let i = 0; i < 140; i++) {
      map.set(`${Math.floor(rnd() * 12)},${30 + Math.floor(rnd() * 12)},${Math.floor(rnd() * 12)}`, STONE);
    }
    const paint = (x: number, y: number, z: number): number => map.get(`${x},${y},${z}`) ?? 0;
    const mesh = buildChunkMesh({ getChunk: () => undefined }, chunkWith(paint), 'fast');
    validate(mesh);
    expect(meshArea(mesh.opaque!.position, mesh.opaque!.index)).toEqual(naiveArea(paint));
  });

  it('run merging keeps the covered area but drops the quad count (RE-2)', () => {
    const paint = (x: number, y: number, z: number): number =>
      x >= 0 && x < 4 && y >= 0 && y < 4 && z >= 0 && z < 4 ? STONE : 0; // 4×4×4 cube = 96 faces
    const naive = naiveArea(paint);
    // 96 shell faces minus the 16 hidden bottoms at y=0 (below the world is treated as solid)
    expect(naive[0] + naive[1] + naive[2]).toBe(80);
    const mesh = buildChunkMesh({ getChunk: () => undefined }, chunkWith(paint), 'fast');
    expect(meshArea(mesh.opaque!.position, mesh.opaque!.index)).toEqual(naive);
    const fast = quads(mesh.opaque!.index);
    expect(fast).toBeLessThanOrEqual(24); // 80 faces merged into a handful of quads
    const fancy = buildChunkMesh({ getChunk: () => undefined }, chunkWith(paint), 'fancy');
    expect(meshArea(fancy.opaque!.position, fancy.opaque!.index)).toEqual(naive);
    // fancy keeps per-block quads so that per-vertex AO can vary
    expect(quads(fancy.opaque!.index)).toBeGreaterThan(fast);
  });

  it('keeps water in its own transparent layer', () => {
    const paint = (x: number, y: number, z: number): number =>
      x >= 0 && x < 6 && y === 50 && z >= 0 && z < 6 ? BlockId.WATER : 0;
    const mesh = buildChunkMesh({ getChunk: () => undefined }, chunkWith(paint), 'fancy');
    validate(mesh);
    expect(mesh.water).not.toBeNull();
    expect(mesh.opaque).toBeNull();
  });

  it('does not emit geometry for fully enclosed blocks', () => {
    const paint = (x: number, y: number, z: number): number =>
      x >= 0 && x < 8 && y >= 20 && y < 28 && z >= 0 && z < 8 ? STONE : 0;
    const mesh = buildChunkMesh({ getChunk: () => undefined }, chunkWith(paint), 'fancy');
    validate(mesh);
    const area = meshArea(mesh.opaque!.position, mesh.opaque!.index);
    // only the outer shell survives: 8×8 top+bottom, 4 walls of 8×8
    expect(area[1]).toBe(128);
    expect(area[0]).toBe(128);
    expect(area[2]).toBe(128);
  });

  it('ambient occlusion darkens corners in fancy mode but not in fast mode', () => {
    const paint = (x: number, y: number, z: number): number => {
      if (y === 40 && x >= 0 && x < 5 && z >= 0 && z < 5) return STONE; // flat slab
      if (x === 2 && y === 41 && z === 2) return STONE; // pillar foot on the slab
      return 0;
    };
    const fancy = buildChunkMesh({ getChunk: () => undefined }, chunkWith(paint), 'fancy');
    const fast = buildChunkMesh({ getChunk: () => undefined }, chunkWith(paint), 'fast');
    validate(fancy);
    validate(fast);
    const distinct = (t: Uint8Array): number => new Set(Array.from(t)).size;
    const fancyTints = fancy.opaque!.tint;
    const fastTints = fast.opaque!.tint;
    // fast: one flat shade per face direction. fancy: AO adds partial corner darkening.
    expect(distinct(fastTints)).toBeLessThanOrEqual(4); // one flat shade per face direction
    expect(distinct(fancyTints)).toBeGreaterThan(distinct(fastTints)); // AO corners near the pillar
    expect(Math.max(...Array.from(fancyTints))).toBeLessThanOrEqual(255);
    expect(Math.min(...Array.from(fancyTints))).toBeGreaterThan(0);
  });

  it('writes light into the vertices it emits', () => {
    const paint = (x: number, y: number, z: number): number =>
      y === 40 && x >= 0 && x < 4 && z >= 0 && z < 4 ? STONE : 0;
    const mesh = buildChunkMesh({ getChunk: () => undefined }, chunkWith(paint), 'fancy');
    const light = mesh.opaque!.light;
    let skyHigh = 0;
    for (let i = 0; i < light.length; i += 2) if (light[i] === 255) skyHigh++; // level 15 → byte 255
    expect(skyHigh).toBeGreaterThan(0); // sunlit top faces
  });
});
