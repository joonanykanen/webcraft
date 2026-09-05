/**
 * Mobs (MO-1 … MO-4). Passive animals wander by day; hostile zombies emerge at night or in
 * zero-light spots and chase the player. Models are built from atlas-textured voxel cubes.
 */
import * as THREE from 'three';
import { CHUNK_SY, MOB_GRAVITY, clamp } from '../core/constants.js';
import { mulberry32 } from '../core/rng.js';
import type { MobState, Vec3 } from '../core/types.js';
import { isSolid } from '../world/blocks.js';
import { ItemId } from '../world/items.js';
import { TILE } from '../world/tiles.js';
import type { Renderer } from '../render/renderer.js';
import type { CubeOptions } from '../render/geometry.js';
import type { EntityHost } from './entities.js';
import { moveWithCollision } from './physics.js';

export type MobKind = 'pig' | 'cow' | 'sheep' | 'zombie';

/** [body tile, head tile] for each species */
const SKIN: Record<MobKind, [number, number]> = {
  pig: [TILE.PIG, TILE.PIG_HEAD],
  cow: [TILE.COW, TILE.COW_HEAD],
  sheep: [TILE.SHEEP, TILE.SHEEP_HEAD],
  zombie: [TILE.ZOMBIE, TILE.ZOMBIE_HEAD],
};

interface MobSpecies {
  kind: MobKind;
  hp: number;
  speed: number;
  hw: number;
  h: number;
  hostile: boolean;
  aggro: number;
  attackRange: number;
  /** half-hearts of damage (MO-3: 2–3 hearts) */
  attackDamage: number;
  attackCooldown: number;
  drop: number | null;
  dropMin: number;
  dropMax: number;
  burnsInSun: boolean;
  idleChance: number;
}

const SPECIES: Record<MobKind, MobSpecies> = {
  pig: {
    kind: 'pig', hp: 10, speed: 1.9, hw: 0.42, h: 0.9, hostile: false, aggro: 0, attackRange: 0,
    attackDamage: 0, attackCooldown: 1, drop: ItemId.MEAT, dropMin: 1, dropMax: 2, burnsInSun: false, idleChance: 0.5,
  },
  cow: {
    kind: 'cow', hp: 10, speed: 1.7, hw: 0.45, h: 1.25, hostile: false, aggro: 0, attackRange: 0,
    attackDamage: 0, attackCooldown: 1, drop: ItemId.MEAT, dropMin: 1, dropMax: 2, burnsInSun: false, idleChance: 0.4,
  },
  sheep: {
    kind: 'sheep', hp: 8, speed: 1.8, hw: 0.42, h: 1.2, hostile: false, aggro: 0, attackRange: 0,
    attackDamage: 0, attackCooldown: 1, drop: ItemId.MEAT, dropMin: 1, dropMax: 2, burnsInSun: false, idleChance: 0.45,
  },
  zombie: {
    kind: 'zombie', hp: 20, speed: 2.85, hw: 0.3, h: 1.9, hostile: true, aggro: 20, attackRange: 1.8,
    attackDamage: 5, attackCooldown: 1.1, drop: null, dropMin: 0, dropMax: 0, burnsInSun: true, idleChance: 0.2,
  },
};

export const MOB_KINDS = Object.keys(SPECIES) as MobKind[];
const DESPAWN_RADIUS = 128; // MO-4
const PASSIVE_CAP = 10; // MO-2
const HOSTILE_CAP = 20; // MO-3
const TOTAL_CAP = 64;

interface CubeSpec {
  size: number;
  x: number;
  y: number;
  z: number;
  head: boolean;
}

function model(kind: MobKind): CubeSpec[] {
  switch (kind) {
    case 'pig':
      return [
        { size: 0.7, x: 0, y: 0.55, z: 0, head: false },
        { size: 0.42, x: 0, y: 0.7, z: -0.44, head: true },
        { size: 0.18, x: -0.22, y: 0.16, z: -0.2, head: false },
        { size: 0.18, x: 0.22, y: 0.16, z: -0.2, head: false },
        { size: 0.18, x: -0.22, y: 0.16, z: 0.22, head: false },
        { size: 0.18, x: 0.22, y: 0.16, z: 0.22, head: false },
      ];
    case 'cow':
      return [
        { size: 0.78, x: 0, y: 0.85, z: 0, head: false },
        { size: 0.46, x: 0, y: 1.12, z: -0.5, head: true },
        { size: 0.2, x: -0.26, y: 0.22, z: -0.26, head: false },
        { size: 0.2, x: 0.26, y: 0.22, z: -0.26, head: false },
        { size: 0.2, x: -0.26, y: 0.22, z: 0.26, head: false },
        { size: 0.2, x: 0.26, y: 0.22, z: 0.26, head: false },
      ];
    case 'sheep':
      return [
        { size: 0.76, x: 0, y: 0.8, z: 0, head: false },
        { size: 0.4, x: 0, y: 1.08, z: -0.44, head: true },
        { size: 0.18, x: -0.22, y: 0.2, z: -0.2, head: false },
        { size: 0.18, x: 0.22, y: 0.2, z: -0.2, head: false },
        { size: 0.18, x: -0.22, y: 0.2, z: 0.22, head: false },
        { size: 0.18, x: 0.22, y: 0.2, z: 0.22, head: false },
      ];
    case 'zombie':
      return [
        { size: 0.55, x: 0, y: 1.28, z: 0, head: false },
        { size: 0.5, x: 0, y: 1.78, z: 0, head: true },
        { size: 0.22, x: -0.16, y: 0.42, z: 0, head: false },
        { size: 0.22, x: 0.16, y: 0.42, z: 0, head: false },
        { size: 0.2, x: -0.38, y: 1.3, z: -0.3, head: false },
        { size: 0.2, x: 0.38, y: 1.3, z: -0.3, head: false },
      ];
  }
}

export class Mob {
  pos: Vec3;
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  yaw: number;
  hp: number;
  onGround = false;
  dead = false;
  hurtTimer = 0;
  attackCd = 0;
  age = 0;
  private wanderTimer = 1;
  private wanderDir: Vec3 = { x: 0, y: 0, z: 0 };
  private group = new THREE.Group();
  private cubes: CubeSpec[];
  private skyLevel = -1;
  private blockLevel = -1;
  private idleSoundTimer = 3 + Math.random() * 8;

  constructor(
    readonly id: number,
    readonly kind: MobKind,
    pos: Vec3,
    private renderer: Renderer,
    hp?: number,
  ) {
    this.pos = { ...pos };
    this.yaw = Math.random() * Math.PI * 2;
    this.hp = hp ?? SPECIES[kind].hp;
    this.cubes = model(kind);
    this.build(15, 0);
    this.group.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.group.rotation.y = this.yaw;
  }

  get species(): MobSpecies {
    return SPECIES[this.kind];
  }

  get collider(): { hw: number; h: number } {
    return { hw: this.species.hw, h: this.species.h };
  }

  get object(): THREE.Object3D {
    return this.group;
  }

  private build(sky: number, blockLight: number): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    const [body, head] = SKIN[this.kind];
    for (const c of this.cubes) {
      const tile = c.head ? head : body;
      const cube: CubeOptions = {
        size: c.size,
        top: tile,
        bottom: tile,
        side: tile,
        sky,
        block: blockLight,
        centered: true,
      };
      const mesh = this.renderer.entityCube(cube);
      mesh.position.set(c.x, c.y, c.z);
      this.group.add(mesh);
    }
    this.skyLevel = sky;
    this.blockLevel = blockLight;
  }

  /** Re-shade the model when the light around it changes (keeps mobs in sync with AM-1). */
  refreshLight(sky: number, blockLight: number): void {
    const s = Math.round(clamp(sky, 0, 15));
    const b = Math.round(clamp(blockLight, 0, 15));
    if (s === this.skyLevel && b === this.blockLevel) return;
    this.build(s, b);
  }

  distanceTo(p: Vec3): number {
    return Math.hypot(p.x - this.pos.x, p.y - this.pos.y, p.z - this.pos.z);
  }

  aabb() {
    const c = this.collider;
    return {
      minX: this.pos.x - c.hw,
      maxX: this.pos.x + c.hw,
      minY: this.pos.y,
      maxY: this.pos.y + c.h,
      minZ: this.pos.z - c.hw,
      maxZ: this.pos.z + c.hw,
    };
  }

  hurt(amount: number, knockFrom?: Vec3): void {
    this.hp -= amount;
    this.hurtTimer = 0.5;
    if (knockFrom) {
      const dx = this.pos.x - knockFrom.x;
      const dz = this.pos.z - knockFrom.z;
      const d = Math.max(0.3, Math.hypot(dx, dz));
      this.vel.x += (dx / d) * 4.4;
      this.vel.z += (dz / d) * 4.4;
      this.vel.y = Math.max(this.vel.y, 3.4);
    }
    if (this.hp <= 0) this.dead = true;
  }

  /** MO-1 wander + MO-3 chase/attack + gravity/collision via the shared mover. */
  update(dt: number, host: EntityHost, night: number): void {
    const sp = this.species;
    const player = host.player;
    this.age += dt;
    this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    this.attackCd = Math.max(0, this.attackCd - dt);

    const dist = this.distanceTo(player.pos);
    const chasing = sp.hostile && !player.creative && dist < sp.aggro;

    let mx = 0;
    let mz = 0;
    if (chasing) {
      const dx = player.pos.x - this.pos.x;
      const dz = player.pos.z - this.pos.z;
      const d = Math.max(0.001, Math.hypot(dx, dz));
      this.yaw = Math.atan2(-dx, -dz);
      if (d > sp.attackRange * 0.75) {
        mx = dx / d;
        mz = dz / d;
      }
      if (d < sp.attackRange && this.attackCd <= 0) {
        this.attackCd = sp.attackCooldown;
        player.hurtTimer = 0;
        player.damage(sp.attackDamage, 'zombie');
        player.vel.x += (-dx / d) * -3.4;
        player.vel.z += (-dz / d) * -3.4;
        player.vel.y = Math.max(player.vel.y, 2.4);
        host.audio.mobSound('hostile');
      }
    } else if (this.hurtTimer > 0 && !sp.hostile) {
      const dx = this.pos.x - player.pos.x;
      const dz = this.pos.z - player.pos.z;
      const d = Math.max(0.001, Math.hypot(dx, dz));
      mx = dx / d;
      mz = dz / d;
      this.yaw = Math.atan2(-mx, -mz);
    } else {
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = 2 + Math.random() * 6;
        if (Math.random() < sp.idleChance) {
          this.wanderDir = { x: 0, y: 0, z: 0 };
        } else {
          const a = Math.random() * Math.PI * 2;
          this.wanderDir = { x: Math.cos(a), y: 0, z: Math.sin(a) };
          this.yaw = Math.atan2(-this.wanderDir.x, -this.wanderDir.z);
        }
      }
      mx = this.wanderDir.x;
      mz = this.wanderDir.z;
    }

    const speed = sp.speed * (this.hurtTimer > 0 && !sp.hostile ? 1.7 : 1);
    const accel = this.onGround ? 10 : 3;
    this.vel.x += (mx * speed - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (mz * speed - this.vel.z) * Math.min(1, accel * dt);
    this.vel.y -= MOB_GRAVITY * dt;
    if (this.vel.y < -TERMINAL) this.vel.y = -TERMINAL;

    const res = moveWithCollision(host.world, this.pos, this.vel, dt, this.collider, this.onGround ? 0.7 : 0);
    this.onGround = res.onGround;
    if ((res.hitX || res.hitZ) && this.onGround) this.vel.y = 7.6; // hop over a 1-block ledge

    // MO-3: hostiles burn when exposed to daylight
    if (sp.burnsInSun && night < 0.35) {
      const bx = Math.floor(this.pos.x);
      const by = Math.floor(this.pos.y + this.collider.h - 0.1);
      const bz = Math.floor(this.pos.z);
      if (host.world.getSkyLight(bx, by, bz) >= 12) {
        this.hp -= 3 * dt;
        if (Math.random() < dt * 6) {
          host.renderer.spawnBlockParticles(this.pos.x, this.pos.y + 1, this.pos.z, TILE.STONE, 2);
        }
        if (this.hp <= 0) this.dead = true;
      }
    }

    this.idleSoundTimer -= dt;
    if (this.idleSoundTimer <= 0) {
      this.idleSoundTimer = 6 + Math.random() * 12;
      if (dist < 18) host.audio.mobSound(sp.hostile ? 'hostile' : 'idle');
    }

    this.group.position.set(this.pos.x, this.pos.y, this.pos.z);
    let diff = this.yaw - this.group.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.group.rotation.y += diff * Math.min(1, 8 * dt);

    const lx = Math.floor(this.pos.x);
    const ly = Math.floor(this.pos.y + 1);
    const lz = Math.floor(this.pos.z);
    this.refreshLight(host.world.getSkyLight(lx, ly, lz), host.world.getBlockLight(lx, ly, lz));
  }

  dispose(): void {
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    this.group.clear();
  }
}

const TERMINAL = 40;

export class MobManager {
  mobs: Mob[] = [];
  nextId = 1;
  private timerPassive = 2;
  private timerHostile = 3;
  private rnd = mulberry32(0x4d4f42);

  constructor(private renderer: Renderer) {}

  get hostiles(): number {
    let n = 0;
    for (const m of this.mobs) if (m.species.hostile) n++;
    return n;
  }

  get passives(): number {
    return this.mobs.length - this.hostiles;
  }

  spawn(kind: MobKind, pos: Vec3, host: EntityHost, hp?: number): Mob {
    // A non-finite position would spread into the mesh matrix and render as garbage geometry.
    const safe: Vec3 = {
      x: Number.isFinite(pos.x) ? pos.x : 0.5,
      y: Number.isFinite(pos.y) ? pos.y : 0,
      z: Number.isFinite(pos.z) ? pos.z : 0.5,
    };
    const mob = new Mob(this.nextId++, kind, safe, this.renderer, hp);
    this.mobs.push(mob);
    host.renderer.addEntityMesh(mob.object);
    return mob;
  }

  remove(mob: Mob): void {
    const i = this.mobs.indexOf(mob);
    if (i >= 0) this.mobs.splice(i, 1);
    this.renderer.removeEntityMesh(mob.object);
    mob.dispose();
  }

  clear(): void {
    for (const m of [...this.mobs]) this.remove(m);
    this.mobs = [];
  }

  /** MO-4: kill → drop resources, despawn. */
  private kill(mob: Mob, host: EntityHost): void {
    host.audio.mobSound('hurt');
    const sp = mob.species;
    if (sp.drop) {
      const n = sp.dropMin + Math.floor(this.rnd() * (sp.dropMax - sp.dropMin + 1));
      for (let i = 0; i < n; i++) {
        host.entities.spawnDrop(host, { x: mob.pos.x, y: mob.pos.y + 0.4, z: mob.pos.z }, sp.drop, 1);
      }
    }
    this.remove(mob);
  }

  hitMob(mob: Mob, damage: number, from: Vec3, host: EntityHost): void {
    mob.hurt(damage, from);
    host.audio.mobSound('hurt');
    host.renderer.spawnBlockParticles(mob.pos.x, mob.pos.y + mob.collider.h * 0.6, mob.pos.z, SKIN[mob.kind][0], 6);
    if (mob.dead) this.kill(mob, host);
  }

  /** Nearest mob whose AABB the ray crosses within `range` (player attack targeting). */
  pickRay(origin: Vec3, dir: Vec3, range: number): Mob | null {
    let best: Mob | null = null;
    let bestT = range;
    for (const m of this.mobs) {
      const b = m.aabb();
      const o = [origin.x, origin.y, origin.z];
      const d = [dir.x, dir.y, dir.z];
      const lo = [b.minX, b.minY, b.minZ];
      const hi = [b.maxX, b.maxY, b.maxZ];
      let t0 = 0;
      let t1 = bestT;
      let ok = true;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-8) {
          if (o[i] < lo[i] || o[i] > hi[i]) {
            ok = false;
            break;
          }
          continue;
        }
        let ta = (lo[i] - o[i]) / d[i];
        let tb = (hi[i] - o[i]) / d[i];
        if (ta > tb) {
          const tmp = ta;
          ta = tb;
          tb = tmp;
        }
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) {
          ok = false;
          break;
        }
      }
      if (ok && t0 < bestT) {
        bestT = t0;
        best = m;
      }
    }
    return best;
  }

  damageInRadius(pos: Vec3, radius: number, amount: number): void {
    for (const m of this.mobs) if (m.distanceTo(pos) < radius) m.hurt(amount, pos);
  }

  update(dt: number, host: EntityHost, night: number, timeOfDay: number): void {
    for (const mob of [...this.mobs]) {
      mob.update(dt, host, night);
      if (mob.dead) this.remove(mob);
    }
    const p = host.player.pos;
    for (const mob of [...this.mobs]) {
      if (mob.distanceTo(p) > DESPAWN_RADIUS || mob.pos.y < -4) this.remove(mob);
    }
    while (this.mobs.length > TOTAL_CAP) {
      let far = this.mobs[0];
      for (const m of this.mobs) if (m.distanceTo(p) > far.distanceTo(p)) far = m;
      this.remove(far);
    }
    this.trySpawn(dt, host, night, timeOfDay);
  }

  /** MO-2 (passive, daytime, lit surface) / MO-3 (hostile, light level 0). */
  private trySpawn(dt: number, host: EntityHost, night: number, timeOfDay: number): void {
    const day = timeOfDay > 0.04 && timeOfDay < 0.46;
    this.timerPassive -= dt;
    this.timerHostile -= dt;
    if (this.timerPassive <= 0) {
      this.timerPassive = 2.4;
      if (day && this.passives < PASSIVE_CAP) this.spawnAttempt(host, ['pig', 'cow', 'sheep'], 30, 56, true, night);
    }
    if (this.timerHostile <= 0) {
      this.timerHostile = 1.4;
      if (!host.player.creative && this.hostiles < HOSTILE_CAP) this.spawnAttempt(host, ['zombie'], 24, 46, false, night);
    }
  }

  private spawnAttempt(
    host: EntityHost,
    kinds: MobKind[],
    rMin: number,
    rMax: number,
    passive: boolean,
    night: number,
  ): Mob | null {
    const p = host.player.pos;
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = this.rnd() * Math.PI * 2;
      const r = rMin + this.rnd() * (rMax - rMin);
      const x = Math.floor(p.x + Math.cos(a) * r);
      const z = Math.floor(p.z + Math.sin(a) * r);
      if (!host.world.isLoadedAt(x, z)) continue;
      const kind = kinds[Math.floor(this.rnd() * kinds.length)];
      const y = findSurfaceY(host, x, z, Math.ceil(SPECIES[kind].h));
      if (!Number.isFinite(y) || y < 1 || y > CHUNK_SY - 3) continue;
      const light = host.world.getLight(x, y, z);
      // sunlight only counts while the sun is up, so nights and caves are "dark" for MO-3
      const level = Math.max(Math.round(light.sky * (1 - night)), light.blockLight);
      if (passive) {
        if (level < 6) continue;
      } else {
        // MO-3: zero light level, i.e. night surface or a light-free cave
        if (level >= 6) continue;
      }
      return this.spawn(kind, { x: x + 0.5, y, z: z + 0.5 }, host);
    }
    return null;
  }

  /** Persist type/position/health (SV-1 keeps mobs light: at most the nearby ones). */
  serializeMobs(): MobState[] {
    return this.mobs.slice(0, 48).map((m) => ({
      id: m.id,
      kind: m.kind,
      pos: { ...m.pos },
      yaw: m.yaw,
      hp: m.hp,
    }));
  }

  deserializeMobs(list: MobState[] | undefined, host: EntityHost): void {
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (!s || !MOB_KINDS.includes(s.kind as MobKind) || !s.pos) continue;
      const mob = new Mob(this.nextId++, s.kind as MobKind, s.pos, this.renderer, s.hp);
      mob.yaw = s.yaw;
      this.mobs.push(mob);
      host.renderer.addEntityMesh(mob.object);
    }
  }
}

/** First y with enough headroom for a mob, scanning down from the column top. */
function findSurfaceY(host: EntityHost, x: number, z: number, needHeight: number): number {
  const top = Math.min(CHUNK_SY - 1, host.world.surfaceY(x, z) + 2);
  for (let y = top; y >= 1; y--) {
    const id = host.world.getBlock(x, y, z);
    if (id === 0 || !isSolid(id)) continue;
    let clear = true;
    for (let k = 1; k <= needHeight; k++) {
      if (isSolid(host.world.getBlock(x, y + k, z))) {
        clear = false;
        break;
      }
    }
    if (clear) return y + 1;
  }
  return -1;
}
