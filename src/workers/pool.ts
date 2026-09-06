/**
 * Worker pool for terrain generation, with a synchronous fallback so the game still runs if
 * Workers are unavailable (Tier-2 environments / restrictive embeds).
 */
import { CHUNK_SX, CHUNK_SZ, CHUNK_VOL } from '../core/constants.js';
import type { GenRequest, GenResponse, WorkerError } from '../core/types.js';
import { generateEditedChunk } from '../world/worldgen.js';
import type { GenPool } from '../world/world.js';

type Done = (cx: number, cz: number, blocks: Uint8Array, biome: Uint8Array, height: Uint8Array) => void;

export class ChunkWorkerPool implements GenPool {
  private workers: Worker[] = [];
  private jobs = new Map<number, Done>();
  private pendingKeys = new Set<number>();
  private nextWorker = 0;
  private nextJob = 1;
  private seed: number;
  lastJobMs = 0;

  constructor(seed: number, size?: number) {
    this.seed = seed >>> 0;
    const n = size ?? Math.max(2, Math.min(4, (navigator.hardwareConcurrency ?? 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<GenResponse | WorkerError>) => this.onMessage(e.data);
      w.onerror = (e) => console.error('chunk worker error', e.message);
      this.workers.push(w);
    }
  }

  static supported(): boolean {
    return typeof Worker !== 'undefined' && typeof URL !== 'undefined';
  }

  private onMessage(data: GenResponse | WorkerError): void {
    if (data.type === 'error') {
      console.error('chunk generation failed:', data.message);
      this.jobs.delete(data.jobId);
      return;
    }
    const cb = this.jobs.get(data.jobId);
    this.jobs.delete(data.jobId);
    this.pendingKeys.delete(keyOf(data.cx, data.cz));
    this.lastJobMs = data.ms;
    if (!cb) return;
    cb(data.cx, data.cz, new Uint8Array(data.blocks), new Uint8Array(data.biome), new Uint8Array(data.height));
  }

  request(cx: number, cz: number, diff: number[], cb: Done): void {
    if (this.workers.length === 0) {
      SyncGenPool.generate(this.seed, cx, cz, diff, cb);
      return;
    }
    const jobId = this.nextJob++;
    this.jobs.set(jobId, cb);
    this.pendingKeys.add(keyOf(cx, cz));
    const req: GenRequest = { type: 'gen', jobId, cx, cz, seed: this.seed, diff };
    const w = this.workers[this.nextWorker % this.workers.length];
    this.nextWorker++;
    w.postMessage(req);
  }

  pending(): number {
    return this.jobs.size;
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.jobs.clear();
    this.pendingKeys.clear();
  }
}

/** Fallback generator that runs on the calling thread but still defers delivery. */
export class SyncGenPool implements GenPool {
  private queue: { cx: number; cz: number; seed: number; diff: number[]; cb: Done }[] = [];
  private seed: number;
  private inflight = 0;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  static generate(seed: number, cx: number, cz: number, diff: number[], cb: Done): void {
    const blocks = new Uint8Array(CHUNK_VOL);
    const biome = new Uint8Array(CHUNK_SX * CHUNK_SZ);
    const height = new Uint8Array(CHUNK_SX * CHUNK_SZ);
    generateEditedChunk(seed, cx, cz, blocks, biome, height, diff);
    queueMicrotask(() => cb(cx, cz, blocks, biome, height));
  }

  request(cx: number, cz: number, diff: number[], cb: Done): void {
    this.queue.push({ cx, cz, seed: this.seed, diff, cb });
    this.inflight++;
  }

  /** Pump a couple of jobs per frame so streaming behaves like the worker pool. */
  pump(jobs = 2): void {
    for (let i = 0; i < jobs && this.queue.length > 0; i++) {
      const j = this.queue.shift();
      if (!j) break;
      this.inflight--;
      SyncGenPool.generate(j.seed, j.cx, j.cz, j.diff, j.cb);
    }
  }

  pending(): number {
    return this.inflight + this.queue.length;
  }

  dispose(): void {
    this.queue.length = 0;
    this.inflight = 0;
  }
}

function keyOf(cx: number, cz: number): number {
  return ((cx + 32768) << 16) | (cz + 32768);
}
