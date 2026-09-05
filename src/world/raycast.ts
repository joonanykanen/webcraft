/** Voxel raycast (DDA / Amanatides & Woo) for block targeting (BI-1). */
import { CHUNK_SY } from '../core/constants.js';
import { isFluid } from './blocks.js';

export interface RayHit {
  x: number;
  y: number;
  z: number;
  /** face normal of the hit block, pointing back toward the ray origin */
  nx: number;
  ny: number;
  nz: number;
  dist: number;
  block: number;
}

export interface RayWorld {
  getBlock(x: number, y: number, z: number): number;
}

export function raycast(
  world: RayWorld,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  includeFluid = false,
): RayHit | null {
  const len = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy + dz * dz));
  dx /= len;
  dy /= len;
  dz /= len;

  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Number.POSITIVE_INFINITY;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Number.POSITIVE_INFINITY;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Number.POSITIVE_INFINITY;

  let tMaxX = dx > 0 ? (x + 1 - ox) / dx : dx < 0 ? (x - ox) / dx : Number.POSITIVE_INFINITY;
  let tMaxY = dy > 0 ? (y + 1 - oy) / dy : dy < 0 ? (y - oy) / dy : Number.POSITIVE_INFINITY;
  let tMaxZ = dz > 0 ? (z + 1 - oz) / dz : dz < 0 ? (z - oz) / dz : Number.POSITIVE_INFINITY;

  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;

  for (let guard = 0; guard < 256; guard++) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      if (tMaxX > maxDist) break;
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY < tMaxZ) {
      if (tMaxY > maxDist) break;
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else {
      if (tMaxZ > maxDist) break;
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    }
    if (y < 0 || y >= CHUNK_SY) continue;
    const b = world.getBlock(x, y, z);
    if (b === 0) continue;
    if (isFluid(b) && !includeFluid) continue;
    return { x, y, z, nx, ny, nz, dist: t, block: b };
  }
  return null;
}
