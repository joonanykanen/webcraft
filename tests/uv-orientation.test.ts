/**
 * Vertical UV convention (RD-3). The atlas is uploaded with flipY = false because the block shader
 * derives a tile's row from the tile index counting down the canvas, so the vertical mirror has to
 * happen inside the tile: `fv = (1.0 - aUV.y) * 0.9375 + 0.03125` in CHUNK_VERT. That only produces
 * right-way-up art if every quad written by the mesher gives its HIGHEST vertex the LARGEST aUV.y.
 *
 * This is the invariant behind "the grass fringe grows at the top of the block, not the bottom" and
 * "a torch's flame is at the top of the stick". The rendered-pixel version lives in the browser smoke
 * test; the geometry half — which also covers hand-built cross quads for torches and plants — is here.
 */
import { describe, expect, it } from 'vitest';
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, blockIndex } from '../src/core/constants.js';
import { BlockId } from '../src/world/blocks.js';
import { Chunk } from '../src/world/chunk.js';
import { buildChunkMesh } from '../src/world/mesher.js';
import { relightChunk } from '../src/world/lighting.js';
import { CHUNK_VERT } from '../src/render/shaders.js';
import type { MeshData } from '../src/core/types.js';

function chunkWith(paint: (x: number, y: number, z: number) => number): Chunk {
  const c = new Chunk(0, 0);
  for (let x = 0; x < CHUNK_SX; x++)
    for (let z = 0; z < CHUNK_SZ; z++)
      for (let y = 0; y < CHUNK_SY; y++) {
        const id = paint(x, y, z);
        if (id) c.blocks[blockIndex(x, y, z)] = id;
      }
  c.recomputeHeights();
  relightChunk({ getChunk: (cx: number, cz: number) => (cx === 0 && cz === 0 ? c : undefined), markDirty: () => {} } as never, c);
  return c;
}

type Quad = { tile: number; ys: number[]; vs: number[] };

function quadsOf(data: MeshData | null): Quad[] {
  if (!data) return [];
  const out: Quad[] = [];
  for (let q = 0; q + 5 < data.index.length; q += 6) {
    const v = [data.index[q], data.index[q + 1], data.index[q + 2], data.index[q + 3]];
    out.push({
      tile: data.tile[v[0]],
      ys: v.map((i) => data.position[i * 3 + 1]),
      vs: v.map((i) => data.uv[i * 2 + 1]),
    });
  }
  return out;
}

/** Quads that actually have a top and a bottom (flat faces carry no vertical information). */
function upright(quads: Quad[]): Quad[] {
  return quads.filter((q) => Math.max(...q.ys) - Math.min(...q.ys) > 0.5);
}

describe('vertical UV convention', () => {
  it('gives the highest vertex of every face the largest v', () => {
    const paint = (x: number, y: number, z: number): number =>
      x === 4 && y === 40 && z === 4 ? BlockId.STONE : x >= 6 && x <= 8 && y === 41 && z === 6 ? BlockId.GRASS : 0;
    const mesh = buildChunkMesh({ getChunk: () => undefined } as never, chunkWith(paint), 'fancy');
    const list = upright(quadsOf(mesh.opaque));
    expect(list.length).toBeGreaterThan(4);
    for (const q of list) {
      const topIdx = q.ys.indexOf(Math.max(...q.ys));
      const bottomIdx = q.ys.indexOf(Math.min(...q.ys));
      expect(q.vs[topIdx]).toBeGreaterThan(q.vs[bottomIdx]);
      expect(q.vs[topIdx]).toBeCloseTo(1, 4);
      expect(q.vs[bottomIdx]).toBeCloseTo(0, 4);
    }
  });

  it('gives the top of a torch the largest v, so its flame points up', () => {
    // Cross geometry is written by hand in the mesher, so it needs its own assertion: the tile is the
    // torch, the quad spans the block vertically, and the flame is painted at the top of that tile.
    const mesh = buildChunkMesh(
      { getChunk: () => undefined } as never,
      chunkWith((x, y, z) => (x === 8 && y === 41 && z === 8 ? BlockId.TORCH : x === 8 && y === 40 && z === 8 ? BlockId.STONE : 0)),
      'fancy',
    );
    const torchQuads = upright(quadsOf(mesh.opaque)).filter((q) => q.tile === 18);
    expect(torchQuads.length).toBeGreaterThanOrEqual(2);
    for (const q of torchQuads) {
      const topIdx = q.ys.indexOf(Math.max(...q.ys));
      expect(q.vs[topIdx]).toBeGreaterThan(0.9);
      // the quad covers the full block height, so the flame cannot be squashed into the base
      expect(Math.max(...q.ys) - Math.min(...q.ys)).toBeCloseTo(1, 3);
    }
  });

  it('the shader mirrors within the tile, and only within the tile', () => {
    // The mesher's convention and the shader's mirror are two halves of one fact. A whole-texture flip
    // would resolve every tile to its mirrored row, so assert the mirror stays inside the tile maths.
    expect(CHUNK_VERT).toContain('(1.0 - aUV.y)');
    expect(CHUNK_VERT).toMatch(/tilePos = vec2\(mod\(aTile, 8\.0\), floor\(aTile \/ 8\.0\)\)/);
  });
});
