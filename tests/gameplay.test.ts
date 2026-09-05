/** Inventory, tools, crafting and recipe registry (IN-1 … IN-6, BI-3). */
import { describe, expect, it } from 'vitest';
import { HOTBAR_SLOTS, INVENTORY_TOTAL, MAX_STACK } from '../src/core/constants.js';
import { Inventory } from '../src/game/inventory.js';
import { CraftingGrid } from '../src/game/crafting.js';
import { RECIPES, matchRecipe, recipeBook, recipeIngredients } from '../src/world/recipes.js';
import { BLOCK_COUNT, BlockId, block } from '../src/world/blocks.js';
import { ItemId, allItemIds, iconOf, item, maxStack, toolOf } from '../src/world/items.js';
import { ATLAS_TILES } from '../src/core/constants.js';

describe('inventory (IN-1)', () => {
  it('has a hotbar plus 27 main slots', () => {
    const inv = new Inventory();
    expect(inv.main.length).toBe(INVENTORY_TOTAL);
    expect(inv.hotbar.length).toBe(HOTBAR_SLOTS);
    expect(INVENTORY_TOTAL).toBe(HOTBAR_SLOTS + 27);
  });

  it('stacks into the first matching slot then the first free one', () => {
    const inv = new Inventory();
    expect(inv.add(BlockId.DIRT, 40)).toBe(0);
    expect(inv.slot(0)?.count).toBe(40);
    expect(inv.add(BlockId.DIRT, 40)).toBe(0);
    expect(inv.slot(0)?.count).toBe(MAX_STACK);
    expect(inv.slot(1)?.count).toBe(40 - (MAX_STACK - 40));
    expect(inv.countItem(BlockId.DIRT)).toBe(80);
  });

  it('reports leftovers when the pack is full', () => {
    const inv = new Inventory();
    for (let i = 0; i < INVENTORY_TOTAL; i++) inv.setSlot(i, { id: BlockId.STONE, count: 1 });
    const left = inv.add(BlockId.GOLD_ORE, 5);
    expect(left).toBe(5); // no room, and nothing was created
    expect(inv.countItem(BlockId.GOLD_ORE)).toBe(0);
  });

  it('consume removes exactly what it claims', () => {
    const inv = new Inventory();
    inv.add(ItemId.STICK, 12);
    expect(inv.consume(ItemId.STICK, 5)).toBe(true);
    expect(inv.countItem(ItemId.STICK)).toBe(7);
    expect(inv.consume(ItemId.STICK, 8)).toBe(false);
    expect(inv.countItem(ItemId.STICK)).toBe(7); // failed consume changes nothing
  });

  it('quick-move shuttles between hotbar and main grid (IN-2)', () => {
    const inv = new Inventory();
    inv.setSlot(2, { id: BlockId.LOG, count: 10 });
    expect(inv.quickMove(2, HOTBAR_SLOTS, INVENTORY_TOTAL - 1)).toBe(true);
    expect(inv.slot(2)).toBeNull();
    expect(inv.slot(HOTBAR_SLOTS)?.id).toBe(BlockId.LOG);
    expect(inv.quickMove(HOTBAR_SLOTS, 0, HOTBAR_SLOTS - 1)).toBe(true);
    expect(inv.slot(0)?.id).toBe(BlockId.LOG);
  });

  it('swap exchanges slots', () => {
    const inv = new Inventory();
    inv.setSlot(0, { id: BlockId.SAND, count: 3 });
    inv.setSlot(5, { id: BlockId.GLASS, count: 2 });
    inv.swap(0, 5);
    expect(inv.slot(0)?.id).toBe(BlockId.GLASS);
    expect(inv.slot(5)?.id).toBe(BlockId.SAND);
  });

  it('tools wear out and break (IN-6)', () => {
    const inv = new Inventory();
    inv.setSlot(0, { id: 200, count: 1, durabilityLeft: 3 }); // wooden pickaxe
    expect(inv.useToolDurability()).toBe(false);
    expect(inv.slot(0)?.durabilityLeft).toBe(2);
    inv.useToolDurability();
    expect(inv.slot(0)?.durabilityLeft).toBe(1);
    expect(inv.useToolDurability()).toBe(true); // broke
    expect(inv.slot(0)).toBeNull();
  });

  it('durability only applies to tools', () => {
    const inv = new Inventory();
    inv.setSlot(0, { id: BlockId.DIRT, count: 5 });
    inv.select(0);
    expect(inv.useToolDurability()).toBe(false);
    expect(inv.slot(0)?.count).toBe(5);
  });

  it('selects and cycles the hotbar', () => {
    const inv = new Inventory();
    inv.select(4);
    expect(inv.selected).toBe(4);
    inv.cycle(1);
    expect(inv.selected).toBe(5);
    inv.select(0);
    inv.cycle(-1);
    expect(inv.selected).toBe(HOTBAR_SLOTS - 1); // wraps
    inv.select(99);
    expect(inv.selected).toBe(HOTBAR_SLOTS - 1); // clamped
  });

  it('finds the best tool for the job', () => {
    const inv = new Inventory();
    expect(inv.bestToolTier()).toBe(0);
    inv.setSlot(1, { id: 201, count: 1 }); // stone pickaxe
    inv.setSlot(2, { id: 200, count: 1 });
    expect(inv.bestToolTier()).toBe(2);
  });

  it('picks edible items only', () => {
    const inv = new Inventory();
    inv.setSlot(0, { id: BlockId.STONE, count: 4 });
    expect(inv.takeFood()).toBeNull();
    inv.setSlot(1, { id: ItemId.APPLE, count: 2 });
    const food = inv.takeFood();
    expect(food?.id).toBe(ItemId.APPLE);
    expect(food!.food).toBeGreaterThan(0);
    expect(inv.countItem(ItemId.APPLE)).toBe(1);
  });

  it('survives a save round-trip', () => {
    const inv = new Inventory();
    inv.add(BlockId.TORCH, 12);
    inv.setSlot(7, { id: 202, count: 1, durabilityLeft: 40 });
    inv.select(7);
    const copy = new Inventory();
    copy.deserialize(inv.serialize());
    expect(copy.slot(0)).toEqual(inv.slot(0));
    expect(copy.slot(7)).toEqual(inv.slot(7));
  });

  it('a new survival character starts with nothing but earns a starter kit', () => {
    const fresh = new Inventory();
    expect(fresh.main.filter((s) => s !== null).length).toBe(0);
    fresh.giveStarterKit();
    const given = fresh.main.filter((s): s is NonNullable<typeof s> => s !== null);
    expect(given.length).toBeGreaterThan(0);
    for (const s of given) expect(s.count).toBeLessThanOrEqual(maxStack(s.id));
  });
});

describe('crafting (IN-3, IN-4, IN-5)', () => {
  it('shapeless planks work in the 2×2 hand grid', () => {
    const grid = new CraftingGrid(2);
    grid.set(0, { id: BlockId.LOG, count: 1 });
    const cur = grid.current();
    expect(cur?.recipe.id).toBe('planks');
    const out = grid.craft();
    expect(out?.id).toBe(BlockId.PLANKS);
    expect(out!.count).toBe(4);
    expect(grid.cells.every((c) => c === null)).toBe(true); // consumed
  });

  it('shaped recipes are trimmed, so off-centre placement still crafts', () => {
    const grid = new CraftingGrid(3);
    grid.set(4, { id: BlockId.PLANKS, count: 1 });
    grid.set(7, { id: BlockId.PLANKS, count: 1 });
    expect(grid.current()?.recipe.id).toBe('sticks');
  });

  it('table-only recipes are hidden from the 2×2 grid', () => {
    for (const id of [200, 201, 202, 203, 210, 220, 230, BlockId.CHEST, BlockId.TNT]) {
      const r = RECIPES.find((x) => x.result.id === id);
      expect(r, `recipe for ${id}`).toBeDefined();
      expect(r!.needsTable, `recipe ${r!.id} should need a crafting table`).toBe(true);
    }
    const hand = new CraftingGrid(2);
    for (let i = 0; i < 3; i++) hand.set(i, { id: BlockId.PLANKS, count: 1 });
    hand.set(4, { id: ItemId.STICK, count: 1 });
    hand.set(7, { id: ItemId.STICK, count: 1 });
    expect(hand.current()).toBeNull(); // too small for a 3-wide pattern

    const g2 = new CraftingGrid(3);
    for (let i = 0; i < 3; i++) g2.set(i, { id: BlockId.PLANKS, count: 1 });
    g2.set(4, { id: ItemId.STICK, count: 1 });
    g2.set(7, { id: ItemId.STICK, count: 1 });
    expect(g2.current()?.recipe.id).toBe('wood_pickaxe');
    const out = g2.craft();
    expect(out?.id).toBe(200);
    expect(g2.cells.filter((c) => c !== null).length).toBe(0); // one of each cell consumed
  });

  it('crafting consumes one ingredient per slot and can repeat', () => {
    const grid = new CraftingGrid(2);
    grid.set(0, { id: BlockId.LOG, count: 3 });
    expect(grid.craft()?.count).toBe(4);
    expect(grid.craft()?.count).toBe(4);
    expect(grid.cells[0]?.count).toBe(1);
    expect(grid.craft()).not.toBeNull();
    expect(grid.current()).toBeNull();
  });

  it('resizing the grid returns the ingredients', () => {
    const grid = new CraftingGrid(2);
    grid.set(0, { id: BlockId.LOG, count: 2 });
    const returned: number[] = [];
    grid.resize(3, (s) => {
      if (s) returned.push(s.count);
    });
    expect(grid.size).toBe(3);
    expect(grid.cells.length).toBe(9);
    expect(returned.length).toBeGreaterThan(0);
  });

  it('drain empties the grid', () => {
    const grid = new CraftingGrid(3);
    grid.set(2, { id: BlockId.LOG, count: 4 });
    const out: number[] = [];
    grid.drain((s) => {
      if (s) out.push(s.count);
    });
    expect(out).toEqual([4]);
    expect(grid.cells.every((c) => c === null)).toBe(true);
  });

  it('nothing crafts from an empty or mismatched grid', () => {
    const grid = new CraftingGrid(3);
    expect(grid.current()).toBeNull();
    grid.set(0, { id: BlockId.SNOW, count: 1 });
    expect(grid.current()).toBeNull();
    expect(grid.craft()).toBeNull();
  });
});

describe('recipe registry (IN-5)', () => {
  it('covers the survival progression with at least 12 recipes', () => {
    expect(RECIPES.length).toBeGreaterThanOrEqual(12);
    const ids = new Set(RECIPES.map((r) => r.id));
    for (const need of [
      'planks',
      'sticks',
      'crafting_table',
      'torch',
      'chest',
      'glass',
      'tnt',
      'wood_pickaxe',
      'stone_pickaxe',
      'iron_pickaxe',
      'gem_pickaxe',
      'wood_sword',
    ]) {
      expect(ids.has(need), `missing recipe: ${need}`).toBe(true);
    }
  });

  it('every recipe uses known items only', () => {
    const known = new Set(allItemIds());
    for (const r of RECIPES) {
      expect(known.has(r.result.id), `unknown result ${r.result.id}`).toBe(true);
      for (const [id] of recipeIngredients(r)) expect(known.has(id), `unknown ingredient ${id}`).toBe(true);
      expect(r.result.count).toBeGreaterThan(0);
    }
  });

  it('matchRecipe ignores empty rows and columns', () => {
    const planks = BlockId.PLANKS;
    expect(matchRecipe([0, 0, 0, 0, planks, planks, 0, planks, planks], 3)?.id).toBe('crafting_table');
    expect(matchRecipe([planks, planks, planks, planks, 0, 0, 0, 0, 0], 3)).toBeNull();
  });

  it('shapeless recipes match in any arrangement', () => {
    expect(matchRecipe([BlockId.LOG, 0, 0, 0], 2)?.id).toBe('planks');
    expect(matchRecipe([0, 0, 0, BlockId.LOG], 2)?.id).toBe('planks');
  });

  it('the recipe book reports ingredient counts for the crafting panels', () => {
    const inv = new Inventory();
    inv.add(BlockId.LOG, 4);
    inv.add(ItemId.STICK, 8);
    const book = recipeBook(inv.main);
    expect(book.length).toBe(RECIPES.length);
    const planks = book.find((b) => b.recipe.id === 'planks');
    expect(planks!.possible).toBe(4); // one craft per log in the pack
    const table = book.find((b) => b.recipe.id === 'crafting_table');
    expect(table!.possible).toBe(0); // no planks in the pack yet
    expect(recipeBook([null, undefined, { id: BlockId.LOG }]).length).toBe(RECIPES.length);
    expect(recipeBook([{ id: BlockId.LOG, count: 8 }]).find((b) => b.recipe.id === 'planks')!.possible).toBe(8);
  });

  it('no recipe is an infinite resource loop', () => {
    // anything whose result is also its only ingredient would duplicate items forever
    for (const r of RECIPES) {
      const need = recipeIngredients(r);
      if (need.size === 1) {
        const [id, n] = [...need.entries()][0];
        if (id === r.result.id) expect(n).toBeGreaterThan(r.result.count);
      }
    }
  });
});

describe('item & block registries stay consistent', () => {
  const TILE_COUNT = ATLAS_TILES * ATLAS_TILES;

  it('every block has a name, tiles and sane physics', () => {
    const ids = Array.from({ length: BLOCK_COUNT - 1 }, (_, i) => i + 1);
    expect(BLOCK_COUNT).toBeGreaterThan(16);
    for (const id of ids) {
      const d = block(id);
      expect(d, `block ${id}`).toBeDefined();
      expect(d!.name.length, `block ${id} name`).toBeGreaterThan(0);
      for (const tile of d!.faces) expect(tile).toBeLessThan(TILE_COUNT);
      expect(d!.hardness).toBeGreaterThanOrEqual(0);
    }
    expect(block(0)!.solid).toBe(false);
    expect(block(9999)).toBe(block(0)); // unknown ids fall back to air
  });

  it('every item resolves to an icon and a stack size', () => {
    for (const id of allItemIds()) {
      const def = item(id);
      expect(def, `item ${id}`).toBeDefined();
      expect(def!.name.length).toBeGreaterThan(0);
      expect(maxStack(id)).toBeGreaterThan(0);
      expect(maxStack(id)).toBeLessThanOrEqual(MAX_STACK);
      const icon = iconOf(id);
      if (icon.blockId !== undefined) expect(block(icon.blockId)).toBeDefined();
    }
  });

  it('tools declare tier, damage and durability', () => {
    const tools = [200, 201, 202, 203, 210, 211, 212, 213, 220, 221, 222, 223, 230, 231, 232, 233];
    let found = 0;
    for (const id of tools) {
      const t = toolOf(id);
      if (!t) continue;
      found++;
      expect(t.tier).toBeGreaterThanOrEqual(1);
      expect(t.tier).toBeLessThanOrEqual(4);
      expect(t.damage).toBeGreaterThan(0);
      expect(t.durability).toBeGreaterThan(0);
    }
    expect(found).toBeGreaterThanOrEqual(8);
  });

  it('block items point at real blocks', () => {
    for (const id of allItemIds()) {
      const b = item(id);
      if (b?.blockId !== undefined) expect(block(b.blockId), `item ${id} → block ${b.blockId}`).toBeDefined();
    }
  });
});
