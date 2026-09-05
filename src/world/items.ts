/** Items: block items reuse block ids; non-block items use 100+, tools use 200+. */
import { BLOCKS } from './blocks.js';

export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword';

export interface IconSpec {
  kind: 'block' | 'stick' | 'apple' | 'meat' | 'coal' | 'ingot' | 'gem' | 'tool';
  blockId?: number;
  tool?: ToolKind;
  tier?: number;
  color?: string;
}

export interface ItemDef {
  id: number;
  name: string;
  maxStack: number;
  blockId?: number;
  tool?: { kind: ToolKind; tier: number; damage: number; durability: number };
  /** hunger points restored when eaten (IN-5) */
  food?: number;
  icon: IconSpec;
  desc?: string;
}

export const TIER_NAMES = ['Hand', 'Wood', 'Stone', 'Iron', 'Gem'];
export const TIER_COLORS = ['#8a8f96', '#a5793f', '#9aa0a6', '#dfe3e8', '#4fd6c9'];
/** Mining speed multiplier when the right tool type is used, per tier (IN-4). */
export const TIER_SPEED = [1, 2.4, 4.2, 6.4, 9.0];
export const TIER_MINING_MULT = [1, 2, 4, 7, 12];

const byId = new Map<number, ItemDef>();

function reg(d: ItemDef): void {
  byId.set(d.id, d);
}

/** Register every block id as an item too (IN-2: stack type = block id). */
export function registerBlockItems(blockIds: { id: number; name: string }[]): void {
  for (const b of blockIds) {
    if (b.id === 0) continue;
    reg({
      id: b.id,
      name: b.name,
      maxStack: 64,
      blockId: b.id,
      icon: { kind: 'block', blockId: b.id },
    });
  }
}

export const ItemId = {
  STICK: 100,
  APPLE: 101,
  MEAT: 102,
  COAL: 103,
  IRON: 104,
  GOLD: 105,
  GEM: 106,
} as const;

reg({
  id: ItemId.STICK,
  name: 'Stick',
  maxStack: 64,
  icon: { kind: 'stick' },
  desc: 'Handle for tools and torches.',
});
reg({
  id: ItemId.APPLE,
  name: 'Apple',
  maxStack: 64,
  food: 4,
  icon: { kind: 'apple' },
  desc: 'Found in leaves. Restores hunger.',
});
reg({
  id: ItemId.MEAT,
  name: 'Field Meat',
  maxStack: 64,
  food: 3,
  icon: { kind: 'meat' },
  desc: 'Dropped by creatures. Restores hunger.',
});
reg({ id: ItemId.COAL, name: 'Coal', maxStack: 64, icon: { kind: 'coal' }, desc: 'For torches.' });
reg({ id: ItemId.IRON, name: 'Iron Shard', maxStack: 64, icon: { kind: 'ingot', color: '#dfe3e8' } });
reg({ id: ItemId.GOLD, name: 'Gold Shard', maxStack: 64, icon: { kind: 'ingot', color: '#f0c33c' } });
reg({
  id: ItemId.GEM,
  name: 'Gem',
  maxStack: 64,
  icon: { kind: 'gem' },
  desc: 'Deep-crystal, found far below sea level.',
});

const TOOL_TEMPLATES: { base: number; kind: ToolKind; label: string; damage: number }[] = [
  { base: 200, kind: 'pickaxe', label: 'Pickaxe', damage: 3 },
  { base: 210, kind: 'axe', label: 'Axe', damage: 4 },
  { base: 220, kind: 'shovel', label: 'Shovel', damage: 2 },
  { base: 230, kind: 'sword', label: 'Sword', damage: 6 },
];
const TIER_LABEL = ['Wood', 'Stone', 'Iron', 'Gem'];
const TIER_DURA = [64, 132, 252, 400];

export const ToolId = {
  WOOD_PICKAXE: 200,
  STONE_PICKAXE: 201,
  IRON_PICKAXE: 202,
  GEM_PICKAXE: 203,
  WOOD_AXE: 210,
  WOOD_SHOVEL: 220,
  WOOD_SWORD: 230,
} as const;

for (const t of TOOL_TEMPLATES) {
  for (let tier = 1; tier <= 4; tier++) {
    const id = t.base + tier - 1;
    reg({
      id,
      name: `${TIER_LABEL[tier - 1]} ${t.label}`,
      maxStack: 1,
      tool: { kind: t.kind, tier, damage: t.damage + (tier - 1), durability: TIER_DURA[tier - 1] },
      icon: { kind: 'tool', tool: t.kind, tier },
      desc: `Tier ${tier} ${t.kind} — mines ${t.kind === 'sword' ? 'nothing special' : 'faster'}.`,
    });
  }
}

export function item(id: number): ItemDef | undefined {
  return byId.get(id);
}
export function itemName(id: number): string {
  return byId.get(id)?.name ?? `#${id}`;
}
export function maxStack(id: number): number {
  return byId.get(id)?.maxStack ?? 64;
}
export function itemBlockId(id: number): number | undefined {
  return byId.get(id)?.blockId;
}
export function isPlaceable(id: number): boolean {
  return byId.get(id)?.blockId !== undefined;
}
export function toolOf(id: number) {
  return byId.get(id)?.tool;
}
export function foodOf(id: number): number | undefined {
  return byId.get(id)?.food;
}
export function allItemIds(): number[] {
  return [...byId.keys()];
}
export function iconOf(id: number): IconSpec {
  return byId.get(id)?.icon ?? { kind: 'coal' };
}

// Block items must be registered before anything looks them up.
registerBlockItems(BLOCKS.map((b) => ({ id: b.id, name: b.name })));
