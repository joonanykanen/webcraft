/** Crafting grid state for the 2×2 (inventory) and 3×3 (crafting table) grids (IN-3). */
import type { Slot } from '../core/types.js';
import { matchRecipe, type Recipe } from '../world/recipes.js';
import type { Inventory } from './inventory.js';

export class CraftingGrid {
  size: 2 | 3;
  cells: Slot[];

  constructor(size: 2 | 3) {
    this.size = size;
    this.cells = new Array(size * size).fill(null);
  }

  resize(size: 2 | 3, dropTo: (s: Slot) => void): void {
    if (size === this.size) return;
    for (const s of this.cells) if (s) dropTo(s);
    this.size = size;
    this.cells = new Array(size * size).fill(null);
  }

  set(index: number, slot: Slot): void {
    if (index >= 0 && index < this.cells.length) this.cells[index] = slot;
  }

  /** The recipe currently matched by the grid, plus its output stack. */
  current(): { recipe: Recipe; out: Slot } | null {
    const ids = this.cells.map((s) => (s ? s.id : 0));
    const recipe = matchRecipe(ids, this.size);
    if (!recipe) return null;
    if (recipe.needsTable && this.size < 3) return null;
    return { recipe, out: { id: recipe.result.id, count: recipe.result.count } };
  }

  /** Consume one of each occupied cell (the craft itself). Returns the produced stack. */
  craft(): Slot {
    const cur = this.current();
    if (!cur) return null;
    for (let i = 0; i < this.cells.length; i++) {
      const s = this.cells[i];
      if (!s) continue;
      s.count--;
      if (s.count <= 0) this.cells[i] = null;
    }
    return cur.out;
  }

  /** One-click craft from the recipe book (IN-6): pull ingredients straight from the inventory. */
  static craftFromBook(recipe: Recipe, inv: Inventory, hasTable: boolean): { ok: boolean; reason?: string } {
    if (recipe.needsTable && !hasTable) return { ok: false, reason: 'Needs a crafting table' };
    const need = new Map<number, number>();
    const addNeed = (id: number): void => {
      if (id) need.set(id, (need.get(id) ?? 0) + 1);
    };
    if (recipe.shapeless) recipe.shapeless.forEach(addNeed);
    else if (recipe.pattern) for (const row of recipe.pattern) row.forEach(addNeed);
    for (const [id, n] of need) if (inv.countItem(id) < n) return { ok: false, reason: 'Missing ingredients' };
    if (inv.add(recipe.result.id, recipe.result.count) > 0) return { ok: false, reason: 'Inventory full' };
    for (const [id, n] of need) inv.consume(id, n);
    return { ok: true };
  }

  drain(into: (s: Slot) => void): void {
    for (let i = 0; i < this.cells.length; i++) {
      const s = this.cells[i];
      if (s) {
        into(s);
        this.cells[i] = null;
      }
    }
  }
}
