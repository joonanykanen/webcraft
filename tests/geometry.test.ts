import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { voxelCubeGeometry } from '../src/render/geometry.js';
import { FACES } from '../src/world/mesher.js';

/** The atlas tile used by each of the six faces (4 vertices per face, FACES order). */
function tilePerFace(g: THREE.BufferGeometry): number[] {
  const a = g.getAttribute('aTile') as THREE.BufferAttribute;
  const out: number[] = [];
  for (let f = 0; f < 6; f++) out.push(a.getX(f * 4));
  return out;
}

function bounds(g: THREE.BufferGeometry) {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  return {
    x: [Math.round(b.min.x * 1000) / 1000, Math.round(b.max.x * 1000) / 1000],
    y: [Math.round(b.min.y * 1000) / 1000, Math.round(b.max.y * 1000) / 1000],
    z: [Math.round(b.min.z * 1000) / 1000, Math.round(b.max.z * 1000) / 1000],
  };
}

describe('voxelCubeGeometry', () => {
  it('has one face per FACES entry, in the same order', () => {
    expect(FACES).toHaveLength(6);
    const g = voxelCubeGeometry({ size: 1, top: 1, bottom: 2, side: 3 });
    expect(g.getAttribute('position').count).toBe(24);
  });

  /**
   * Regression: mob eyes were part of the whole head tile, so every side of the head — including
   * the back — showed a face. The eyes now live on a dedicated front tile.
   */
  it('maps the front tile onto the facing (-z) face only', () => {
    const g = voxelCubeGeometry({ size: 1, top: 10, bottom: 11, side: 12, front: 13 });
    const tiles = tilePerFace(g);
    expect(tiles[0]).toBe(10); // +y
    expect(tiles[1]).toBe(11); // -y
    expect(tiles[2]).toBe(12); // +x
    expect(tiles[3]).toBe(12); // -x
    expect(tiles[4]).toBe(12); // +z
    expect(tiles[5]).toBe(13); // -z — where a mob turned by rotation.y looks
  });

  it('falls back to the side tile when no front tile is given', () => {
    const tiles = tilePerFace(voxelCubeGeometry({ size: 1, top: 1, bottom: 1, side: 7 }));
    expect(tiles).toEqual([1, 1, 7, 7, 7, 7]);
  });

  it('supports non-uniform scale for arm and item shapes', () => {
    const g = voxelCubeGeometry({ top: 0, bottom: 0, side: 0, scale: [0.1, 0.2, 0.4], centered: true });
    expect(bounds(g)).toEqual({ x: [-0.05, 0.05], y: [-0.1, 0.1], z: [-0.2, 0.2] });
  });

  it('keeps the old corner-aligned behaviour when not centred', () => {
    const g = voxelCubeGeometry({ size: 2, top: 0, bottom: 0, side: 0 });
    expect(bounds(g)).toEqual({ x: [0, 2], y: [0, 2], z: [0, 2] });
  });

  it('applies per-face tints so a face can be brightened independently', () => {
    const g = voxelCubeGeometry({ size: 1, top: 0, bottom: 0, side: 0, tints: [1, 1, 1, 1, 1, 1.4] });
    const tint = g.getAttribute('aTint') as THREE.BufferAttribute;
    expect(tint.getX(5 * 4)).toBeCloseTo(1.4);
    expect(tint.getX(0)).toBeCloseTo(1);
  });
});
