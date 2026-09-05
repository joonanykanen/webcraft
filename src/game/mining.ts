/** Mining rules (BI-3 / IN-4): break times, drop tables, placement validity. */
import { CHUNK_SY } from '../core/constants.js';
import { block, isFluid, isSolid } from '../world/blocks.js';
import { TIER_SPEED, itemBlockId, toolOf } from '../world/items.js';

export interface Drop {
  id: number;
  count: number;
}

/**
 * Seconds to break a block with the held item. `hardness` is defined as hand-mining seconds,
 * a matching tool multiplies speed by its tier (IN-4); the wrong tool barely helps.
 */
export function breakTime(blockId: number, heldItemId: number): number {
  const d = block(blockId);
  if (!d) return Infinity;
  if (d.unbreakable) return Infinity;
  if (d.hardness <= 0) return 0;
  const tool = heldItemId ? toolOf(heldItemId) : undefined;
  let mult = 1;
  if (tool) {
    if (tool.kind === d.tool) mult = TIER_SPEED[tool.tier];
    else mult = 1 + tool.tier * 0.15; // wrong tool: marginally faster than hand
    if (tool.kind === 'sword' && d.tool !== 'none') mult = Math.min(mult, 1.3);
  }
  return Math.max(0.05, d.hardness / mult);
}

/** What the block yields. Returns null when the tool tier is too low (no drop, BI-3). */
export function dropFor(blockId: number, toolTier: number): Drop | null {
  const d = block(blockId);
  if (!d || d.unbreakable) return null;
  if (d.minTier > toolTier) return null;
  const id = d.drop ?? d.id;
  if (!id) return null;
  return { id, count: d.dropCount ?? 1 };
}

/** Is `heldItemId` a block that can be placed? */
export function heldBlockId(heldItemId: number): number {
  if (!heldItemId) return -1;
  const b = itemBlockId(heldItemId);
  return b === undefined ? -1 : b;
}

/**
 * A block may only be placed into air/fluid, must touch something (or sit on the ground), and must
 * not intersect a player or mob (BI-2).
 */
export function canPlaceAt(
  world: { getBlock(x: number, y: number, z: number): number },
  x: number,
  y: number,
  z: number,
  blockId: number,
): boolean {
  if (y < 0 || y >= CHUNK_SY) return false;
  const target = world.getBlock(x, y, z);
  if (target !== 0 && !isFluid(target)) return false;
  const d = block(blockId);
  if (!d) return false;
  if (d.cross) {
    // torches & plants need a solid support below or beside
    return (
      isSolid(world.getBlock(x, y - 1, z)) ||
      isSolid(world.getBlock(x + 1, y, z)) ||
      isSolid(world.getBlock(x - 1, y, z)) ||
      isSolid(world.getBlock(x, y, z + 1)) ||
      isSolid(world.getBlock(x, y, z - 1)) ||
      isSolid(world.getBlock(x, y + 1, z))
    );
  }
  // must not float in mid-air: require at least one solid neighbour
  return (
    isSolid(world.getBlock(x, y - 1, z)) ||
    isSolid(world.getBlock(x, y + 1, z)) ||
    isSolid(world.getBlock(x + 1, y, z)) ||
    isSolid(world.getBlock(x - 1, y, z)) ||
    isSolid(world.getBlock(x, y, z + 1)) ||
    isSolid(world.getBlock(x, y, z - 1))
  );
}

/** Does a solid block at this cell intersect the given AABB? (used to keep players from being sealed in) */
export function boxIntersectsCell(
  box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
  x: number,
  y: number,
  z: number,
): boolean {
  return box.maxX > x && box.minX < x + 1 && box.maxY > y && box.minY < y + 1 && box.maxZ > z && box.minZ < z + 1;
}
