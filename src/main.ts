/** App entry: WebGL capability probe, world slots, game lifecycle, HUD & panel wiring. */
import type { PlayerState, Settings, Slot, WorldRecord } from './core/types.js';
import { AudioBus } from './audio/audio.js';
import { Game, type Screen } from './game/game.js';
import type { MilestoneView } from './game/achievements.js';
import { CraftingGrid } from './game/crafting.js';
import { Renderer } from './render/renderer.js';
import { downloadWorldFile, fileToWorld, makeEmptySave } from './save/codec.js';
import * as idb from './save/idb.js';
import { Hud, type HudSlotView } from './ui/hud.js';
import { InventoryUI, type InventoryBindings } from './ui/inventory.js';
import { loadSettings, Menus, saveSettings, type MenuCallbacks } from './ui/menus.js';
import { BlockId } from './world/blocks.js';

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
    webcraft?: { readonly game: Game | null; readonly BlockId: typeof BlockId; readonly version: string };
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
  // Debug/inspection surface used by the smoke tests and the probes in scripts/.
  window.webcraft = { get game(): Game | null { return game; }, BlockId, version: '1.0.0' };
  hud = new Hud();
  menus = new Menus(menuCallbacks(), settings);
  const probe = Renderer.probe();
  const features = [
    { name: 'WebGL 2 (recommended) — fancy lighting & bigger worlds', ok: probe.webgl2 },
    { name: 'WebGL 1 (minimum) — required', ok: probe.webgl1 },
    { name: '32-bit index buffer (large worlds)', ok: probe.webgl2 || probe.uintIndex },
    { name: 'IndexedDB (world save slots)', ok: idb.idbSupported() },
    { name: 'Web Audio (synthesised sound)', ok: typeof AudioContext !== 'undefined' || typeof webkitAudioCtx() !== 'undefined' },
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
    // The Renderer measures the canvas' own CSS box; the observer inside it already handles this,
    // but the menu canvas (before a world exists) still needs the manual sizing below.
    game?.renderer.resize();
  });
  window.addEventListener('keydown', onGlobalKey);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void flushSave();
  });
  window.addEventListener('pagehide', () => void flushSave());
  const unlock = (): void => void audio.ensure();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  menus.show('main');
  // Only a genuinely coarse pointer (phone/tablet) may switch touch UI on by itself.
  // `maxTouchPoints > 0` is also true for touch-screen laptops, and enabling touch controls there
  // used to activate a second look input under the mouse — see Input.addLook() and the drag handler
  // in Menus.wireTouch().
  if (settings.showTouchControls || coarsePointer()) menus.setTouchVisible(true);
}

function webkitAudioCtx(): unknown {
  return (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
}

/** True on phones/tablets: a touch-primary device, not merely a device that can also be touched. */
function coarsePointer(): boolean {
  if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return true;
  return (navigator.maxTouchPoints ?? 0) > 0 && !window.matchMedia;
}

function applyViewport(): void {
  // Only for the pre-game canvas: once a Renderer exists it owns the drawing buffer, because the
  // aspect must come from the live CSS box or the whole frame gets stretched (see Renderer.resize).
  if (window.webcraft?.game) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
}

function onGlobalKey(e: KeyboardEvent): void {
  if (e.code === 'Tab') {
    // UI-6: the goal card fades out on its own; Tab pins it open, Tab again lets it fade.
    if (!game || !playing || game.screen !== 'none') return;
    e.preventDefault();
    const pinned = hud.toggleMilestonePinned();
    notify(pinned ? 'Goal card pinned' : 'Goal card will fade out');
    return;
  }
  if (e.code === 'F3') {
    e.preventDefault();
    settings.debugOverlay = !settings.debugOverlay;
    applySettings(settings);
    notify(`Debug overlay ${settings.debugOverlay ? 'on' : 'off'}`);
    return;
  }
  if (e.code !== 'Escape' || !game) return;
  if (menus.milestoneShowing()) {
    // Esc closes the milestone panel and stays in the pause menu (and never leaks to the game)
    e.preventDefault();
    e.stopImmediatePropagation();
    menus.show('pause');
    return;
  }
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
    game.renderer.resize();
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
      onMilestone: (_view: MilestoneView) => {
        hud.focusMilestones(); // an achieved goal is worth looking at (UI-6)
        hud.markDirty();
        if (menus.milestoneShowing()) menus.renderMilestones(game?.milestoneViews() ?? []);
      },
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
  menus.setTouchVisible(settings.showTouchControls || coarsePointer());
  menus.show('none');
  // Mouse look needs no browser permission: the cursor simply disappears over the world and the
  // first click captures it. Nothing to hint about, nothing for the browser to warn about.
  g.input.setActive(true);
  startHudLoop();
}

/** WG-6: generate the spawn area before the player gets control (no falling through the world). */
function streamSpawn(g: Game): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (): void => {
      // Pump the streaming ourselves: nothing else runs the world loop yet, so without this the
      // bar never moved and the world appeared in one piece when the safety timeout fired.
      const p = g.pumpReady(9);
      const pct = Math.round(p * 100);
      const stage = p < 0.58 ? 'Generating terrain…' : p < 1 ? 'Lighting and meshing…' : 'Ready';
      menus.setLoading(0.05 + p * 0.95, p < 1 ? `${stage} ${pct}%` : stage);
      if (p >= 1 || performance.now() - t0 > 25000) {
        menus.setLoading(1, 'Ready');
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
    // UI-6: "craft X" milestones
    onCraft: (itemId, times) => g.noteCraft(itemId, times),
    craftSound: () => g.audio.craft(),
    notify: (text, kind) => notify(text, kind ?? 'info'),
  };
}

function onScreen(s: Screen): void {
  if (!game) return;
  // UI-6: one rule for the goal card, from the one place that knows what is on screen. Any panel
  // counts as "the goal is what you are acting on", and returning to play re-shows it for a while —
  // so closing the crafting table puts the next goal back up, and it never stays up forever.
  hud.setMilestoneContext(s !== 'none');
  switch (s) {
    case 'none':
      invUI?.stash();
      pendingChest = null;
      menus.show('none');
      // `playing` was left false by the pause/death screen, which used to mean "resume from
      // pause and the HUD never comes back" — ownership of the flag belongs here.
      playing = true;
      hud.setVisible(true);
      game.input.capture();
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
  hud.resetMilestones(); // a fresh world starts with an unpinned goal card
  hudTimer = window.setInterval(() => {
    if (!game || !playing) return;
    const m = game.hudModel();
    const hotbar: (HudSlotView | null)[] = [];
    for (let i = 0; i < 9; i++) {
      const s = game.inventory.main[i];
      hotbar.push(s ? { id: s.id, count: s.count, durabilityLeft: s.durabilityLeft } : null);
    }
    hud.setMilestone(m.milestone);
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
