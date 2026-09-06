/**
 * Milestones / achievements (UI-6). They replace the old tutorial cards: instead of a modal that
 * steals the mouse, play itself unlocks a chain of goals and the HUD shows the next one.
 */
import { describe, expect, it } from 'vitest';
import { BlockId } from '../src/world/blocks.js';
import { ItemId, ToolId } from '../src/world/items.js';
import { MILESTONES, Milestones, emptyStats } from '../src/game/achievements.js';

const { LOG, STONE, COBBLESTONE, TORCH, CRAFTING_TABLE, GRASS } = BlockId;
const { STICK, COAL, IRON, GEM } = ItemId;
const { WOOD_PICKAXE, STONE_PICKAXE, IRON_PICKAXE, GEM_PICKAXE, WOOD_SWORD } = ToolId;
/** Tool ids are tier-offset: wood 0, stone 1, iron 2, gem 3 (see recipes.ts). */
const IRON_SWORD = WOOD_SWORD + 2;

/** The prerequisite chain for everything that needs a stone pickaxe. */
function toStoneTool(m: Milestones): void {
  m.observe({ kind: 'mine', block: LOG, n: 4 });
  m.observe({ kind: 'craft', item: CRAFTING_TABLE });
  m.observe({ kind: 'craft', item: WOOD_PICKAXE });
  m.observe({ kind: 'mine', block: STONE, n: 16 });
  m.observe({ kind: 'craft', item: STONE_PICKAXE });
}

describe('milestones (UI-6)', () => {
  it('starts with nothing unlocked and a clear first goal', () => {
    const m = new Milestones();
    expect(m.unlockedCount).toBe(0);
    const next = m.next();
    expect(next?.def.id).toBe('firstLog');
    expect(next?.goal).toEqual({ have: 0, need: 1 });
  });

  it('unlocks from real gameplay and announces exactly once', () => {
    const m = new Milestones();
    const heard: string[] = [];
    m.onUnlock = (def) => heard.push(def.id);

    m.observe({ kind: 'mine', block: LOG });
    expect(m.has('firstLog')).toBe(true);
    expect(heard).toEqual(['firstLog']);

    m.observe({ kind: 'mine', block: LOG }); // already unlocked: no repeat toast
    expect(heard).toEqual(['firstLog']);
    expect(m.next()?.def.id).toBe('craftingTable');
  });

  it('counts quantities instead of single events', () => {
    const m = new Milestones();
    m.observe({ kind: 'mine', block: LOG, n: 10 });
    expect(m.stats.mined[LOG]).toBe(10);
    m.observe({ kind: 'mine', block: LOG, n: 21 });
    expect(m.has('lumberjack')).toBe(false); // 31 of 32
    m.observe({ kind: 'mine', block: LOG });
    expect(m.has('lumberjack')).toBe(true);
  });

  it('gates a goal behind its requirement, then retroactively unlocks it', () => {
    const m = new Milestones();
    m.observe({ kind: 'craft', item: CRAFTING_TABLE });
    expect(m.has('craftingTable')).toBe(false); // no log yet: the chain has not started
    const view = m.views().find((v) => v.def.id === 'craftingTable');
    expect(view?.available).toBe(false);
    expect(view?.goal).toEqual({ have: 1, need: 1 });

    m.observe({ kind: 'mine', block: LOG });
    expect(m.has('craftingTable')).toBe(true); // the requirement arrived late
  });

  it('the whole chain is completable by playing', () => {
    const m = new Milestones();
    m.observe({ kind: 'mine', block: LOG, n: 40 });
    m.observe({ kind: 'craft', item: CRAFTING_TABLE });
    m.observe({ kind: 'craft', item: STICK, n: 8 });
    m.observe({ kind: 'craft', item: WOOD_PICKAXE });
    m.observe({ kind: 'mine', block: STONE, n: 20 });
    m.observe({ kind: 'mine', block: COBBLESTONE });
    m.observe({ kind: 'craft', item: STONE_PICKAXE });
    m.observe({ kind: 'place', block: TORCH, n: 8 });
    m.observe({ kind: 'obtain', item: COAL });
    m.observe({ kind: 'obtain', item: IRON });
    m.observe({ kind: 'obtain', item: GEM });
    m.observe({ kind: 'craft', item: IRON_SWORD });
    m.observe({ kind: 'craft', item: IRON_PICKAXE });
    m.observe({ kind: 'craft', item: GEM_PICKAXE });
    m.observe({ kind: 'kill', mob: 'zombie' });
    m.observe({ kind: 'place', block: GRASS, n: 4 });
    m.observe({ kind: 'place', block: BlockId.DIRT, n: 60 });
    m.setFlag('swam', 1);
    m.setFlag('deepCave', 1);
    m.setFlag('nights', 1);
    m.setFlag('deaths', 1);
    const missing = MILESTONES.filter((d) => !m.has(d.id)).map((d) => d.id);
    expect(missing).toEqual([]);
    expect(m.unlockedCount).toBe(m.total);
    expect(m.next()).toBeNull(); // nothing left to chase
  });

  it('tracks one-shot flags and counts hostile kills', () => {
    const m = new Milestones();
    toStoneTool(m);
    m.observe({ kind: 'kill', mob: 'zombie' });
    expect(m.has('monsterHunter')).toBe(true);
    m.observe({ kind: 'flag', name: 'nights' });
    expect(m.has('nightShift')).toBe(true);
    m.setFlag('deepCave', 1);
    expect(m.stats.flags.deepCave).toBe(1);
  });

  it('survives a save/load round-trip and ignores unknown ids', () => {
    const m = new Milestones();
    m.observe({ kind: 'mine', block: LOG, n: 3 });
    m.observe({ kind: 'craft', item: CRAFTING_TABLE });
    const saved = JSON.parse(JSON.stringify(m.save())) as ReturnType<Milestones['save']>;

    const restored = new Milestones();
    const heard: string[] = [];
    restored.onUnlock = (def) => heard.push(def.id);
    restored.load(saved);
    expect(restored.unlockedCount).toBe(2);
    expect(restored.stats.mined[LOG]).toBe(3);
    expect(restored.next()?.def.id).toBe('woodenTool');
    expect(heard).toEqual([]); // restoring is not "unlocking"

    restored.load({ unlocked: ['firstLog', 'not-a-real-milestone'], stats: undefined });
    expect(restored.unlockedCount).toBe(1);
    restored.load(undefined);
    expect(restored.unlockedCount).toBe(0);
    expect(restored.stats).toEqual(emptyStats());
  });

  it('warmUp replays a save without firing toasts', () => {
    const m = new Milestones();
    const heard: string[] = [];
    m.onUnlock = (def) => heard.push(def.id);
    m.warmUp(() => {
      m.observe({ kind: 'mine', block: LOG });
      m.observe({ kind: 'craft', item: CRAFTING_TABLE });
    });
    expect(m.unlockedCount).toBe(2);
    expect(heard).toEqual([]);
    m.observe({ kind: 'craft', item: WOOD_PICKAXE });
    expect(heard).toEqual(['woodenTool']); // live play notifies again afterwards
  });

  it('the definitions themselves stay coherent', () => {
    const all = new Set(MILESTONES.map((d) => d.id));
    expect(all.size).toBe(MILESTONES.length); // no duplicate ids
    const seen = new Set<string>();
    for (const def of MILESTONES) {
      expect(def.title.length).toBeGreaterThan(2);
      expect(def.goal.length).toBeGreaterThan(2);
      expect(def.body.length).toBeGreaterThan(5);
      for (const r of def.requires) {
        expect(all.has(r), `unknown requirement ${r} on ${def.id}`).toBe(true);
        // declared before its dependants: the panel and the HUD tracker read the list in order
        expect(seen.has(r), `requirement ${r} must be declared before ${def.id}`).toBe(true);
      }
      seen.add(def.id);
    }
    // every goal must be reachable: a fresh stat block gives a finite, non-negative "have"
    const m = new Milestones();
    for (const view of m.views()) {
      expect(Number.isFinite(view.goal.have), view.def.id).toBe(true);
      expect(view.goal.need, view.def.id).toBeGreaterThan(0);
    }
    // and the HUD tracker must be one of the definitions
    const fresh = new Milestones();
    expect(MILESTONES).toContain(fresh.next()?.def);
  });
});
