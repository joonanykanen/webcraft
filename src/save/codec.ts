/**
 * Save codec (SV-1 / SV-3): sparse block diffs, RLE compressed, base64 packed.
 * Format is versioned with a forward-migration hook (§8 "versioned schema").
 */
import { SCHEMA_VERSION } from '../core/constants.js';
import type { SaveData, WorldRecord } from '../core/types.js';
import { checksum } from '../core/rng.js';
import { keyToChunk } from '../core/constants.js';

// ---------------------------------------------------------------- varint / RLE
function writeVarint(out: number[], value: number): void {
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0xff) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function readVarint(bytes: Uint8Array, at: { i: number }): number {
  let shift = 0;
  let result = 0;
  for (;;) {
    const b = bytes[at.i++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return result;
}

/** Run-length encode a byte stream: [value, runLength(varint), ...] */
export function rleEncode(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const v = bytes[i];
    let run = 1;
    while (i + run < bytes.length && bytes[i + run] === v && run < 0xffff_ffff) run++;
    out.push(v);
    writeVarint(out, run);
    i += run;
  }
  return new Uint8Array(out);
}

export function rleDecode(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  const at = { i: 0 };
  while (at.i < bytes.length) {
    const v = bytes[at.i++];
    const run = readVarint(bytes, at);
    for (let k = 0; k < run; k++) out.push(v);
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------- base64
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- diffs
/** chunk diff → base64(RLE(varint index-delta, blockId)) */
export function encodeChunkDiff(diff: Map<number, number>): string {
  const flat: number[] = [];
  const entries = [...diff.entries()].sort((a, b) => a[0] - b[0]);
  let prev = 0;
  for (const [index, id] of entries) {
    writeVarint(flat, index - prev);
    flat.push(id);
    prev = index;
  }
  return bytesToBase64(rleEncode(new Uint8Array(flat)));
}

/** base64 diff → flat [index, id, index, id, ...] */
export function decodeChunkDiff(encoded: string): number[] {
  const bytes = rleDecode(base64ToBytes(encoded));
  const out: number[] = [];
  const at = { i: 0 };
  let index = 0;
  while (at.i < bytes.length) {
    index += readVarint(bytes, at);
    const id = bytes[at.i++];
    out.push(index, id);
  }
  return out;
}

export function encodeDiffs(diffs: Map<number, Map<number, number>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, diff] of diffs) {
    if (diff.size === 0) continue;
    const [cx, cz] = keyToChunk(key);
    out[`${cx},${cz}`] = encodeChunkDiff(diff);
  }
  return out;
}

/** Decode into a map keyed by packed chunk key, for feeding World.diffs before chunks stream in. */
export function decodeDiffs(chunks: Record<string, string>): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  for (const [k, v] of Object.entries(chunks)) {
    const parts = k.split(',');
    const cx = Number(parts[0]);
    const cz = Number(parts[1]);
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;
    const flat = decodeChunkDiff(v);
    const diff = new Map<number, number>();
    for (let i = 0; i + 1 < flat.length; i += 2) diff.set(flat[i], flat[i + 1]);
    out.set(((cx + 32768) << 16) | (cz + 32768), diff);
  }
  return out;
}

// ---------------------------------------------------------------- whole save
export function checksumOf(data: SaveData, meta: { id: string; name: string; seed: number; mode: string }): string {
  return checksum(`${meta.id}|${meta.name}|${meta.seed}|${meta.mode}|${JSON.stringify(data)}`);
}

export function makeEmptySave(player: SaveData['player']): SaveData {
  return {
    version: SCHEMA_VERSION,
    timeOfDay: 0.18,
    player,
    inventory: new Array(36).fill(null),
    selected: 0,
    chunks: {},
    chests: {},
    nextMobId: 1,
    stats: { blocksMined: 0, blocksPlaced: 0, distance: 0 },
  };
}

/** Accept older schemas and fill in anything missing (forward compatibility). */
export function migrateSave(raw: Partial<SaveData> & Record<string, unknown>): SaveData {
  const version = typeof raw.version === 'number' ? raw.version : 0;
  const base = makeEmptySave({
    pos: { x: 0.5, y: 80, z: 0.5 },
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    saturation: 5,
    air: 10,
    onGround: false,
    flying: false,
    spawn: { x: 0.5, y: 80, z: 0.5 },
    deaths: 0,
  });
  const merged: SaveData = {
    ...base,
    ...raw,
    version: SCHEMA_VERSION,
    player: { ...base.player, ...(raw.player ?? {}) },
    inventory: Array.isArray(raw.inventory) ? (raw.inventory as SaveData['inventory']).slice(0, 36) : base.inventory,
    chunks: (raw.chunks as Record<string, string>) ?? {},
    chests: (raw.chests as SaveData['chests']) ?? {},
    stats: { ...base.stats, ...((raw.stats as SaveData['stats']) ?? {}) },
  };
  if (merged.inventory.length < 36) {
    while (merged.inventory.length < 36) merged.inventory.push(null);
  }
  if (version === 0) merged.timeOfDay = 0.18;
  return merged;
}

// ---------------------------------------------------------------- file export/import (SV-3)
const FILE_TAG = 'webcraft-world';

export function worldToFile(record: WorldRecord): string {
  return JSON.stringify(
    {
      format: FILE_TAG,
      version: SCHEMA_VERSION,
      id: record.id,
      name: record.name,
      seed: record.seed,
      seedLabel: record.seedLabel,
      mode: record.mode,
      createdAt: record.createdAt,
      savedAt: Date.now(),
      playtimeMs: record.playtimeMs,
      data: record.data,
      checksum: record.checksum,
    },
    null,
    0,
  );
}

export function fileToWorld(text: string): { record: WorldRecord; warnings: string[] } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Not a readable world file: ${(err as Error).message}`);
  }
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null) throw new Error('Not a WebCraft world file.');
  const rawMeta = raw as { format?: string; data?: Record<string, unknown>; seed?: unknown; checksum?: unknown };
  if (rawMeta.format !== FILE_TAG) throw new Error('Not a WebCraft world file (missing format tag).');
  if (typeof rawMeta.data !== 'object' || rawMeta.data === null) throw new Error('World file has no save data.');
  if (typeof rawMeta.seed !== 'number' || !Number.isFinite(rawMeta.seed)) {
    throw new Error('World file has no usable seed.');
  }
  // the stored checksum covers the payload as written, so verify it before migrating
  if (rawMeta.checksum) {
    const expected = checksumOf(rawMeta.data as unknown as SaveData, {
      id: String(raw?.id ?? ''),
      name: String(raw?.name ?? ''),
      seed: rawMeta.seed,
      mode: String(raw?.mode ?? 'survival'),
    });
    if (String(rawMeta.checksum) !== expected) warnings.push('File checksum mismatch — some chunks may be damaged.');
  }
  const data = migrateSave(rawMeta.data);
  const id = `imported-${Date.now().toString(36)}`;
  const meta = {
    id,
    name: String(raw?.name ?? 'Imported World').slice(0, 24),
    seed: rawMeta.seed,
    mode: String(raw?.mode ?? 'survival'),
  };
  const record: WorldRecord = {
    id,
    name: meta.name,
    seed: meta.seed >>> 0,
    seedLabel: String(raw?.seedLabel ?? meta.seed >>> 0),
    mode: meta.mode === 'creative' ? 'creative' : 'survival',
    version: SCHEMA_VERSION,
    createdAt: Number(raw?.createdAt ?? Date.now()),
    lastPlayed: Date.now(),
    playtimeMs: Number(raw?.playtimeMs ?? 0),
    thumbnail: '',
    data,
    checksum: checksumOf(data, meta),
  };
  const fileVersion = Number(raw?.version ?? SCHEMA_VERSION);
  if (fileVersion > SCHEMA_VERSION) {
    warnings.push(`File was written by a newer WebCraft (v${fileVersion}); some data may be ignored.`);
  }
  return { record, warnings };
}

export function downloadWorldFile(record: WorldRecord): void {
  const text = worldToFile(record);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${record.name.replace(/[^\w\-]+/g, '_') || 'world'}.webcraft.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
