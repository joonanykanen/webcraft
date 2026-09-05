/** Dynamic entities: gravity blocks (EN-3), primed TNT (EN-4) and collectible item drops. */
import type { Object3D } from 'three';
import { CHUNK_SY } from '../core/constants.js';
import type { Vec3 } from '../core/types.js';
import { BlockId, block, isFluid, isSolid } from '../world/blocks.js';
import type { AudioBus } from '../audio/audio.js';
import type { Renderer } from '../render/renderer.js';
import type { CubeOptions } from '../render/geometry.js';
import type { Inventory } from './inventory.js';
import { dropFor } from './mining.js';
import { moveWithCollision } from './physics.js';
import type { Player } from './player.js';
import type { World } from '../world/world.js';

export interface EntityHost {
  world: World;
  renderer: Renderer;
  audio: AudioBus;
  player: Player;
  inventory: Inventory;
  entities: EntityManager;
  /** area damage for mobs (explosions) */
  damageMobsInRadius(pos: Vec3, radius: number, amount: number): void;
  /** stats, particles and gravity follow-up when a block disappears */
  noteBlockBroken(blockId: number, x: number, y: number, z: number): void;
  noteExplosion(x: number, y: number, z: number, radius: number): void;
}

export abstract class Entity {
  pos: Vec3;
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  dead = false;
  age = 0;
  protected mesh: Object3D | null = null;
  abstract collider: { hw: number; h: number };
  abstract update(dt: number, host: EntityHost): void;

  constructor(pos: Vec3) {
    this.pos = { ...pos };
  }
  attachMesh(obj: Object3D | null): void {
    this.mesh = obj;
  }
  get currentMesh(): Object3D | null {
    return this.mesh;
  }
  syncMesh(): void {
    if (this.mesh) this.mesh.position.set(this.pos.x, this.pos.y + this.collider.h / 2, this.pos.z);
  }
  disposeMesh(renderer: Renderer): void {
    if (this.mesh) renderer.removeEntityMesh(this.mesh);
    this.mesh = null;
  }
}

function cubeFor(blockId: number, size: number, centered = true, shade = 1): CubeOptions | null {
  const d = block(blockId);
  if (!d) return null;
  return { size, top: d.faces[0], bottom: d.faces[1], side: d.faces[2], sky: 15, block: 0, centered, shade };
}

/** EN-3: sand & gravel fall to the first solid surface below them. */
export class FallingBlock extends Entity {
  collider = { hw: 0.45, h: 0.95 };
  constructor(
    pos: Vec3,
    public blockId: number,
  ) {
    super(pos);
    this.vel.y = -1;
  }

  update(dt: number, host: EntityHost): void {
    this.vel.y = Math.max(-40, this.vel.y - 28 * dt);
    const res = moveWithCollision(host.world, this.pos, this.vel, dt, this.collider);
    this.syncMesh();
    if (!(res.onGround || this.pos.y <= 0.02)) return;

    const bx = Math.floor(this.pos.x);
    const bz = Math.floor(this.pos.z);
    let by = Math.floor(this.pos.y + 0.02);
    while (by < CHUNK_SY - 1 && isSolid(host.world.getBlock(bx, by, bz))) by++;
    if (by < CHUNK_SY && host.world.isLoadedAt(bx, bz)) {
      host.world.setBlock(bx, by, bz, this.blockId);
      host.audio.placeBlock('sand');
    } else {
      host.inventory.add(this.blockId, 1);
    }
    this.dead = true;
  }
}

/** EN-4: primed TNT — 3 s fuse, chain reaction, destroys blocks inside radius 4. */
export class TntEntity extends Entity {
  collider = { hw: 0.45, h: 0.98 };
  fuse = 3;
  private flash = 0;
  constructor(pos: Vec3) {
    super(pos);
    this.vel.y = 2.4;
  }

  update(dt: number, host: EntityHost): void {
    this.fuse -= dt;
    this.vel.y = Math.max(-30, this.vel.y - 24 * dt);
    moveWithCollision(host.world, this.pos, this.vel, dt, this.collider);
    this.syncMesh();
    if (this.mesh) {
      this.flash += dt;
      this.mesh.scale.setScalar(1 + Math.sin(this.flash * 22) * 0.07);
      if (this.flash > 0.16) {
        this.flash = 0;
        host.renderer.spawnBlockParticles(this.pos.x, this.pos.y + 0.9, this.pos.z, block(BlockId.TNT)?.faces[2] ?? 25, 1);
      }
    }
    if (this.fuse <= 0) {
      explode(host, this.pos.x, this.pos.y + 0.5, this.pos.z, 4);
      this.dead = true;
    }
  }
}

/** Dropped item: bobs, spins, and is magnetised toward the player. */
export class ItemDrop extends Entity {
  collider = { hw: 0.18, h: 0.36 };
  pickupDelay = 0.5;
  constructor(
    pos: Vec3,
    public item: number,
    public count: number,
  ) {
    super(pos);
    this.vel.x = (Math.random() - 0.5) * 1.5;
    this.vel.z = (Math.random() - 0.5) * 1.5;
    this.vel.y = 2.2;
  }

  update(dt: number, host: EntityHost): void {
    this.pickupDelay -= dt;
    const p = host.player.pos;
    const dx = p.x - this.pos.x;
    const dy = p.y + 0.7 - this.pos.y;
    const dz = p.z - this.pos.z;
    const d = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));

    if (this.pickupDelay <= 0) {
      if (d < 3) {
        const pull = 26 * dt;
        this.vel.x += (dx / d) * pull;
        this.vel.y += (dy / d) * pull * 0.8;
        this.vel.z += (dz / d) * pull;
      }
      if (d < 1.05) {
        const left = host.inventory.add(this.item, this.count);
        if (left === 0) {
          this.dead = true;
          host.audio.click();
          return;
        }
        this.count = left;
      }
    } else {
      this.vel.y -= 20 * dt;
    }
    this.vel.x *= 1 - Math.min(1, 3 * dt);
    this.vel.z *= 1 - Math.min(1, 3 * dt);
    moveWithCollision(host.world, this.pos, this.vel, dt, this.collider);
    if (this.mesh) {
      this.mesh.position.set(this.pos.x, this.pos.y + 0.2 + Math.sin(this.age * 4) * 0.06, this.pos.z);
      this.mesh.rotation.y += dt * 1.7;
    }
    if (this.age > 300) this.dead = true;
  }
}

/** EN-3: sand & gravel above a removed/support-changed cell fall down. */
export function settleGravity(host: EntityHost, x: number, y: number, z: number): void {
  for (let cy = y + 1; cy < CHUNK_SY; cy++) {
    const id = host.world.getBlock(x, cy, z);
    if (id === 0) break;
    const d = block(id);
    if (!d) break;
    if (isFluid(id)) break;
    if (!d.gravity) break;
    const below = host.world.getBlock(x, cy - 1, z);
    if (below === 0 || isFluid(below)) {
      host.world.setBlock(x, cy, z, 0);
      host.entities.spawnFallingBlock(host, x, cy, z, id);
    }
  }
}

/** Blast (radius 4 by default). Unbreakable blocks and fluids survive (EN-4). */
export function explode(host: EntityHost, x: number, y: number, z: number, radius = 4): void {
  host.audio.explode();
  host.noteExplosion(x, y, z, radius);
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const cz = Math.floor(z);
  const r = Math.ceil(radius);
  const chain: Vec3[] = [];
  host.world.beginBatch();
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > radius) continue;
        const bx = cx + dx;
        const by = cy + dy;
        const bz = cz + dz;
        if (by < 1 || by >= CHUNK_SY) continue;
        if (!host.world.isLoadedAt(bx, bz)) continue;
        const id = host.world.getBlock(bx, by, bz);
        if (id === 0 || isFluid(id)) continue;
        const d = block(id);
        if (!d || d.unbreakable) continue;
        if (id === BlockId.TNT) {
          host.world.setBlock(bx, by, bz, 0);
          chain.push({ x: bx + 0.5, y: by + 0.1, z: bz + 0.5 });
          continue;
        }
        host.world.setBlock(bx, by, bz, 0);
        host.noteBlockBroken(id, bx, by, bz);
        if (d.faces[2] >= 0) host.renderer.spawnBlockParticles(bx, by, bz, d.faces[2], 4);
        const drop = dropFor(id, 9);
        if (drop && Math.random() < 0.8 - dist / (radius * 2)) {
          host.entities.spawnDrop(host, { x: bx + 0.5, y: by + 0.5, z: bz + 0.5 }, drop.id, drop.count);
        }
        host.noteBlockBroken(id, bx, by, bz); // gravity follow-up + save dirty flag
      }
    }
  }
  host.world.endBatch();
  for (const p of chain) host.entities.spawnTnt(host, p);

  // knockback + damage to the player
  const p = host.player.pos;
  const pd = Math.hypot(p.x - x, p.y + 0.9 - y, p.z - z);
  if (pd < radius * 1.6) {
    const power = (1 - pd / (radius * 1.6)) * 15;
    host.player.vel.x += ((p.x - x) / Math.max(0.4, pd)) * power;
    host.player.vel.y += power * 0.6;
    host.player.vel.z += ((p.z - z) / Math.max(0.4, pd)) * power;
    if (!host.player.creative && pd < radius) {
      host.player.hurtTimer = 0;
      host.player.damage(Math.round((1 - pd / radius) * 13) + 1, 'explosion');
    }
  }
  host.damageMobsInRadius({ x, y, z }, radius * 1.4, 12);
}

/** All dynamic entities; their meshes reuse the chunk material so they match the world visually. */
export class EntityManager {
  list: Entity[] = [];

  private add(host: EntityHost, e: Entity, cube: CubeOptions | null): void {
    if (cube) {
      const mesh = host.renderer.entityCube(cube);
      e.attachMesh(mesh);
      host.renderer.addEntityMesh(mesh);
      e.syncMesh();
    }
    this.list.push(e);
  }

  spawnFallingBlock(host: EntityHost, x: number, y: number, z: number, blockId: number): void {
    this.add(host, new FallingBlock({ x: x + 0.5, y, z: z + 0.5 }, blockId), cubeFor(blockId, 0.98));
  }

  spawnTnt(host: EntityHost, pos: Vec3): void {
    this.add(host, new TntEntity({ x: pos.x, y: pos.y, z: pos.z }), cubeFor(BlockId.TNT, 0.96));
  }

  spawnDrop(host: EntityHost, pos: Vec3, item: number, count: number): void {
    const cube = item < 100 ? cubeFor(item, 0.34, true, 1.3) : null;
    this.add(host, new ItemDrop({ x: pos.x, y: pos.y, z: pos.z }, item, count), cube);
    const e = this.list[this.list.length - 1];
    if (e.currentMesh) e.currentMesh.rotation.y = Math.random() * Math.PI;
  }

  update(dt: number, host: EntityHost): void {
    let removed = false;
    for (const e of this.list) {
      if (e.dead) continue;
      e.age += dt;
      e.update(dt, host);
      if (e.dead) {
        e.disposeMesh(host.renderer);
        removed = true;
      }
    }
    if (removed) this.list = this.list.filter((e) => !e.dead);
  }

  /** Distance cull so far-away entities don't tick forever. */
  cullFar(pos: Vec3, maxDist: number, renderer: Renderer): void {
    for (const e of this.list) {
      if (Math.hypot(e.pos.x - pos.x, e.pos.y - pos.y, e.pos.z - pos.z) > maxDist) {
        e.disposeMesh(renderer);
        e.dead = true;
      }
    }
    this.list = this.list.filter((e) => !e.dead);
  }

  clear(renderer: Renderer): void {
    for (const e of this.list) e.disposeMesh(renderer);
    this.list = [];
  }

  count(): number {
    return this.list.length;
  }
}
