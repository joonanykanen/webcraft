/**
 * IndexedDB persistence (SV-1 / SV-2). Records are checksummed so a corrupted write can be
 * detected and reported instead of silently destroying a world (Risk-2).
 */
import { MAX_WORLD_SLOTS, SCHEMA_VERSION } from '../core/constants.js';
import type { WorldRecord } from '../core/types.js';
import { checksumOf } from './codec.js';

const DB_NAME = 'webcraft';
const DB_VERSION = 1;
const STORE = 'worlds';

let dbPromise: Promise<IDBDatabase> | null = null;

export function idbSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!idbSupported()) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('lastPlayed', 'lastPlayed');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

export interface LoadResult {
  record: WorldRecord;
  corrupted: boolean;
  migrated: boolean;
}

export async function listWorlds(): Promise<LoadResult[]> {
  const all = await tx<WorldRecord[]>('readonly', (s) => s.getAll() as IDBRequest<WorldRecord[]>);
  const out: LoadResult[] = [];
  for (const r of all) {
    const migrated = r.version !== SCHEMA_VERSION;
    const corrupted = checksumOf(r.data, r) !== r.checksum;
    out.push({ record: { ...r, version: SCHEMA_VERSION }, corrupted, migrated });
  }
  out.sort((a, b) => b.record.lastPlayed - a.record.lastPlayed);
  return out.slice(0, MAX_WORLD_SLOTS);
}

export async function getWorld(id: string): Promise<LoadResult | null> {
  const r = await tx<WorldRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<WorldRecord | undefined>);
  if (!r) return null;
  const corrupted = checksumOf(r.data, r) !== r.checksum;
  return { record: { ...r, version: SCHEMA_VERSION }, corrupted, migrated: r.version !== SCHEMA_VERSION };
}

export async function putWorld(record: WorldRecord): Promise<void> {
  const withChecksum: WorldRecord = { ...record, checksum: checksumOf(record.data, record) };
  await tx('readwrite', (s) => s.put(withChecksum) as IDBRequest);
}

export async function deleteWorld(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id) as IDBRequest);
}

export async function worldCount(): Promise<number> {
  return (await tx<number>('readonly', (s) => s.count() as IDBRequest<number>)) ?? 0;
}

export async function exportWorld(id: string): Promise<WorldRecord | null> {
  const r = await getWorld(id);
  return r ? r.record : null;
}

export function rechecksum(record: WorldRecord): string {
  return checksumOf(record.data, record);
}

/** Best-effort storage quota indicator for the settings screen. */
export async function storageEstimate(): Promise<{ usageMb: number; quotaMb: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const e = await navigator.storage.estimate();
    return { usageMb: (e.usage ?? 0) / 1e6, quotaMb: (e.quota ?? 0) / 1e6 };
  } catch {
    return null;
  }
}
