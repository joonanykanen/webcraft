/** Small geometry helpers that reuse the chunk material's attribute layout (entities, overlays). */
import * as THREE from 'three';
import { ATLAS_TILES } from '../core/constants.js';
import { FACES } from '../world/mesher.js';

const CORNER_AB = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export interface CubeOptions {
  size?: number;
  top: number;
  bottom: number;
  side: number;
  sky?: number;
  block?: number;
  shade?: number;
  /** centre the cube on its origin instead of aligning it to a block cell */
  centered?: boolean;
  /** per-face tint multipliers (length 6) overriding `shade` */
  tints?: number[];
}

/** A unit cube using the same attributes as chunk meshes, so it shares the chunk material. */
export function voxelCubeGeometry(opts: CubeOptions): THREE.BufferGeometry {
  const size = opts.size ?? 1;
  const sky = (opts.sky ?? 15) / 15;
  const blk = (opts.block ?? 0) / 15;
  const shade = opts.shade ?? 1;
  const off = opts.centered ? 0 : 0.5;
  const pos: number[] = [];
  const uv: number[] = [];
  const tile: number[] = [];
  const light: number[] = [];
  const tint: number[] = [];
  const index: number[] = [];
  let v = 0;
  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const t = opts.tints ? opts.tints[f] : face.shade * shade;
    const tileIndex = f === 0 ? opts.top : f === 1 ? opts.bottom : opts.side;
    for (let c = 0; c < 4; c++) {
      const a = CORNER_AB[c][0];
      const b = CORNER_AB[c][1];
      pos.push(
        (face.p0[0] + face.u[0] * a + face.v[0] * b - 0.5) * size + off,
        (face.p0[1] + face.u[1] * a + face.v[1] * b - 0.5) * size + off,
        (face.p0[2] + face.u[2] * a + face.v[2] * b - 0.5) * size + off,
      );
      uv.push(a, b);
      tile.push(tileIndex);
      light.push(sky, blk);
      tint.push(t);
    }
    index.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aTile', new THREE.Float32BufferAttribute(tile, 1));
  g.setAttribute('aLight', new THREE.Float32BufferAttribute(light, 2));
  g.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 1));
  g.setIndex(index);
  return g;
}

/** Wireframe box used to highlight the targeted block (BI-1). */
export function blockHighlightGeometry(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(1.0025, 1.0025, 1.0025);
  const g = new THREE.EdgesGeometry(box, 1);
  box.dispose();
  return g;
}

export const ATLAS_DIVISOR = ATLAS_TILES;
