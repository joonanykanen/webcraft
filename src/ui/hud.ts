/** HUD: crosshair, hotbar, hearts/hunger/breath, held item, toasts, debug overlay (UI-3, UI-5). */
import { HOTBAR_SLOTS, MAX_HEARTS } from '../core/constants.js';
import type { Settings } from '../core/types.js';
import { itemName, toolOf } from '../world/items.js';
import { durabilityFrac, paintItem } from './icons.js';
import { pipImage, type PipKind } from './pips.js';
import type { HudModel } from '../game/game.js';

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

interface HotbarSlot {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  count: HTMLElement;
}

export class Hud {
  private hud = el<HTMLElement>('hud');
  private healthRow = el<HTMLElement>('health-row');
  private hungerRow = el<HTMLElement>('hunger-row');
  private airRow = el<HTMLElement>('air-row');
  private hotbarEl = el<HTMLElement>('hotbar');
  private hand = el<HTMLElement>('hand-item');
  private handCanvas = el<HTMLCanvasElement>('hand-item').querySelector('canvas')!;
  private debugEl = el<HTMLElement>('debug');
  private toastsEl = el<HTMLElement>('toasts');
  private titleEl = el<HTMLElement>('title-card');
  private water = el<HTMLElement>('fx-water');
  private hurtFx = el<HTMLElement>('fx-hurt');
  private fade = el<HTMLElement>('fx-fade');

  private slots: HotbarSlot[] = [];
  private pips: Record<PipKind, HTMLElement[]> = { heart: [], food: [], air: [] };
  private lastHotbar: (HudSlotView | null)[] | null = null;
  private dirty = true;
  private lastHandId = -1;
  private swingTimer = 0;
  private titleTimer = 0;
  debugVisible = false;

  constructor() {
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const root = document.createElement('div');
      root.className = 'slot';
      const canvas = document.createElement('canvas');
      canvas.width = 40;
      canvas.height = 40;
      const count = document.createElement('span');
      count.className = 'count';
      const hint = document.createElement('span');
      hint.className = 'keyhint';
      hint.textContent = String(i + 1);
      root.append(canvas, count, hint);
      this.hotbarEl.append(root);
      this.slots.push({ root, canvas, count });
    }
    this.buildPips('heart', this.healthRow, MAX_HEARTS);
    this.buildPips('food', this.hungerRow, MAX_HEARTS);
    this.buildPips('air', this.airRow, 10);
  }

  private buildPips(kind: PipKind, row: HTMLElement, n: number): void {
    row.textContent = '';
    for (let i = 0; i < n; i++) {
      const p = document.createElement('div');
      p.className = 'pip';
      p.style.backgroundImage = `url(${pipImage(kind, 'empty')})`;
      row.append(p);
      this.pips[kind].push(p);
    }
  }

  setVisible(v: boolean): void {
    this.hud.classList.toggle('hidden', !v);
  }

  /** Force the hotbar to be repainted on the next frame (after an inventory mutation). */
  markDirty(): void {
    this.dirty = true;
  }

  setDebugVisible(v: boolean): void {
    this.debugVisible = v;
    this.debugEl.classList.toggle('hidden', !v);
  }

  setWater(v: boolean): void {
    this.water.classList.toggle('hidden', !v);
  }

  setFade(v: boolean): void {
    this.fade.classList.toggle('on', v);
  }

  swing(): void {
    this.hand.classList.add('swing');
    this.swingTimer = window.setTimeout(() => this.hand.classList.remove('swing'), 200);
  }

  hurt(): void {
    this.hurtFx.classList.remove('hidden');
    this.hurtFx.style.opacity = '0.65';
    window.setTimeout(() => {
      this.hurtFx.style.opacity = '0';
    }, 60);
    window.setTimeout(() => this.hurtFx.classList.add('hidden'), 460);
  }

  title(text: string, ms = 2600): void {
    this.titleEl.textContent = text;
    this.titleEl.classList.remove('hidden');
    window.clearTimeout(this.titleTimer);
    this.titleTimer = window.setTimeout(() => this.titleEl.classList.add('hidden'), ms);
  }

  toast(text: string, kind: 'info' | 'warn' | 'good' = 'info'): void {
    if (this.toastsEl.childElementCount > 4) this.toastsEl.firstElementChild?.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.style.borderColor = kind === 'warn' ? 'rgba(240,180,60,0.6)' : kind === 'good' ? 'rgba(120,220,140,0.55)' : 'rgba(255,255,255,0.14)';
    t.textContent = text;
    this.toastsEl.append(t);
    window.setTimeout(() => t.classList.add('fade'), 2000);
    window.setTimeout(() => t.remove(), 2500);
  }

  /** Redraw hotbar + bars + debug text. */
  render(m: HudModel, hotbar: (HudSlotView | null)[], selected: number, settings: Settings): void {
    if (hotbar !== this.lastHotbar || selected !== this.currentSelection || this.dirty) {
      this.currentSelection = selected;
      this.lastHotbar = hotbar;
      this.dirty = false;
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        const item = hotbar[i];
        const id = item?.id ?? 0;
        s.root.classList.toggle('selected', i === selected);
        s.root.classList.toggle('tool', id !== 0 && !!toolOf(id));
        if (id !== 0) {
          paintItem(s.canvas, id);
          s.canvas.style.visibility = 'visible';
          const dur = durabilityFrac(id, item?.durabilityLeft);
          if (dur !== null && dur < 1) {
            s.canvas.style.filter = `saturate(${0.4 + dur * 0.8}) brightness(${0.7 + dur * 0.4})`;
          } else {
            s.canvas.style.filter = '';
          }
        } else {
          s.canvas.style.visibility = 'hidden';
        }
        s.count.textContent = item && item.count > 1 ? String(item.count) : '';
      }
      this.lastHandId = -1;
    }
    if (m.held) {
      if (m.held.id !== this.lastHandId) {
        this.lastHandId = m.held.id;
        paintItem(this.handCanvas, m.held.id);
      }
      this.hand.style.visibility = settings.showHand ? 'visible' : 'hidden';
    } else if (this.lastHandId !== 0) {
      this.lastHandId = 0;
      const ctx = this.handCanvas.getContext('2d');
      ctx?.clearRect(0, 0, this.handCanvas.width, this.handCanvas.height);
    }

    this.updatePips('heart', this.pips.heart, m.health, m.maxHealth);
    this.updatePips('food', this.pips.food, m.food, m.maxFood);
    this.airRow.classList.toggle('hidden', m.air >= m.maxAir - 0.01);
    if (m.air < m.maxAir) this.updatePips('air', this.pips.air, m.air, m.maxAir);
    this.setWater(m.inWater && m.sky > 0 ? true : m.inWater);

    if (this.debugVisible) this.debugEl.innerHTML = this.debugText(m);
  }

  private currentSelection = -1;

  private updatePips(kind: PipKind, nodes: HTMLElement[], value: number, max: number): void {
    const perIcon = max / nodes.length; // 2 half-units per icon
    for (let i = 0; i < nodes.length; i++) {
      const remaining = value - i * perIcon;
      const mode = remaining >= perIcon - 0.001 ? 'full' : remaining > 0.001 ? 'half' : 'empty';
      const img = pipImage(kind, mode);
      const url = `url(${img})`;
      if (nodes[i].dataset.img !== img) {
        nodes[i].dataset.img = img;
        nodes[i].style.backgroundImage = url;
      }
    }
  }

  private debugText(m: HudModel): string {
    const p = m.pos;
    const clock = clockTime(m.timeOfDay);
    const hold = m.held ? `${itemName(m.held.id)}${m.held.durabilityLeft !== undefined ? ` ${m.held.durabilityLeft}` : ''}` : 'empty hand';
    const fps = m.fps >= 55 ? '' : m.fps >= 30 ? ' warn' : ' warn';
    const lines: [string, string, string?][] = [
      ['FPS', m.fps.toFixed(0) + ` (${m.frameMs.toFixed(1)}ms)`, fps],
      ['sim', `${m.tickMs.toFixed(2)}ms · mesh ${m.meshMs.toFixed(1)}ms`, m.meshMs > 8 ? ' warn' : undefined],
      ['xyz', `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`],
      ['chunk', `${m.chunk[0]}, ${m.chunk[1]} · biome ${m.biome}`],
      ['chunks', `${m.chunks} loaded · rd ${m.renderDistance} · q ${m.genQueue} · dirty ${m.dirty}`],
      ['draws', `${m.drawCalls} · ${(m.triangles / 1000).toFixed(0)}k tris`],
      ['light', `${m.light.toFixed(1)} (sky ${m.sky} · block ${m.blockLight})`],
      ['time', `${clock} · ${m.timeOfDay.toFixed(3)}`],
      ['mobs', `${m.mobs} (${m.hostiles} hostile) · ent ${m.entities}`],
      ['held', hold],
      ['target', m.targetBlock ? `${itemName(m.targetBlock)} @ ${m.reach?.toFixed(2)}m` : 'none'],
      ['state', `${m.mode} · ${m.quality} · webgl${m.webgl2 ? '2' : '1'}${m.flying ? ' · fly' : ''}${m.sneaking ? ' · sneak' : ''}${m.onGround ? '' : ' · air'}`],
      ['mined', `${m.stats.blocksMined} · placed ${m.stats.blocksPlaced} · deaths ${m.deaths}`],
      ['seed', String(m.seed)],
    ];
    return lines
      .map(([k, v, cls]) => `<div><span class="dim">${k}</span> ${escapeHtml(v)}${cls ? `<span class="${cls.trim()}"></span>` : ''}</div>`)
      .join('');
  }

  dispose(): void {
    window.clearTimeout(this.swingTimer);
    window.clearTimeout(this.titleTimer);
  }
}

/** Hotbar entry as the HUD needs it (id + stack size + tool wear). */
export interface HudSlotView {
  id: number;
  count: number;
  durabilityLeft?: number;
}

export function clockTime(t: number): string {
  const hours = (6 + t * 24) % 24;
  const h = Math.floor(hours);
  const mm = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

