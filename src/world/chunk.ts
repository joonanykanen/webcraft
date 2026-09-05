/** A chunk column of voxels: block storage, packed light, mesh bookkeeping. */
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, CHUNK_VOL, blockIndex, chunkKey } from '../core/constants.js';
import type { BiomeId } from '../core/types.js';

export type ChunkState = 'empty' | 'data' | 'meshed';

export class Chunk {
  readonly cx: number;
  readonly cz: number;
  readonly key: number;
  readonly blocks: Uint8Array;
  /** packed light: high nibble = sky light, low nibble = block light (0..15) */
  readonly light: Uint8Array;
  readonly biome: Uint8Array;
  /** per-column highest non-air y + 1 (0..CHUNK_SY) */
  readonly height: Uint8Array;
  state: ChunkState = 'data';
  /** geometry needs to be rebuilt */
  dirty = true;
  needsLight = true;
  lastAccess = 0;
  /** render-layer handles (kept `unknown` so the world layer stays renderer-free) */
  meshOpaque: unknown = null;
  meshWater: unknown = null;
  /** true when every voxel is air */
  empty = false;
  version = 0;

  constructor(cx: number, cz: number) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.blocks = new Uint8Array(CHUNK_VOL);
    this.light = new Uint8Array(CHUNK_VOL);
    this.biome = new Uint8Array(CHUNK_SX * CHUNK_SZ);
    this.height = new Uint8Array(CHUNK_SX * CHUNK_SZ);
  }

  get(x: number, y: number, z: number): number {
    return this.blocks[blockIndex(x, y, z)];
  }

  getLight(x: number, y: number, z: number): number {
    return this.light[blockIndex(x, y, z)];
  }

  skyAt(x: number, y: number, z: number): number {
    return this.light[blockIndex(x, y, z)] >> 4;
  }

  blockAt(x: number, y: number, z: number): number {
    return this.light[blockIndex(x, y, z)] & 15;
  }

  biomeAt(lx: number, lz: number): BiomeId {
    return this.biome[lx * CHUNK_SZ + lz] as BiomeId;
  }

  columnHeight(lx: number, lz: number): number {
    return this.height[lx * CHUNK_SZ + lz];
  }

  recomputeHeights(): void {
    this.empty = true;
    for (let x = 0; x < CHUNK_SX; x++) {
      for (let z = 0; z < CHUNK_SZ; z++) {
        let h = 0;
        const base = (x * CHUNK_SZ + z) * CHUNK_SY;
        for (let y = CHUNK_SY - 1; y >= 0; y--) {
          if (this.blocks[base + y] !== 0) {
            h = y + 1;
            break;
          }
        }
        this.height[x * CHUNK_SZ + z] = h;
        if (h > 0) this.empty = false;
      }
    }
  }

  dispose(): void {
    this.meshOpaque = null;
    this.meshWater = null;
    this.state = 'empty';
  }
}
