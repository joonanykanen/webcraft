/** Player mechanics: gravity, jump, swim, breath, hunger, damage, respawn (PH-1 … PH-6, IN-5). */
import { describe, expect, it } from 'vitest';
import { CHUNK_SY } from '../src/core/constants.js';
import { BlockId } from '../src/world/blocks.js';
import { MAX_AIR, MAX_FOOD, MAX_HEARTS } from '../src/core/constants.js';
import { Player, type PlayerCallbacks } from '../src/game/player.js';
import type { MoveState } from '../src/game/input.js';
import type { PhysWorld } from '../src/game/physics.js';

const GROUND = 64;

const quiet: () => PlayerCallbacks = () => ({
  onStep: () => {},
  onJump: () => {},
  onLand: () => {},
  onDamage: () => {},
  onSplash: () => {},
});

function move(partial: Partial<MoveState> = {}): MoveState {
  return { forward: 0, right: 0, jump: false, sneak: false, sprint: false, up: false, down: false, ...partial };
}

/** Solid floor at y<64, plus a wall at x∈[10,11) and a pool of water over x∈[30,40). */
function world(overrides?: (x: number, y: number, z: number) => number): PhysWorld {
  return {
    getBlock(x, y, z) {
      if (overrides) {
        const o = overrides(x, y, z);
        if (o !== undefined) return o;
      }
      if (y < 0) return BlockId.BEDROCK;
      if (x >= 30 && x < 40 && y < GROUND) return BlockId.WATER; // pool (water fills to the floor level)
      if (y < GROUND) return BlockId.STONE;
      if (x >= 10 && x < 11 && y < GROUND + 4) return BlockId.STONE;
      return 0;
    },
  };
}

function playerAt(y = GROUND, cb: Partial<PlayerCallbacks> = {}): Player {
  return new Player({ x: 4.5, y, z: 4.5 }, { ...quiet(), ...cb });
}

function sim(p: Player, m: MoveState, w: PhysWorld, ticks: number, dt = 1 / 60, flight = false): void {
  for (let i = 0; i < ticks; i++) p.update(dt, m, w, flight);
}

describe('gravity & locomotion', () => {
  it('falls to the floor, reports the landing and stops', () => {
    const w = world();
    let landed = -1;
    const p = playerAt(GROUND + 8, { onLand: (d) => (landed = d) });
    sim(p, move(), w, 180);
    expect(p.onGround).toBe(true);
    expect(p.pos.y).toBeCloseTo(GROUND, 2);
    expect(landed).toBeGreaterThan(6);
  });

  it('walking covers ground, sprinting covers more, crouching covers less', () => {
    const w = world();
    const walk = playerAt();
    sim(walk, move({ forward: 1 }), w, 60);
    const sprint = playerAt();
    sim(sprint, move({ forward: 1, sprint: true }), w, 60);
    const creep = playerAt();
    sim(creep, move({ forward: 1, sneak: true }), w, 60);
    const walked = Math.hypot(walk.pos.x - 4.5, walk.pos.z - 4.5);
    const ran = Math.hypot(sprint.pos.x - 4.5, sprint.pos.z - 4.5);
    const crept = Math.hypot(creep.pos.x - 4.5, creep.pos.z - 4.5);
    expect(walked).toBeGreaterThan(2.5);
    expect(ran).toBeGreaterThan(walked * 1.15);
    expect(crept).toBeLessThan(walked * 0.85);
  });

  it('sprinting needs food (PH-5)', () => {
    const w = world();
    const p = playerAt();
    p.food = 4; // less than 3 hearts of hunger
    sim(p, move({ forward: 1, sprint: true }), w, 60);
    expect(p.sprinting).toBe(false);
  });

  it('jumps about one block and comes back down', () => {
    const w = world();
    const p = playerAt();
    let peak = p.pos.y;
    for (let i = 0; i < 60; i++) {
      p.update(1 / 60, move({ jump: true }), w, false);
      peak = Math.max(peak, p.pos.y);
    }
    for (let i = 0; i < 200; i++) p.update(1 / 60, move(), w, false); // let it settle
    const jumped = peak > GROUND + 0.8;
    expect(jumped).toBe(true);
    expect(peak).toBeLessThan(GROUND + 2);
    expect(p.pos.y).toBeCloseTo(GROUND, 1);
  });

  it('cannot walk through solid rock', () => {
    const w = world();
    const p = playerAt();
    p.yaw = -Math.PI / 2; // face +x
    sim(p, move({ forward: 1 }), w, 300);
    expect(p.pos.x).toBeLessThan(10);
  });
});

describe('fall damage (PH-3)', () => {
  it('hurts after a long drop but not after a short one', () => {
    const w = world();
    const safe = playerAt(GROUND + 3);
    sim(safe, move(), w, 200);
    expect(safe.health).toBe(MAX_HEARTS * 2);

    const far = playerAt(GROUND + 40);
    sim(far, move(), w, 400);
    expect(far.health).toBeLessThan(MAX_HEARTS * 2);
    expect(far.pos.y).toBeCloseTo(GROUND, 1);
  });

  it('water breaks a fall (and splashing is reported)', () => {
    const w = world();
    let splashes = 0;
    const p = new Player({ x: 34.5, y: GROUND + 40, z: 4.5 }, { ...quiet(), onSplash: () => splashes++ });
    for (let i = 0; i < 500; i++) p.update(1 / 60, move(), w, false);
    expect(p.health).toBe(MAX_HEARTS * 2);
    expect(splashes).toBeGreaterThan(0);
    expect(p.inWater).toBe(true);
  });

  it('creative mode takes no fall damage', () => {
    const w = world();
    const p = playerAt(GROUND + 40);
    p.mode = 'creative';
    sim(p, move(), w, 400);
    expect(p.health).toBe(MAX_HEARTS * 2);
  });
});

describe('flight (PH-6, creative only)', () => {
  it('double-tapping jump toggles flight when allowed', () => {
    const w = world();
    const p = playerAt();
    p.update(1 / 60, move({ jump: true }), w, true);
    p.update(1 / 60, move({ jump: true }), w, true); // second tap within 0.32 s
    expect(p.flying).toBe(true);
    const y0 = p.pos.y;
    p.update(1 / 60, move({ up: true }), w, true);
    expect(p.pos.y).toBeGreaterThan(y0);
    p.flying = false;
    sim(p, move(), w, 120);
    expect(p.onGround).toBe(true);
  });

  it('is unavailable in survival', () => {
    const w = world();
    const p = playerAt();
    for (let i = 0; i < 10; i++) p.update(1 / 60, move({ jump: true }), w, false);
    expect(p.flying).toBe(false);
  });
});

describe('breath & drowning (PH-4)', () => {
  it('uses up air underwater and drowns afterwards', () => {
    const w = world();
    const p = new Player({ x: 34.5, y: 40, z: 4.5 }, quiet());
    p.pos = { x: 34.5, y: 40, z: 4.5 };
    sim(p, move(), w, 60);
    expect(p.headInWater).toBe(true);
    expect(p.air).toBeLessThan(MAX_AIR);

    let causes: string[] = [];
    const p2 = new Player({ x: 34.5, y: 40, z: 4.5 }, { ...quiet(), onDamage: (_a, cause) => causes.push(cause) });
    sim(p2, move(), w, 1400);
    expect(p2.air).toBe(0);
    expect(p2.health).toBeLessThan(MAX_HEARTS * 2);
    expect(causes).toContain('drowning');
  });

  it('refills air as soon as the head is in open air', () => {
    const w = world();
    const p = new Player({ x: 4.5, y: GROUND, z: 4.5 }, quiet());
    p.air = 2;
    sim(p, move(), w, 180);
    expect(p.headInWater).toBe(false);
    expect(p.air).toBeCloseTo(MAX_AIR, 1);
  });
});

describe('hunger, eating & regeneration (IN-5)', () => {
  it('hunger drains over time and starves at zero', () => {
    const p = playerAt();
    const w = world();
    sim(p, move(), w, 60 * 60);
    expect(p.food).toBeLessThan(MAX_FOOD * 2);

    p.food = 0;
    p.saturation = 0;
    const before = p.health;
    sim(p, move(), w, 600);
    expect(p.health).toBeLessThan(before);
  });

  it('sprinting burns hunger faster than standing still', () => {
    const w = world();
    const idle = playerAt();
    sim(idle, move(), w, 600);
    const runner = playerAt();
    sim(runner, move({ forward: 1, sprint: true }), w, 600);
    expect(runner.food).toBeLessThan(idle.food);
  });

  it('eating restores food and saturation, capped at the maximum', () => {
    const p = playerAt();
    p.food = 4;
    p.saturation = 0;
    p.eat(6);
    expect(p.food).toBe(10);
    expect(p.saturation).toBeGreaterThan(0);
    p.eat(6);
    p.eat(6);
    p.eat(6);
    expect(p.food).toBe(MAX_FOOD * 2);
  });

  it('regenerates health while well fed', () => {
    const p = playerAt();
    p.health = 10;
    p.food = MAX_FOOD * 2;
    p.saturation = 8;
    const w = world();
    sim(p, move(), w, 600);
    expect(p.health).toBeGreaterThan(10);
  });

  it('creative mode never gets hungry', () => {
    const p = playerAt();
    p.mode = 'creative';
    const w = world();
    sim(p, move({ forward: 1, sprint: true }), w, 60 * 600);
    expect(p.food).toBe(MAX_FOOD * 2);
    expect(p.health).toBe(MAX_HEARTS * 2);
  });
});

describe('damage & respawn', () => {
  it('applies a short invulnerability window and clamps health', () => {
    const w = world();
    let lastCause = '';
    const p = playerAt(GROUND, { onDamage: (amount, cause) => (lastCause = `${cause}:${amount}`) });
    p.damage(4, 'zombie');
    expect(p.health).toBe(MAX_HEARTS * 2 - 4);
    expect(lastCause).toBe('zombie:4');
    p.damage(4, 'zombie'); // still invulnerable
    expect(p.health).toBe(MAX_HEARTS * 2 - 4);
    sim(p, move(), w, 60); // 1 s later the window is over
    p.damage(99, 'cactus');
    expect(p.health).toBe(0);
  });

  it('creative players cannot be hurt', () => {
    const p = playerAt();
    p.mode = 'creative';
    p.damage(10, 'zombie');
    expect(p.health).toBe(MAX_HEARTS * 2);
  });

  it('respawns at the bed/spawn point with full stats', () => {
    const w = world();
    const p = playerAt(GROUND);
    p.health = 0;
    p.food = 2;
    p.air = 1;
    p.flying = true;
    p.pos = { x: 200.5, y: 80, z: -120.5 };
    const deaths0 = p.deaths;
    p.respawn();
    expect(p.health).toBe(MAX_HEARTS * 2);
    expect(p.food).toBe(MAX_FOOD * 2);
    expect(p.air).toBe(MAX_AIR);
    expect(p.flying).toBe(false);
    expect(p.deaths).toBe(deaths0 + 1);
    expect(p.pos).toEqual({ x: 4.5, y: GROUND + 1, z: 4.5 }); // one block above the spawn point
    sim(p, move(), w, 60);
  });

  it('never lets the player fall out of the world', () => {
    const w = world();
    const p = playerAt();
    p.pos = { x: 4.5, y: -20, z: 4.5 };
    p.update(1 / 60, move(), w, false);
    expect(p.pos.y).toBeGreaterThan(CHUNK_SY);
    expect(p.health).toBe(0); // the void is lethal in survival
  });
});
