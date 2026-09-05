/**
 * AABB vs voxel-grid movement (PH-2 / PH-3). Axis-separated with sub-stepping so fast motion can
 * never tunnel through a wall, even at low FPS (M0 exit criterion: "no tunneling at 20-block falls").
 */
import { CHUNK_SY } from '../core/constants.js';
import { isSolid } from '../world/blocks.js';

export interface Collider {
  /** half width on X/Z */
  hw: number;
  /** height */
  h: number;
}

export interface PhysWorld {
  getBlock(x: number, y: number, z: number): number;
}

export interface MoveResult {
  onGround: boolean;
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
  hitCeiling: boolean;
  stepped: boolean;
}

const EPS = 1e-3;
const MAX_STEP = 0.3;

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

function boxOf(x: number, y: number, z: number, c: Collider): Box {
  return { minX: x - c.hw, maxX: x + c.hw, minY: y, maxY: y + c.h, minZ: z - c.hw, maxZ: z + c.hw };
}

function collides(world: PhysWorld, b: Box): boolean {
  const x0 = Math.floor(b.minX + EPS);
  const x1 = Math.floor(b.maxX - EPS);
  const y0 = Math.floor(b.minY + EPS);
  const y1 = Math.floor(b.maxY - EPS);
  const z0 = Math.floor(b.minZ + EPS);
  const z1 = Math.floor(b.maxZ - EPS);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (y < 0) return true; // bedrock floor of the world
      if (y >= CHUNK_SY) continue;
      for (let z = z0; z <= z1; z++) {
        if (isSolid(world.getBlock(x, y, z))) return true;
      }
    }
  }
  return false;
}

/**
 * Integrate `vel` over `dt` into `pos`, resolving collisions against the voxel grid.
 * Returns contact flags. `stepUp` lets walkers climb single-block ledges automatically.
 */
export function moveWithCollision(
  world: PhysWorld,
  pos: { x: number; y: number; z: number },
  vel: { x: number; y: number; z: number },
  dt: number,
  collider: Collider,
  stepUp = 0,
): MoveResult {
  const res: MoveResult = { onGround: false, hitX: false, hitY: false, hitZ: false, hitCeiling: false, stepped: false };

  // ---------------- Y ----------------
  const dy = vel.y * dt;
  if (dy !== 0) {
    const steps = Math.max(1, Math.ceil(Math.abs(dy) / MAX_STEP));
    const inc = dy / steps;
    for (let i = 0; i < steps; i++) {
      const ny = pos.y + inc;
      if (collides(world, boxOf(pos.x, ny, pos.z, collider))) {
        if (inc < 0) {
          pos.y = Math.floor(ny) + 1 + EPS;
          res.onGround = true;
        } else {
          pos.y = Math.floor(ny + collider.h) - collider.h - EPS;
          res.hitCeiling = true;
        }
        vel.y = 0;
        res.hitY = true;
        break;
      }
      pos.y = ny;
    }
  }

  // ---------------- X / Z ----------------
  for (const axis of ['x', 'z'] as const) {
    const d = axis === 'x' ? vel.x * dt : vel.z * dt;
    if (d === 0) continue;
    const steps = Math.max(1, Math.ceil(Math.abs(d) / MAX_STEP));
    const inc = d / steps;
    for (let i = 0; i < steps; i++) {
      const nx = axis === 'x' ? pos.x + inc : pos.x;
      const nz = axis === 'z' ? pos.z + inc : pos.z;
      if (!collides(world, boxOf(nx, pos.y, nz, collider))) {
        if (axis === 'x') pos.x = nx;
        else pos.z = nz;
        continue;
      }
      if (stepUp > 0) {
        // climbing: the raised position must be free here *and* at the target
        const lift = Math.abs(pos.y - Math.floor(pos.y)) > 0.001 ? stepUp + 0.02 : stepUp;
        const canStandHere = !collides(world, boxOf(pos.x, pos.y + lift, pos.z, collider));
        const canStandThere = !collides(world, boxOf(nx, pos.y + lift, nz, collider));
        if (canStandHere && canStandThere) {
          pos.y += lift;
          pos.x = nx;
          pos.z = nz;
          res.stepped = true;
          continue;
        }
      }
      if (axis === 'x') {
        pos.x = vel.x > 0 ? Math.floor(nx + collider.hw) - collider.hw - EPS : Math.floor(nx - collider.hw) + 1 + collider.hw + EPS;
        vel.x = 0;
        res.hitX = true;
      } else {
        pos.z = vel.z > 0 ? Math.floor(nz + collider.hw) - collider.hw - EPS : Math.floor(nz - collider.hw) + 1 + collider.hw + EPS;
        vel.z = 0;
        res.hitZ = true;
      }
      break;
    }
  }

  if (!res.onGround) {
    // grounded test: a hair below the feet
    res.onGround = collides(world, boxOf(pos.x, pos.y - 0.03, pos.z, collider));
  }
  return res;
}

/** Does the entity's box intersect a block satisfying `test`? (swimming / head-in-water checks) */
export function boxContains(
  world: PhysWorld,
  x: number,
  y: number,
  z: number,
  c: Collider,
  test: (id: number) => boolean,
): boolean {
  const b = boxOf(x, y, z, c);
  const x0 = Math.floor(b.minX + EPS);
  const x1 = Math.floor(b.maxX - EPS);
  const y0 = Math.floor(b.minY + EPS);
  const y1 = Math.floor(b.maxY - EPS);
  const z0 = Math.floor(b.minZ + EPS);
  const z1 = Math.floor(b.maxZ - EPS);
  for (let xi = x0; xi <= x1; xi++)
    for (let yi = y0; yi <= y1; yi++)
      for (let zi = z0; zi <= z1; zi++) if (test(world.getBlock(xi, yi, zi))) return true;
  return false;
}
