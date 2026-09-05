/**
 * World: chunk store + streaming pipeline + block edits + lighting entry points.
 *
 * Chunk pipeline (§8): generate (worker) → apply player diffs → light → mesh → upload.
 * Terrain generation runs in a worker pool; lighting and meshing run on the main thread inside a
 * per-frame millisecond budget, so a single frame never spikes (§8.3).
 */
import {
  CHUNK_SX,
  CHUNK_SZ,
  CHUNK_SY,
  CHUNK_UNLOAD_MARGIN,
  CHUNK_VOL,
  SEA_LEVEL,
  blockIndex,
  chunkKey,
  keyToChunk,
} from '../core/constants.js';
import type { BiomeId } from '../core/types.js';
import { decodeDiffs, encodeDiffs } from '../save/codec.js';
import { Chunk } from './chunk.js';
import { borderSignature, rebuildBlockLight, relightChunk, relightSkyColumn } from './lighting.js';
import { buildChunkMesh, type ChunkMesh, type MeshWorld } from './mesher.js';
import { findSpawn, generateChunk, terrainContext, type ColumnInfo } from './worldgen.js';
import { isFluid, isOpaque, isSolid } from './blocks.js';

export interface GenPool {
  /** Ask for chunk terrain; `diff` is a flat [index, blockId, ...] list of player edits. */
  request(
    cx: number,
    cz: number,
    diff: number[],
    cb: (cx: number, cz: number, blocks: Uint8Array, biome: Uint8Array, height: Uint8Array) => void,
  ): void;
  pending(): number;
}

export interface MeshSink {
  upload(chunk: Chunk, mesh: ChunkMesh): void;
  remove(chunk: Chunk): void;
}

export interface WorldOptions {
  seed: number;
  pool: GenPool | null;
  sink: MeshSink | null;
  renderDistance: number;
  quality: 'fancy' | 'fast';
}

export interface WorldStats {
  chunks: number;
  genQueue: number;
  dirty: number;
  meshMs: number;
  meshedLast: number;
  receivedLast: number;
}

const NEIGHBOURS: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

export class World implements MeshWorld {
  readonly seed: number;
  readonly chunks = new Map<number, Chunk>();
  /** chunkKey -> (blockIndex -> blockId) player edits — this *is* the save payload (SV-1) */
  diffs = new Map<number, Map<number, number>>();
  renderDistance: number;
  quality: 'fancy' | 'fast';
  pool: GenPool | null;
  sink: MeshSink | null;

  stats: WorldStats = { chunks: 0, genQueue: 0, dirty: 0, meshMs: 0, meshedLast: 0, receivedLast: 0 };

  private pending = new Set<number>();
  private columnCache = new Map<number, ColumnInfo>();
  private frameCounter = 0;
  private receivedThisFrame = 0;
  private batchDepth = 0;
  private batchDirty = new Set<number>();
  private relightQueue: Chunk[] = [];

  constructor(opts: WorldOptions) {
    this.seed = opts.seed >>> 0;
    this.pool = opts.pool;
    this.sink = opts.sink;
    this.renderDistance = opts.renderDistance;
    this.quality = opts.quality;
  }

  // ---------------------------------------------------------------- coordinates
  static chunkOf(x: number, z: number): [number, number] {
    return [Math.floor(x / CHUNK_SX), Math.floor(z / CHUNK_SZ)];
  }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_SY) return 0;
    const cx = Math.floor(x / CHUNK_SX);
    const cz = Math.floor(z / CHUNK_SZ);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return 0;
    return c.blocks[blockIndex(x - cx * CHUNK_SX, y, z - cz * CHUNK_SZ)];
  }

  /** Collision helper. Unloaded chunks can be treated as solid so entities never fall into the void. */
  isSolidAt(x: number, y: number, z: number, treatUnloadedSolid = false): boolean {
    if (y < 0) return true;
    if (y >= CHUNK_SY) return false;
    const cx = Math.floor(x / CHUNK_SX);
    const cz = Math.floor(z / CHUNK_SZ);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return treatUnloadedSolid;
    return isSolid(c.blocks[blockIndex(x - cx * CHUNK_SX, y, z - cz * CHUNK_SZ)]);
  }

  isFluidAt(x: number, y: number, z: number): boolean {
    return isFluid(this.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
  }

  isOpaqueAt(x: number, y: number, z: number): boolean {
    return isOpaque(this.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
  }

  isLoadedAt(x: number, z: number): boolean {
    return this.chunks.has(chunkKey(Math.floor(x / CHUNK_SX), Math.floor(z / CHUNK_SZ)));
  }

  /** Top non-air block of a column (accepts fractional world coordinates). */
  heightAt(x: number, z: number): number {
    const wx = Math.floor(x);
    const wz = Math.floor(z);
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c) return c.columnHeight(wx - cx * CHUNK_SX, wz - cz * CHUNK_SZ) - 1;
    return this.columnInfo(wx, wz).h - 1;
  }

  biomeAt(x: number, z: number): BiomeId {
    const wx = Math.floor(x);
    const wz = Math.floor(z);
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c) return c.biomeAt(wx - cx * CHUNK_SX, wz - cz * CHUNK_SZ);
    return this.columnInfo(wx, wz).biome;
  }

  private columnInfo(x: number, z: number): ColumnInfo {
    const key = (x + 8388608) * 16777216 + (z + 8388608);
    let c = this.columnCache.get(key);
    if (c === undefined) {
      c = terrainContext(this.seed).column(x, z);
      if (this.columnCache.size > 20000) this.columnCache.clear();
      this.columnCache.set(key, c);
    }
    return c;
  }

  seaLevel(): number {
    return SEA_LEVEL;
  }

  // ---------------------------------------------------------------- light queries (LI-*)
  /** Packed light byte at a position (high nibble sky, low nibble block light); 0 if unloaded. */
  lightByteAt(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_SY) return y >= CHUNK_SY ? 0xff : 0;
    const cx = Math.floor(x / CHUNK_SX);
    const cz = Math.floor(z / CHUNK_SZ);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return 0;
    return c.getLight(x - cx * CHUNK_SX, y, z - cz * CHUNK_SZ);
  }

  getSkyLight(x: number, y: number, z: number): number {
    if (y >= CHUNK_SY) return 15;
    return this.lightByteAt(x, y, z) >> 4;
  }

  getBlockLight(x: number, y: number, z: number): number {
    return this.lightByteAt(x, y, z) & 15;
  }

  getLight(x: number, y: number, z: number): { sky: number; blockLight: number } {
    const b = this.lightByteAt(x, y, z);
    return { sky: b >> 4, blockLight: b & 15 };
  }

  // ---------------------------------------------------------------- persistence (SV-1)
  serializeChunks(): Record<string, string> {
    return encodeDiffs(this.diffs);
  }

  /** Install diffs from a save; they are replayed as chunks generate/stream in. */
  applyDiffsFromSave(chunks: Record<string, string>): void {
    this.diffs = decodeDiffs(chunks);
  }

  /** Highest solid block y in a loaded column, or -1 when unloaded. */
  surfaceY(x: number, z: number): number {
    const wx = Math.floor(x);
    const wz = Math.floor(z);
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return -1;
    return c.columnHeight(wx - cx * CHUNK_SX, wz - cz * CHUNK_SZ) - 1;
  }

  // ---------------------------------------------------------------- edits
  /** Apply an edit. Returns the previous block id, or -1 when the edit was impossible. */
  setBlock(x: number, y: number, z: number, id: number): number {
    if (y < 0 || y >= CHUNK_SY) return -1;
    const cx = Math.floor(x / CHUNK_SX);
    const cz = Math.floor(z / CHUNK_SZ);
    const key = chunkKey(cx, cz);
    const c = this.chunks.get(key);
    if (!c) return -1;
    const lx = x - cx * CHUNK_SX;
    const lz = z - cz * CHUNK_SZ;
    const i = blockIndex(lx, y, lz);
    const prev = c.blocks[i];
    if (prev === id) return -1;
    c.blocks[i] = id;

    // record the edit for persistence (SV-1: only diffs are stored)
    let d = this.diffs.get(key);
    if (!d) this.diffs.set(key, (d = new Map()));
    d.set(i, id);

    // column height (drives lighting + mesh skip + spawn checks)
    let h = 0;
    const base = (lx * CHUNK_SZ + lz) * CHUNK_SY;
    for (let yy = CHUNK_SY - 1; yy >= 0; yy--) {
      if (c.blocks[base + yy] !== 0) {
        h = yy + 1;
        break;
      }
    }
    c.height[lx * CHUNK_SZ + lz] = h;
    c.version++;
    c.dirty = true;

    if (this.batchDepth > 0) {
      this.batchDirty.add(key);
      return prev;
    }

    relightSkyColumn(c, lx, lz);
    const before = borderSignature(c);
    rebuildBlockLight(this, c);
    const lightChanged = borderSignature(c) !== before;
    const onBorder = lx === 0 || lx === CHUNK_SX - 1 || lz === 0 || lz === CHUNK_SZ - 1;
    if (onBorder || lightChanged) {
      // neighbour faces may change shading/AO (onBorder) and light can flow across the seam
      for (const [dx, dz] of NEIGHBOURS) {
        this.markDirty(cx + dx, cz + dz);
        if (lightChanged) this.requestRelightChunk(cx + dx, cz + dz);
      }
    }
    return prev;
  }

  /** Group many edits (explosions, falling sand) so lighting is rebuilt once. */
  beginBatch(): void {
    this.batchDepth++;
  }

  endBatch(): void {
    this.batchDepth--;
    if (this.batchDepth > 0) return;
    for (const key of this.batchDirty) {
      const [cx, cz] = keyToChunk(key);
      const c = this.getChunk(cx, cz);
      if (!c) continue;
      relightChunk(this, c);
      for (const [dx, dz] of NEIGHBOURS) {
        this.markDirty(cx + dx, cz + dz);
        this.requestRelightChunk(cx + dx, cz + dz);
      }
    }
    this.batchDirty.clear();
  }

  markDirty(cx: number, cz: number): void {
    const c = this.getChunk(cx, cz);
    if (c) c.dirty = true;
  }

  markAllDirty(): void {
    for (const c of this.chunks.values()) c.dirty = true;
  }

  setQuality(q: 'fancy' | 'fast'): void {
    if (q === this.quality) return;
    this.quality = q;
    this.markAllDirty();
  }

  setRenderDistance(d: number): void {
    this.renderDistance = d;
  }

  // ---------------------------------------------------------------- streaming
  /** Stream chunks around a position; call once per rendered frame. */
  update(px: number, pz: number, meshBudgetMs: number, maxMeshPerFrame: number): void {
    this.frameCounter++;
    const t0 = performance.now();
    const pcx = Math.floor(px / CHUNK_SX);
    const pcz = Math.floor(pz / CHUNK_SZ);
    const r = this.renderDistance;
    const genR = r + 1;
    this.receivedThisFrame = 0;

    if (this.pool) {
      // 1. request missing terrain, closest first
      const wanted: [number, number, number][] = [];
      for (let dx = -genR; dx <= genR; dx++) {
        for (let dz = -genR; dz <= genR; dz++) {
          const cx = pcx + dx;
          const cz = pcz + dz;
          const key = chunkKey(cx, cz);
          if (this.chunks.has(key) || this.pending.has(key)) continue;
          wanted.push([cx, cz, dx * dx + dz * dz]);
        }
      }
      wanted.sort((a, b) => a[2] - b[2]);
      const cap = 8 + this.pool.pending();
      for (const [cx, cz] of wanted) {
        if (this.pool.pending() >= cap) break;
        this.requestGeneration(cx, cz);
      }
    } else {
      // synchronous generation (tests, or browsers without worker support)
      let budget = 2;
      for (let dx = -r; dx <= r && budget > 0; dx++) {
        for (let dz = -r; dz <= r && budget > 0; dz++) {
          if (this.chunks.has(chunkKey(pcx + dx, pcz + dz))) continue;
          this.generateInline(pcx + dx, pcz + dz, false);
          budget--;
        }
      }
    }

    // 2. relight queued chunks (spread over frames to avoid hitches)
    let lightBudget = 4;
    while (this.relightQueue.length > 0 && lightBudget > 0) {
      const c = this.relightQueue.shift() as Chunk;
      lightBudget--;
      if (!this.chunks.has(c.key)) continue;
      if (!c.needsLight) continue;
      const before = borderSignature(c);
      relightChunk(this, c);
      this.markDirty(c.cx, c.cz);
      if (borderSignature(c) !== before) {
        for (const [dx, dz] of NEIGHBOURS) {
          this.markDirty(c.cx + dx, c.cz + dz);
          this.requestRelightChunk(c.cx + dx, c.cz + dz);
        }
      }
    }

    // 3. mesh dirty chunks whose neighbourhood is ready (budgeted)
    let built = 0;
    const work: Chunk[] = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const c = this.getChunk(pcx + dx, pcz + dz);
        if (c && c.dirty) work.push(c);
      }
    }
    work.sort((a, b) => dist2(a.cx, a.cz, pcx, pcz) - dist2(b.cx, b.cz, pcx, pcz));
    for (const c of work) {
      if (built >= maxMeshPerFrame) break;
      if (built > 0 && performance.now() - t0 > meshBudgetMs) break;
      if (!this.neighboursReady(c.cx, c.cz)) continue;
      this.meshChunk(c);
      built++;
    }

    // 4. evict far chunks (LRU) and dispose their GPU resources (§8 memory)
    const cut = r + CHUNK_UNLOAD_MARGIN;
    for (const [key, c] of this.chunks) {
      if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > cut) {
        if (this.sink) this.sink.remove(c);
        this.chunks.delete(key);
      } else {
        c.lastAccess = this.frameCounter;
      }
    }

    let dirty = 0;
    for (const c of this.chunks.values()) if (c.dirty) dirty++;
    this.stats.chunks = this.chunks.size;
    this.stats.genQueue = this.pending.size;
    this.stats.dirty = dirty;
    this.stats.meshMs = performance.now() - t0;
    this.stats.meshedLast = built;
    this.stats.receivedLast = this.receivedThisFrame;
  }

  private neighboursReady(cx: number, cz: number): boolean {
    for (const [dx, dz] of NEIGHBOURS) if (!this.chunks.has(chunkKey(cx + dx, cz + dz))) return false;
    return true;
  }

  requestGeneration(cx: number, cz: number): void {
    const pool = this.pool;
    if (!pool) return;
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    const d = this.diffs.get(key);
    const diff: number[] = [];
    if (d) for (const [i, v] of d) diff.push(i, v);
    pool.request(cx, cz, diff, (rcx, rcz, blocks, biome, height) => this.onGenerated(rcx, rcz, blocks, biome, height));
  }

  /** Generate on the calling thread (spawn area, tests, pool-less fallback). */
  generateInline(cx: number, cz: number, light = true): Chunk {
    const key = chunkKey(cx, cz);
    const existing = this.chunks.get(key);
    if (existing) return existing;
    const blocks = new Uint8Array(CHUNK_VOL);
    const biome = new Uint8Array(CHUNK_SX * CHUNK_SZ);
    const height = new Uint8Array(CHUNK_SX * CHUNK_SZ);
    generateChunk(this.seed, cx, cz, blocks, biome, height);
    const d = this.diffs.get(key);
    if (d) for (const [i, v] of d) blocks[i] = v;
    const c = new Chunk(cx, cz);
    c.blocks.set(blocks);
    c.biome.set(biome);
    c.height.set(height);
    c.needsLight = false;
    c.dirty = true;
    this.chunks.set(key, c);
    if (light) relightChunk(this, c);
    return c;
  }

  private onGenerated(cx: number, cz: number, blocks: Uint8Array, biome: Uint8Array, height: Uint8Array): void {
    const key = chunkKey(cx, cz);
    this.pending.delete(key);
    this.receivedThisFrame++;
    if (this.chunks.has(key)) return;
    const c = new Chunk(cx, cz);
    c.blocks.set(blocks);
    if (biome.length === c.biome.length) c.biome.set(biome);
    if (height.length === c.height.length) c.height.set(height);
    else c.recomputeHeights();
    c.needsLight = true;
    c.dirty = true;
    this.chunks.set(key, c);
    this.requestRelightChunk(cx, cz);
  }

  private meshChunk(c: Chunk): void {
    if (c.needsLight) relightChunk(this, c);
    const mesh = buildChunkMesh(this, c, this.quality);
    c.dirty = false;
    c.state = 'meshed';
    if (this.sink) this.sink.upload(c, mesh);
  }

  /** Force everything around a position to exist, be lit and be meshed (first frame / teleports). */
  prepareSync(px: number, pz: number, radius: number): void {
    const pcx = Math.floor(px / CHUNK_SX);
    const pcz = Math.floor(pz / CHUNK_SZ);
    for (let dx = -radius - 1; dx <= radius + 1; dx++) {
      for (let dz = -radius - 1; dz <= radius + 1; dz++) {
        this.generateInline(pcx + dx, pcz + dz, false);
      }
    }
    for (let dx = -radius - 1; dx <= radius + 1; dx++) {
      for (let dz = -radius - 1; dz <= radius + 1; dz++) {
        const c = this.getChunk(pcx + dx, pcz + dz);
        if (c) relightChunk(this, c);
      }
    }
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const c = this.getChunk(pcx + dx, pcz + dz);
        if (c && c.dirty) this.meshChunk(c);
      }
    }
  }

  requestRelightChunk(cx: number, cz: number): void {
    if (this.relightQueue.length > 32) return; // safety valve against propagation storms
    const c = this.getChunk(cx, cz);
    if (!c) return;
    c.needsLight = true;
    if (!this.relightQueue.includes(c)) this.relightQueue.push(c);
  }

  /** Immediately relight + remesh the chunks around a block (used after explosions). */
  flushLightAround(x: number, z: number, radiusChunks = 1): void {
    const [cx, cz] = World.chunkOf(x, z);
    for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
      for (let dz = -radiusChunks; dz <= radiusChunks; dz++) {
        const c = this.getChunk(cx + dx, cz + dz);
        if (!c) continue;
        relightChunk(this, c);
        this.markDirty(cx + dx, cz + dz);
      }
    }
  }

  dispose(): void {
    if (this.sink) for (const c of this.chunks.values()) this.sink.remove(c);
    this.chunks.clear();
    this.pending.clear();
    this.columnCache.clear();
    this.relightQueue.length = 0;
  }
}

function dist2(cx: number, cz: number, px: number, pz: number): number {
  const dx = cx - px;
  const dz = cz - pz;
  return dx * dx + dz * dz;
}

export { findSpawn };
