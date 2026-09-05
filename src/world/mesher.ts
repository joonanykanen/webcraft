/**
 * Chunk mesher (RD-2 face culling · RD-6 corner AO · RD-7 run-merging).
 *
 * Two geometry payloads per chunk: an opaque/cut-out pass (alphaTest) and an alpha-blended water
 * pass. Per-vertex attributes:
 *   position – local to the chunk (meshes are positioned at the chunk origin → no float drift)
 *   tile     – atlas tile index (8×8 grid)
 *   uv       – (u in *tile units* along the face tangent, v in tile units) so merged runs tile
 *   light    – (sky, block) 0..15 → day/night dimming happens in the shader, no remeshing needed
 *   tint     – directional face shading × corner ambient occlusion
 */
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, MAX_LIGHT, ATLAS_TILES } from '../core/constants.js';
import type { MeshData } from '../core/types.js';
import type { Chunk } from './chunk.js';
import { BlockId, faceTile, hidesFace, isAir, isBlend, isCross, isOpaque } from './blocks.js';

const PX = CHUNK_SX + 2;
const PY = CHUNK_SY + 2;
const PZ = CHUNK_SZ + 2;
const PAD_VOL = PX * PY * PZ;
const padBlocks = new Uint8Array(PAD_VOL);
const padSky = new Uint8Array(PAD_VOL);
const padBlkLight = new Uint8Array(PAD_VOL);
/** face f of padded cell c already emitted by a merged run: consumed[c*6+f] */
const consumed = new Uint8Array(PAD_VOL * 6);

const pIdx = (lx: number, ly: number, lz: number): number => (lx * PZ + lz) * PY + ly;

export interface MeshWorld {
  getChunk(cx: number, cz: number): Chunk | undefined;
}

export interface ChunkMesh {
  opaque: MeshData | null;
  water: MeshData | null;
}

/** face ids: 0 +Y, 1 -Y, 2 +X, 3 -X, 4 +Z, 5 -Z — cross(u,v) always equals the face normal */
export interface FaceDef {
  n: [number, number, number];
  p0: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
  shade: number;
}

export const FACES: FaceDef[] = [
  { n: [0, 1, 0], p0: [0, 1, 1], u: [1, 0, 0], v: [0, 0, -1], shade: 1.0 },
  { n: [0, -1, 0], p0: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 0.5 },
  { n: [1, 0, 0], p0: [1, 0, 1], u: [0, 0, -1], v: [0, 1, 0], shade: 0.74 },
  { n: [-1, 0, 0], p0: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0], shade: 0.74 },
  { n: [0, 0, 1], p0: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.88 },
  { n: [0, 0, -1], p0: [1, 0, 0], u: [-1, 0, 0], v: [0, 1, 0], shade: 0.88 },
];
const CORNER_AB = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
/** light levels are stored 0..15 but uploaded normalized, so scale 15 → 255 exactly */
const LIGHT_BYTE = 255 / MAX_LIGHT;

const AO_LEVEL = [0.44, 0.64, 0.83, 1.0];
const WATER_SURFACE_Y = 0.88;

function copyColumn(
  srcBlocks: Uint8Array,
  srcLight: Uint8Array,
  srcBase: number,
  dstBase: number,
): void {
  // the padded layer below y=0 is solid so bedrock does not emit hidden downward faces
  padBlocks[dstBase] = BlockId.BEDROCK;
  padBlocks.set(srcBlocks.subarray(srcBase, srcBase + CHUNK_SY), dstBase + 1);
  padBlocks.fill(0, dstBase + 1 + CHUNK_SY, dstBase + PY);
  for (let i = 0; i < PY; i++) {
    // padded ly = chunk y + 1; outside the column there is air with no light
    const packed = i === 0 || i > CHUNK_SY ? 0 : srcLight[srcBase + i - 1];
    const k = dstBase + i;
    padSky[k] = packed >> 4;
    padBlkLight[k] = packed & 15;
  }
}

function ownColumn(lx: number, lz: number, src: Chunk, sx: number, sz: number): void {
  const base = (sx * CHUNK_SZ + sz) * CHUNK_SY;
  copyColumn(src.blocks, src.light, base, pIdx(lx, 0, lz));
}

function fillPadding(world: MeshWorld, chunk: Chunk): void {
  // unloaded neighbours must read as air, so always start clean
  padBlocks.fill(0);
  padSky.fill(0);
  padBlkLight.fill(0);

  for (let x = 0; x < CHUNK_SX; x++) for (let z = 0; z < CHUNK_SZ; z++) ownColumn(x + 1, z + 1, chunk, x, z);

  const west = world.getChunk(chunk.cx - 1, chunk.cz);
  if (west) for (let z = 0; z < CHUNK_SZ; z++) ownColumn(0, z + 1, west, CHUNK_SX - 1, z);
  const east = world.getChunk(chunk.cx + 1, chunk.cz);
  if (east) for (let z = 0; z < CHUNK_SZ; z++) ownColumn(PX - 1, z + 1, east, 0, z);
  const north = world.getChunk(chunk.cx, chunk.cz - 1);
  if (north) for (let x = 0; x < CHUNK_SX; x++) ownColumn(x + 1, 0, north, x, CHUNK_SZ - 1);
  const south = world.getChunk(chunk.cx, chunk.cz + 1);
  if (south) for (let x = 0; x < CHUNK_SX; x++) ownColumn(x + 1, PZ - 1, south, x, 0);

  // diagonal columns matter for corner AO
  const nw = world.getChunk(chunk.cx - 1, chunk.cz - 1);
  if (nw) ownColumn(0, 0, nw, CHUNK_SX - 1, CHUNK_SZ - 1);
  const ne = world.getChunk(chunk.cx + 1, chunk.cz - 1);
  if (ne) ownColumn(PX - 1, 0, ne, 0, CHUNK_SZ - 1);
  const sw = world.getChunk(chunk.cx - 1, chunk.cz + 1);
  if (sw) ownColumn(0, PZ - 1, sw, CHUNK_SX - 1, 0);
  const se = world.getChunk(chunk.cx + 1, chunk.cz + 1);
  if (se) ownColumn(PX - 1, PZ - 1, se, 0, 0);

  // open sky above the world ceiling
  for (let x = 0; x < PX; x++) for (let z = 0; z < PZ; z++) padSky[pIdx(x, PY - 1, z)] = 15;
}

class GeoBuf {
  private pos = new Float32Array(3 * 4096);
  private uvo = new Float32Array(2 * 4096);
  private tiles = new Float32Array(4096);
  private light = new Uint8Array(2 * 4096);
  private tint = new Uint8Array(4096);
  private idx = new Uint32Array(6 * 2048);
  v = 0;
  i = 0;

  private ensure(verts: number, indices: number): void {
    if (verts > this.pos.length / 3) {
      const n = Math.max(verts, this.pos.length / 3) * 2;
      const p = new Float32Array(n * 3);
      p.set(this.pos.subarray(0, this.v * 3));
      this.pos = p;
      const u = new Float32Array(n * 2);
      u.set(this.uvo.subarray(0, this.v * 2));
      this.uvo = u;
      const t = new Float32Array(n);
      t.set(this.tiles.subarray(0, this.v));
      this.tiles = t;
      const l = new Uint8Array(n * 2);
      l.set(this.light.subarray(0, this.v * 2));
      this.light = l;
      const g = new Uint8Array(n);
      g.set(this.tint.subarray(0, this.v));
      this.tint = g;
    }
    if (indices > this.idx.length) {
      const n = Math.max(indices, this.idx.length) * 2;
      const a = new Uint32Array(n);
      a.set(this.idx.subarray(0, this.i));
      this.idx = a;
    }
  }

  quad(
    xs: number[],
    ys: number[],
    zs: number[],
    us: number[],
    vs: number[],
    tile: number,
    sky: number,
    blk: number,
    tints: number[],
  ): void {
    const base = this.v;
    this.ensure(base + 4, this.i + 6);
    for (let k = 0; k < 4; k++) {
      const p = this.v * 3;
      this.pos[p] = xs[k];
      this.pos[p + 1] = ys[k];
      this.pos[p + 2] = zs[k];
      this.uvo[this.v * 2] = us[k];
      this.uvo[this.v * 2 + 1] = vs[k];
      this.tiles[this.v] = tile;
      // light is uploaded as a normalized ubyte attribute: 0..15 must span the full 0..255 range
      this.light[this.v * 2] = sky * LIGHT_BYTE;
      this.light[this.v * 2 + 1] = blk * LIGHT_BYTE;
      this.tint[this.v] = tints[k];
      this.v++;
    }
    this.idx[this.i++] = base;
    this.idx[this.i++] = base + 1;
    this.idx[this.i++] = base + 2;
    this.idx[this.i++] = base;
    this.idx[this.i++] = base + 2;
    this.idx[this.i++] = base + 3;
  }

  result(): MeshData | null {
    if (this.v === 0) return null;
    return {
      position: this.pos.slice(0, this.v * 3),
      uv: this.uvo.slice(0, this.v * 2),
      tile: this.tiles.slice(0, this.v),
      light: this.light.slice(0, this.v * 2),
      tint: this.tint.slice(0, this.v),
      index: this.idx.slice(0, this.i),
    };
  }
}

/** Build the geometry for one chunk (assumes the chunk's light data is up to date). */
export function buildChunkMesh(world: MeshWorld, chunk: Chunk, quality: 'fancy' | 'fast'): ChunkMesh {
  fillPadding(world, chunk);
  consumed.fill(0);
  const opaque = new GeoBuf();
  const water = new GeoBuf();
  const fancy = quality === 'fancy';
  const maxRun = fancy ? 1 : 16;

  // below the world is treated as solid so bedrock never emits invisible downward faces
  const opaqueAt = (lx: number, ly: number, lz: number): number =>
    ly < 0 ? 1 : lx < 0 || lx >= PX || lz < 0 || lz >= PZ || ly >= PY ? 0 : isOpaque(padBlocks[pIdx(lx, ly, lz)]) ? 1 : 0;

  for (let x = 0; x < CHUNK_SX; x++) {
    const lx = x + 1;
    for (let z = 0; z < CHUNK_SZ; z++) {
      const lz = z + 1;
      const colTop = chunk.columnHeight(x, z);
      for (let y = 0; y < colTop; y++) {
        const pi = pIdx(lx, y + 1, lz);
        const id = padBlocks[pi];
        if (isAir(id)) continue;

        if (isCross(id)) {
          const above = pIdx(lx, y + 2, lz);
          emitCross(opaque, x, y, z, faceTile(id, 2), padSky[above], padBlkLight[above]);
          continue;
        }

        const buf = isBlend(id) ? water : opaque;
        const aboveIsWater = isBlend(padBlocks[pIdx(lx, y + 2, lz)]);
        const yTop = isBlend(id) && !aboveIsWater ? WATER_SURFACE_Y : 1.0;

        for (let f = 0; f < 6; f++) {
          const ci = pi * 6 + f;
          if (consumed[ci]) continue;
          const face = FACES[f];
          const nx = lx + face.n[0];
          const ny = y + 1 + face.n[1];
          const nz = lz + face.n[2];
          const ni = pIdx(nx, ny, nz);
          if (hidesFace(id, padBlocks[ni])) continue;

          const sky = padSky[ni];
          const blkL = padBlkLight[ni];
          const tile = faceTile(id, f);

          // ---- run ownership (RD-7) ----
          // A run must be emitted by its first block along the face tangent; cells are visited in
          // x→z→y order which is not the tangent order for −X/−Z faces, so check the previous cell.
          if (maxRun > 1) {
            const rx = lx - face.u[0];
            const ry = y + 1 - face.u[1];
            const rz = lz - face.u[2];
            if (rx >= 0 && rx < PX && rz >= 0 && rz < PZ && ry >= 0 && ry < PY) {
              const rpi = pIdx(rx, ry, rz);
              if (padBlocks[rpi] === id && !consumed[rpi * 6 + f]) {
                const rni = pIdx(rx + face.n[0], ry + face.n[1], rz + face.n[2]);
                if (
                  !hidesFace(id, padBlocks[rni]) &&
                  padSky[rni] === sky &&
                  padBlkLight[rni] === blkL &&
                  isBlend(padBlocks[rni]) === isBlend(padBlocks[pi])
                ) {
                  continue;
                }
              }
            }
          }

          // ---- corner ambient occlusion (RD-6) ----
          const tints = [255, 255, 255, 255];
          if (fancy) {
            for (let c = 0; c < 4; c++) {
              const a = CORNER_AB[c][0];
              const b = CORNER_AB[c][1];
              const su = a === 1 ? 1 : -1;
              const sv = b === 1 ? 1 : -1;
              const ux = face.u[0] * su;
              const uy = face.u[1] * su;
              const uz = face.u[2] * su;
              const vx = face.v[0] * sv;
              const vy = face.v[1] * sv;
              const vz = face.v[2] * sv;
              const s1 = opaqueAt(nx + ux, ny + uy, nz + uz);
              const s2 = opaqueAt(nx + vx, ny + vy, nz + vz);
              const sc = opaqueAt(nx + ux + vx, ny + uy + vy, nz + uz + vz);
              const ao = s1 && s2 ? 0 : 3 - (s1 + s2 + sc);
              tints[c] = Math.round(face.shade * AO_LEVEL[ao] * 255);
            }
          } else {
            const sh = Math.round(face.shade * 255);
            tints[0] = tints[1] = tints[2] = tints[3] = sh;
          }

          // ---- run merging (RD-7): extend along the face tangent ----
          let run = 1;
          if (maxRun > 1) {
            while (run < maxRun) {
              const qx = lx + face.u[0] * run;
              const qy = y + 1 + face.u[1] * run;
              const qz = lz + face.u[2] * run;
              if (qx < 0 || qx >= PX || qz < 0 || qz >= PZ || qy < 0 || qy >= PY) break;
              const qi = pIdx(qx, qy, qz);
              if (padBlocks[qi] !== id) break;
              if (consumed[qi * 6 + f]) break;
              const qfi = pIdx(qx + face.n[0], qy + face.n[1], qz + face.n[2]);
              if (hidesFace(id, padBlocks[qfi])) break;
              if (padSky[qfi] !== sky || padBlkLight[qfi] !== blkL) break;
              run++;
            }
          }

          const xs: number[] = [0, 0, 0, 0];
          const ys: number[] = [0, 0, 0, 0];
          const zs: number[] = [0, 0, 0, 0];
          const us: number[] = [0, 0, 0, 0];
          const vs: number[] = [0, 0, 0, 0];
          for (let c = 0; c < 4; c++) {
            const a = CORNER_AB[c][0];
            const b = CORNER_AB[c][1];
            const au = a === 1 ? run : 0;
            xs[c] = x + face.p0[0] + face.u[0] * au + face.v[0] * b;
            ys[c] = Math.min(y + face.p0[1] + face.u[1] * au + face.v[1] * b, y + yTop);
            zs[c] = z + face.p0[2] + face.u[2] * au + face.v[2] * b;
            us[c] = au * 0.99995; // keep the last vertex inside its tile so fract() tiling works
            vs[c] = b;
          }
          buf.quad(xs, ys, zs, us, vs, tile, sky, blkL, tints);

          for (let k = 1; k < run; k++) {
            const qx = lx + face.u[0] * k;
            const qy = y + 1 + face.u[1] * k;
            const qz = lz + face.u[2] * k;
            consumed[pIdx(qx, qy, qz) * 6 + f] = 1;
          }
        }
      }
    }
  }
  return { opaque: opaque.result(), water: water.result() };
}

function emitCross(
  buf: GeoBuf,
  x: number,
  y: number,
  z: number,
  tile: number,
  sky: number,
  blk: number,
): void {
  const tints = [255, 232, 214, 240];
  const us = [0, 1, 1, 0];
  const vs = [0, 0, 1, 1];
  const a = 0.3;
  const b = 0.7;
  const ys = [y, y, y + 1, y + 1];
  for (const flip of [false, true]) {
    const xs = flip ? [x + a, x + b, x + b, x + a] : [x + b, x + a, x + a, x + b];
    const zs = flip ? [z + a, z + b, z + b, z + a] : [z + b, z + a, z + a, z + b];
    buf.quad(xs, ys, zs, us, vs, tile, sky, blk, tints);
  }
  for (const flip of [false, true]) {
    const xs = flip ? [x + b, x + a, x + a, x + b] : [x + a, x + b, x + b, x + a];
    const zs = flip ? [z + a, z + b, z + b, z + a] : [z + b, z + a, z + a, z + b];
    buf.quad(xs, ys, zs, us, vs, tile, sky, blk, tints);
  }
}

export const ATLAS_SIZE = ATLAS_TILES;
export const MAX_RUN_WIDTH = 16;
