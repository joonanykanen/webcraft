/** Inventory (IN-1 … IN-6): 9 hotbar + 27 main slots, stacking, tool durability, drag cursor. */
import { HOTBAR_SLOTS, INVENTORY_TOTAL, MAX_STACK, clamp } from '../core/constants.js';
import type { Slot } from '../core/types.js';
import { BlockId } from '../world/blocks.js';
import { foodOf, isPlaceable, item, itemBlockId, maxStack, toolOf } from '../world/items.js';

export class Inventory {
  /** 36 slots: 0..8 = hotbar, 9..35 = main grid (IN-1) */
  main: Slot[] = new Array(INVENTORY_TOTAL).fill(null);
  /** item held by the mouse while dragging in the inventory UI */
  cursor: Slot = null;
  selected = 0;
  creative = false;
  /** bumped on every mutation so the UI can refresh cheaply */
  version = 0;
  /** UI-6: called whenever items actually land in a slot (drops, crafting output, ...) */
  onObtain: ((id: number, count: number) => void) | null = null;

  get hotbar(): Slot[] {
    return this.main.slice(0, HOTBAR_SLOTS);
  }

  slot(i: number): Slot {
    return this.main[i] ?? null;
  }

  stackMaxFor(id: number): number {
    return id === 0 ? MAX_STACK : maxStack(id);
  }

  /** Add items; returns how many did not fit (0 = success). */
  add(id: number, count = 1, durabilityLeft?: number): number {
    if (id === 0 || count <= 0) return 0;
    if (this.creative) return 0;
    const max = this.stackMaxFor(id);
    let left = count;
    const tool = toolOf(id);
    if (!tool) {
      for (let i = 0; i < this.main.length && left > 0; i++) {
        const s = this.main[i];
        if (s && s.id === id && s.count < max) {
          const take = Math.min(max - s.count, left);
          s.count += take;
          left -= take;
        }
      }
    }
    for (let i = 0; i < this.main.length && left > 0; i++) {
      if (this.main[i]) continue;
      const take = Math.min(max, left);
      this.main[i] = { id, count: take, durabilityLeft: tool ? (durabilityLeft ?? tool.durability) : undefined };
      left -= take;
    }
    if (left !== count) {
      this.version++;
      this.onObtain?.(id, count - left);
    }
    return left;
  }

  /** Count of items that fit into a specific slot (used by UI drag logic). */
  fitsIn(slot: Slot, id: number, count: number): number {
    if (!slot) return Math.min(this.stackMaxFor(id), count);
    if (slot.id !== id) return 0;
    if (toolOf(id)) return 0;
    return Math.max(0, Math.min(this.stackMaxFor(id) - slot.count, count));
  }

  countItem(id: number): number {
    let n = 0;
    for (const s of this.main) if (s && s.id === id) n += s.count;
    return n;
  }

  /** Remove `count` of `id` from anywhere; false (and no change) if not enough. */
  consume(id: number, count: number): boolean {
    if (this.countItem(id) < count) return false;
    let left = count;
    for (let i = 0; i < this.main.length && left > 0; i++) {
      const s = this.main[i];
      if (!s || s.id !== id) continue;
      const take = Math.min(s.count, left);
      s.count -= take;
      left -= take;
      if (s.count <= 0) this.main[i] = null;
    }
    this.version++;
    return true;
  }

  setSlot(i: number, slot: Slot): void {
    if (i < 0 || i >= this.main.length) return;
    this.main[i] = slot && slot.count > 0 && slot.id !== 0 ? slot : null;
    this.version++;
  }

  /** Left-click swap / merge between two slots. */
  swap(i: number, j: number): void {
    if (i < 0 || j < 0 || i >= this.main.length || j >= this.main.length) return;
    const a = this.main[i];
    const b = this.main[j];
    if (a && b && a.id === b.id && !toolOf(a.id)) {
      const max = this.stackMaxFor(a.id);
      const total = Math.min(a.count + b.count, max);
      const overflow = a.count + b.count - total;
      this.main[j] = { ...b, count: total };
      this.main[i] = overflow > 0 ? { ...a, count: overflow } : null;
    } else {
      this.main[i] = b;
      this.main[j] = a;
    }
    this.version++;
  }

  /** Move up to `n` items from slot i into the first free/mergeable slot (shift-click quick-move). */
  quickMove(i: number, toStart: number, toEnd: number): boolean {
    const s = this.main[i];
    if (!s) return false;
    const max = this.stackMaxFor(s.id);
    if (!toolOf(s.id)) {
      for (let j = toStart; j <= toEnd; j++) {
        const t = this.main[j];
        if (t && t.id === s.id && t.count < max) {
          const move = Math.min(max - t.count, s.count);
          t.count += move;
          s.count -= move;
          if (s.count <= 0) this.main[i] = null;
          this.version++;
          return true;
        }
      }
    }
    for (let j = toStart; j <= toEnd; j++) {
      if (!this.main[j]) {
        this.main[j] = s;
        this.main[i] = null;
        this.version++;
        return true;
      }
    }
    return false;
  }

  select(i: number): void {
    this.selected = clamp(i, 0, HOTBAR_SLOTS - 1);
    this.version++;
  }

  cycle(delta: number): void {
    this.selected = (this.selected + delta + HOTBAR_SLOTS) % HOTBAR_SLOTS;
    this.version++;
  }

  selectedSlot(): Slot {
    return this.main[this.selected] ?? null;
  }

  /** Item id of the held stack (0 = nothing held). */
  heldId(): number {
    return this.main[this.selected]?.id ?? 0;
  }

  heldBlockId(): number {
    const id = this.heldId();
    return id && isPlaceable(id) ? (itemBlockId(id) ?? -1) : -1;
  }

  heldTool() {
    return toolOf(this.heldId());
  }

  /** Spend one use of the held tool; true when it broke and must be removed. */
  useToolDurability(amount = 1): boolean {
    if (this.creative) return false;
    const s = this.main[this.selected];
    if (!s) return false;
    const tool = toolOf(s.id);
    if (!tool) return false;
    if (s.durabilityLeft === undefined) s.durabilityLeft = tool.durability;
    s.durabilityLeft -= amount;
    this.version++;
    if (s.durabilityLeft <= 0) {
      this.main[this.selected] = null;
      return true;
    }
    return false;
  }

  bestToolTier(): number {
    let best = 0;
    for (const s of this.main) {
      if (!s) continue;
      const t = toolOf(s.id);
      if (t && t.tier > best) best = t.tier;
    }
    return best;
  }

  /** Eat the first edible stack found (IN-5). */
  takeFood(): { id: number; food: number } | null {
    for (let i = 0; i < this.main.length; i++) {
      const s = this.main[i];
      if (!s) continue;
      const food = foodOf(s.id);
      if (!food) continue;
      s.count--;
      if (s.count <= 0) this.main[i] = null;
      this.version++;
      return { id: s.id, food };
    }
    return null;
  }

  /** Creative-mode "pick block" / give (IN-2). */
  give(id: number): void {
    if (id === 0) return;
    if (this.creative) {
      if (!this.main[this.selected]) {
        this.main[this.selected] = { id, count: this.stackMaxFor(id) };
        this.version++;
      }
      return;
    }
    const s = this.main[this.selected];
    if (!s) this.main[this.selected] = { id, count: 1 };
    else this.setSlot(this.selected, { id, count: this.stackMaxFor(id) });
  }

  clear(): void {
    this.main = new Array(INVENTORY_TOTAL).fill(null);
    this.cursor = null;
    this.version++;
  }

  serialize(): Slot[] {
    return this.main.map((s) => (s ? { ...s } : null));
  }

  deserialize(list: Slot[] | undefined): void {
    this.main = new Array(INVENTORY_TOTAL).fill(null);
    if (Array.isArray(list)) {
      for (let i = 0; i < INVENTORY_TOTAL; i++) {
        const s = list[i] as Slot;
        if (s && typeof s.id === 'number' && s.id !== 0 && s.count > 0) this.main[i] = { ...s };
      }
    }
    this.version++;
  }

  /** Fill the hotbar for a fresh survival world (starter kit so crafting is reachable). */
  giveStarterKit(): void {
    this.setSlot(0, { id: BlockId.PLANKS, count: 16 });
    this.setSlot(1, { id: BlockId.LOG, count: 8 });
    this.setSlot(2, { id: BlockId.TORCH, count: 8 });
    this.version++;
  }
}

export function itemDisplayName(id: number): string {
  return item(id)?.name ?? `#${id}`;
}
