/** App entry: WebGL capability probe, world slots, game lifecycle, HUD & panel wiring. */
import type { PlayerState, Settings, Slot, WorldRecord } from './core/types.js';
import { AudioBus } from './audio/audio.js';
import { Game, type Screen, type TutorialEvent } from './game/game.js';
import { CraftingGrid } from './game/crafting.js';
import { Renderer } from './render/renderer.js';
import { downloadWorldFile, fileToWorld, makeEmptySave } from './save/codec.js';
import * as idb from './save/idb.js';
import { Hud, type HudSlotView } from './ui/hud.js';
import { InventoryUI, type InventoryBindings } from './ui/inventory.js';
import { loadSettings, Menus, saveSettings, type MenuCallbacks } from './ui/menus.js';

const canvas = must<HTMLCanvasElement>('viewport');
const settings: Settings = loadSettings();
const audio = new AudioBus();

let menus: Menus;
let hud: Hud;
let game: Game | null = null;
let grid: CraftingGrid | null = null;
let invUI: InventoryUI | null = null;
let pendingChest: { slots: Slot[]; label: string } | null = null;
let hudTimer = 0;
let lastCause = 'the unknown';
let playing = false;

/** Live handle for the console (`webcraft.game.world.getBlock(...)`) and the browser smoke test. */
declare global {
  interface Window {
    webcraft?: { readonly game: Game | null; readonly version: string };
  }
}

function must<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

function notify(text: string, kind: 'info' | 'warn' | 'good' = 'info'): void {
  hud?.toast(text, kind);
}

// ------------------------------------------------------------ boot (MM-5 capability probe)
function boot(): void {
  window.webcraft = { get game(): Game | null { return game; }, version: '1.0.0' };
  hud = new Hud();
  menus = new Menus(menuCallbacks(), settings);
  const probe = Renderer.probe();
  const features = [
    { name: 'WebGL 2 (recommended) — fancy lighting & bigger worlds', ok: probe.webgl2 },
    { name: 'WebGL 1 (minimum) — required', ok: probe.webgl1 },
    { name: '32-bit index buffer (large worlds)', ok: probe.webgl2 || probe.uintIndex },
    { name: 'IndexedDB (world save slots)', ok: idb.idbSupported() },
    { name: 'Web Audio (synthesised sound)', ok: typeof AudioContext !== 'undefined' || typeof webkitAudioCtx() !== 'undefined' },
    { name: 'Pointer lock (mouse capture)', ok: 'requestPointerLock' in Element.prototype },
  ];
  if (!probe.webgl1) {
    menus.showUnsupported(features);
    return;
  }
  if (!probe.webgl2) notify('WebGL2 unavailable — running in WebGL1 compatibility mode', 'warn');
  if (!idb.idbSupported()) notify('IndexedDB blocked — use Export to keep your worlds', 'warn');

  applyViewport();
  window.addEventListener('resize', () => {
    applyViewport();
    game?.renderer.resize(window.innerWidth, window.innerHeight);
  });
  window.addEventListener('keydown', onGlobalKey);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void flushSave();
  });
  window.addEventListener('pagehide', () => void flushSave());
  const unlock = (): void => {
    void audio.ensure();
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  menus.show('main');
  if (settings.showTouchControls || (navigator.maxTouchPoints ?? 0) > 0) menus.setTouchVisible(true);
}

function webkitAudioCtx(): unknown {
  return (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
}

function applyViewport(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
}

function onGlobalKey(e: KeyboardEvent): void {
  if (e.code === 'F3') {
    e.preventDefault();
    settings.debugOverlay = !settings.debugOverlay;
    applySettings(settings);
    notify(`Debug overlay ${settings.debugOverlay ? 'on' : 'off'}`);
    return;
  }
  if (e.code !== 'Escape' || !game) return;
  if (menus.screen === 'settings' || menus.screen === 'help' || menus.screen === 'about') {
    e.preventDefault();
    menus.show(game.screen === 'none' ? 'pause' : (game.screen as never));
  } else if (game.screen === 'inventory' || game.screen === 'chest') {
    e.preventDefault();
    closePanel();
  }
}

function applySettings(next: Settings): void {
  Object.assign(settings, next);
  saveSettings(settings);
  hud.setDebugVisible(settings.debugOverlay);
  if (game) {
    game.setSettings(settings);
    game.renderer.resize(window.innerWidth, window.innerHeight);
    if (!menus.isOpen()) menus.setTouchVisible(settings.showTouchControls);
  }
}

// ------------------------------------------------------------ callbacks
function menuCallbacks(): MenuCallbacks {
  return {
    refreshWorlds: async () => {
      try {
        return await idb.listWorlds();
      } catch (err) {
        notify(`Could not read save slots: ${(err as Error).message}`, 'warn');
        return [];
      }
    },
    createWorld: (name, seed, mode) => {
      const record: WorldRecord = {
        id: newId(),
        name,
        seed,
        seedLabel: String(seed),
        mode,
        difficulty: 'normal',
        deaths: 0,
        version: 1,
        createdAt: Date.now(),
        lastPlayed: Date.now(),
        playtimeMs: 0,
        thumbnail: '',
        data: makeEmptySave(freshPlayerState()),
        checksum: '',
      };
      void play(record, true);
    },
    playWorld: (rec) => void play(rec, false),
    deleteWorld: async (id) => {
      await idb.deleteWorld(id);
      notify('World deleted');
    },
    exportWorld: async (id) => {
      const rec = await idb.exportWorld(id);
      if (!rec) {
        notify('Nothing to export', 'warn');
        return;
      }
      downloadWorldFile(rec);
      notify('Exported world file', 'good');
    },
    importWorld: async (file) => {
      try {
        const { record, warnings } = fileToWorld(await file.text());
        record.id = newId();
        record.lastPlayed = Date.now();
        await idb.putWorld(record);
        notify(
          warnings.length ? `Imported with warnings: ${warnings.join('; ')}` : `Imported "${record.name}"`,
          warnings.length ? 'warn' : 'good',
        );
      } catch (err) {
        notify(`Import failed: ${(err as Error).message}`, 'warn');
      }
    },
    applySettings: (s) => applySettings(s),
    settings: () => settings,
    game: () => game,
    resume: () => game?.setScreen('none'),
    respawn: () => {
      if (!game) return;
      game.respawn();
      game.setScreen('none');
      hud.setVisible(true);
    },
    closePanel: () => closePanel(),
    quitToWorldSelect: () => void quitToMenu(),
    saveNow: () => void flushSave(true),
    notify: (text, kind) => notify(text, kind),
  };
}

function freshPlayerState(): PlayerState {
  return {
    pos: { x: 0.5, y: 96, z: 0.5 },
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    saturation: 5,
    air: 10,
    onGround: false,
    flying: false,
    spawn: { x: 0.5, y: 96, z: 0.5 },
    deaths: 0,
  };
}

function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ------------------------------------------------------------ play / quit
async function play(record: WorldRecord, fresh: boolean): Promise<void> {
  if (game) await quitToMenu(true);
  audio.ensure();
  menus.show('loading');
  menus.setLoading(0.04, `Loading "${record.name}"…`);
  const isFresh = fresh || Object.keys(record.data.chunks ?? {}).length === 0;
  const probe = Renderer.probe();

  const g = new Game({
    canvas,
    record,
    settings,
    audio,
    webgl2: probe.webgl2,
    freshWorld: isFresh,
    hooks: {
      onScreen: (s: Screen) => onScreen(s),
      onToast: (text, kind) => notify(text, kind ?? 'info'),
      onDamage: (_amount, cause) => {
        lastCause = cause;
        hud.hurt();
      },
      onDeath: () => {
        playing = false;
        hud.setVisible(false);
        menus.setDeathCause(
          `Cause: ${lastCause}. Everything you carried returns to you on respawn in ${g.mode} mode.`,
        );
        menus.show('death');
        void flushSave();
      },
      onSaved: (ok, ms) => notify(ok ? `Saved (${ms.toFixed(0)} ms)` : 'Autosave failed', ok ? 'good' : 'warn'),
      onInventoryChanged: () => {
        hud.markDirty();
        invUI?.refresh();
      },
      onTutorial: (ev: TutorialEvent) => menus.tutorialEvent(ev),
      onSettingsChanged: (next) => {
        saveSettings(next);
        hud.markDirty();
      },
      onOpenChest: (slots, label) => {
        pendingChest = { slots, label };
        invUI = new InventoryUI(bindings());
        invUI.build('chest');
        game?.setScreen('chest');
      },
    },
  });
  game = g;
  grid = new CraftingGrid(2);
  invUI = new InventoryUI(bindings());
  menus.attachGame(g);

  g.boot();
  await streamSpawn(g);

  menus.setLoading(1, 'Ready');
  g.start();
  playing = true;
  hud.setVisible(true);
  hud.setDebugVisible(settings.debugOverlay);
  menus.setTouchVisible(settings.showTouchControls || (navigator.maxTouchPoints ?? 0) > 0);
  menus.show('none');
  g.input.requestLock();
  if (isFresh) menus.showTutorialCard('intro');
  startHudLoop();
}

/** WG-6: generate the spawn area before the player gets control (no falling through the world). */
function streamSpawn(g: Game): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (): void => {
      const p = g.readyProgress();
      menus.setLoading(0.05 + p * 0.9, p < 1 ? `Generating terrain… ${Math.round(p * 100)}%` : 'Lighting the world…');
      if (p >= 1 || performance.now() - t0 > 15000) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function bindings(): InventoryBindings {
  const g = game as Game;
  return {
    inventory: g.inventory,
    grid: grid as CraftingGrid,
    hasTable: () => g.nearCraftingTable(),
    chestSlots: () => pendingChest?.slots ?? null,
    onChanged: () => {
      g.hooks.onInventoryChanged();
      g.markDirty();
    },
    craftSound: () => g.audio.craft(),
    notify: (text, kind) => notify(text, kind ?? 'info'),
  };
}

function onScreen(s: Screen): void {
  if (!game) return;
  switch (s) {
    case 'none':
      invUI?.stash();
      pendingChest = null;
      menus.show('none');
      hud.setVisible(playing);
      game.input.requestLock();
      break;
    case 'inventory':
      invUI = new InventoryUI(bindings());
      invUI.build('inventory');
      menus.show('inventory');
      hud.setVisible(false);
      break;
    case 'chest':
      menus.show('chest');
      hud.setVisible(false);
      break;
    case 'pause':
      playing = false;
      menus.show('pause');
      hud.setVisible(false);
      break;
    case 'death':
      playing = false;
      menus.setDeathCause(`Cause: ${lastCause}. Respawn returns your inventory to you.`);
      menus.show('death');
      hud.setVisible(false);
      break;
    case 'settings':
      menus.show('settings');
      break;
  }
}

function closePanel(): void {
  invUI?.stash();
  pendingChest = null;
  invUI = null;
  game?.setScreen('none');
}

function startHudLoop(): void {
  window.clearInterval(hudTimer);
  hudTimer = window.setInterval(() => {
    if (!game || !playing) return;
    const m = game.hudModel();
    const hotbar: (HudSlotView | null)[] = [];
    for (let i = 0; i < 9; i++) {
      const s = game.inventory.main[i];
      hotbar.push(s ? { id: s.id, count: s.count, durabilityLeft: s.durabilityLeft } : null);
    }
    hud.render(m, hotbar, game.inventory.selected, settings);
  }, 100);
}

async function flushSave(manual = false): Promise<void> {
  if (!game) return;
  const ok = await game.save(manual);
  if (manual) notify(ok ? 'World saved' : 'Save failed', ok ? 'good' : 'warn');
}

async function quitToMenu(silent = false): Promise<void> {
  const g = game;
  if (!g) return;
  window.clearInterval(hudTimer);
  playing = false;
  await g.save(true);
  g.stop();
  game = null;
  invUI = null;
  pendingChest = null;
  g.dispose();
  menus.detachGame();
  hud.setVisible(false);
  if (!silent) {
    menus.show('worlds');
    menus.renderWorlds(await idb.listWorlds());
  }
}

// ------------------------------------------------------------ go
try {
  boot();
} catch (err) {
  console.error(err);
  const box = document.getElementById('screen-unsupported');
  const list = document.getElementById('support-list');
  if (box && list) {
    box.classList.add('active');
    const li = document.createElement('li');
    li.className = 'bad';
    li.textContent = `Startup failed: ${(err as Error).message}`;
    list.textContent = '';
    list.append(li);
  }
}
