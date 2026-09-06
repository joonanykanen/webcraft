/** Menus, world list, settings, pause/death panels, milestone panel & touch controls (MM-1 … MM-5, UI-4, UI-6). */
import { clamp } from '../core/constants.js';
import { DEFAULT_SETTINGS, type Settings, type WorldRecord } from '../core/types.js';
import { seedFromString } from '../core/rng.js';
import type { LoadResult } from '../save/idb.js';
import type { Game } from '../game/game.js';
import { paintItem } from './icons.js';
import { clockTime } from './hud.js';

export type ScreenName =
  | 'loading'
  | 'unsupported'
  | 'main'
  | 'worlds'
  | 'settings'
  | 'help'
  | 'about'
  | 'pause'
  | 'death'
  | 'inventory'
  | 'chest'
  | 'milestones'
  | 'none';

export interface MenuCallbacks {
  refreshWorlds(): Promise<LoadResult[]>;
  createWorld(name: string, seed: number, mode: 'survival' | 'creative'): void;
  playWorld(rec: WorldRecord): void;
  deleteWorld(id: string): Promise<void>;
  exportWorld(id: string): void;
  importWorld(file: File): Promise<void>;
  applySettings(s: Settings): void;
  settings(): Settings;
  game(): Game | null;
  resume(): void;
  respawn(): void;
  closePanel(): void;
  quitToWorldSelect(): void;
  saveNow(): void;
  notify(text: string, kind?: 'info' | 'warn' | 'good'): void;
}

const SCREEN_IDS: Record<ScreenName, string | null> = {
  loading: 'screen-loading',
  unsupported: 'screen-unsupported',
  main: 'screen-main',
  worlds: 'screen-worlds',
  settings: 'screen-settings',
  help: 'screen-help',
  about: 'screen-about',
  pause: 'screen-pause',
  death: 'screen-death',
  inventory: 'panel-inventory',
  chest: 'panel-chest',
  milestones: 'screen-milestones',
  none: null,
};


function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

const SETTINGS_KEY = 'webcraft.settings';

export class Menus {
  private cbs: MenuCallbacks;
  private screens = new Map<ScreenName, HTMLElement | null>();
  private current: ScreenName = 'loading';
  private returnTo: ScreenName = 'main';
  private settings: Settings;
  private game: Game | null = null;
  private loadBar = el<HTMLElement>('load-bar');
  private loadStatus = el<HTMLElement>('load-status');
  private worldList = el<HTMLElement>('world-list');
  private modeChoice: 'survival' | 'creative' = 'survival';
  private stick = el<HTMLElement>('stick');
  private knob = el<HTMLElement>('stick-knob');

  constructor(cbs: MenuCallbacks, settings: Settings) {
    this.cbs = cbs;
    this.settings = { ...settings };
    for (const key of Object.keys(SCREEN_IDS) as ScreenName[]) {
      const id = SCREEN_IDS[key];
      this.screens.set(key, id ? document.getElementById(id) : null);
    }
    this.buildSettings();
    this.wireMenus();
    this.buildTouch();
  }

  // ------------------------------------------------------------ screen stack
  show(name: ScreenName): void {
    // overlay screens keep the screen they were opened from, so "Back" returns there
    if (name !== 'settings' && name !== 'help' && name !== 'about' && name !== 'milestones') {
      this.returnTo = name === 'none' ? 'main' : name;
    }
    this.current = name;
    for (const [key, node] of this.screens) {
      node?.classList.toggle('active', key === name);
    }
    if (name === 'worlds') void this.cbs.refreshWorlds().then((r) => this.renderWorlds(r));
    if (name === 'pause') this.updatePauseMeta();
  }

  get screen(): ScreenName {
    return this.current;
  }

  isOpen(): boolean {
    return this.current !== 'none';
  }

  attachGame(game: Game): void {
    this.game = game;
    this.settings = { ...game.settings };
    this.buildSettings();
  }

  detachGame(): void {
    this.game = null;
  }

  private updatePauseMeta(): void {
    const node = document.getElementById('pause-meta');
    if (!node) return;
    if (!this.game) {
      node.textContent = '';
      return;
    }
    const m = this.game.hudModel();
    node.textContent = `${this.game.record.name} · seed ${this.game.record.seed} · ${clockTime(m.timeOfDay)} · xyz ${m.pos.x.toFixed(0)} ${m.pos.y.toFixed(0)} ${m.pos.z.toFixed(
      0,
    )} · mined ${m.stats.blocksMined} · placed ${m.stats.blocksPlaced} · ${m.mode}`;
  }

  // ------------------------------------------------------------ wiring
  private wireMenus(): void {
    const click = (id: string, fn: () => void): void => {
      const node = document.getElementById(id);
      if (!node) return;
      node.addEventListener('click', () => fn());
    };

    for (const back of Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-back]'))) {
      back.addEventListener('click', () => this.show(this.current === 'settings' && this.game ? 'pause' : this.returnTo));
    }

    click('btn-quick-start', () => {
      this.show('worlds');
      el<HTMLInputElement>('new-name').focus();
    });
    click('btn-worlds', () => this.show('worlds'));
    click('btn-help', () => this.show('help'));
    click('btn-settings', () => this.show('settings'));
    click('btn-about', () => this.show('about'));

    // pause menu (MM-3)
    click('btn-resume', () => this.cbs.resume());
    click('btn-save', () => {
      this.cbs.saveNow();
      this.updatePauseMeta();
    });
    click('btn-pause-settings', () => this.show('settings'));
    click('btn-milestones', () => this.openMilestones());
    click('btn-close-milestones', () => this.show(this.game ? this.returnTo : 'main'));
    click('btn-quit', () => this.cbs.quitToWorldSelect());

    // death screen (MO-4)
    click('btn-respawn', () => this.cbs.respawn());
    click('btn-death-quit', () => this.cbs.quitToWorldSelect());

    // inventory / chest panels
    click('btn-inv-milestones', () => this.openMilestones());
    click('btn-close-inv', () => this.cbs.closePanel());
    click('btn-close-chest', () => this.cbs.closePanel());

    // create world (MM-2) — the form lives inside the worlds screen
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#new-mode .seg-btn'))) {
      b.addEventListener('click', () => {
        for (const o of Array.from(document.querySelectorAll('#new-mode .seg-btn'))) o.classList.remove('active');
        b.classList.add('active');
        this.modeChoice = b.dataset.mode === 'creative' ? 'creative' : 'survival';
      });
    }
    click('btn-create', () => {
      const name = el<HTMLInputElement>('new-name').value.trim() || 'New World';
      const seedText = el<HTMLInputElement>('new-seed').value.trim();
      const seed = seedText === '' ? (Date.now() % 2147483647) | 0 : /^\d+$/.test(seedText) ? Number(seedText) | 0 : seedFromString(seedText);
      el<HTMLInputElement>('new-name').value = '';
      el<HTMLInputElement>('new-seed').value = '';
      this.cbs.createWorld(name, seed, this.modeChoice);
    });

    const file = document.getElementById('import-file') as HTMLInputElement | null;
    file?.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (f) {
        await this.cbs.importWorld(f);
        this.renderWorlds(await this.cbs.refreshWorlds()); // the new slot must show up right away
      }
      file.value = '';
    });

  }

  // ------------------------------------------------------------ world list (MM-1)
  renderWorlds(results: LoadResult[]): void {
    this.worldList.textContent = '';
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'card';
      empty.style.padding = '1rem';
      empty.textContent = 'No worlds yet — create one on the right, or import a .webcraft.json file.';
      this.worldList.append(empty);
      return;
    }
    for (const res of results) {
      const rec = res.record;
      const row = document.createElement('div');
      row.className = 'world-item';
      row.setAttribute('role', 'listitem');

      const img = document.createElement('img');
      img.alt = '';
      if (rec.thumbnail) img.src = rec.thumbnail;
      else img.style.visibility = 'hidden';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = rec.name;
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = rec.mode;
      name.append(badge);
      if (res.corrupted) {
        const b = pill('recovered', 'var(--warn)');
        name.append(b);
      } else if (res.migrated) {
        name.append(pill('migrated', 'var(--muted)'));
      }
      const sub = document.createElement('div');
      sub.className = 'wsub';
      sub.textContent = `seed ${rec.seed} · ${clockTime(rec.data.timeOfDay)} · ${approxBytes(rec)} · ${new Date(
        rec.lastPlayed,
      ).toLocaleString()}`;
      meta.append(name, sub);

      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(
        btn('Play', 'primary small', () => this.cbs.playWorld(rec)),
        btn('Export', 'small', () => this.cbs.exportWorld(rec.id)),
        btn('Delete', 'small danger', () => {
          if (!confirm(`Delete "${rec.name}"? This cannot be undone.`)) return;
          void this.cbs.deleteWorld(rec.id).then(() => this.cbs.refreshWorlds()).then((r) => this.renderWorlds(r));
        }),
      );
      row.append(img, meta, actions);
      row.addEventListener('dblclick', () => this.cbs.playWorld(rec));
      this.worldList.append(row);
    }
  }

  // ------------------------------------------------------------ settings (MM-4)
  private buildSettings(): void {
    const host = el<HTMLElement>('settings-fields');
    host.textContent = '';
    const s = this.settings;

    const slider = (
      key: keyof Settings,
      label: string,
      min: number,
      max: number,
      step: number,
      fmt: (v: number) => string,
      hint: string,
    ): void => {
      const row = document.createElement('div');
      row.className = 'setting';
      const l = document.createElement('label');
      l.textContent = label;
      const wrap = document.createElement('div');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(s[key] as number);
      const out = document.createElement('output');
      out.textContent = fmt(Number(s[key] as number));
      input.addEventListener('input', () => {
        const v = Number(input.value);
        out.textContent = fmt(v);
        this.patch({ [key]: v } as Partial<Settings>);
      });
      wrap.append(input, out);
      const h = document.createElement('div');
      h.className = 'hint';
      h.textContent = hint;
      row.append(l, wrap, h);
      host.append(row);
    };

    const toggle = (key: keyof Settings, label: string, hint: string): void => {
      const row = document.createElement('div');
      row.className = 'setting';
      const l = document.createElement('label');
      l.textContent = label;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(s[key]);
      input.style.cssText = 'width:auto;accent-color:var(--accent);justify-self:start';
      input.addEventListener('change', () => this.patch({ [key]: input.checked } as Partial<Settings>));
      const h = document.createElement('div');
      h.className = 'hint';
      h.textContent = hint;
      row.append(l, input, h);
      host.append(row);
    };

    slider('renderDistance', 'Render distance', 4, 16, 1, (v) => `${v} chunks`, 'How much world is visible. Biggest GPU cost.');
    slider('fov', 'Field of view', 60, 100, 1, (v) => `${v}°`, 'Wider feels faster, narrower is calmer.');
    slider('sensitivity', 'Mouse sensitivity', 0.2, 3, 0.05, (v) => v.toFixed(2), 'Look speed.');
    slider('volume', 'Sound effects', 0, 1, 0.05, pct, 'Mining, footsteps, crafting, explosions.');
    slider('ambientVolume', 'Ambience', 0, 1, 0.05, pct, 'Wind, cave drone, rain — all synthesised.');
    slider('maxChunksPerFrame', 'Mesh budget', 1, 4, 1, (v) => `${v}/frame`, 'Higher = chunks appear sooner, frames less smooth.');

    const q = document.createElement('div');
    q.className = 'setting';
    const ql = document.createElement('label');
    ql.textContent = 'Quality';
    const qsel = document.createElement('select');
    for (const [v, t] of [
      ['fancy', 'Fancy (ambient occlusion + water waves)'],
      ['fast', 'Fast (flat shading)'],
    ] as const) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      qsel.append(o);
    }
    qsel.value = s.quality;
    qsel.addEventListener('change', () => this.patch({ quality: qsel.value as Settings['quality'] }));
    const qh = document.createElement('div');
    qh.className = 'hint';
    qh.textContent = 'Fast drops per-vertex AO and wave animation — roughly half the triangles.';
    q.append(ql, qsel, qh);
    host.append(q);

    toggle('invertY', 'Invert vertical look', 'Mouse up looks up.');

    toggle(
      'lockMouse',
      'Lock mouse while playing',
      'On (default): the browser grabs the cursor, so look never runs out — second monitor, ' +
        'holding the mouse button, dragging off the edge. Chrome shows a short "mouse pointer is ' +
        'hidden" notice for it, which can cost one Escape press. Off: nothing is grabbed, so the ' +
        'cursor stays free to leave the window.',
    );
    toggle('showHand', 'Show held item', 'HUD preview of the selected stack.');
    toggle('fallDamage', 'Fall damage', 'Off = long drops are harmless.');
    toggle('colorblindEdges', 'Block edge outlines', 'Accessibility: stronger face separation.');
    toggle('debugOverlay', 'Debug overlay (F3)', 'FPS, position, chunk & lighting stats, draw calls.');
    toggle('showTouchControls', 'Touch controls', 'On-screen stick and buttons (UI-4).');

    const row = document.createElement('div');
    row.className = 'setting';
    const rl = document.createElement('label');
    rl.textContent = 'Reset';
    const rb = btn('Restore defaults', 'small', () => {
      this.settings = { ...DEFAULT_SETTINGS };
      this.push();
      this.buildSettings();
      this.cbs.notify('Settings reset');
    });
    const rh = document.createElement('div');
    rh.className = 'hint';
    rh.textContent = 'Back up worlds with Export before deleting them.';
    row.append(rl, rb, rh);
    host.append(row);
  }

  private patch(p: Partial<Settings>): void {
    this.settings = { ...this.settings, ...p };
    this.push();
  }

  private push(): void {
    saveSettings(this.settings);
    this.cbs.applySettings({ ...this.settings });
  }

  currentSettings(): Settings {
    return { ...this.settings };
  }

  // ------------------------------------------------------------ loading / support
  setLoading(progress: number, status: string): void {
    this.loadBar.style.width = `${Math.round(clamp(progress, 0, 1) * 100)}%`;
    this.loadStatus.textContent = status;
  }

  /** MM-5: list required features, marking the missing ones. */
  showUnsupported(features: { name: string; ok: boolean }[]): void {
    const host = el<HTMLElement>('support-list');
    host.textContent = '';
    for (const f of features) {
      const li = document.createElement('li');
      li.textContent = `${f.ok ? '✔' : '✘'} ${f.name}`;
      if (!f.ok) li.className = 'bad';
      host.append(li);
    }
    this.show('unsupported');
  }

  setDeathCause(text: string): void {
    const node = document.getElementById('death-cause');
    if (node) node.textContent = text;
  }

  // ------------------------------------------------------------ milestones (UI-6)
  /** Open the progression panel (from the pause menu or the inventory). */
  openMilestones(): void {
    this.renderMilestones();
    this.show('milestones');
  }

  /** Redraw the milestone cards: unlocked, available (outlined) and locked (greyed, title hidden). */
  renderMilestones(views = this.game?.milestoneViews() ?? []): void {
    const host = document.getElementById('milestones-grid');
    if (!host) return;
    host.textContent = '';
    const done = views.filter((v) => v.unlocked).length;
    const counter = document.getElementById('milestones-count');
    if (counter) counter.textContent = `${done} / ${views.length} unlocked`;

    for (const v of views) {
      const card = document.createElement('div');
      card.className = `ms-card${v.unlocked ? ' unlocked' : v.available ? ' available' : ' locked'}`;
      card.dataset.ms = v.def.id;

      const icon = document.createElement('canvas');
      icon.width = 40;
      icon.height = 40;
      icon.className = 'ms-icon';
      paintItem(icon, v.def.icon);
      if (!v.unlocked) icon.style.filter = 'grayscale(1) brightness(0.6)';
      card.appendChild(icon);

      const body = document.createElement('div');
      body.className = 'ms-text';
      const title = document.createElement('div');
      title.className = 'ms-title';
      title.textContent = v.available || v.unlocked ? v.def.title : '???';
      const blurb = document.createElement('div');
      blurb.className = 'ms-body';
      blurb.textContent =
        v.available || v.unlocked
          ? v.def.body
          : `Requires: ${v.def.requires.map((r) => this.titleOf(r)).join(', ')}`;
      const goal = document.createElement('div');
      goal.className = 'ms-goal';
      goal.textContent = v.unlocked ? 'Unlocked' : `${v.def.goal} — ${Math.min(v.goal.have, v.goal.need)}/${v.goal.need}`;
      body.append(title, blurb, goal);
      card.appendChild(body);
      host.appendChild(card);
    }
  }

  private titleOf(id: string): string {
    return this.game?.milestoneViews().find((v) => v.def.id === id)?.def.title ?? id;
  }

  milestoneShowing(): boolean {
    return this.current === 'milestones';
  }

  // ------------------------------------------------------------ touch controls (UI-4)
  private buildTouch(): void {
    const hold = (node: Element, on: (v: boolean) => void): void => {
      const down = (e: Event): void => {
        e.preventDefault();
        on(true);
      };
      const up = (e: Event): void => {
        e.preventDefault();
        on(false);
      };
      node.addEventListener('pointerdown', down);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
      node.addEventListener('pointerleave', up);
    };
    for (const b of Array.from(document.querySelectorAll<HTMLElement>('#touch-buttons [data-touch]'))) {
      const kind = b.dataset.touch ?? '';
      hold(b, (v) => {
        const t = this.game?.input.touch;
        if (!t) return;
        if (kind === 'mine') t.mine = v;
        else if (kind === 'place') t.place = v;
        else if (kind === 'jump') t.jump = v;
        else if (kind === 'sneak') t.sneak = v;
        else if (kind === 'up') t.up = v;
        else if (kind === 'down') t.down = v;
      });
    }

    // virtual stick → touch.x/y (see Input.readMove)
    let active = false;
    const setKnob = (dx: number, dy: number): void => {
      this.knob.style.transform = `translate(${dx * 26}px, ${dy * 26}px)`;
    };
    const move = (e: PointerEvent): void => {
      const r = this.stick.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let dx = (e.clientX - cx) / (r.width / 2);
      let dy = (e.clientY - cy) / (r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      setKnob(dx, dy);
      const t = this.game?.input.touch;
      if (!t) return;
      t.x = Math.abs(dx) > 0.2 ? dx : 0;
      t.y = Math.abs(dy) > 0.2 ? dy : 0;
    };
    this.stick.addEventListener('pointerdown', (e) => {
      active = true;
      this.stick.setPointerCapture(e.pointerId);
      move(e);
    });
    this.stick.addEventListener('pointermove', (e) => {
      if (active) move(e);
    });
    const end = (): void => {
      active = false;
      setKnob(0, 0);
      const t = this.game?.input.touch;
      if (t) {
        t.x = 0;
        t.y = 0;
      }
    };
    this.stick.addEventListener('pointerup', end);
    this.stick.addEventListener('pointercancel', end);

    // drag anywhere on the viewport to look around
    const view = el<HTMLCanvasElement>('viewport');
    let look: { x: number; y: number } | null = null;
    view.addEventListener('pointerdown', (e) => {
      if (!this.game?.input.touch.enabled) return;
      look = { x: e.clientX, y: e.clientY };
    });
    view.addEventListener('pointermove', (e) => {
      const g = this.game;
      if (!g || !g.input.touch.enabled || !look) return;
      g.input.addLook((e.clientX - look.x) * 5, (e.clientY - look.y) * 5);
      look = { x: e.clientX, y: e.clientY };
    });
    view.addEventListener('pointerup', () => {
      look = null;
    });
  }

  setTouchVisible(v: boolean): void {
    el<HTMLElement>('touch-ui').classList.toggle('hidden', !v);
    if (this.game) this.game.input.touch.enabled = v;
  }
}

// ------------------------------------------------------------ helpers
function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function btn(label: string, cls: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `btn ${cls}`.trim();
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

function pill(text: string, color: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'badge';
  s.style.cssText = `margin-left:6px;color:${color};border-color:${color}`;
  s.textContent = text;
  return s;
}

function approxBytes(rec: WorldRecord): string {
  const n = Object.values(rec.data.chunks).reduce((a: number, c: string) => a + c.length, 0);
  return n > 0 ? `${(n / 1024).toFixed(1)} KB edited` : 'unedited';
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — settings just won't persist */
  }
}
