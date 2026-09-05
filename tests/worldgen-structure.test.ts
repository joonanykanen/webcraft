/**
 * Structural invariants of generated terrain (WG-5).
 *
 * These exist because the decorator once planted trunks one block too low: every in-chunk
 * tree was rejected by the "surface must be the surface block" check, so chunks ended up
 * with nothing but the canopy edges that leaked in from their neighbours — trunks: 0.
 * Golden hashes happily stayed stable through that, so hashes alone are not enough.
 */
import { describe, expect, it } from 'vitest';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, CHUNK_VOL } from '../src/core/constants.js';
import { BlockId } from '../src/world/blocks.js';
import { generateChunk, terrainContext } from '../src/world/worldgen.js';

interface Region {
  side: number;
  get: (x: number, y: number, z: number) => number;
  counts: Map<number, number>;
}

/** Stitch an n×n chunk area into one addressable volume (chunk coords 0..n-1). */
function generateRegion(seed: number, n: number): Region {
  const side = n * CHUNK_SX;
  const blocks = new Uint8Array(side * side * CHUNK_SY);
  const scratch = new Uint8Array(CHUNK_VOL);
  const flat = new Uint8Array(CHUNK_SX * CHUNK_SZ);
  for (let cx = 0; cx < n; cx++) {
    for (let cz = 0; cz < n; cz++) {
      scratch.fill(0);
      generateChunk(seed, cx, cz, scratch, flat, flat);
      for (let x = 0; x < CHUNK_SX; x++) {
        for (let z = 0; z < CHUNK_SZ; z++) {
          const src = (x * CHUNK_SZ + z) * CHUNK_SY;
          const dst = ((cx * CHUNK_SX + x) * side + (cz * CHUNK_SZ + z)) * CHUNK_SY;
          blocks.set(scratch.subarray(src, src + CHUNK_SY), dst);
        }
      }
    }
  }
  const get = (x: number, y: number, z: number): number => {
    if (x < 0 || z < 0 || y < 0 || x >= side || z >= side || y >= CHUNK_SY) return -1;
    return blocks[(x * side + z) * CHUNK_SY + y];
  };
  const counts = new Map<number, number>();
  for (let i = 0; i < blocks.length; i++) counts.set(blocks[i], (counts.get(blocks[i]) ?? 0) + 1);
  return { side, get, counts };
}

const MARGIN = 3; // cross-chunk canopy edges legitimately hang over the area border

function forEachInArea(r: Region, fn: (x: number, y: number, z: number, block: number) => void): void {
  for (let x = MARGIN; x < r.side - MARGIN; x++) {
    for (let z = MARGIN; z < r.side - MARGIN; z++) {
      for (let y = 1; y < CHUNK_SY; y++) {
        const b = r.get(x, y, z);
        if (b !== 0 && b !== BlockId.WATER) fn(x, y, z, b);
      }
    }
  }
}

describe('generated tree structure (WG-5)', () => {
  const r = generateRegion(1337, 4);

  it('grows tree trunks at all', () => {
    const logs = r.counts.get(BlockId.LOG) ?? 0;
    const leaves = r.counts.get(BlockId.LEAVES) ?? 0;
    expect(logs).toBeGreaterThan(0);
    expect(leaves).toBeGreaterThan(0);
    // a canopy is roughly 40-90 leaves around a 4-7 block trunk; "leaves with no trunk"
    // showed up as logs = 0 / leaves = 500 before the decorator was fixed
    expect(logs).toBeGreaterThan(leaves / 20);
  });

  it('never leaves a leaf floating in the air without a trunk nearby', () => {
    const floating: string[] = [];
    forEachInArea(r, (x, y, z, block) => {
      if (block !== BlockId.LEAVES) return;
      // canopy reaches 2 cells out from the trunk and the trunk spans up to 7 blocks
      for (let dx = -3; dx <= 3 && floating.length < 5; dx++) {
        for (let dz = -3; dz <= 3 && floating.length < 5; dz++) {
          for (let dy = -4; dy <= 4; dy++) {
            if (r.get(x + dx, y + dy, z + dz) === BlockId.LOG) return;
          }
        }
      }
      floating.push(`${x},${y},${z}`);
    });
    expect(floating).toEqual([]);
  });

  it('stands every trunk on solid ground with no gaps in the column', () => {
    let columns = 0;
    const broken: string[] = [];
    for (let x = MARGIN; x < r.side - MARGIN; x++) {
      for (let z = MARGIN; z < r.side - MARGIN; z++) {
        const column: number[] = [];
        for (let y = 1; y < CHUNK_SY; y++) if (r.get(x, y, z) === BlockId.LOG) column.push(y);
        if (!column.length) continue;
        columns++;
        for (let i = 1; i < column.length; i++) {
          if (column[i] !== column[i - 1] + 1) broken.push(`gap at ${x},${z}: ${column[i - 1]} -> ${column[i]}`);
        }
        const below = r.get(x, column[0] - 1, z);
        if (below === -1 || below === 0 || below === BlockId.LOG || below === BlockId.LEAVES) {
          broken.push(`trunk foot at ${x},${z},${column[0]} sits on ${below}`);
        }
      }
    }
    expect(columns).toBeGreaterThan(4);
    expect(broken).toEqual([]);
  });

  it('never lets a trunk poke out through the canopy', () => {
    let tips = 0;
    forEachInArea(r, (x, y, z, block) => {
      if (block !== BlockId.LOG) return;
      if (r.get(x, y + 1, z) === BlockId.LOG) return; // not the top of this trunk
      tips++;
      // a bare log tip reads as a brown stump sitting on the leaf plate
      expect(r.get(x, y + 1, z), `log tip at ${x},${y},${z}`).toBe(BlockId.LEAVES);
    });
    expect(tips).toBeGreaterThan(0);
  });

  it('places cacti on desert sand', () => {
    // Find a desert column with the (cheap) climate model, then generate the 3x3 chunk
    // neighbourhood around it and look for cactus. Scanning whole worlds for a rare biome
    // would be slow; scanning columns is free.
    const ctx = terrainContext(7);
    let spot: { x: number; z: number } | null = null;
    outer: for (let x = -600; x <= 600; x += 5) {
      for (let z = -600; z <= 600; z += 5) {
        const col = ctx.column(x, z);
        if (col.biome === 4 /* DESERT */) {
          spot = { x, z };
          break outer;
        }
      }
    }
    expect(spot, 'a desert must exist somewhere in the world').not.toBeNull();
    const at = spot as { x: number; z: number };

    // generate the 3x3 chunk area around the desert column into one buffer
    const cx0 = Math.floor(at.x / CHUNK_SX) - 1;
    const cz0 = Math.floor(at.z / CHUNK_SZ) - 1;
    const side = 3 * CHUNK_SX;
    const blocks = new Uint8Array(side * side * CHUNK_SY);
    const scratch = new Uint8Array(CHUNK_VOL);
    const flat = new Uint8Array(CHUNK_SX * CHUNK_SZ);
    for (let cx = cx0; cx < cx0 + 3; cx++) {
      for (let cz = cz0; cz < cz0 + 3; cz++) {
        scratch.fill(0); // generateChunk only writes columns up to the surface; leftovers would leak
        generateChunk(7, cx, cz, scratch, flat, flat);
        for (let x = 0; x < CHUNK_SX; x++) {
          for (let z = 0; z < CHUNK_SZ; z++) {
            const src = (x * CHUNK_SZ + z) * CHUNK_SY;
            const dst = ((cx - cx0) * CHUNK_SX + x) * side * CHUNK_SY + ((cz - cz0) * CHUNK_SZ + z) * CHUNK_SY;
            blocks.set(scratch.subarray(src, src + CHUNK_SY), dst);
          }
        }
      }
    }
    let cacti = 0;
    let badBase = 0;
    // stay one column inside the area: decor at the border legitimately belongs to a chunk
    // we did not generate
    for (let x = 1; x < side - 1; x++) {
      for (let z = 1; z < side - 1; z++) {
        for (let y = 1; y < CHUNK_SY; y++) {
          if (blocks[(x * side + z) * CHUNK_SY + y] !== BlockId.CACTUS) continue;
          cacti++;
          const below = blocks[(x * side + z) * CHUNK_SY + y - 1];
          if (below !== BlockId.SAND && below !== BlockId.SANDSTONE && below !== BlockId.CACTUS) badBase++;
        }
      }
    }
    expect(cacti).toBeGreaterThan(0);
    expect(badBase).toBe(0);
  });

  it('keeps trunk feet on the surface block of their own column', () => {
    // the surface convention (col.h = the surface block itself) is what broke in the first
    // place: a foot planted below it would be buried in dirt
    const wrong: string[] = [];
    forEachInArea(r, (x, y, z, block) => {
      if (block !== BlockId.LOG) return;
      if (r.get(x, y - 1, z) !== BlockId.LOG) {
        const foot = r.get(x, y - 1, z);
        if (foot !== BlockId.GRASS && foot !== BlockId.DIRT && foot !== BlockId.SNOW && foot !== BlockId.SAND) {
          wrong.push(`${x},${y},${z} foot=${foot}`);
        }
      }
    });
    expect(wrong).toEqual([]);
  });
});

describe('biome coverage (WG-3)', () => {
  it('every biome actually occurs in the world', () => {
    // The climate thresholds used to be so tight that desert covered 1.5% of the map and
    // snow 3%, i.e. a player might never see them. Sample the climate over a wide area.
    const share = new Map<number, number>();
    for (const seed of [7, 1337]) {
      const ctx = terrainContext(seed);
      const seen = new Map<number, number>();
      let n = 0;
      for (let x = -1400; x <= 1400; x += 11) {
        for (let z = -1400; z <= 1400; z += 11) {
          seen.set(ctx.column(x, z).biome, (seen.get(ctx.column(x, z).biome) ?? 0) + 1);
          n++;
        }
      }
      for (const [b, c] of seen) share.set(b, Math.max(share.get(b) ?? 0, c / n));
    }
    for (let biome = 0; biome < 7; biome++) {
      expect(share.get(biome) ?? 0, `biome ${biome} never occurs`).toBeGreaterThan(0.01);
    }
  });

  it('deserts are hot and sandy, snow is cold', () => {
    const ctx = terrainContext(7);
    let desert = 0;
    let desertSandy = 0;
    let snow = 0;
    for (let x = -1200; x <= 1200; x += 9) {
      for (let z = -1200; z <= 1200; z += 9) {
        const c = ctx.column(x, z);
        if (c.biome === 4 /* DESERT */) {
          desert++;
          if (c.surface === BlockId.SAND) desertSandy++;
        }
        if (c.biome === 6 /* SNOW */) snow++;
      }
    }
    expect(desert).toBeGreaterThan(10);
    expect(desertSandy).toBe(desert);
    expect(snow).toBeGreaterThan(10);
  });
});
