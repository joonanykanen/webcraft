/** Player: first-person controller with voxel-collision physics, swimming, flight, breath & hunger. */
import {
  AIR_DRAIN,
  CHUNK_SY,
  FALL_SAFE_BLOCKS,
  FLY_SPRINT_SPEED,
  FLY_SPEED,
  GRAVITY,
  JUMP_BUFFER_S,
  JUMP_SPEED,
  COYOTE_S,
  MAX_AIR,
  MAX_FOOD,
  MAX_HEARTS,
  PLAYER_EYE,
  SNEAK_SPEED,
  SPRINT_SPEED,
  TERMINAL_VELOCITY,
  WALK_SPEED,
  clamp,
} from '../core/constants.js';
import type { GameMode, Vec3 } from '../core/types.js';
import { block, isFluid } from '../world/blocks.js';
import type { MoveState } from './input.js';
import { boxContains, moveWithCollision, type PhysWorld } from './physics.js';

export interface PlayerCallbacks {
  onStep: (surface: string, speed: number) => void;
  onJump: () => void;
  onLand: (fallDistance: number) => void;
  onDamage: (amount: number, cause: string) => void;
  onSplash: () => void;
}

const PLAYER_COLLIDER = { hw: 0.3, h: 1.8 };

export class Player {
  pos: Vec3;
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  onGround = false;
  flying = false;
  inWater = false;
  headInWater = false;
  sneaking = false;
  sprinting = false;
  health = MAX_HEARTS * 2;
  food = MAX_FOOD * 2;
  saturation = 5;
  air = MAX_AIR;
  hurtTimer = 0;
  deaths = 0;
  spawn: Vec3;
  distanceWalked = 0;
  mode: GameMode = 'survival';
  fallDamageEnabled = true;
  private fallStartY: number | null = null;
  private stepDistance = 0;
  private lastSurface = 'dirt';
  private spaceTapTime = -10;
  private jumpBuffer = 0;
  private coyote = 0;
  private prevJump = false;
  private dpsAccum = 0;
  private readonly callbacks: PlayerCallbacks;

  constructor(spawn: Vec3, callbacks: PlayerCallbacks) {
    this.pos = { ...spawn };
    this.spawn = { ...spawn };
    this.callbacks = callbacks;
  }

  get collider() {
    return PLAYER_COLLIDER;
  }

  get creative(): boolean {
    return this.mode === 'creative';
  }

  eyeY(): number {
    return this.pos.y + (this.sneaking ? PLAYER_EYE - 0.18 : PLAYER_EYE);
  }

  look(dx: number, dy: number): void {
    this.yaw -= dx;
    this.pitch -= dy;
    const limit = Math.PI / 2 - 0.02;
    this.pitch = clamp(this.pitch, -limit, limit);
  }

  forward(): Vec3 {
    return { x: -Math.sin(this.yaw), y: 0, z: -Math.cos(this.yaw) };
  }

  right(): Vec3 {
    return { x: Math.cos(this.yaw), y: 0, z: -Math.sin(this.yaw) };
  }

  /** Camera look vector. */
  view(): Vec3 {
    const cp = Math.cos(this.pitch);
    return { x: -Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: -Math.cos(this.yaw) * cp };
  }

  aabb() {
    return {
      minX: this.pos.x - PLAYER_COLLIDER.hw,
      maxX: this.pos.x + PLAYER_COLLIDER.hw,
      minY: this.pos.y,
      maxY: this.pos.y + PLAYER_COLLIDER.h,
      minZ: this.pos.z - PLAYER_COLLIDER.hw,
      maxZ: this.pos.z + PLAYER_COLLIDER.hw,
    };
  }

  intersectsBlock(bx: number, by: number, bz: number): boolean {
    const b = this.aabb();
    return b.maxX > bx && b.minX < bx + 1 && b.maxY > by && b.minY < by + 1 && b.maxZ > bz && b.minZ < bz + 1;
  }

  /** Fixed-timestep simulation step (called at 60 Hz). */
  update(dt: number, move: MoveState, world: PhysWorld, allowFlight: boolean): void {
    const wasOnGround = this.onGround;
    const prevX = this.pos.x;
    const prevZ = this.pos.z;

    // ---- environment ----
    const headBlock = world.getBlock(Math.floor(this.pos.x), Math.floor(this.eyeY()), Math.floor(this.pos.z));
    const wasInWater = this.inWater;
    this.inWater = boxContains(world, this.pos.x, this.pos.y, this.pos.z, PLAYER_COLLIDER, isFluid);
    this.headInWater = isFluid(headBlock);
    if (this.inWater && !wasInWater && Math.abs(this.vel.y) > 3) this.callbacks.onSplash();

    // ---- double-tap space toggles flight (PH-6, creative only) ----
    if (allowFlight && move.jump && !this.flying) {
      const now = performance.now() / 1000;
      if (now - this.spaceTapTime < 0.32) {
        this.flying = true;
        this.vel.y = 0;
      }
      this.spaceTapTime = now;
    } else if (!move.jump) {
      this.spaceTapTime = performance.now() / 1000;
    }
    if (!allowFlight) this.flying = false;

    // ---- jump intent: edge-detected and buffered (PH-2) ----
    // Movement state is sampled at 60 Hz, so a fast tap can begin and end between two
    // samples and read as "jump does nothing" (especially while sprinting past blocks).
    // A short buffer keeps the intent alive; a coyote window covers leaving a ledge.
    if (move.jump && !this.prevJump) this.jumpBuffer = JUMP_BUFFER_S;
    this.prevJump = move.jump;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.onGround ? COYOTE_S : Math.max(0, this.coyote - dt);
    const wantJump = move.jump || this.jumpBuffer > 0;

    // ---- horizontal wish direction ----
    const f = this.forward();
    const r = this.right();
    let wx = f.x * clamp(move.forward, -1, 1) + r.x * clamp(move.right, -1, 1);
    let wz = f.z * clamp(move.forward, -1, 1) + r.z * clamp(move.right, -1, 1);
    const len = Math.hypot(wx, wz);
    if (len > 0.0001) {
      wx /= len;
      wz /= len;
    }
    this.sneaking = move.sneak && !this.flying;
    this.sprinting =
      move.sprint && !this.sneaking && move.forward > 0.1 && (!this.inWater || this.flying) && this.food > 6;

    let speed = WALK_SPEED;
    if (this.flying) speed = move.sprint ? FLY_SPRINT_SPEED : FLY_SPEED;
    else if (this.sneaking) speed = SNEAK_SPEED;
    else if (this.sprinting) speed = SPRINT_SPEED;
    else if (this.inWater) speed = WALK_SPEED * 0.6;

    const accel = this.flying ? 14 : this.onGround ? 16 : this.inWater ? 7 : 4.5;
    const targetX = wx * speed;
    const targetZ = wz * speed;
    const blend = Math.min(1, accel * dt);
    this.vel.x += (targetX - this.vel.x) * blend;
    this.vel.z += (targetZ - this.vel.z) * blend;
    if (len < 0.0001) {
      const drag = this.onGround ? 12 : this.inWater ? 5 : 1.6;
      const d = Math.min(1, drag * dt);
      this.vel.x -= this.vel.x * d;
      this.vel.z -= this.vel.z * d;
    }

    // ---- vertical ----
    if (this.flying) {
      let vy = 0;
      if (wantJump || move.up) vy += FLY_SPEED * 0.8;
      if (move.down || move.sneak) vy -= FLY_SPEED * 0.7;
      this.vel.y += (vy - this.vel.y) * Math.min(1, 12 * dt);
      if (this.pos.y < 1 && vy <= 0) {
        this.flying = false;
        this.vel.y = 0;
      }
    } else if (this.inWater) {
      this.vel.y -= GRAVITY * 0.22 * dt;
      this.vel.y *= 1 - Math.min(1, 2.6 * dt);
      if (wantJump) this.vel.y = Math.min(4.2, this.vel.y + 16 * dt);
      if (move.down || move.sneak) this.vel.y -= 8 * dt;
      this.vel.y = clamp(this.vel.y, -4.5, 4.5);
    } else {
      this.vel.y -= GRAVITY * dt;
      if (wantJump && (this.onGround || this.coyote > 0)) {
        this.vel.y = JUMP_SPEED;
        this.onGround = false;
        this.coyote = 0;
        this.jumpBuffer = 0;
        this.callbacks.onJump();
      }
      this.vel.y = clamp(this.vel.y, -TERMINAL_VELOCITY, TERMINAL_VELOCITY);
    }

    // ---- move + collide (PH-3) ----
    const res = moveWithCollision(world, this.pos, this.vel, dt, PLAYER_COLLIDER, this.onGround ? 0.62 : 0);
    const wasFlying = this.flying;

    // sneaking keeps you on ledges (PH-2)
    if (this.sneaking && wasOnGround && !res.onGround && !this.flying && !this.inWater) {
      this.pos.x = prevX;
      this.pos.z = prevZ;
      this.vel.x = 0;
      this.vel.z = 0;
      this.onGround = true;
    } else {
      this.onGround = res.onGround;
    }

    if (this.flying && this.onGround && this.vel.y <= 0 && (move.down || move.sneak)) this.flying = false;
    if (wasFlying && !this.flying) this.vel.y = 0;

    // ---- fall tracking / damage (PH-5) ----
    if (!this.onGround && !this.flying && !this.inWater) {
      if (this.fallStartY === null || this.pos.y > this.fallStartY) this.fallStartY = this.pos.y;
    } else if (this.fallStartY !== null) {
      const fallDistance = this.fallStartY - this.pos.y;
      this.fallStartY = null;
      if (this.onGround) {
        this.callbacks.onLand(fallDistance);
        const safe = FALL_SAFE_BLOCKS;
        if (!this.creative && this.fallDamageEnabled && fallDistance > safe && !this.inWater) {
          this.hurtTimer = 0;
          this.damage(Math.round((fallDistance - safe) * 2), 'fall');
        }
      }
    }
    if (this.inWater) this.fallStartY = null;

    // ---- footsteps ----
    const planarSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && planarSpeed > 0.9) {
      this.stepDistance += planarSpeed * dt;
      if (this.stepDistance > 2.1) {
        this.stepDistance = 0;
        const below = world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.4), Math.floor(this.pos.z));
        this.lastSurface = surfaceOf(below);
        this.callbacks.onStep(this.lastSurface, planarSpeed);
      }
    } else if (!this.onGround) {
      this.stepDistance = 1.6;
    }
    this.distanceWalked += planarSpeed * dt;

    // ---- breath (PH-4) ----
    if (this.headInWater) {
      this.air -= AIR_DRAIN * dt * (this.sprinting ? 1.4 : 1);
      if (this.air <= 0) {
        this.air = 0;
        if (!this.creative) this.drainHealth(4 * dt, 'drowning');
      }
    } else {
      this.air = Math.min(MAX_AIR, this.air + dt * 4);
    }

    // ---- hunger / regeneration (IN-5, survival only) ----
    if (!this.creative) {
      let drain = 0.02;
      if (this.sprinting && this.onGround) drain += 0.1;
      if (this.flying) drain += 0.02;
      if (this.inWater) drain += 0.03;
      this.food = Math.max(0, this.food - drain * dt);
      this.saturation = Math.max(0, this.saturation - drain * 0.4 * dt);
      if (this.food >= MAX_FOOD * 1.7 && this.health < MAX_HEARTS * 2) {
        this.health = Math.min(MAX_HEARTS * 2, this.health + 0.18 * dt);
        this.food = Math.max(0, this.food - 0.05 * dt);
      }
      if (this.food <= 0) this.drainHealth(0.35 * dt, 'starve');
    }
    if (this.hurtTimer > 0) this.hurtTimer -= dt;

    // ---- safety net: never fall out of the world ----
    if (this.pos.y < -6) {
      this.pos.y = CHUNK_SY + 4;
      this.vel.y = 0;
      if (!this.creative) this.drainHealth(MAX_HEARTS * 2, 'void');
    }
  }

  damage(amount: number, cause: string): void {
    if (this.creative || amount <= 0) return;
    if (this.hurtTimer > 0) return;
    this.hurtTimer = 0.55;
    this.health = Math.max(0, this.health - amount);
    this.callbacks.onDamage(amount, cause);
  }

  /** Continuous damage (drowning / starving): no invulnerability window, throttled feedback. */
  drainHealth(amount: number, cause: string): void {
    if (this.creative || amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this.dpsAccum += amount;
    if (this.dpsAccum >= 1) {
      this.dpsAccum = 0;
      this.hurtTimer = 0.3;
      this.callbacks.onDamage(1, cause);
    }
  }

  heal(amount: number): void {
    this.health = Math.min(MAX_HEARTS * 2, this.health + amount);
  }

  eat(food: number): void {
    this.food = Math.min(MAX_FOOD * 2, this.food + food);
    this.saturation = Math.min(10, this.saturation + food * 0.6);
  }

  get dead(): boolean {
    return this.health <= 0;
  }

  get healthFrac(): number {
    return this.health / (MAX_HEARTS * 2);
  }
  get foodFrac(): number {
    return this.food / (MAX_FOOD * 2);
  }
  get airFrac(): number {
    return this.air / MAX_AIR;
  }

  respawn(): void {
    this.pos = { ...this.spawn };
    this.pos.y += 1;
    this.vel = { x: 0, y: 0, z: 0 };
    this.health = MAX_HEARTS * 2;
    this.food = MAX_FOOD * 2;
    this.saturation = 5;
    this.air = MAX_AIR;
    this.flying = false;
    this.fallStartY = null;
    this.hurtTimer = 1.2;
    this.deaths++;
  }

  teleport(v: Vec3): void {
    this.pos = { ...v };
    this.vel = { x: 0, y: 0, z: 0 };
  }

  serialize() {
    return {
      pos: { ...this.pos },
      yaw: this.yaw,
      pitch: this.pitch,
      health: this.health,
      food: this.food,
      saturation: this.saturation,
      air: this.air,
      onGround: this.onGround,
      flying: this.flying,
      spawn: { ...this.spawn },
      deaths: this.deaths,
    };
  }

  deserialize(s: Partial<ReturnType<Player['serialize']>>): void {
    if (s.pos) this.pos = { ...s.pos };
    if (typeof s.yaw === 'number') this.yaw = s.yaw;
    if (typeof s.pitch === 'number') this.pitch = s.pitch;
    if (typeof s.health === 'number') this.health = clamp(s.health, 0, MAX_HEARTS * 2);
    if (typeof s.food === 'number') this.food = clamp(s.food, 0, MAX_FOOD * 2);
    if (typeof s.saturation === 'number') this.saturation = s.saturation;
    if (typeof s.air === 'number') this.air = clamp(s.air, 0, MAX_AIR);
    if (typeof s.flying === 'boolean') this.flying = s.flying && this.creative;
    if (s.spawn) this.spawn = { ...s.spawn };
    if (typeof s.deaths === 'number') this.deaths = s.deaths;
  }
}

function surfaceOf(blockId: number): string {
  const d = block(blockId);
  return d ? d.sound : 'dirt';
}
