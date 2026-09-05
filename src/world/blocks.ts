/**
 * Block registry. IDs 0–23 follow Appendix B of the PRD (fixed order); 19+ are the
 * additional v1 blocks (gravel, crafting table, chest, TNT, cactus).
 */
import { TILE } from './tiles.js';
import { TORCH_LIGHT } from '../core/constants.js';

export const BlockId = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  LOG: 4,
  PLANKS: 5,
  LEAVES: 6,
  SAND: 7,
  COAL_ORE: 8,
  IRON_ORE: 9,
  GOLD_ORE: 10,
  GEM_ORE: 11,
  WATER: 12,
  BEDROCK: 13,
  COBBLESTONE: 14,
  GLASS: 15,
  BRICK: 16,
  SNOW: 17,
  TORCH: 18,
  GRAVEL: 19,
  CRAFTING_TABLE: 20,
  CHEST: 21,
  TNT: 22,
  CACTUS: 23,
  SANDSTONE: 24,
} as const;
export type BlockId = (typeof BlockId)[keyof typeof BlockId];

export type StepSound = 'grass' | 'stone' | 'wood' | 'sand' | 'snow' | 'gravel' | 'glass' | 'dirt' | 'none';
export type ToolKind = 'none' | 'pickaxe' | 'axe' | 'shovel';

export interface BlockDef {
  id: number;
  name: string;
  /** [top, bottom, side] atlas tiles */
  faces: number[];
  solid: boolean;
  /** hides neighbouring faces & blocks light completely */
  opaque: boolean;
  /** cut-out alpha (leaves, glass, torch) — rendered in the "transparent" pass with alphaTest */
  cutout?: boolean;
  /** alpha-blended, sorted pass (water) */
  blend?: boolean;
  /** two crossed quads instead of a cube (torch) */
  cross?: boolean;
  fluid?: boolean;
  gravity?: boolean; // AM-5 sand/gravel
  unbreakable?: boolean;
  explosive?: boolean;
  /** seconds of hand-mining before the block breaks (0 = instant) */
  hardness: number;
  tool: ToolKind;
  /** lowest tool tier that yields a drop (0 hand, 1 wood, 2 stone, 3 iron, 4 gem) */
  minTier: number;
  light: number;
  drop?: number; // item id; defaults to own id
  dropCount?: number;
  sound: StepSound;
  /** shown in tooltips / pick-block availability */
  creativeOnly?: boolean;
}

const def = (id: number, name: string, faces: number[], rest: Partial<BlockDef> & { hardness: number }): BlockDef => ({
  id,
  name,
  faces,
  solid: true,
  opaque: true,
  light: 0,
  tool: 'none',
  minTier: 0,
  sound: 'dirt',
  ...rest,
});

export const BLOCKS: BlockDef[] = [
  def(BlockId.AIR, 'Air', [0, 0, 0], {
    hardness: 0,
    solid: false,
    opaque: false,
    sound: 'none',
  }),
  def(BlockId.GRASS, 'Grass Block', [TILE.GRASS_TOP, TILE.DIRT, TILE.GRASS_SIDE], {
    hardness: 0.5,
    tool: 'shovel',
    sound: 'grass',
    drop: BlockId.DIRT,
  }),
  def(BlockId.DIRT, 'Dirt', [TILE.DIRT, TILE.DIRT, TILE.DIRT], {
    hardness: 0.5,
    tool: 'shovel',
    sound: 'dirt',
  }),
  def(BlockId.STONE, 'Stone', [TILE.STONE, TILE.STONE, TILE.STONE], {
    hardness: 2.0,
    tool: 'pickaxe',
    minTier: 1,
    drop: BlockId.COBBLESTONE,
    sound: 'stone',
  }),
  def(BlockId.LOG, 'Wood Log', [TILE.LOG_TOP, TILE.LOG_TOP, TILE.LOG_SIDE], {
    hardness: 1.5,
    tool: 'axe',
    sound: 'wood',
  }),
  def(BlockId.PLANKS, 'Planks', [TILE.PLANKS, TILE.PLANKS, TILE.PLANKS], {
    hardness: 1.2,
    tool: 'axe',
    sound: 'wood',
  }),
  def(BlockId.LEAVES, 'Leaves', [TILE.LEAVES, TILE.LEAVES, TILE.LEAVES], {
    hardness: 0.25,
    opaque: false,
    cutout: true,
    sound: 'grass',
  }),
  def(BlockId.SAND, 'Sand', [TILE.SAND, TILE.SAND, TILE.SAND], {
    hardness: 0.5,
    tool: 'shovel',
    gravity: true,
    sound: 'sand',
  }),
  def(BlockId.COAL_ORE, 'Coal Ore', [TILE.COAL_ORE, TILE.COAL_ORE, TILE.COAL_ORE], {
    hardness: 2.4,
    tool: 'pickaxe',
    minTier: 1,
    drop: 103,
    sound: 'stone',
  }),
  def(BlockId.IRON_ORE, 'Iron Ore', [TILE.IRON_ORE, TILE.IRON_ORE, TILE.IRON_ORE], {
    hardness: 2.8,
    tool: 'pickaxe',
    minTier: 2,
    drop: 104,
    sound: 'stone',
  }),
  def(BlockId.GOLD_ORE, 'Gold Ore', [TILE.GOLD_ORE, TILE.GOLD_ORE, TILE.GOLD_ORE], {
    hardness: 3.0,
    tool: 'pickaxe',
    minTier: 3,
    drop: 105,
    sound: 'stone',
  }),
  def(BlockId.GEM_ORE, 'Gem Ore', [TILE.GEM_ORE, TILE.GEM_ORE, TILE.GEM_ORE], {
    hardness: 3.4,
    tool: 'pickaxe',
    minTier: 3,
    drop: 106,
    sound: 'stone',
  }),
  def(BlockId.WATER, 'Water', [TILE.WATER, TILE.WATER, TILE.WATER], {
    hardness: 999,
    solid: false,
    opaque: false,
    blend: true,
    fluid: true,
    unbreakable: true,
    sound: 'none',
  }),
  def(BlockId.BEDROCK, 'Bedrock', [TILE.BEDROCK, TILE.BEDROCK, TILE.BEDROCK], {
    hardness: 999,
    unbreakable: true,
    sound: 'stone',
  }),
  def(BlockId.COBBLESTONE, 'Cobblestone', [TILE.COBBLE, TILE.COBBLE, TILE.COBBLE], {
    hardness: 2.2,
    tool: 'pickaxe',
    minTier: 1,
    sound: 'stone',
  }),
  def(BlockId.GLASS, 'Glass', [TILE.GLASS, TILE.GLASS, TILE.GLASS], {
    hardness: 0.3,
    opaque: false,
    cutout: true,
    sound: 'glass',
  }),
  def(BlockId.BRICK, 'Bricks', [TILE.BRICK, TILE.BRICK, TILE.BRICK], {
    hardness: 2.0,
    tool: 'pickaxe',
    minTier: 1,
    sound: 'stone',
  }),
  def(BlockId.SNOW, 'Snow Block', [TILE.SNOW_TOP, TILE.DIRT, TILE.SNOW_TOP], {
    hardness: 0.3,
    tool: 'shovel',
    sound: 'snow',
  }),
  def(BlockId.TORCH, 'Torch', [TILE.TORCH, TILE.TORCH, TILE.TORCH], {
    hardness: 0.02,
    solid: false,
    opaque: false,
    cutout: true,
    cross: true,
    light: TORCH_LIGHT,
    sound: 'wood',
  }),
  def(BlockId.GRAVEL, 'Gravel', [TILE.GRAVEL, TILE.GRAVEL, TILE.GRAVEL], {
    hardness: 0.6,
    tool: 'shovel',
    gravity: true,
    sound: 'gravel',
  }),
  def(BlockId.CRAFTING_TABLE, 'Crafting Table', [TILE.CRAFT_TOP, TILE.PLANKS, TILE.CRAFT_SIDE], {
    hardness: 1.2,
    tool: 'axe',
    sound: 'wood',
  }),
  def(BlockId.CHEST, 'Chest', [TILE.CHEST_TOP, TILE.PLANKS, TILE.CHEST_FRONT], {
    hardness: 1.0,
    tool: 'axe',
    sound: 'wood',
  }),
  def(BlockId.TNT, 'Volatile Block', [TILE.TNT_TOP, TILE.TNT_TOP, TILE.TNT_SIDE], {
    hardness: 0.2,
    explosive: true,
    sound: 'grass',
  }),
  def(BlockId.CACTUS, 'Cactus', [TILE.CACTUS_TOP, TILE.CACTUS_TOP, TILE.CACTUS_SIDE], {
    hardness: 0.4,
    opaque: false,
    cutout: true,
    sound: 'grass',
  }),
  def(BlockId.SANDSTONE, 'Sandstone', [TILE.SANDSTONE, TILE.SANDSTONE, TILE.SANDSTONE], {
    hardness: 1.6,
    tool: 'pickaxe',
    minTier: 1,
    sound: 'stone',
  }),
];

export const BLOCK_COUNT = BLOCKS.length;

const isSolidTable = new Uint8Array(BLOCK_COUNT);
const isOpaqueTable = new Uint8Array(BLOCK_COUNT);
const isFluidTable = new Uint8Array(BLOCK_COUNT);
const lightTable = new Uint8Array(BLOCK_COUNT);
const gravityTable = new Uint8Array(BLOCK_COUNT);
const cutoutTable = new Uint8Array(BLOCK_COUNT);
const blendTable = new Uint8Array(BLOCK_COUNT);
const crossTable = new Uint8Array(BLOCK_COUNT);

for (let i = 0; i < BLOCK_COUNT; i++) {
  const b = BLOCKS[i];
  isSolidTable[i] = b.solid ? 1 : 0;
  isOpaqueTable[i] = b.opaque ? 1 : 0;
  isFluidTable[i] = b.fluid ? 1 : 0;
  lightTable[i] = b.light | 0;
  gravityTable[i] = b.gravity ? 1 : 0;
  cutoutTable[i] = b.cutout ? 1 : 0;
  blendTable[i] = b.blend ? 1 : 0;
  crossTable[i] = b.cross ? 1 : 0;
}

export function block(id: number): BlockDef {
  return BLOCKS[id] ?? BLOCKS[0];
}
export function isAir(id: number): boolean {
  return id === 0;
}
export function isSolid(id: number): boolean {
  return isSolidTable[id] === 1;
}
export function isOpaque(id: number): boolean {
  return isOpaqueTable[id] === 1;
}
export function isFluid(id: number): boolean {
  return isFluidTable[id] === 1;
}
export function blockLight(id: number): number {
  return lightTable[id];
}
export function hasGravity(id: number): boolean {
  return gravityTable[id] === 1;
}
export function isCutout(id: number): boolean {
  return cutoutTable[id] === 1;
}
export function isBlend(id: number): boolean {
  return blendTable[id] === 1;
}
export function isCross(id: number): boolean {
  return crossTable[id] === 1;
}
/** Face hidden from a neighbour of type `n` (used by the mesher). */
export function hidesFace(self: number, n: number): boolean {
  if (n === 0) return false;
  if (isOpaque(n)) return true;
  // don't render internal faces between identical transparent materials — except leaves, whose
  // cut-out texture has holes and would look hollow otherwise
  if (n === self) return self !== BlockId.LEAVES;
  return false;
}
/** Does light pass through this block? returns attenuation (0..15), or 15 for "blocked". */
export function lightAttenuation(id: number): number {
  if (id === 0) return 1;
  if (isOpaque(id)) return 15;
  if (id === BlockId.WATER) return 2;
  if (id === BlockId.LEAVES) return 2;
  if (id === BlockId.GLASS) return 1;
  return 1;
}
export function blockName(id: number): string {
  return block(id).name;
}
/** Tile for a face direction index: 0 +Y, 1 -Y, 2..5 sides */
export function faceTile(id: number, faceIndex: number): number {
  const b = block(id);
  if (faceIndex === 0) return b.faces[0];
  if (faceIndex === 1) return b.faces[1];
  return b.faces[2];
}

/** Creative-mode block picker list. */
export const PLACEABLE_BLOCKS: number[] = BLOCKS.filter(
  (b) => b.id !== BlockId.AIR && !b.creativeOnly,
).map((b) => b.id);
