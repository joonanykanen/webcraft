/** Save format: varint + RLE + base64 sparse diffs, checksums, migration, file round-trip (SV-1 … SV-4). */
import { describe, expect, it } from 'vitest';
import { CHUNK_VOL, SCHEMA_VERSION } from '../src/core/constants.js';
import { mulberry32 } from '../src/core/rng.js';
import {
  base64ToBytes,
  bytesToBase64,
  checksumOf,
  decodeChunkDiff,
  decodeDiffs,
  encodeChunkDiff,
  encodeDiffs,
  fileToWorld,
  makeEmptySave,
  migrateSave,
  rleDecode,
  rleEncode,
  worldToFile,
} from '../src/save/codec.js';
import { World } from '../src/world/world.js';
import { SyncGenPool } from '../src/workers/pool.js';
import type { WorldRecord } from '../src/core/types.js';

function diffPairs(flat: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i + 1 < flat.length; i += 2) m.set(flat[i], flat[i + 1]);
  return m;
}

describe('rle / varint / base64', () => {
  it('round-trips random and repetitive streams', () => {
    const rng = mulberry32(99);
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([7]),
      new Uint8Array(4096), // all zeros
      Uint8Array.from({ length: 1024 }, () => Math.floor(rng() * 256)),
      Uint8Array.from({ length: 512 }, (_, i) => i % 3),
    ];
    for (const bytes of cases) {
      expect(Array.from(rleDecode(rleEncode(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('compresses long runs', () => {
    const long = new Uint8Array(8192); // one giant run of zeros
    const enc = rleEncode(long);
    expect(enc.length).toBeLessThan(8);
    expect(rleDecode(enc).length).toBe(8192);
  });

  it('base64 is byte exact for every value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(base64ToBytes(bytesToBase64(all)))).toEqual(Array.from(all));
  });
});

describe('chunk diffs', () => {
  it('round-trips sparse edits (including large indices)', () => {
    const diff = new Map<number, number>([
      [0, 1],
      [1, 3],
      [127, 12],
      [128, 13],
      [4096, 20],
      [CHUNK_VOL - 1, 24],
    ]);
    const back = diffPairs(decodeChunkDiff(encodeChunkDiff(diff)));
    expect([...back.entries()].sort((a, b) => a[0] - b[0])).toEqual([...diff.entries()].sort((a, b) => a[0] - b[0]));
  });

  it('empty diffs stay empty', () => {
    expect(decodeChunkDiff(encodeChunkDiff(new Map()))).toEqual([]);
    expect(encodeDiffs(new Map([[1, new Map()]]))).toEqual({});
  });

  it('every block id survives', () => {
    const diff = new Map<number, number>();
    for (let id = 0; id < 25; id++) diff.set(id * 101, id);
    expect(diffPairs(decodeChunkDiff(encodeChunkDiff(diff)))).toEqual(diff);
  });

  it('encodeDiffs/decodeDiffs keeps negative chunk coords', () => {
    const diffs = new Map<number, Map<number, number>>([
      [(((0 + 32768) << 16) | (0 + 32768)), new Map([[5, 3]])],
      [(((-7 + 32768) << 16) | (1234 + 32768)), new Map([[600, 9]])],
    ]);
    const back = decodeDiffs(encodeDiffs(diffs));
    expect(back.size).toBe(2);
    expect(back.get(((-7 + 32768) << 16) | (1234 + 32768))?.get(600)).toBe(9);
  });
});

describe('world diffs survive a reload (SV-2)', () => {
  it('edits are replayed into freshly generated chunks', () => {
    const seed = 6060;
    const a = new World({ seed, pool: new SyncGenPool(seed), sink: null, renderDistance: 3, quality: 'fast' });
    a.prepareSync(8, 8, 1);
    const y = a.surfaceY(4, 4);
    expect(y).toBeGreaterThan(4);
    a.setBlock(4, y + 2, 4, 20); // crafting table floating in the air
    a.setBlock(4, y + 3, 4, 18); // torch
    a.setBlock(9, y + 1, 9, 0); // dig a hole
    const ground = a.getBlock(4, y, 4);
    const serialized = a.serializeChunks();
    expect(Object.keys(serialized).length).toBeGreaterThan(0);
    a.dispose();

    const b = new World({ seed, pool: new SyncGenPool(seed), sink: null, renderDistance: 3, quality: 'fast' });
    b.applyDiffsFromSave(serialized);
    b.prepareSync(8, 8, 1);
    expect(b.getBlock(4, y + 2, 4)).toBe(20);
    expect(b.getBlock(4, y + 3, 4)).toBe(18);
    expect(b.getBlock(9, y + 1, 9)).toBe(0);
    // untouched blocks in the same column regenerate identically from the seed
    expect(b.getBlock(4, y, 4)).toBe(ground);
    b.dispose();
  });

  it('diffs are per chunk, so the payload stays small', () => {
    const seed = 717;
    const w = new World({ seed, pool: new SyncGenPool(seed), sink: null, renderDistance: 2, quality: 'fast' });
    w.prepareSync(0, 0, 0);
    w.setBlock(2, 70, 2, 16);
    const encoded = w.serializeChunks();
    expect(Object.keys(encoded).length).toBe(1);
    expect((encoded['0,0'] ?? '').length).toBeLessThan(24);
    w.dispose();
  });
});

describe('save integrity & migration (SV-4)', () => {
  const meta = { id: 'w1', name: 'Test', seed: 42, mode: 'survival' };

  it('checksum detects any change', () => {
    const data = makeEmptySave({
      pos: { x: 0, y: 70, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 20,
      food: 20,
      saturation: 5,
      air: 10,
      onGround: true,
      flying: false,
      spawn: { x: 0, y: 70, z: 0 },
      deaths: 0,
    });
    const sum = checksumOf(data, meta);
    expect(sum).toBe(checksumOf(data, meta));
    data.timeOfDay = 0.5;
    expect(checksumOf(data, meta)).not.toBe(sum);
  });

  it('migrateSave fills missing fields from an old payload', () => {
    const old = { version: 1, chunks: {}, player: { pos: { x: 1, y: 2, z: 3 } } } as never;
    const fixed = migrateSave(old);
    expect(fixed.version).toBe(SCHEMA_VERSION);
    expect(fixed.inventory.length).toBe(36);
    expect(fixed.player.pos).toEqual({ x: 1, y: 2, z: 3 });
    expect(fixed.chests).toEqual({});
    expect(fixed.stats).toMatchObject({ blocksMined: 0 });
  });

  it('file export/import is lossless', () => {
    const record: WorldRecord = {
      id: 'w1',
      name: 'Round Trip',
      seed: 1234,
      seedLabel: '1234',
      mode: 'creative',
      version: SCHEMA_VERSION,
      createdAt: 1,
      lastPlayed: 2,
      playtimeMs: 3,
      thumbnail: 'data:,',
      data: makeEmptySave({
        pos: { x: 0, y: 70, z: 0 },
        yaw: 1,
        pitch: 0.5,
        health: 12,
        food: 8,
        saturation: 1,
        air: 9,
        onGround: true,
        flying: false,
        spawn: { x: 0, y: 70, z: 0 },
        deaths: 2,
      }),
      checksum: '',
    };
    record.data.chunks['0,0'] = encodeChunkDiff(new Map([[100, 22]]));
    record.data.chests['1,2,3'] = [{ id: 21, count: 2 }, null];
    record.checksum = checksumOf(record.data, record);

    const { record: back, warnings } = fileToWorld(worldToFile(record));
    expect(warnings).toEqual([]);
    expect(back.seed).toBe(1234);
    expect(back.data.chunks['0,0']).toBe(record.data.chunks['0,0']);
    expect(back.data.chests['1,2,3']?.[0]?.count).toBe(2);
    expect(back.data.player.health).toBe(12);
  });

  it('a corrupt file is reported, not silently accepted', () => {
    expect(() => fileToWorld('{"nope": true}')).toThrow();
    expect(() => fileToWorld('not json at all')).toThrow();
  });
});
