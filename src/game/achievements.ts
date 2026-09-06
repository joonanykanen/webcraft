/**
 * Milestones (UI-6): a Minecraft-style progression chain that replaces the old tutorial cards.
 *
 * Nothing blocks the player — each milestone is a goal with a requirement chain, unlocked from
 * live gameplay stats, announced with a toast + chime, listed in the Milestones panel with the
 * locked ones greyed out, and summarised as a single "next goal" line on the HUD.
 */
import { BlockId } from '../world/blocks.js';
import { ItemId, ToolId } from '../world/items.js';

const LOG = BlockId.LOG;
const STONE = BlockId.STONE;
const COBBLE = BlockId.COBBLESTONE;
const TORCH = BlockId.TORCH;
const CRAFTING_TABLE = BlockId.CRAFTING_TABLE;
const DIRT = BlockId.DIRT;
const GRASS = BlockId.GRASS;
const STICK = ItemId.STICK;
const COAL = ItemId.COAL;
const IRON = ItemId.IRON;
const GEM = ItemId.GEM;
const APPLE = ItemId.APPLE;
const WOOD_PICKAXE = ToolId.WOOD_PICKAXE;
const STONE_PICKAXE = ToolId.STONE_PICKAXE;
const IRON_PICKAXE = ToolId.IRON_PICKAXE;
const GEM_PICKAXE = ToolId.GEM_PICKAXE;
/** Sword ids are `WOOD_SWORD + tier - 1`. */
const IRON_SWORD = ToolId.WOOD_SWORD + 2;
import type { MilestoneSave } from '../core/types.js';
import type { MobKind } from './mobs.js';

/** Everything a milestone can be measured against. Small, serialisable, diffed as the player plays. */
export interface Stats {
  mined: Record<number, number>;
  placed: Record<number, number>;
  crafted: Record<number, number>;
  obtained: Record<number, number>;
  killed: Record<string, number>;
  flags: Record<string, number>;
}

export function emptyStats(): Stats {
  return { mined: {}, placed: {}, crafted: {}, obtained: {}, killed: {}, flags: {} };
}

export type Observed =
  | { kind: 'mine'; block: number; n?: number }
  | { kind: 'place'; block: number; n?: number }
  | { kind: 'craft'; item: number; n?: number }
  | { kind: 'obtain'; item: number; n?: number }
  | { kind: 'kill'; mob: MobKind; n?: number }
  | { kind: 'flag'; name: string; value?: number };

export interface Goal {
  have: number;
  need: number;
}

export interface MilestoneDef {
  id: string;
  title: string;
  /** Flavour line, shown under the title (vanilla advancements do the same). */
  body: string;
  /** Item id used for the icon, painted by ui/icons.ts. */
  icon: number;
  /** Prerequisite milestones: greyed out until all of them are unlocked. */
  requires: string[];
  goal: string;
  /** Progress towards the goal, read from the live stats. */
  check: (s: Stats) => Goal;
}

const count = (map: Record<number, number>, id: number): number => map[id] ?? 0;
const sum = (map: Record<number, number>): number => Object.values(map).reduce((a, b) => a + b, 0);

/** The chain, in panel order. Requirements gate both the panel layout and the HUD's next goal. */
export const MILESTONES: MilestoneDef[] = [
  {
    id: 'firstLog',
    title: 'Getting Started',
    body: 'Punch a tree to get logs',
    icon: LOG,
    requires: [],
    goal: 'Mine 1 log',
    check: (s) => ({ have: count(s.mined, LOG), need: 1 }),
  },
  {
    id: 'craftingTable',
    title: 'Working at the Bench',
    body: 'A crafting table opens a 3×3 grid',
    icon: CRAFTING_TABLE,
    requires: ['firstLog'],
    goal: 'Craft a crafting table',
    check: (s) => ({ have: count(s.crafted, CRAFTING_TABLE), need: 1 }),
  },
  {
    id: 'woodenTool',
    title: 'Time to Mine',
    body: 'Sticks and planks make a pickaxe',
    icon: WOOD_PICKAXE,
    requires: ['craftingTable'],
    goal: 'Craft a wooden pickaxe',
    check: (s) => ({ have: count(s.crafted, WOOD_PICKAXE), need: 1 }),
  },
  {
    id: 'stoneAge',
    title: 'Stone Age',
    body: 'Dig into the ground and break stone',
    icon: COBBLE,
    requires: ['woodenTool'],
    goal: 'Mine 16 stone',
    check: (s) => ({ have: count(s.mined, STONE) + count(s.mined, COBBLE), need: 16 }),
  },
  {
    id: 'stoneTool',
    title: 'Better Than Sticks',
    body: 'Stone tools dig deeper and faster',
    icon: STONE_PICKAXE,
    requires: ['stoneAge'],
    goal: 'Craft a stone pickaxe',
    check: (s) => ({ have: count(s.crafted, STONE_PICKAXE), need: 1 }),
  },
  {
    id: 'lightItUp',
    title: 'Light It Up',
    body: 'Torches keep the dark — and the zombies — away',
    icon: TORCH,
    requires: ['stoneAge'],
    goal: 'Place 8 torches',
    check: (s) => ({ have: count(s.placed, TORCH), need: 8 }),
  },
  {
    id: 'hotTopic',
    title: 'Hot Topic',
    body: 'Coal lights the way and fuels a furnace',
    icon: COAL,
    requires: ['stoneAge'],
    goal: 'Mine coal ore',
    check: (s) => ({ have: count(s.obtained, COAL), need: 1 }),
  },
  {
    id: 'ironAge',
    title: 'Iron Age',
    body: 'Smelt iron ore into ingots',
    icon: IRON,
    requires: ['stoneTool'],
    goal: 'Obtain an iron ingot',
    check: (s) => ({ have: count(s.obtained, IRON), need: 1 }),
  },
  {
    id: 'diamonds',
    title: 'Diamonds!',
    body: 'The deepest caves hide the bluest stone',
    icon: GEM,
    requires: ['ironAge'],
    goal: 'Find a diamond',
    check: (s) => ({ have: count(s.obtained, GEM), need: 1 }),
  },
  {
    id: 'nightShift',
    title: 'Shoot the Moon',
    body: 'Stay alive until the sun comes back',
    icon: TORCH,
    requires: [],
    goal: 'Survive your first night',
    check: (s) => ({ have: s.flags.nights ?? 0, need: 1 }),
  },
  {
    id: 'monsterHunter',
    title: 'Monster Hunter',
    body: 'Stand your ground when the sun goes down',
    icon: IRON_SWORD,
    requires: ['stoneTool'],
    goal: 'Defeat a hostile mob',
    check: (s) => ({ have: (s.killed.zombie ?? 0) * 1, need: 1 }),
  },
  {
    id: 'deepDark',
    title: 'How Did I Get Here?',
    body: 'The caves below y = 20 are not for the faint-hearted',
    icon: STONE,
    requires: ['stoneAge'],
    goal: 'Descend below y = 20',
    check: (s) => ({ have: s.flags.deepCave ?? 0, need: 1 }),
  },
  {
    id: 'swimmer',
    title: 'Two Birds, One Pickaxe',
    body: 'Water is a highway, not a wall',
    icon: GRASS,
    requires: [],
    goal: 'Take a swim',
    check: (s) => ({ have: s.flags.swam ?? 0, need: 1 }),
  },
  {
    id: 'lumberjack',
    title: 'Lumberjack',
    body: 'A forest is only potential planks',
    icon: STICK,
    requires: ['firstLog'],
    goal: 'Mine 32 logs',
    check: (s) => ({ have: count(s.mined, LOG), need: 32 }),
  },
  {
    id: 'builder',
    title: 'Home Sweet Home',
    body: 'Stack blocks until it looks like shelter',
    icon: DIRT,
    requires: ['craftingTable'],
    goal: 'Place 64 blocks',
    check: (s) => ({ have: sum(s.placed), need: 64 }),
  },
  {
    id: 'groceries',
    title: 'Supplies',
    body: 'Apples and planks: the two food groups',
    icon: APPLE,
    requires: ['craftingTable'],
    goal: 'Craft 8 sticks',
    check: (s) => ({ have: count(s.crafted, STICK), need: 8 }),
  },
  {
    id: 'armed',
    title: 'Preparedness',
    body: 'A sword turns a zombie into experience',
    icon: IRON_SWORD,
    requires: ['ironAge'],
    goal: 'Craft an iron sword',
    check: (s) => ({ have: count(s.crafted, IRON_SWORD), need: 1 }),
  },
  {
    id: 'pickOfChoice',
    title: 'The Best There Is',
    body: 'Nothing in the overworld resists an iron pickaxe',
    icon: IRON_PICKAXE,
    requires: ['ironAge'],
    goal: 'Craft an iron pickaxe',
    check: (s) => ({ have: count(s.crafted, IRON_PICKAXE), need: 1 }),
  },
  {
    id: 'benchmark',
    title: 'Benchmarking',
    body: 'A pickaxe of gems: the end of the chain',
    icon: GEM_PICKAXE,
    requires: ['diamonds', 'pickOfChoice'],
    goal: 'Craft a gem pickaxe',
    check: (s) => ({ have: count(s.crafted, GEM_PICKAXE), need: 1 }),
  },
  {
    id: 'landscaper',
    title: 'Landscaping',
    body: 'Grass under your feet, by your own hand',
    icon: GRASS,
    requires: ['craftingTable'],
    goal: 'Plant grass on 4 dirt blocks',
    check: (s) => ({ have: count(s.placed, GRASS), need: 4 }),
  },
  {
    id: 'didItHurt',
    title: 'Did It Hurt?',
    body: 'Everyone falls off a cliff eventually',
    icon: DIRT,
    requires: [],
    goal: 'Die once (it is only a detour)',
    check: (s) => ({ have: s.flags.deaths ?? 0, need: 1 }),
  },
];

export interface MilestoneView {
  def: MilestoneDef;
  unlocked: boolean;
  available: boolean; // all requirements unlocked
  goal: Goal;
}

export type UnlockListener = (def: MilestoneDef) => void;

export class Milestones {
  private unlocked = new Set<string>();
  readonly stats: Stats = emptyStats();
  onUnlock: UnlockListener | null = null;
  /** True while the game should not fire new milestones (unit tests / world load). */
  private warming = false;

  byId(id: string): MilestoneDef | undefined {
    return MILESTONES.find((m) => m.id === id);
  }

  has(id: string): boolean {
    return this.unlocked.has(id);
  }

  get unlockedCount(): number {
    return this.unlocked.size;
  }

  get total(): number {
    return MILESTONES.length;
  }

  /** Restore a saved progression; unknown ids are dropped so old files keep working. */
  load(save: MilestoneSave | undefined): void {
    this.unlocked.clear();
    Object.assign(this.stats, emptyStats());
    if (!save) return;
    for (const id of save.unlocked ?? []) if (this.byId(id)) this.unlocked.add(id);
    const s = save.stats as Stats | undefined;
    if (s) {
      Object.assign(this.stats.mined, s.mined ?? {});
      Object.assign(this.stats.placed, s.placed ?? {});
      Object.assign(this.stats.crafted, s.crafted ?? {});
      Object.assign(this.stats.obtained, s.obtained ?? {});
      Object.assign(this.stats.killed, s.killed ?? {});
      Object.assign(this.stats.flags, s.flags ?? {});
    }
  }

  save(): MilestoneSave {
    return { unlocked: [...this.unlocked].sort(), stats: JSON.parse(JSON.stringify(this.stats)) as Stats };
  }

  /** Feed one gameplay event; unlocks everything that event completed. */
  observe(evt: Observed): void {
    const s = this.stats;
    const n = 'n' in evt ? (evt.n ?? 1) : 1;
    switch (evt.kind) {
      case 'mine':
        s.mined[evt.block] = (s.mined[evt.block] ?? 0) + n;
        break;
      case 'place':
        s.placed[evt.block] = (s.placed[evt.block] ?? 0) + n;
        break;
      case 'craft':
        s.crafted[evt.item] = (s.crafted[evt.item] ?? 0) + n;
        s.obtained[evt.item] = (s.obtained[evt.item] ?? 0) + n;
        break;
      case 'obtain':
        s.obtained[evt.item] = (s.obtained[evt.item] ?? 0) + n;
        break;
      case 'kill':
        s.killed[evt.mob] = (s.killed[evt.mob] ?? 0) + n;
        break;
      case 'flag':
        s.flags[evt.name] = (s.flags[evt.name] ?? 0) + (evt.value ?? 1);
        break;
    }
    this.evaluate();
  }

  /** Set (not add) a flag such as "deepest cave reached". */
  setFlag(name: string, value: number): void {
    if (this.stats.flags[name] === value) return;
    this.stats.flags[name] = value;
    this.evaluate();
  }

  /** Re-check every definition; used after loading a save or changing stats in bulk. */
  evaluate(): void {
    for (const def of MILESTONES) {
      if (this.unlocked.has(def.id)) continue;
      if (!this.requirementsMet(def)) continue;
      const g = def.check(this.stats);
      if (g.have < g.need) continue;
      this.unlocked.add(def.id);
      if (!this.warming) this.onUnlock?.(def);
    }
  }

  /** Freeze unlock notifications while the world is being restored. */
  warmUp(fn: () => void): void {
    this.warming = true;
    try {
      fn();
    } finally {
      this.warming = false;
    }
  }

  requirementsMet(def: MilestoneDef): boolean {
    return def.requires.every((r) => this.unlocked.has(r));
  }

  views(): MilestoneView[] {
    return MILESTONES.map((def) => ({
      def,
      unlocked: this.unlocked.has(def.id),
      available: this.requirementsMet(def),
      goal: def.check(this.stats),
    }));
  }

  /** The next goal to show on the HUD: unlocked-order, first incomplete that is available. */
  next(): MilestoneView | null {
    const list = this.views();
    return list.find((v) => !v.unlocked && v.available) ?? list.find((v) => !v.unlocked) ?? null;
  }

  /** Ids of milestones that were unlocked by `after` (used by tests and the smoke test). */
  newlyUnlocked(after: string[]): string[] {
    const before = new Set(after);
    return [...this.unlocked].filter((id) => !before.has(id));
  }
}
