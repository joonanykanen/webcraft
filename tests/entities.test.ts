/** Dynamic entities and mobs: gravity blocks, TNT, drops, spawn rules (EN-3, EN-4, MO-1 … MO-4). */
import { afterEach, describe, expect, it } from 'vitest';
import { Group } from 'three';
import { BlockId } from '../src/world/blocks.js';
import { ItemId } from '../src/world/items.js';
import { World } from '../src/world/world.js';
import { SyncGenPool } from '../src/workers/pool.js';
import { Inventory } from '../src/game/inventory.js';
import { Player } from '../src/game/player.js';
import {
  EntityManager,
  FallingBlock,
  ItemDrop,
  TntEntity,
  explode,
  settleGravity,
  type EntityHost,
} from '../src/game/entities.js';
import { MobManager } from '../src/game/mobs.js';
import type { Renderer } from '../src/render/renderer.js';
import type { AudioBus } from '../src/audio/audio.js';

const rendererStub = {
  entityCube: () => new Group(),
  addEntityMesh: () => {},
  removeEntityMesh: () => {},
  spawnBlockParticles: () => {},
} as unknown as Renderer;

const audioStub = {
  explode: () => {},
  click: () => {},
  mobSound: () => {},
  placeBlock: () => {},
  step: () => {},
} as unknown as AudioBus;

interface TestHost extends EntityHost {
  broken: number[];
  explosions: { x: number; y: number; z: number; r: number }[];
}

const hosts: TestHost[] = [];

function makeHost(seed: number, renderDistance = 2): TestHost {
  const pool = new SyncGenPool(seed);
  const world = new World({ seed, pool, sink: null, renderDistance, quality: 'fast' });
  world.prepareSync(0, 0, renderDistance);
  const y = world.surfaceY(8, 8) + 2;
  const player = new Player(
    { x: 8.5, y, z: 8.5 },
    { onStep: () => {}, onJump: () => {}, onLand: () => {}, onDamage: () => {}, onSplash: () => {} },
  );
  player.pos.y = y;
  const host = {
    world,
    renderer: rendererStub,
    audio: audioStub,
    player,
    inventory: new Inventory(),
    entities: new EntityManager(),
    broken: [],
    explosions: [],
    damageMobsInRadius: () => {},
    noteBlockBroken: (blockId: number) => {
      host.broken.push(blockId);
    },
    noteExplosion: (x: number, y: number, z: number, radius: number) => {
      host.explosions.push({ x, y, z, r: radius });
    },
  } as unknown as TestHost;
  hosts.push(host);
  return host;
}

/** Hollow out a cube of air deep underground so blasts have clean geometry to measure. */
function chamber(host: TestHost, cx: number, cy: number, cz: number, half: number): void {
  for (let x = cx - half; x <= cx + half; x++)
    for (let y = cy - half; y <= cy + half; y++)
      for (let z = cz - half; z <= cz + half; z++) host.world.setBlock(x, y, z, 0);
}

afterEach(() => {
  while (hosts.length) hosts.pop()!.world.dispose();
});

describe('explosions (EN-4)', () => {
  it('clears blocks inside the radius and spares everything outside it', () => {
    const host = makeHost(4711);
    const c = { x: 8, y: host.world.surfaceY(8, 8) - 14, z: 8 };
    chamber(host, c.x, c.y, c.z, 7);
    // witness blocks just outside the blast radius
    for (const [dx, dy, dz] of [[5, 0, 0], [-5, 0, 0], [0, 5, 0], [0, -5, 0], [0, 0, 5], [0, 0, -5], [4, 4, 0], [0, 4, 4]] as const) {
      host.world.setBlock(c.x + dx, c.y + dy, c.z + dz, BlockId.STONE);
    }
    host.broken.length = 0;

    explode(host, c.x + 0.5, c.y + 0.5, c.z + 0.5, 4);

    expect(host.explosions.length).toBe(1);
    for (let dx = -4; dx <= 4; dx++)
      for (let dy = -4; dy <= 4; dy++)
        for (let dz = -4; dz <= 4; dz++) {
          if (Math.hypot(dx, dy, dz) > 4) continue;
          expect(host.world.getBlock(c.x + dx, c.y + dy, c.z + dz), `(${dx},${dy},${dz})`).toBe(0);
        }
    for (const [dx, dy, dz] of [[5, 0, 0], [-5, 0, 0], [0, 5, 0], [0, -5, 0], [0, 0, 5], [0, 0, -5], [4, 4, 0], [0, 4, 4]] as const) {
      expect(host.world.getBlock(c.x + dx, c.y + dy, c.z + dz), `witness (${dx},${dy},${dz})`).toBe(BlockId.STONE);
    }
    expect(host.broken.length).toBe(0); // only air was inside the radius
  });

  it('leaves indestructible blocks and fluids alone', () => {
    const host = makeHost(4712);
    const c = { x: 8, y: host.world.surfaceY(8, 8) - 14, z: 8 };
    chamber(host, c.x, c.y, c.z, 6);
    host.world.setBlock(c.x + 2, c.y, c.z, BlockId.BEDROCK);
    host.world.setBlock(c.x, c.y, c.z + 2, BlockId.WATER);

    explode(host, c.x + 0.5, c.y + 0.5, c.z + 0.5, 4);

    expect(host.world.getBlock(c.x + 2, c.y, c.z)).toBe(BlockId.BEDROCK);
    expect(host.world.getBlock(c.x, c.y, c.z + 2)).toBe(BlockId.WATER);
  });

  it('detonates neighbouring TNT blocks as a chain reaction', () => {
    const host = makeHost(4713);
    const c = { x: 8, y: host.world.surfaceY(8, 8) - 14, z: 8 };
    chamber(host, c.x, c.y, c.z, 6);
    host.world.setBlock(c.x + 2, c.y, c.z, BlockId.TNT);

    explode(host, c.x + 0.5, c.y + 0.5, c.z + 0.5, 4);

    expect(host.world.getBlock(c.x + 2, c.y, c.z)).toBe(0);
    const tnt = host.entities.list.filter((e) => e instanceof TntEntity);
    expect(tnt.length).toBe(1);
  });

  it('a primed TNT entity blows after its fuse and vanishes', () => {
    const host = makeHost(4714);
    const c = { x: 8, y: host.world.surfaceY(8, 8) - 14, z: 8 };
    chamber(host, c.x, c.y, c.z, 6);
    host.entities.spawnTnt(host, { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });
    expect(host.entities.count()).toBe(1);

    for (let i = 0; i < 260; i++) host.entities.update(1 / 60, host); // ~4.3 s

    expect(host.entities.list.filter((e) => e instanceof TntEntity).length).toBe(0);
    expect(host.explosions.length).toBe(1);
    expect(host.world.getBlock(c.x, c.y, c.z)).toBe(0);
  });

  it('records the destroyed blocks in the save diff', () => {
    const host = makeHost(4715);
    const y = host.world.surfaceY(8, 8);
    const before = JSON.stringify(host.world.serializeChunks()).length;
    explode(host, 8.5, y + 0.5, 8.5, 4); // blast the untouched terrain
    const after = JSON.stringify(host.world.serializeChunks()).length;
    expect(after).toBeGreaterThan(before);
    expect(host.broken.length).toBeGreaterThan(10); // real rock was removed
    expect(host.world.getBlock(8, y, 8)).toBe(0);
  });
});

describe('gravity blocks (EN-3)', () => {
  it('makes unsupported sand and gravel fall while stone stays put', () => {
    const host = makeHost(4720);
    const base = host.world.surfaceY(8, 8) + 4;
    host.world.setBlock(8, base, 8, BlockId.SAND);
    host.world.setBlock(8, base + 1, 8, BlockId.GRAVEL);
    host.world.setBlock(9, base, 8, BlockId.STONE);
    host.world.setBlock(10, base, 8, BlockId.DIRT);

    settleGravity(host, 8, base - 1, 8); // support under the sand was removed
    expect(host.world.getBlock(8, base, 8)).toBe(0);
    expect(host.world.getBlock(8, base + 1, 8)).toBe(0); // the gravel above fell too
    settleGravity(host, 9, base - 1, 8);
    settleGravity(host, 10, base - 1, 8);
    expect(host.world.getBlock(9, base, 8)).toBe(BlockId.STONE);
    expect(host.world.getBlock(10, base, 8)).toBe(BlockId.DIRT);
    expect(host.entities.list.filter((e) => e instanceof FallingBlock).length).toBe(2);
  });

  it('a falling block lands and becomes a block again', () => {
    const host = makeHost(4721);
    const floor = host.world.surfaceY(8, 8);
    chamber(host, 8, floor + 8, 8, 5);
    host.entities.spawnFallingBlock(host, 8, floor + 10, 8, BlockId.SAND);
    const sand = host.entities.list[0];

    for (let i = 0; i < 600 && !sand.dead; i++) host.entities.update(1 / 40, host);

    expect(sand.dead).toBe(true);
    const landed = host.world.getBlock(8, floor + 1, 8);
    expect(landed).toBe(BlockId.SAND);
  });

  it('does not run when the block above is resting on something', () => {
    const host = makeHost(4722);
    const base = host.world.surfaceY(8, 8);
    host.world.setBlock(8, base + 1, 8, BlockId.SAND); // sits on the terrain
    settleGravity(host, 8, base, 8);
    expect(host.world.getBlock(8, base + 1, 8)).toBe(BlockId.SAND);
    expect(host.entities.count()).toBe(0);
  });
});

describe('item drops', () => {
  it('are pulled to the player and collected', () => {
    const host = makeHost(4730);
    const p = host.player.pos;
    host.entities.spawnDrop(host, { x: p.x + 0.6, y: p.y + 0.4, z: p.z }, BlockId.DIRT, 3);
    for (let i = 0; i < 180; i++) host.entities.update(1 / 60, host);
    expect(host.inventory.countItem(BlockId.DIRT)).toBe(3);
    expect(host.entities.list.filter((e) => e instanceof ItemDrop && !e.dead).length).toBe(0);
  });

  it('stay on the floor until picked up and expire eventually', () => {
    const host = makeHost(4731);
    const p = host.player.pos;
    host.entities.spawnDrop(host, { x: p.x + 30, y: p.y, z: p.z }, ItemId.COAL, 1);
    for (let i = 0; i < 120; i++) host.entities.update(1 / 60, host);
    expect(host.inventory.countItem(ItemId.COAL)).toBe(0);
    const drop = host.entities.list.find((e) => e instanceof ItemDrop) as ItemDrop | undefined;
    expect(drop).toBeDefined();
    for (let i = 0; i < 400; i++) host.entities.update(1, host); // 400 s > lifespan
    expect(drop!.dead).toBe(true);
  });
});

describe('mobs (MO-1 … MO-4)', () => {
  it('caps the population and drops mobs that stray too far', () => {
    const host = makeHost(4740, 2);
    const mobs = new MobManager(rendererStub);
    const p = host.player.pos;
    for (let i = 0; i < 80; i++) mobs.spawn('pig', { x: p.x + (i % 8) - 4, y: p.y + 1, z: p.z + Math.floor(i / 8) - 4 }, host);
    expect(mobs.mobs.length).toBe(80);
    const far = mobs.spawn('pig', { x: p.x + 400, y: p.y + 1, z: p.z }, host);
    mobs.update(1 / 60, host, 0, 0.2);
    expect(mobs.mobs.length).toBeLessThanOrEqual(64);
    expect(mobs.mobs.includes(far)).toBe(false);
    mobs.clear();
    expect(mobs.mobs.length).toBe(0);
  });

  it('kills mobs and drops their loot', () => {
    const host = makeHost(4741, 2);
    const mobs = new MobManager(rendererStub);
    const p = host.player.pos;
    const pig = mobs.spawn('pig', { x: p.x + 2, y: p.y, z: p.z }, host);
    mobs.hitMob(pig, 999, { x: p.x, y: p.y, z: p.z }, host);
    expect(mobs.mobs.length).toBe(0);
    const drops = host.entities.list.filter((e) => e instanceof ItemDrop) as ItemDrop[];
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops[0].item).toBe(ItemId.MEAT);
  });

  it('hostiles chase and hurt the player, but ignore creative mode', () => {
    const host = makeHost(4742, 2);
    const mobs = new MobManager(rendererStub);
    const p = host.player.pos;
    const start = { x: p.x + 6, y: p.y, z: p.z };
    const zombie = mobs.spawn('zombie', start, host);
    host.player.health = 20;

    for (let i = 0; i < 300; i++) mobs.update(1 / 30, host, 1, 0.7);
    expect(Math.hypot(zombie.pos.x - start.x, zombie.pos.z - start.z)).toBeGreaterThan(0.5);
    expect(host.player.health).toBeLessThan(20);

    host.player.mode = 'creative';
    const frozen = host.player.health;
    for (let i = 0; i < 300; i++) mobs.update(1 / 30, host, 1, 0.7);
    expect(host.player.health).toBe(frozen);
  });

  it('spawns animals in daylight and zombies in darkness (MO-2 / MO-3)', () => {
    const host = makeHost(4750, 5);
    const mobs = new MobManager(rendererStub);
    for (let i = 0; i < 40; i++) mobs.update(0.5, host, 0, 0.2); // bright day
    expect(mobs.passives).toBeGreaterThan(0);
    expect(mobs.hostiles).toBe(0);
    mobs.clear();

    for (let i = 0; i < 60; i++) mobs.update(0.5, host, 1, 0.75); // deep night
    expect(mobs.hostiles).toBeGreaterThan(0);
  });

  it('refuses to spawn hostiles while the player is in creative mode', () => {
    const host = makeHost(4751, 5);
    host.player.mode = 'creative';
    const mobs = new MobManager(rendererStub);
    for (let i = 0; i < 60; i++) mobs.update(0.5, host, 1, 0.75);
    expect(mobs.hostiles).toBe(0);
  });

  it('burns zombies in daylight and keeps animals alive', () => {
    const host = makeHost(4752, 2);
    const mobs = new MobManager(rendererStub);
    const p = host.player.pos;
    const exposed = mobs.spawn('zombie', { x: p.x + 3, y: host.world.surfaceY(10, 10) + 1, z: p.z }, host);
    const pig = mobs.spawn('pig', { x: p.x - 3, y: host.world.surfaceY(6, 6) + 1, z: p.z }, host);
    for (let i = 0; i < 900; i++) mobs.update(1 / 20, host, 0, 0.2); // bright sun
    expect(exposed.dead || exposed.hp < 20).toBe(true);
    expect(pig.hp).toBe(10);
  });

  it('survives a save round-trip', () => {
    const host = makeHost(4760, 2);
    const mobs = new MobManager(rendererStub);
    const p = host.player.pos;
    const a = mobs.spawn('cow', { x: p.x + 4, y: p.y, z: p.z }, host);
    const b = mobs.spawn('zombie', { x: p.x - 4, y: p.y, z: p.z }, host);
    const state = JSON.parse(JSON.stringify(mobs.serializeMobs()));

    const host2 = makeHost(4760, 2);
    const restored = new MobManager(rendererStub);
    restored.deserializeMobs(state, host2);
    expect(restored.mobs.length).toBe(2);
    expect(restored.mobs[0].kind).toBe(a.kind);
    expect(restored.mobs[1].kind).toBe(b.kind);
    expect(restored.mobs[0].hp).toBe(a.hp);
    expect(restored.mobs[0].pos.x).toBeCloseTo(a.pos.x, 3);
  });
});
