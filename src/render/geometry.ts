/** Small geometry helpers that reuse the chunk material's attribute layout (entities, overlays). */
import * as THREE from 'three';
import { ATLAS_TILES, TILE_PX } from '../core/constants.js';
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
  /**
   * Tile for the nose/front face (local -z, which is where a mob turned with `rotation.y` looks —
   * `yaw = atan2(-dx, -dz)` and the heads are modelled toward -z).
   * Eyes live here so they are not stamped onto the back of the head as well.
   */
  front?: number;
  sky?: number;
  block?: number;
  shade?: number;
  /** centre the cube on its origin instead of aligning it to a block cell */
  centered?: boolean;
  /** per-face tint multipliers (length 6) overriding `shade` */
  tints?: number[];
  /** non-uniform size in blocks; overrides the uniform `size` when given */
  scale?: [number, number, number];
  /**
   * Flip the texture's V axis. The chunk face basis runs `v` downwards, so art painted "upright"
   * into the atlas (mob faces: eyes above the snout) renders upside-down on a cube unless the
   * entity flips it back. Terrain tiles are near-symmetric, so only entities need this.
   */
  flipV?: boolean;
}

/** Index of the local -z face inside `FACES` (+y, -y, +x, -x, +z, -z): the direction a mob faces. */
const FRONT_FACE = 5;

/**
 * Largest UV corner that survives the vertex shader's `fract(aUV)` wrap. The chunk shader wraps so
 * a single greedy-run face can repeat a tile; a corner at exactly 1.0 wrapped back to 0, which
 * collapsed entity/hand cube faces onto a few texels (mobs looked flat-coloured).
 */
const UV_MAX = 1 - 1 / (TILE_PX * 32);

/** A unit cube using the same attributes as chunk meshes, so it shares the chunk material. */
export function voxelCubeGeometry(opts: CubeOptions): THREE.BufferGeometry {
  const size = opts.size ?? 1;
  const [sx, sy, sz] = opts.scale ?? [size, size, size];
  const sky = (opts.sky ?? 15) / 15;
  const blk = (opts.block ?? 0) / 15;
  const shade = opts.shade ?? 1;
  const ox = opts.centered ? 0 : sx / 2;
  const oy = opts.centered ? 0 : sy / 2;
  const oz = opts.centered ? 0 : sz / 2;
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
    const tileIndex =
      f === FRONT_FACE && opts.front !== undefined
        ? opts.front
        : f === 0
          ? opts.top
          : f === 1
            ? opts.bottom
            : opts.side;
    for (let c = 0; c < 4; c++) {
      const a = CORNER_AB[c][0];
      const b = CORNER_AB[c][1];
      pos.push(
        (face.p0[0] + face.u[0] * a + face.v[0] * b - 0.5) * sx + ox,
        (face.p0[1] + face.u[1] * a + face.v[1] * b - 0.5) * sy + oy,
        (face.p0[2] + face.u[2] * a + face.v[2] * b - 0.5) * sz + oz,
      );
      // The chunk shader wraps aUV with fract() so one face can tile a greedy run. A corner at
      // exactly 1.0 therefore wraps back to 0, which collapsed entity faces onto a handful of
      // texels (mobs looked flat-coloured, held blocks wrong). Stay just inside the range.
      const vv = opts.flipV ? 1 - b : b;
      uv.push(a === 1 ? UV_MAX : a, vv === 1 ? UV_MAX : vv);
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
