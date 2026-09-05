/** Inventory, crafting grid, chest and recipe-book UI (IN-1 … IN-6, UI-3). */
import { HOTBAR_SLOTS, INVENTORY_TOTAL } from '../core/constants.js';
import type { Slot } from '../core/types.js';
import { BlockId } from '../world/blocks.js';
import { item, maxStack, toolOf } from '../world/items.js';
import { RECIPES, type Recipe } from '../world/recipes.js';
import type { CraftingGrid } from '../game/crafting.js';
import type { Inventory } from '../game/inventory.js';
import { drawItemIcon, durabilityFrac } from './icons.js';

/** A read/write view onto one stack, wherever it lives (inventory, grid, chest, result). */
interface Accessor {
  get(): Slot;
  set(v: Slot): void;
  label?: string;
  /** shift-click quick-move; returns true when something moved */
  shift?: (inv: Inventory) => boolean;
}

interface SlotOpts {
  readonly?: boolean;
  /** use an existing element as the slot root instead of creating one */
  host?: HTMLElement;
}

class SlotWidget {
  root: HTMLElement;
  private canvas = document.createElement('canvas');
  private count = document.createElement('span');
  private bar = document.createElement('div');
  private sig = '';

  constructor(
    readonly acc: Accessor,
    readonly ui: InventoryUI,
    readonly opts: SlotOpts = {},
  ) {
    this.root = opts.host ?? document.createElement('div');
    if (!opts.host) this.root.className = 'slot';
    this.root.classList.add('slot');
    this.canvas.width = 44;
    this.canvas.height = 44;
    this.count.className = 'count';
    this.bar.className = 'durability';
    this.root.append(this.canvas, this.count, this.bar);
    this.root.addEventListener('mousedown', (e) => this.ui.onSlotMouseDown(this, e));
    this.root.addEventListener('mouseenter', () => this.ui.showTip(this.acc, this));
    this.root.addEventListener('mouseleave', () => this.ui.hideTip());
  }

  /** Item currently displayed (used for durability tooltips). */
  item(): Slot {
    return this.acc.get();
  }

  refresh(version: number): void {
    const s = this.acc.get();
    const id = s?.id ?? 0;
    const dur = s ? durabilityFrac(id, s.durabilityLeft) : null;
    const sig = `${id}:${s?.count ?? 0}:${dur === null ? '-' : dur.toFixed(2)}:${this.ui.hoverResult ? 'r' : ''}:${version}`;
    if (sig === this.sig) return;
    this.sig = sig;
    if (id === 0) {
      this.canvas.style.visibility = 'hidden';
      this.count.textContent = '';
      this.bar.style.display = 'none';
      return;
    }
    this.canvas.style.visibility = 'visible';
    const ctx = this.canvas.getContext('2d');
    if (ctx) drawItemIcon(ctx, id, this.canvas.width);
    this.count.textContent = (s?.count ?? 0) > 1 ? String(s?.count ?? 0) : '';
    if (dur !== null) {
      this.bar.style.display = 'block';
      this.bar.style.width = `${Math.round(dur * 100)}%`;
      this.bar.style.background = dur > 0.5 ? '#5ad46a' : dur > 0.22 ? '#e8c34a' : '#e05252';
    } else {
      this.bar.style.display = 'none';
    }
    this.root.classList.toggle('tool', !!toolOf(id));
  }
}

export interface InventoryBindings {
  inventory: Inventory;
  grid: CraftingGrid;
  hasTable: () => boolean;
  chestSlots: () => Slot[] | null;
  onChanged: () => void;
  craftSound: () => void;
  notify: (text: string, kind?: 'info' | 'warn' | 'good') => void;
}

export class InventoryUI {
  version = 0;
  hoverResult = false;
  private mainGrid = el<HTMLDivElement>('inv-main');
  private hotbarGrid = el<HTMLDivElement>('inv-hotbar');
  private craftGrid = el<HTMLDivElement>('craft-grid');
  private craftResult = el<HTMLElement>('craft-result');
  private craftLabel = el<HTMLElement>('craft-label');
  private chestGrid = el<HTMLDivElement>('chest-grid');
  private chestMainGrid = el<HTMLDivElement>('chest-inv-main');
  private chestHotbarGrid = el<HTMLDivElement>('chest-inv-hotbar');
  private recipeList = el<HTMLElement>('recipe-list');
  private recipeFilter = el<HTMLInputElement>('recipe-filter');
  private invTitle = el<HTMLElement>('inv-title');
  private cursorEl = el<HTMLElement>('cursor-stack');
  private cursorCanvas = document.createElement('canvas');
  private cursorCount = document.createElement('span');
  private tip = el<HTMLElement>('tooltip');
  private widgets: SlotWidget[] = [];
  private resultWidget: SlotWidget | null = null;
  private recipeWidgets = new Map<string, HTMLElement>();
  private b: InventoryBindings;

  constructor(bindings: InventoryBindings) {
    this.b = bindings;
    this.cursorCanvas.width = 44;
    this.cursorCanvas.height = 44;
    this.cursorCount.className = 'count';
    this.cursorEl.append(this.cursorCanvas, this.cursorCount);
    this.cursorEl.classList.add('hidden');
    window.addEventListener('mousemove', (e) => {
      this.cursorEl.style.left = `${e.clientX}px`;
      this.cursorEl.style.top = `${e.clientY}px`;
      if (!this.tip.classList.contains('hidden')) {
        this.tip.style.left = `${Math.min(window.innerWidth - 310, e.clientX + 16)}px`;
        this.tip.style.top = `${Math.min(window.innerHeight - 110, e.clientY + 18)}px`;
      }
    });
    this.recipeFilter.addEventListener('input', () => this.refreshRecipes());
    this.buildRecipeBook();
  }

  // ------------------------------------------------------------ construction
  build(mode: 'inventory' | 'chest'): void {
    const inv = this.b.inventory;
    const chest = mode === 'chest' ? this.b.chestSlots() : null;
    this.widgets = [];
    this.resultWidget = null;
    for (const host of [this.mainGrid, this.hotbarGrid, this.craftGrid, this.chestGrid, this.chestMainGrid, this.chestHotbarGrid]) {
      host.textContent = '';
    }
    const mk = (acc: Accessor, host: HTMLElement, opts?: SlotOpts): SlotWidget => {
      const w = new SlotWidget(acc, this, opts);
      host.append(w.root);
      this.widgets.push(w);
      return w;
    };
    const invSlot = (i: number, host: HTMLElement, shiftStart: number, shiftEnd: number): void => {
      mk(
        {
          get: () => inv.main[i] ?? null,
          set: (v) => inv.setSlot(i, v),
          label: i < HOTBAR_SLOTS ? 'Hotbar' : 'Inventory',
          shift: (inv2) => inv2.quickMove(i, shiftStart, shiftEnd),
        },
        host,
      );
    };

    if (mode === 'chest' && chest) {
      this.invTitle.textContent = 'Chest';
      for (let i = 0; i < chest.length; i++) {
        mk(
          {
            get: () => chest[i] ?? null,
            set: (v) => {
              chest[i] = v;
              this.changed();
            },
            label: 'Chest',
            shift: (inv2) => {
              const s = chest[i];
              if (!s) return false;
              const left = inv2.add(s.id, s.count, s.durabilityLeft);
              chest[i] = left > 0 ? { ...s, count: left } : null;
              return left !== s.count;
            },
          },
          this.chestGrid,
        );
      }
      for (let i = HOTBAR_SLOTS; i < INVENTORY_TOTAL; i++) invSlot(i, this.chestMainGrid, 0, HOTBAR_SLOTS - 1);
      for (let i = 0; i < HOTBAR_SLOTS; i++) invSlot(i, this.chestHotbarGrid, HOTBAR_SLOTS, INVENTORY_TOTAL - 1);
    } else {
      this.invTitle.textContent = 'Inventory';
      for (let i = HOTBAR_SLOTS; i < INVENTORY_TOTAL; i++) invSlot(i, this.mainGrid, 0, HOTBAR_SLOTS - 1);
      for (let i = 0; i < HOTBAR_SLOTS; i++) invSlot(i, this.hotbarGrid, HOTBAR_SLOTS, INVENTORY_TOTAL - 1);

      // crafting grid: 2×2 by hand, 3×3 next to a crafting table (IN-3)
      const grid = this.b.grid;
      const size = this.b.hasTable() ? 3 : 2;
      grid.resize(size as 2 | 3, (s) => {
        if (s) inv.add(s.id, s.count, s.durabilityLeft);
      });
      this.craftGrid.style.gridTemplateColumns = `repeat(${size}, 52px)`;
      for (let i = 0; i < size * size; i++) {
        mk(
          {
            get: () => grid.cells[i] ?? null,
            set: (v) => {
              grid.set(i, v);
              this.changed();
            },
            label: 'Crafting grid',
            shift: () => false,
          },
          this.craftGrid,
        );
      }
      this.craftLabel.textContent =
        size === 3
          ? '3×3 crafting table in range — full recipe set available'
          : '2×2 grid — place and use a crafting table for the full 3×3 grid';

      this.craftResult.textContent = '';
      this.resultWidget = new SlotWidget(
        {
          get: () => this.b.grid.current()?.out ?? null,
          set: () => this.takeResult(),
          label: 'Result',
        },
        this,
        { readonly: true, host: this.craftResult },
      );
      this.widgets.push(this.resultWidget);
    }
    this.refresh();
    this.refreshRecipes();
  }

  // ------------------------------------------------------------ interaction
  onSlotMouseDown(w: SlotWidget, e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const inv = this.b.inventory;
    if (w === this.resultWidget) {
      this.takeResult();
      return;
    }
    const acc = w.acc;
    if (e.shiftKey && acc.shift) {
      if (acc.shift(inv)) this.changed();
      return;
    }
    const right = e.button === 2;
    const here = acc.get();
    const cursor = inv.cursor;

    if (!cursor) {
      if (!here) return;
      if (right) {
        const take = Math.ceil(here.count / 2);
        inv.cursor = { ...here, count: take };
        here.count -= take;
        if (here.count <= 0) acc.set(null);
      } else {
        inv.cursor = here;
        acc.set(null);
      }
    } else if (!here) {
      if (right) {
        acc.set({ ...cursor, count: 1 });
        cursor.count--;
        if (cursor.count <= 0) inv.cursor = null;
      } else {
        acc.set(cursor);
        inv.cursor = null;
      }
    } else if (here.id === cursor.id && !toolOf(here.id)) {
      const max = maxStack(here.id);
      const move = Math.min(max - here.count, cursor.count);
      if (move > 0) {
        here.count += move;
        cursor.count -= move;
        if (cursor.count <= 0) inv.cursor = null;
      } else {
        acc.set(cursor);
        inv.cursor = here;
      }
    } else {
      acc.set(cursor);
      inv.cursor = here;
    }
    this.changed();
  }

  private takeResult(): void {
    const grid = this.b.grid;
    if (!grid.current()) return;
    const out = grid.craft();
    if (!out) return;
    const inv = this.b.inventory;
    const cur = inv.cursor;
    if (cur && cur.id === out.id && !toolOf(out.id)) {
      const max = maxStack(out.id);
      const move = Math.min(max - cur.count, out.count);
      cur.count += move;
      if (move < out.count) inv.add(out.id, out.count - move);
    } else if (!cur) {
      inv.cursor = out;
    } else {
      const left = inv.add(out.id, out.count);
      if (left > 0) {
        // no room: refund the ingredients instead of losing the craft
        grid.cells.forEach((s, i) => {
          if (s) grid.set(i, { ...s, count: s.count + 1 });
        });
        this.b.notify('Inventory full', 'warn');
        return;
      }
    }
    this.b.craftSound();
    this.changed();
    this.refreshRecipes();
  }

  private craftFromBook(recipe: Recipe): void {
    const inv = this.b.inventory;
    if (recipe.needsTable && !this.b.hasTable()) {
      this.b.notify('That recipe needs a crafting table', 'warn');
      return;
    }
    const need = ingredientsOf(recipe);
    for (const [id, n] of need) {
      if (inv.countItem(id) < n) {
        this.b.notify('Missing ingredients', 'warn');
        return;
      }
    }
    if (inv.add(recipe.result.id, recipe.result.count) > 0) {
      this.b.notify('Inventory full', 'warn');
      return;
    }
    for (const [id, n] of need) inv.consume(id, n);
    this.b.craftSound();
    this.changed();
    this.refreshRecipes();
  }

  // ------------------------------------------------------------ recipe book
  private buildRecipeBook(): void {
    this.recipeList.textContent = '';
    for (const recipe of RECIPES) {
      const root = document.createElement('div');
      root.className = 'recipe';
      const c = document.createElement('canvas');
      c.width = 40;
      c.height = 40;
      const ctx = c.getContext('2d');
      if (ctx) drawItemIcon(ctx, recipe.result.id, 40);
      root.append(c);
      root.addEventListener('click', () => this.craftFromBook(recipe));
      root.addEventListener('mouseenter', () => this.showRecipeTip(recipe));
      root.addEventListener('mouseleave', () => this.hideTip());
      this.recipeList.append(root);
      this.recipeWidgets.set(recipe.id, root);
    }
  }

  private refreshRecipes(): void {
    const inv = this.b.inventory;
    const filter = this.recipeFilter.value.trim().toLowerCase();
    for (const recipe of RECIPES) {
      const root = this.recipeWidgets.get(recipe.id);
      if (!root) continue;
      let possible = Infinity;
      for (const [id, n] of ingredientsOf(recipe)) {
        possible = Math.min(possible, Math.floor(inv.countItem(id) / n));
      }
      if (!Number.isFinite(possible)) possible = 0;
      const name = item(recipe.result.id)?.name.toLowerCase() ?? '';
      root.style.display = filter === '' || name.includes(filter) ? '' : 'none';
      root.classList.toggle('no', possible <= 0 || (recipe.needsTable && !this.b.hasTable()));
      root.title = `${item(recipe.result.id)?.name ?? ''} ×${recipe.result.count}`;
    }
  }

  // ------------------------------------------------------------ refresh & tooltips
  changed(): void {
    this.version++;
    this.b.onChanged();
    this.refresh();
  }

  refresh(): void {
    for (const w of this.widgets) w.refresh(this.version);
    this.refreshCursor();
  }

  private refreshCursor(): void {
    const c = this.b.inventory.cursor;
    if (!c) {
      this.cursorEl.classList.add('hidden');
      return;
    }
    this.cursorEl.classList.remove('hidden');
    const ctx = this.cursorCanvas.getContext('2d');
    if (ctx) drawItemIcon(ctx, c.id, this.cursorCanvas.width);
    this.cursorCount.textContent = c.count > 1 ? String(c.count) : '';
  }

  showTip(acc: Accessor, w: SlotWidget): void {
    const stack = acc.get() ?? this.b.inventory.cursor;
    if (!stack) {
      this.hideTip();
      return;
    }
    const def = item(stack.id);
    const tool = toolOf(stack.id);
    const lines: string[] = [];
    if (tool) {
      lines.push(
        `${tool.kind} · tier ${tool.tier} · ${tool.damage} dmg`,
        `durability ${stack.durabilityLeft ?? tool.durability}/${tool.durability}`,
      );
    } else if (def?.food) {
      lines.push(`Food · restores ${def.food} hunger`);
    } else if (def?.blockId !== undefined) {
      lines.push(
        def.blockId === BlockId.TORCH ? 'Placeable · emits light 14' : `Placeable block · stack of ${maxStack(stack.id)}`,
      );
    }
    if (def?.desc) lines.push(def.desc);
    if (acc.label) lines.push(acc.label);
    this.tip.innerHTML = `<span class="t-name">${escape(def?.name ?? `Item ${stack.id}`)}</span>${lines
      .map((l) => `<span class="t-sub">${escape(l)}</span>`)
      .join('<br>')}`;
    this.tip.classList.remove('hidden');
    void w;
  }

  private showRecipeTip(recipe: Recipe): void {
    const inv = this.b.inventory;
    const parts: string[] = [];
    for (const [id, n] of ingredientsOf(recipe)) {
      const have = inv.countItem(id);
      parts.push(
        `<span class="t-sub" style="color:${have >= n ? '#9fdca7' : '#e79a9a'}">${n}× ${escape(
          item(id)?.name ?? String(id),
        )} — have ${have}</span>`,
      );
    }
    if (recipe.needsTable) parts.push('<span class="t-sub">Needs a crafting table</span>');
    this.tip.innerHTML =
      `<span class="t-name">${escape(item(recipe.result.id)?.name ?? '')} ×${recipe.result.count}</span>` +
      parts.join('<br>');
    this.tip.classList.remove('hidden');
  }

  hideTip(): void {
    this.tip.classList.add('hidden');
  }

  /** Panel closed: return the cursor stack and grid contents to the inventory. */
  stash(): void {
    const inv = this.b.inventory;
    this.b.grid.drain((s) => {
      if (s) inv.add(s.id, s.count, s.durabilityLeft);
    });
    if (inv.cursor) {
      const left = inv.add(inv.cursor.id, inv.cursor.count, inv.cursor.durabilityLeft);
      inv.cursor = left > 0 ? { ...inv.cursor, count: left } : null;
    }
    this.hideTip();
    this.changed();
  }

  openHoverResult(v: boolean): void {
    this.hoverResult = v;
  }
}

function ingredientsOf(recipe: Recipe): Map<number, number> {
  const need = new Map<number, number>();
  const add = (id: number): void => {
    if (id) need.set(id, (need.get(id) ?? 0) + 1);
  };
  if (recipe.shapeless) recipe.shapeless.forEach(add);
  else if (recipe.pattern) for (const row of recipe.pattern) row.forEach(add);
  return need;
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}
