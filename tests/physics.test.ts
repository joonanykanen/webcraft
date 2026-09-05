/** Voxel collision (PH-2/PH-3), raycasting (WI-1) and mining/placement rules (BI-3, IN-4). */
import { describe, expect, it } from 'vitest';
import { boxContains, moveWithCollision, type Collider, type PhysWorld } from '../src/game/physics.js';
import { breakTime, boxIntersectsCell, canPlaceAt, dropFor, heldBlockId } from '../src/game/mining.js';
import { raycast } from '../src/world/raycast.js';
import { BlockId } from '../src/world/blocks.js';
import { ItemId } from '../src/world/items.js';

const FLOOR = 64; // every y below this is stone
const WOOD_PICK = 200;
const STONE_PICK = 201;
const IRON_PICK = 202;
const GEM_PICK = 203;

/**
 * ground: y < 64 everywhere
 * wall:   x ∈ [10,11), y < 72
 * ledge:  x ≥ 20, y = 64 (a one-block step)
 * roof:   x ∈ [30,40), y = 66 (low ceiling to bonk)
 */
const world: PhysWorld = {
  getBlock(x, y, z): number {
    void z;
    if (y < 0) return BlockId.BEDROCK;
    if (y < FLOOR) return BlockId.STONE;
    if (x >= 10 && x < 11 && y < 72) return BlockId.STONE;
    if (x >= 20 && y === 64) return BlockId.STONE;
    if (x >= 30 && x < 40 && y === 66) return BlockId.STONE;
    return 0;
  },
};
const player: Collider = { hw: 0.3, h: 1.8 };

describe('voxel collision', () => {
  it('lands on top of the floor without penetration', () => {
    const pos = { x: 4.5, y: 70, z: 4.5 };
    const vel = { x: 0, y: -20, z: 0 };
    let res = moveWithCollision(world, pos, vel, 1 / 60, player);
    for (let i = 0; i < 240 && !res.onGround; i++) res = moveWithCollision(world, pos, vel, 1 / 60, player);
    expect(res.onGround).toBe(true);
    expect(pos.y).toBeCloseTo(FLOOR, 2);
  });

  it('never tunnels on enormous steps (M0: no tunneling at 20-block falls)', () => {
    for (const dt of [1, 0.5, 0.25]) {
      const pos = { x: 4.5, y: 70, z: 4.5 };
      const vel = { x: 0, y: -60, z: 0 };
      const res = moveWithCollision(world, pos, vel, dt, player);
      expect(pos.y).toBeGreaterThanOrEqual(FLOOR - 0.01);
      expect(res.onGround || res.hitY).toBe(true);
    }
  });

  it('stops against a wall and reports the axis', () => {
    const pos = { x: 8, y: FLOOR, z: 4.5 };
    const vel = { x: 40, y: 0, z: 0 };
    const res = moveWithCollision(world, pos, vel, 0.05, player);
    expect(res.hitX).toBe(true);
    expect(vel.x).toBe(0);
    expect(pos.x).toBeLessThan(10 - player.hw);
  });

  it('is blocked by a full-height step without step-up assist', () => {
    const pos = { x: 18.5, y: FLOOR, z: 4.5 };
    const vel = { x: 8, y: 0, z: 0 };
    const res = moveWithCollision(world, pos, vel, 0.2, player, 0);
    expect(res.hitX).toBe(true);
    expect(pos.x).toBeLessThan(20);
  });

  it('climbs a block edge while rising (player step assist)', () => {
    const pos = { x: 19.2, y: FLOOR + 0.7, z: 4.5 };
    const vel = { x: 6, y: 1, z: 0 };
    let stepped = false;
    for (let i = 0; i < 20; i++) {
      const r = moveWithCollision(world, pos, vel, 1 / 30, player, 0.62);
      stepped = stepped || r.stepped;
      vel.x = 6;
    }
    expect(stepped).toBe(true);
    expect(pos.x).toBeGreaterThan(20);
    expect(pos.y).toBeGreaterThanOrEqual(FLOOR + 0.5);
  });

  it('a generous step-up climbs from flat ground', () => {
    const pos = { x: 19.4, y: FLOOR, z: 4.5 };
    const vel = { x: 5, y: 0, z: 0 };
    const res = moveWithCollision(world, pos, vel, 0.1, player, 1.05);
    expect(res.stepped).toBe(true);
    expect(pos.y).toBeGreaterThan(FLOOR);
  });

  it('bonks the head on a low ceiling', () => {
    const pos = { x: 34.5, y: FLOOR, z: 4.5 };
    const vel = { x: 0, y: 30, z: 0 };
    const res = moveWithCollision(world, pos, vel, 0.25, player);
    expect(res.hitCeiling).toBe(true);
    expect(pos.y + player.h).toBeLessThanOrEqual(66 + 0.05);
  });

  it('boxContains reports fluids inside the entity box', () => {
    const wet: PhysWorld = { getBlock: (_x, y) => (y < 50 ? BlockId.WATER : 0) };
    const inWater = (id: number): boolean => id === BlockId.WATER;
    expect(boxContains(wet, 0.5, 20, 0.5, player, inWater)).toBe(true);
    expect(boxContains(wet, 0.5, 80, 0.5, player, inWater)).toBe(false);
  });
});

describe('raycast (DDA, WI-1)', () => {
  const flat: PhysWorld = { getBlock: (_x, y) => (y < 40 ? BlockId.STONE : 0) };

  it('hits the ground below and reports the face normal', () => {
    const hit = raycast(flat, 0.5, 50, 0.5, 0, -1, 0, 20);
    expect(hit).not.toBeNull();
    expect(hit!.block).toBe(BlockId.STONE);
    expect(hit!.y).toBe(39);
    expect(hit!.ny).toBe(1); // top face → placement goes to y+1
    expect(hit!.dist).toBeCloseTo(10, 0);
  });

  it('reports the entry normal when looking into a wall', () => {
    const wall: PhysWorld = { getBlock: (x) => (x >= 5 ? BlockId.STONE : 0) };
    const hit = raycast(wall, 2.5, 10, 2.5, 1, 0, 0, 20);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBe(5);
    expect(hit!.nx).toBe(-1);
    expect(hit!.dist).toBeCloseTo(2.5, 1);
  });

  it('ignores water unless targeting fluids', () => {
    const lake: PhysWorld = {
      getBlock: (_x, y) => (y === 30 ? BlockId.WATER : y < 20 ? BlockId.STONE : 0),
    };
    expect(raycast(lake, 0.5, 40, 0.5, 0, -1, 0, 30)!.block).toBe(BlockId.STONE);
    expect(raycast(lake, 0.5, 40, 0.5, 0, -1, 0, 30, true)!.block).toBe(BlockId.WATER);
  });

  it('gives up beyond the reach distance', () => {
    const empty: PhysWorld = { getBlock: () => 0 };
    expect(raycast(empty, 0.5, 5, 0.5, 0, 1, 0, 6)).toBeNull();
  });

  it('never misses a block directly at the eye', () => {
    const solid: PhysWorld = { getBlock: () => BlockId.STONE };
    const hit = raycast(solid, 0.5, 5.5, 0.5, 1, 0, 0, 6);
    expect(hit).not.toBeNull();
  });
});

describe('mining rules (BI-3 / IN-4)', () => {
  it('better tools of the right kind mine faster', () => {
    const hand = breakTime(BlockId.STONE, 0);
    const wood = breakTime(BlockId.STONE, WOOD_PICK);
    const stone = breakTime(BlockId.STONE, STONE_PICK);
    const iron = breakTime(BlockId.STONE, IRON_PICK);
    const gem = breakTime(BlockId.STONE, GEM_PICK);
    expect(hand).toBeGreaterThan(wood);
    expect(wood).toBeGreaterThan(stone);
    expect(stone).toBeGreaterThan(iron);
    expect(iron).toBeGreaterThan(gem);
    expect(gem).toBeGreaterThan(0);
  });

  it('soft blocks are quicker than hard ones', () => {
    expect(breakTime(BlockId.DIRT, 0)).toBeLessThan(breakTime(BlockId.STONE, 0));
    expect(breakTime(BlockId.SAND, 0)).toBeLessThan(breakTime(BlockId.STONE, 0));
    expect(breakTime(BlockId.LOG, 0)).toBeLessThan(breakTime(BlockId.IRON_ORE, 0));
  });

  it('bedrock is indestructible', () => {
    expect(breakTime(BlockId.BEDROCK, GEM_PICK)).toBe(Infinity);
    expect(dropFor(BlockId.BEDROCK, 4)).toBeNull();
  });

  it('the wrong tier yields no drop (BI-3)', () => {
    expect(dropFor(BlockId.STONE, 0)).toBeNull(); // fist → stone gives nothing
    expect(dropFor(BlockId.STONE, 1)?.id).toBe(BlockId.COBBLESTONE);
    expect(dropFor(BlockId.DIRT, 0)?.id).toBe(BlockId.DIRT);
    expect(dropFor(BlockId.GRAVEL, 0)?.id).toBe(BlockId.GRAVEL);
    expect(dropFor(BlockId.LEAVES, 0)).not.toBeNull();
  });

  it('ores demand a decent pickaxe and pay out materials', () => {
    expect(dropFor(BlockId.COAL_ORE, 0)).toBeNull();
    expect(dropFor(BlockId.COAL_ORE, 1)?.id).toBe(ItemId.COAL);
    expect(dropFor(BlockId.IRON_ORE, 1)).toBeNull();
    expect(dropFor(BlockId.IRON_ORE, 2)?.id).toBe(ItemId.IRON);
    expect(dropFor(BlockId.GEM_ORE, 2)).toBeNull(); // needs an iron pick
    expect(dropFor(BlockId.GEM_ORE, 3)?.id).toBe(ItemId.GEM);
  });

  it('heldBlockId only accepts placeable block items', () => {
    expect(heldBlockId(BlockId.DIRT)).toBe(BlockId.DIRT);
    expect(heldBlockId(ItemId.STICK)).toBe(-1);
    expect(heldBlockId(0)).toBe(-1);
  });
});

describe('placement rules', () => {
  // a stone mass at x ≤ 0 below y=40, a water pocket at (0,40,0), void everywhere else
  const w: PhysWorld = {
    getBlock(x, y, z): number {
      void z;
      if (x === 0 && y === 40) return BlockId.WATER;
      if (x <= 0 && y < 40) return BlockId.STONE;
      return 0;
    },
  };

  it('needs a neighbour to hold the block', () => {
    expect(canPlaceAt(w, 4, 41, 4, BlockId.DIRT)).toBe(false); // floating in the void
    expect(canPlaceAt(w, 1, 39, 4, BlockId.DIRT)).toBe(true); // against the stone face
    expect(canPlaceAt(w, 1, 45, 4, BlockId.COBBLESTONE)).toBe(false);
  });

  it('replaces water but not stone', () => {
    expect(canPlaceAt(w, 0, 40, 0, BlockId.COBBLESTONE)).toBe(true);
    expect(canPlaceAt(w, 0, 39, 0, BlockId.DIRT)).toBe(false);
  });

  it('stays inside the world', () => {
    expect(canPlaceAt(w, 4, 128, 4, BlockId.DIRT)).toBe(false);
    expect(canPlaceAt(w, 4, -1, 4, BlockId.DIRT)).toBe(false);
  });

  it('torches need something to lean on', () => {
    const air: PhysWorld = { getBlock: () => 0 };
    expect(canPlaceAt(air, 5, 50, 5, BlockId.TORCH)).toBe(false);
    const floor: PhysWorld = { getBlock: (_x, y) => (y < 40 ? BlockId.STONE : 0) };
    expect(canPlaceAt(floor, 5, 40, 5, BlockId.TORCH)).toBe(true);
  });

  it('boxIntersectsCell matches overlapping AABBs only', () => {
    const box = { minX: 0.2, maxX: 0.8, minY: 0.5, maxY: 2.3, minZ: 0.2, maxZ: 0.8 };
    expect(boxIntersectsCell(box, 0, 1, 0)).toBe(true);
    expect(boxIntersectsCell(box, 0, 0, 0)).toBe(true);
    expect(boxIntersectsCell(box, 1, 1, 0)).toBe(false);
    expect(boxIntersectsCell(box, 0, 9, 0)).toBe(false);
  });
});
