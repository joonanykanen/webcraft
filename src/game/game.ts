/**
 * Game: the orchestrator. Owns the world, renderer, player, mobs, entities, inventory, day/night
 * cycle and the fixed-timestep simulation loop (§8 architecture, UI-2 flow).
 */
import {
  AUTOSAVE_MS,
  CHUNK_SX,
  CHUNK_SZ,
  DAY_LENGTH_MS,
  JUMP_BUFFER_S,
  MAX_AIR,
  MAX_STACK,
  MAX_FOOD,
  MAX_HEARTS,
  MESH_BUDGET_MS,
  PLAYER_REACH,
  READY_RADIUS,
  TICK_RATE,
  chunkKey,
  clamp,
} from '../core/constants.js';
import { dayNightCurve } from '../core/daynight.js';
import { BIOME_NAMES, type GameMode, type SaveData, type Settings, type Slot, type Vec3, type WorldRecord } from '../core/types.js';
import { mulberry32 } from '../core/rng.js';
import type { AudioBus } from '../audio/audio.js';
import { putWorld } from '../save/idb.js';
import { Renderer, type CameraState } from '../render/renderer.js';
import { SyncGenPool, ChunkWorkerPool } from '../workers/pool.js';
import type { GenPool } from '../world/world.js';
import { World } from '../world/world.js';
import { BlockId, block, isSolid } from '../world/blocks.js';
import { itemName, toolOf } from '../world/items.js';
import { TILE } from '../world/tiles.js';
import { raycast, type RayHit } from '../world/raycast.js';
import { findSpawn } from '../world/worldgen.js';
import { EntityManager, explode, settleGravity, type EntityHost } from './entities.js';
import { Milestones, type MilestoneView } from './achievements.js';
import { Input } from './input.js';
import { Inventory } from './inventory.js';
import { MobManager, type Mob, type MobKind } from './mobs.js';
import { boxIntersectsCell, breakTime, canPlaceAt, dropFor, heldBlockId } from './mining.js';
import { Player } from './player.js';

export type Screen = 'none' | 'inventory' | 'chest' | 'pause' | 'death' | 'settings';

/** Shape of {@link Game.hudModel} — consumed by the HUD & debug overlay. */
export interface HudModel {
  fps: number;
  frameMs: number;
  tickMs: number;
  meshMs: number;
  pos: Vec3;
  chunk: [number, number];
  biome: string;
  chunks: number;
  renderDistance: number;
  genQueue: number;
  dirty: number;
  drawCalls: number;
  triangles: number;
  light: number;
  sky: number;
  blockLight: number;
  health: number;
  maxHealth: number;
  food: number;
  maxFood: number;
  air: number;
  maxAir: number;
  timeOfDay: number;
  mobs: number;
  hostiles: number;
  entities: number;
  mode: GameMode;
  held: Slot;
  selected: number;
  inWater: boolean;
  flying: boolean;
  sneaking: boolean;
  sprinting: boolean;
  onGround: boolean;
  reach: number | null;
  targetBlock: number;
  ready: number;
  seed: number;
  webgl2: boolean;
  quality: 'fancy' | 'fast';
  stats: { blocksMined: number; blocksPlaced: number; distance: number };
  deaths: number;
  /** UI-6: the next goal shown on the HUD tracker (null once everything is unlocked). */
  milestone: { title: string; goal: string; icon: number; have: number; need: number; unlocked: number; total: number } | null;
}

export interface GameHooks {
  onScreen(screen: Screen): void;
  onToast(text: string, kind?: 'info' | 'warn' | 'good'): void;
  onDamage(amount: number, cause: string): void;
  onDeath(): void;
  onSaved(ok: boolean, ms: number): void;
  onInventoryChanged(): void;
  /** UI-6: a milestone just unlocked (toast + chime + panel refresh). */
  onMilestone(view: MilestoneView): void;
  onOpenChest(slots: Slot[], label: string): void;
  /** optional: a keyboard shortcut changed a setting, so the shell can persist it */
  onSettingsChanged?(settings: Settings): void;
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  record: WorldRecord;
  settings: Settings;
  hooks: GameHooks;
  audio: AudioBus;
  webgl2: boolean;
  freshWorld: boolean;
}

const ATTACK_COOLDOWN = 0.34;
const PLACE_COOLDOWN = 0.16;

export class Game implements EntityHost {
  record: WorldRecord;
  settings: Settings;
  readonly hooks: GameHooks;
  readonly audio: AudioBus;
  readonly renderer: Renderer;
  readonly world: World;
  readonly pool: GenPool | null;
  readonly player: Player;
  readonly inventory = new Inventory();
  readonly mobs: MobManager;
  readonly entities = new EntityManager();
  readonly input = new Input();
  mode: GameMode;
  readonly seed: number;

  screen: Screen = 'none';
  timeOfDay: number;
  readonly freshWorld: boolean;
  private timeMs = 0;
  private target: RayHit | null = null;
  private mobTarget: Mob | null = null;
  private mineProgress = 0;
  private mineKey = '';
  private attackTimer = 0;
  private placeTimer = 0;
  /** View-model animation state (VII): walk-bob phase and the rhythm of arm swings. */
  private bobPhase = 0;
  private swingTimer = 0;
  private lastHeldId = -1;
  private saveTimer = AUTOSAVE_MS / 1000;
  private dirtySave = false;
  private accumulator = 0;
  private lastFrame = 0;
  private running = false;
  private rafId = 0;
  private fps = 60;
  private frameMs = 0;
  private frameSamples: number[] = [];
  private chests: Record<string, Slot[]>;
  private chestSlots: Slot[] | null = null;
  private nightAnnounced = false;
  private booted = false;
  /** UI-6: milestone progression (replaces the tutorial cards). */
  readonly milestones = new Milestones();
  private rnd = mulberry32(0x9e37);
  private stats: { blocksMined: number; blocksPlaced: number; distance: number };
  private startedAt = Date.now();
  private tickCount = 0;
  private lastTickMs = 0;

  constructor(opts: GameOptions) {
    this.record = opts.record;
    this.settings = opts.settings;
    this.hooks = opts.hooks;
    this.audio = opts.audio;
    this.freshWorld = opts.freshWorld;
    this.seed = opts.record.seed >>> 0;
    this.mode = opts.record.mode;
    this.timeOfDay = opts.record.data.timeOfDay ?? 0.2;
    this.stats = { ...opts.record.data.stats };

    this.renderer = new Renderer(opts.canvas, opts.settings, opts.webgl2);
    const pool = ChunkWorkerPool.supported() ? new ChunkWorkerPool(this.seed) : null;
    this.pool = pool ?? new SyncGenPool(this.seed);
    this.world = new World({
      seed: this.seed,
      pool: this.pool,
      sink: this.renderer,
      renderDistance: opts.settings.renderDistance,
      quality: opts.settings.quality,
    });
    this.mobs = new MobManager(this.renderer);

    const spawn = findSpawn(this.seed);
    this.player = new Player(
      { x: spawn.x, y: spawn.y, z: spawn.z },
      {
        onStep: (surface) => this.audio.step(surface as 'grass'),
        onJump: () => this.audio.step('grass'),
        onLand: (dist) => {
          if (dist > 1.2) this.audio.step('dirt');
        },
        onDamage: (amount, cause) => {
          this.audio.hurt();
          this.hooks.onDamage(amount, cause);
        },
        onSplash: () => this.audio.splash(),
      },
    );
    this.player.mode = this.mode;
    this.player.fallDamageEnabled = opts.settings.fallDamage;
    this.inventory.creative = this.mode === 'creative';
    this.chests = { ...opts.record.data.chests };

    this.input.attach(opts.canvas);
    this.input.sensitivity = opts.settings.sensitivity;
    this.input.invertY = opts.settings.invertY;
    this.input.setLockMouse(opts.settings.lockMouse);
    this.input.onKeyDown = (code) => this.onKey(code);
    // UI-6: milestones react to what the player actually collects, and announce themselves.
    this.inventory.onObtain = (id, n) => {
      this.milestones.observe({ kind: 'obtain', item: id, n });
    };
    this.milestones.onUnlock = (def) => {
      this.audio.milestone();
      this.hooks.onToast(`Milestone unlocked: ${def.title}`, 'good');
      this.dirtySave = true;
      const view = this.milestones.views().find((v) => v.def.id === def.id);
      if (view) this.hooks.onMilestone(view);
    };
    this.input.onLockChange = (locked) => {
      if (!locked && this.screen === 'none' && this.running) {
        // Escape is handled by the browser here: it exits pointer lock and the page may or may not
        // also see the keydown. Remember the pause so a keydown for the *same* press cannot toggle
        // straight back out of it (which looked like "Escape does nothing").
        this.lockPauseAt = performance.now();
        this.setScreen('pause');
      }
    };
  }

  // ------------------------------------------------------------ boot
  /** Build the spawn area synchronously so the player never falls through the world (WG-6). */
  boot(): void {
    if (this.booted) return;
    this.booted = true;
    const data = this.record.data;
    this.world.applyDiffsFromSave(data.chunks ?? {});
    const spawn = findSpawn(this.seed);
    if (this.freshWorld) {
      this.player.spawn = { ...spawn };
      this.player.pos = { ...spawn, y: spawn.y + 1 };
      if (this.mode === 'survival') this.inventory.giveStarterKit();
    } else {
      this.player.deserialize(data.player);
    }
    this.inventory.deserialize(data.inventory);
    this.inventory.select(data.selected ?? 0);
    // UI-6: restore milestone progress (unknown ids dropped, counters merged)
    this.milestones.warmUp(() => {
      this.milestones.load(data.milestones);
      this.milestones.evaluate();
    });
    // solid ground under the player before physics starts (WG-6 M0 criterion)
    this.world.prepareSync(this.player.pos.x, this.player.pos.z, 2);
    this.ensureFreeStanding();
    this.mobs.deserializeMobs(data.mobs, this);
    this.renderer.setRenderDistance(this.settings.renderDistance);
    this.renderer.setSettings(this.settings);
    this.audio.ensure();
    this.audio.setVolume(this.settings.volume);
    this.audio.setAmbientVolume(this.settings.ambientVolume);
    this.audio.startAmbience();
  }

  /** Nudge the player out of geometry they may have saved inside of. */
  private ensureFreeStanding(): void {
    const fx = Math.floor(this.player.pos.x);
    const fz = Math.floor(this.player.pos.z);
    const groundY = this.world.surfaceY(fx, fz);
    if (groundY >= 0 && this.player.pos.y > groundY + 1.02) this.player.pos.y = groundY + 1.02;
    let guard = 0;
    while (guard++ < 40) {
      const y = Math.floor(this.player.pos.y);
      const blocked = isSolid(this.world.getBlock(fx, y, fz)) || isSolid(this.world.getBlock(fx, y + 1, fz));
      if (!blocked) break;
      this.player.pos.y = y + 1 + 0.02;
    }
  }

  /** 0..1 initial-streaming progress for the loading screen (WG-6). */
  /**
   * Loading-phase pump (WG-6): stream, light and mesh the spawn area while the loading card is
   * up. Progress must reflect *real* work — the previous version only counted chunks that the
   * boot step had requested, so the bar sat at ~15 % and the world then appeared all at once
   * when the 15 s safety timeout fired.
   */
  pumpReady(budgetMs: number): number {
    this.world.update(this.player.pos.x, this.player.pos.z, budgetMs, 24);
    return this.readyProgress();
  }

  /** 0..1 across the chunks the player lands in: 60 % terrain, 40 % lighting + meshing. */
  readyProgress(): number {
    const r = READY_RADIUS;
    const pcx = Math.floor(this.player.pos.x / CHUNK_SX);
    const pcz = Math.floor(this.player.pos.z / CHUNK_SZ);
    let loaded = 0;
    let meshed = 0;
    let total = 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        total++;
        const c = this.world.chunks.get(chunkKey(pcx + dx, pcz + dz));
        if (!c) continue;
        loaded++;
        if (!c.dirty) meshed++;
      }
    }
    return (loaded / total) * 0.6 + (meshed / total) * 0.4;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.input.active = this.screen === 'none'; // hand the keyboard over to the game
    this.lastFrame = performance.now();
    this.loop(this.lastFrame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  get paused(): boolean {
    return this.screen !== 'none';
  }

  setScreen(s: Screen): void {
    if (this.screen === s) return;
    this.screen = s;
    this.input.setActive(s === 'none');
    this.input.uiKeys = s === 'inventory' || s === 'chest';
    this.input.endActions();
    if (s === 'none') this.input.capture();
    else this.input.release();
    if (s !== 'chest') this.chestSlots = null;
    this.hooks.onScreen(s);
  }

  // ------------------------------------------------------------ main loop
  private loop = (now: number) => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    let frameDt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (frameDt > 0.5) frameDt = 0.5; // tab was hidden: don't fast-forward the sim

    // ---- mouse look: apply accumulated pointer-lock / touch-look deltas (BI-1, UI-4) ----
    // Nothing else in the engine consumes these, so a frame where they are not applied
    // is a frame where the mouse "does nothing".
    if (!this.paused && this.screen === 'none') {
      const look = this.input.consumeLook();
      if (look.dx !== 0 || look.dy !== 0) this.player.look(look.dx, look.dy);
    } else {
      this.input.consumeLook(); // panel owns the mouse: drop stale deltas
    }

    // ---- fixed timestep simulation (20 TPS logic inside 60 FPS render) ----
    if (!this.paused) {
      this.accumulator += frameDt;
      const stepDt = 1 / (TICK_RATE * 3); // 60 Hz physics for smooth motion
      let steps = 0;
      while (this.accumulator >= stepDt && steps < 6) {
        this.tick(stepDt);
        this.accumulator -= stepDt;
        steps++;
      }
      if (steps === 6) this.accumulator = 0;
    }

    // ---- time of day (RD-5) ----
    if (!this.paused) {
      this.timeMs += frameDt * 1000;
      this.timeOfDay = (this.baseTime + this.timeMs / DAY_LENGTH_MS) % 1;
    }
    const lightInfo = this.renderer.setTimeOfDay(this.timeOfDay);

    // ---- targeting (BI-1 highlight) & mining overlay (BI-4) ----
    if (!this.paused) this.updateTargeting(frameDt);
    this.renderer.setTarget(this.screen === 'none' && this.target ? this.target : null);
    this.renderer.setMiningProgress(this.target, this.mineProgress);

    // ---- camera ----
    const hspeed = Math.hypot(this.player.vel.x, this.player.vel.z);
    if (this.player.onGround && hspeed > 0.4 && !this.paused) this.bobPhase += frameDt * (3.4 + hspeed * 1.35);
    const heldId = this.inventory.heldId();
    if (heldId !== this.lastHeldId) {
      this.lastHeldId = heldId;
      this.renderer.setHeldItem(heldId);
    }
    const cam: CameraState = {
      x: this.player.pos.x,
      y: this.player.eyeY(),
      z: this.player.pos.z,
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      fov: this.settings.fov + (this.player.sprinting ? 6 : 0) + (this.player.flying ? 4 : 0),
      bob: this.bobPhase,
    };
    this.renderer.setUnderwater(this.player.headInWater);
    const frameStart = performance.now();
    this.renderer.render(cam, this.paused ? 0 : frameDt);

    // ---- chunk streaming (budgeted, §8.3) ----
    this.world.update(this.player.pos.x, this.player.pos.z, MESH_BUDGET_MS, this.settings.maxChunksPerFrame);

    // ---- ambience ----
    const sky = this.world.getSkyLight(Math.floor(this.player.pos.x), Math.floor(this.player.eyeY()), Math.floor(this.player.pos.z));
    const underground = 1 - clamp(sky / 12, 0, 1);
    this.audio.tickAmbience(frameDt, lightInfo.night, this.player.headInWater ? 1 : underground, 0);
    if (lightInfo.night > 0.75 && !this.nightAnnounced) {
      this.nightAnnounced = true;
    }
    if (lightInfo.night < 0.25 && this.nightAnnounced) {
      // the sun came back up on us: that counts as surviving a night
      this.nightAnnounced = false;
      this.milestones.observe({ kind: 'flag', name: 'nights' });
    }

    // ---- autosave (SV-1) ----
    this.saveTimer -= frameDt;
    if (this.saveTimer <= 0) {
      this.saveTimer = AUTOSAVE_MS / 1000;
      if (this.dirtySave) void this.save(false);
    }

    // ---- stats ----
    this.frameMs = performance.now() - frameStart;
    this.frameSamples.push(frameDt);
    if (this.frameSamples.length > 40) this.frameSamples.shift();
    const sum = this.frameSamples.reduce((a, b) => a + b, 0);
    this.fps = sum > 0 ? this.frameSamples.length / sum : 60;
  };

  /** One simulation step. */
  private tick(dt: number): void {
    const t0 = performance.now();
    this.tickCount++;
    const move = this.input.move();
    // Latch a Space tap that began and ended between two sim steps: without this a quick
    // tap (or a tapped jump while sprinting) is sampled as "never pressed".
    if (!move.jump && performance.now() - this.input.jumpPressedAt < JUMP_BUFFER_S * 1000) move.jump = true;
    this.player.update(dt, move, this.world, this.mode === 'creative');
    this.mobs.update(dt, this, this.nightFactor(), this.timeOfDay);
    this.entities.update(dt, this);
    this.entities.cullFar(this.player.pos, 140, this.renderer);
    if (this.player.dead) {
      if (this.screen !== 'death') {
        this.milestones.observe({ kind: 'flag', name: 'deaths' });
        this.setScreen('death');
        this.hooks.onDeath();
      }
    }
    // world-exploration milestones, sampled cheaply once per second
    if (this.tickCount % 20 === 0) {
      if (this.player.pos.y < 20) this.milestones.observe({ kind: 'flag', name: 'deepCave' });
      if (this.player.headInWater) this.milestones.observe({ kind: 'flag', name: 'swam' });
    }
    if (this.tickCount % 20 === 0) this.dirtySave = true;
    this.lastTickMs = performance.now() - t0;
  }

  private get baseTime(): number {
    return this.record.data.timeOfDay ?? 0.2;
  }

  /** Night weight for spawning/burning — the renderer's own curve, so light and behaviour agree. */
  nightFactor(): number {
    return dayNightCurve(this.timeOfDay).night;
  }

  // ------------------------------------------------------------ keys
  /** Set when losing the mouse caused a pause (see the onLockChange wiring in the constructor). */
  private lockPauseAt = -1e9;

  /** True once, for ~0.5 s after a lock loss: the Escape that dropped the lock is this keydown. */
  private sameKeypressAsLockLoss(): boolean {
    if (performance.now() - this.lockPauseAt > 500) return false;
    this.lockPauseAt = -1e9;
    return true;
  }

  private onKey(code: string): void {
    if (code === 'Escape') {
      if (this.screen === 'death') return;
      if (this.sameKeypressAsLockLoss()) return;
      this.setScreen(this.screen === 'none' ? 'pause' : 'none');
      return;
    }
    if (this.screen === 'death') return;
    if (code === 'KeyE') {
      this.setScreen(this.screen === 'inventory' ? 'none' : 'inventory');
      return;
    }
    if (this.screen !== 'none') return;
    if (code.startsWith('Digit')) {
      const n = Number(code.slice(5));
      if (n >= 1 && n <= 9) this.inventory.select(n - 1);
      return;
    }
    if (code === 'KeyQ') {
      this.dropHeld();
      return;
    }
    if (code === 'KeyF') {
      // HUD convenience: toggle the held-item view model (documented on the help screen)
      this.settings.showHand = !this.settings.showHand;
      this.hooks.onSettingsChanged?.(this.settings);
      this.hooks.onToast(this.settings.showHand ? 'Held item shown' : 'Held item hidden', 'info');
      return;
    }
    if (code === 'KeyR') {
      if (this.mode === 'creative') {
        this.player.teleport({ x: this.player.spawn.x, y: this.player.spawn.y + 1, z: this.player.spawn.z });
        this.world.prepareSync(this.player.pos.x, this.player.pos.z, 2);
      }
      return;
    }
    if (code === 'MouseMiddle' && this.mode === 'creative' && this.target) {
      const id = this.target.block;
      if (id) {
        this.inventory.give(id);
        this.hooks.onToast(`Picked ${itemName(id)}`, 'good');
      }
    }
  }

  // ------------------------------------------------------------ targeting & interaction
  private updateTargeting(dt: number): void {
    const eye = this.player.view();
    const reach = PLAYER_REACH + (this.mode === 'creative' ? 3 : 0);
    this.target = raycast(
      this.world,
      this.player.pos.x,
      this.player.eyeY(),
      this.player.pos.z,
      eye.x,
      eye.y,
      eye.z,
      reach,
    );
    this.mobTarget = this.mobs.pickRay({ x: this.player.pos.x, y: this.player.eyeY(), z: this.player.pos.z }, eye, reach);

    const wheel = this.input.consumeWheel();
    if (wheel !== 0) this.inventory.cycle(wheel);

    this.attackTimer = Math.max(0, this.attackTimer - dt);
    this.placeTimer = Math.max(0, this.placeTimer - dt);
    this.swingTimer = Math.max(0, this.swingTimer - dt);

    // ---- mining / attacking ----
    if (this.input.mining) {
      const hitMobFirst = !!this.mobTarget && (!this.target || this.mobTarget.distanceTo(this.player.pos) < (this.target?.dist ?? 99));
      if (hitMobFirst && this.mobTarget) {
        if (this.attackTimer <= 0) this.attack(this.mobTarget);
      } else if (this.target) {
        // keep swinging while the button is held, otherwise the arm looks frozen (§VII)
        if (this.swingTimer <= 0) {
          this.swingTimer = 0.42;
          this.renderer.swingHand();
        }
        this.mineTick(dt, this.target);
      } else {
        // punching air still swings — an arm that ignores the button reads as a broken game
        if (this.swingTimer <= 0) {
          this.swingTimer = 0.42;
          this.renderer.swingHand();
          this.audio.step('dirt');
        }
        this.mineProgress = 0;
        this.mineKey = '';
      }
    } else {
      this.mineProgress = 0;
      this.mineKey = '';
      this.swingTimer = 0;
    }

    // ---- placing / using / eating ----
    if (this.input.placing) {
      if (this.placeTimer <= 0) this.useHeld();
    }
  }

  private attack(mob: Mob): void {
    this.attackTimer = ATTACK_COOLDOWN;
    this.renderer.swingHand();
    const held = this.inventory.heldId();
    const tool = toolOf(held);
    const damage = tool ? tool.damage : 1;
    this.mobs.hitMob(mob, damage, this.player.pos, this);
    if (mob.dead) this.milestones.observe({ kind: 'kill', mob: mob.kind as MobKind });
    this.useTool(1);
    this.audio.step('wood');
  }

  private mineTick(dt: number, hit: RayHit): void {
    const id = hit.block;
    const def = block(id);
    if (!def) return;
    const key = `${hit.x},${hit.y},${hit.z}`;
    if (key !== this.mineKey) {
      this.mineKey = key;
      this.mineProgress = 0;
    }
    if (def.unbreakable) {
      this.mineProgress = 0;
      if (this.rnd() < dt * 2) this.hooks.onToast(`${def.name} is unbreakable`, 'warn');
      return;
    }
    const held = this.inventory.heldId();
    const secs = this.mode === 'creative' ? 0.02 : breakTime(id, held);
    this.mineProgress = clamp(this.mineProgress + dt / Math.max(0.02, secs), 0, 1);
    if (this.mineProgress >= 1) {
      this.breakBlock(hit);
      this.mineProgress = 0;
      this.mineKey = '';
    }
  }

  /** BI-1/BI-3: remove the block, drop its item, spend durability, wake up gravity. */
  breakBlock(hit: RayHit): void {
    const id = hit.block;
    const def = block(id);
    if (!def || def.unbreakable) return;
    const held = this.inventory.heldId();
    const tool = toolOf(held);
    const tier = tool && tool.kind !== 'sword' ? tool.tier : this.inventory.bestToolTier();

    this.world.setBlock(hit.x, hit.y, hit.z, 0);
    this.audio.breakBlock(def.sound);
    if (def.faces[2] >= 0) this.renderer.spawnBlockParticles(hit.x, hit.y, hit.z, def.faces[2], 12);

    if (this.mode === 'survival') {
      const drop = dropFor(id, tier);
      if (drop) {
        this.entities.spawnDrop(this, { x: hit.x + 0.5, y: hit.y + 0.4, z: hit.z + 0.5 }, drop.id, drop.count);
      } else if (def.minTier > tier && def.tool !== 'none') {
        this.hooks.onToast(`Need a better ${def.tool} for ${def.name}`, 'warn');
      }
      this.useTool(1);
    }
    this.stats.blocksMined++;
    this.dirtySave = true;
    this.milestones.observe({ kind: 'mine', block: id });
    this.settleGravity(hit.x, hit.y, hit.z);
  }

  private useTool(amount: number): void {
    if (this.inventory.useToolDurability(amount)) {
      this.audio.breakBlock('stone');
      this.hooks.onToast('Tool broke', 'warn');
      this.hooks.onInventoryChanged();
    }
  }

  /** BI-2: place the held block, or open / use what we pointed at. */
  private useHeld(): void {
    const hit = this.target;
    const held = this.inventory.heldId();
    this.renderer.swingHand();

    // 1. interact with blocks that open UIs
    if (hit) {
      const id = this.world.getBlock(hit.x, hit.y, hit.z);
      if (id === BlockId.CRAFTING_TABLE) {
        this.placeTimer = PLACE_COOLDOWN;
        this.setScreen('inventory');
        this.hooks.onToast('Crafting table: 3×3 grid', 'info');
        return;
      }
      if (id === BlockId.CHEST) {
        this.openChest(hit.x, hit.y, hit.z);
        return;
      }
      if (id === BlockId.TNT) {
        this.placeTimer = 0.5;
        this.world.setBlock(hit.x, hit.y, hit.z, 0);
        this.entities.spawnTnt(this, { x: hit.x + 0.5, y: hit.y + 0.05, z: hit.z + 0.5 });
        this.hooks.onToast('TNT primed — 3 s', 'warn');
        this.dirtySave = true;
        return;
      }
    }

    // 2. eat when we are not holding a placeable block
    const blockId = heldBlockId(held);
    if (blockId < 0) {
      if (this.mode === 'survival' && this.player.food < MAX_FOOD * 2 - 1) {
        const taken = this.inventory.takeFood();
        if (taken) {
          this.player.eat(taken.food);
          this.audio.eat();
          this.placeTimer = 0.6;
          this.hooks.onInventoryChanged();
        }
      }
      return;
    }

    if (!hit) return;
    const px = hit.x + hit.nx;
    const py = hit.y + hit.ny;
    const pz = hit.z + hit.nz;
    if (!canPlaceAt(this.world, px, py, pz, blockId)) {
      this.placeTimer = 0.25;
      return;
    }
    const b = block(blockId);
    if (b && isSolid(blockId) && boxIntersectsCell(this.player.aabb(), px, py, pz)) {
      this.placeTimer = 0.25;
      return;
    }
    // don't seal a mob inside a block either
    for (const m of this.mobs.mobs) {
      if (isSolid(blockId) && boxIntersectsCell(m.aabb(), px, py, pz)) return;
    }

    this.world.setBlock(px, py, pz, blockId);
    this.placeTimer = PLACE_COOLDOWN;
    this.audio.placeBlock(b ? b.sound : 'dirt');
    if (this.mode === 'survival') {
      this.inventory.consume(blockId, 1);
      this.hooks.onInventoryChanged();
    }
    this.stats.blocksPlaced++;
    this.dirtySave = true;
    this.milestones.observe({ kind: 'place', block: blockId });
    this.settleGravity(px, py, pz);
  }

  private openChest(x: number, y: number, z: number): void {
    const key = `${x},${y},${z}`;
    let slots = this.chests[key];
    if (!slots) {
      slots = new Array(27).fill(null);
      this.chests[key] = slots;
    }
    this.chestSlots = slots;
    this.placeTimer = 0.3;
    this.setScreen('chest');
    this.hooks.onOpenChest(slots, 'Chest');
  }

  getChestSlots(): Slot[] | null {
    return this.chestSlots;
  }

  /** EN-3: sand & gravel above a removed/support-changed cell fall down. */
  settleGravity(x: number, y: number, z: number): void {
    settleGravity(this, x, y, z);
  }

  dropHeld(): void {
    const s = this.inventory.selectedSlot();
    if (!s) return;
    const v = this.player.view();
    this.entities.spawnDrop(
      this,
      { x: this.player.pos.x + v.x, y: this.player.eyeY() - 0.2, z: this.player.pos.z + v.z },
      s.id,
      1,
    );
    s.count--;
    if (s.count <= 0) this.inventory.setSlot(this.inventory.selected, null);
    this.hooks.onInventoryChanged();
    this.dirtySave = true;
  }

  // ------------------------------------------------------------ EntityHost
  damageMobsInRadius(pos: Vec3, radius: number, amount: number): void {
    this.mobs.damageInRadius(pos, radius, amount);
  }

  noteBlockBroken(blockId: number, x: number, y: number, z: number): void {
    if (blockId === 0) return;
    this.stats.blocksMined++;
    this.settleGravity(x, y, z);
    this.dirtySave = true;
  }

  noteExplosion(x: number, y: number, z: number, radius: number): void {
    this.renderer.spawnBlockParticles(x, y, z, TILE.TNT_SIDE, 40);
    this.hooks.onToast(`Explosion (r=${radius})`, 'warn');
  }

  /** Public helper used by the pause menu / debug key. */
  detonateAt(x: number, y: number, z: number, radius = 4): void {
    explode(this, x, y, z, radius);
  }

  // ------------------------------------------------------------ save / load (SV-*)
  buildSave(): SaveData {
    const data: SaveData = {
      version: this.record.version,
      timeOfDay: this.timeOfDay,
      player: this.player.serialize(),
      inventory: this.inventory.serialize(),
      selected: this.inventory.selected,
      chunks: this.world.serializeChunks(),
      chests: this.chests,
      mobs: this.mobs.serializeMobs(),
      nextMobId: this.mobs.nextId,
      stats: { ...this.stats, distance: this.stats.distance + this.player.distanceWalked },
      milestones: this.milestones.save(),
    };
    return data;
  }

  async save(manual: boolean): Promise<boolean> {
    const t0 = performance.now();
    try {
      const data = this.buildSave();
      const thumb = manual ? this.renderer.captureThumbnail(192, 108) : this.record.thumbnail;
      this.record = {
        ...this.record,
        data,
        thumbnail: thumb,
        lastPlayed: Date.now(),
        playtimeMs: this.record.playtimeMs + (Date.now() - this.startedAt),
      };
      this.startedAt = Date.now();
      this.stats.distance = 0;
      this.player.distanceWalked = 0;
      await putWorld(this.record);
      this.dirtySave = false;
      this.hooks.onSaved(true, performance.now() - t0);
      if (manual) this.hooks.onToast('World saved', 'good');
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.hooks.onToast(`Save failed: ${msg}`, 'warn');
      this.hooks.onSaved(false, performance.now() - t0);
      return false;
    }
  }

  // ------------------------------------------------------------ misc UI plumbing
  respawn(): void {
    this.player.respawn();
    this.world.prepareSync(this.player.pos.x, this.player.pos.z, 2);
    this.ensureFreeStanding();
    this.setScreen('none');
  }

  setSettings(s: Settings): void {
    const prev = this.settings;
    this.settings = s;
    this.player.fallDamageEnabled = s.fallDamage;
    this.input.sensitivity = s.sensitivity;
    this.input.invertY = s.invertY;
    this.input.setLockMouse(s.lockMouse);
    this.audio.setVolume(s.volume);
    this.audio.setAmbientVolume(s.ambientVolume);
    if (prev.quality !== s.quality) this.world.setQuality(s.quality);
    if (prev.renderDistance !== s.renderDistance) this.world.setRenderDistance(s.renderDistance);
    this.renderer.setSettings(s);
  }

  /** Everything the HUD & debug overlay display (UI-5). */
  hudModel(): HudModel {
    const info = this.renderer.info();
    const light = this.world.getLight(
      Math.floor(this.player.pos.x),
      Math.floor(this.player.eyeY()),
      Math.floor(this.player.pos.z),
    );
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      tickMs: this.lastTickMs,
      meshMs: this.world.stats.meshMs,
      pos: { ...this.player.pos },
      chunk: [Math.floor(this.player.pos.x / CHUNK_SX), Math.floor(this.player.pos.z / CHUNK_SZ)],
      biome: BIOME_NAMES[this.world.biomeAt(Math.floor(this.player.pos.x), Math.floor(this.player.pos.z))],
      chunks: this.world.chunks.size,
      renderDistance: this.settings.renderDistance,
      genQueue: this.world.stats.genQueue,
      dirty: this.world.stats.dirty,
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      light: Math.max(light.sky * this.renderer.getDayLight(), light.blockLight),
      sky: light.sky,
      blockLight: light.blockLight,
      health: this.player.health,
      maxHealth: MAX_HEARTS * 2,
      food: this.player.food,
      maxFood: MAX_FOOD * 2,
      air: this.player.air,
      maxAir: MAX_AIR,
      timeOfDay: this.timeOfDay,
      mobs: this.mobs.mobs.length,
      hostiles: this.mobs.hostiles,
      entities: this.entities.count(),
      mode: this.mode,
      held: this.inventory.selectedSlot(),
      selected: this.inventory.selected,
      inWater: this.player.inWater,
      flying: this.player.flying,
      sneaking: this.player.sneaking,
      sprinting: this.player.sprinting,
      onGround: this.player.onGround,
      reach: this.target ? this.target.dist : null,
      targetBlock: this.target ? this.target.block : 0,
      ready: this.readyProgress(),
      seed: this.seed,
      webgl2: info.webgl2,
      quality: this.settings.quality,
      stats: { ...this.stats },
      deaths: this.player.deaths,
      milestone: this.milestoneTracker(),
    };
  }

  dispose(): void {
    this.stop();
    this.input.detach();
    this.mobs.clear();
    this.entities.clear(this.renderer);
    this.world.dispose();
    this.renderer.dispose();
  }

  /** The UI mutated the inventory/chests, so the next autosave must run. */
  markDirty(): void {
    this.dirtySave = true;
  }

  /** UI-6: HUD tracker row (null when the whole chain is done). */
  milestoneTracker(): HudModel['milestone'] {
    const nx = this.milestones.next();
    if (!nx) return null;
    return {
      title: nx.def.title,
      goal: nx.def.goal,
      icon: nx.def.icon,
      have: Math.min(nx.goal.have, nx.goal.need),
      need: nx.goal.need,
      unlocked: this.milestones.unlockedCount,
      total: this.milestones.total,
    };
  }

  /** UI-6: the panel's rows (locked ones flagged, plus live progress). */
  milestoneViews(): MilestoneView[] {
    return this.milestones.views();
  }

  /** UI-6: called by the crafting UI so "craft X" milestones can be measured. */
  noteCraft(itemId: number, times = 1): void {
    for (let i = 0; i < times; i++) this.milestones.observe({ kind: 'craft', item: itemId });
  }

  /** UI-6: called when a mob dies to us. */
  noteKill(kind: MobKind): void {
    this.milestones.observe({ kind: 'kill', mob: kind });
  }

  /** IN-3: true when a crafting table is close enough to unlock the 3×3 grid. */
  nearCraftingTable(): boolean {
    const p = this.player.pos;
    const r = 4;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (this.world.getBlock(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz) === BlockId.CRAFTING_TABLE) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /** Creative convenience: put a full set of blocks into the hotbar (CM-2). */
  creativeFillHotbar(): void {
    const ids: number[] = [
      BlockId.GRASS,
      BlockId.DIRT,
      BlockId.STONE,
      BlockId.COBBLESTONE,
      BlockId.SAND,
      BlockId.LOG,
      BlockId.PLANKS,
      BlockId.GLASS,
      BlockId.TORCH,
    ];
    ids.forEach((id, i) => this.inventory.setSlot(i, { id, count: MAX_STACK }));
    this.hooks.onInventoryChanged();
  }

  /** Switch game mode at runtime (pause menu / creative mode CM-1). */
  setMode(mode: GameMode): void {
    this.mode = mode;
    this.inventory.creative = mode === 'creative';
    this.player.mode = mode;
    this.player.flying = false;
    if (mode === 'creative') {
      this.player.health = MAX_HEARTS * 2;
      this.player.food = MAX_FOOD * 2;
      this.player.air = MAX_AIR;
    }
    this.hooks.onToast(`Mode: ${mode}`, 'good');
  }

  /** Cheat/dev helper used by the pause menu in creative mode. */
  giveItem(id: number): boolean {
    if (this.mode !== 'creative') return false;
    this.inventory.give(id);
    this.hooks.onInventoryChanged();
    return true;
  }

  /** Creative "spawn animal" helper (pause-menu dev tools); harmless in survival. */
  spawnAnimal(kind: MobKind): void {
    const v = this.player.view();
    const pos = {
      x: Math.floor(this.player.pos.x + v.x * 3),
      y: Math.floor(this.player.pos.y + 1),
      z: Math.floor(this.player.pos.z + v.z * 3),
    };
    if (!this.world.isLoadedAt(pos.x, pos.z)) return;
    this.mobs.spawn(kind, pos, this);
    this.hooks.onToast(`Spawned ${kind}`, 'good');
  }
}
