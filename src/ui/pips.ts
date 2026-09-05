/** HUD icon pips (hearts / hunger / breath) drawn as original pixel art at runtime. */

type Cell = [number, number, number, number]; // x, y, w, h

const HEART: Cell[] = [
  [2, 3, 4, 2],
  [8, 3, 4, 2],
  [1, 5, 12, 3],
  [2, 8, 10, 2],
  [4, 10, 6, 2],
  [6, 12, 2, 1],
];

const FOOD: Cell[] = [
  [3, 2, 6, 3],
  [2, 4, 8, 4],
  [4, 8, 4, 2],
  [6, 9, 2, 4],
  [5, 12, 4, 2],
];

const AIR: Cell[] = [
  [5, 2, 5, 2],
  [3, 4, 8, 2],
  [2, 6, 10, 5],
  [3, 11, 8, 2],
  [5, 13, 4, 1],
];

export type PipKind = 'heart' | 'food' | 'air';

const KINDS: Record<PipKind, { cells: Cell[]; main: string; shade: string; hi: string }> = {
  heart: { cells: HEART, main: '#e0443e', shade: '#8f1f1c', hi: '#ff8e86' },
  food: { cells: FOOD, main: '#c9843c', shade: '#7d4d20', hi: '#f0bd7a' },
  air: { cells: AIR, main: '#8fd0ff', shade: '#3d7fae', hi: '#e2f5ff' },
};

function paint(kind: PipKind, mode: 'full' | 'half' | 'empty'): string {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const spec = KINDS[kind];
  const px = (x: number, y: number, w: number, h: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  if (mode === 'empty') {
    for (const [x, y, w, h] of spec.cells) px(x, y, w, h, 'rgba(14,18,26,0.78)');
    for (const [x, y, w, h] of spec.cells) {
      px(x, y, w, 1, 'rgba(255,255,255,0.13)');
      px(x, y + h - 1, w, 1, 'rgba(255,255,255,0.05)');
    }
  } else {
    const half = mode === 'half';
    for (const [x, y, w, h] of spec.cells) {
      const useW = half ? Math.max(1, Math.round(w / 2)) : w;
      if (half && x + w / 2 < 8) px(x, y, Math.min(useW, 8 - x), h, spec.main);
      else if (!half) px(x, y, w, h, spec.main);
      px(x, y + h - 1, half ? useW : w, 1, spec.shade);
      px(x, y, half ? useW : w, 1, spec.hi);
    }
    if (half) {
      px(7, 1, 2, 14, 'rgba(6,10,16,0.55)');
      for (const [x, y, w, h] of spec.cells) if (x + w > 8) px(Math.max(x, 8), y, x + w - Math.max(x, 8), h, 'rgba(16,20,28,0.7)');
    }
  }
  return c.toDataURL();
}

const cache = new Map<string, string>();

export function pipImage(kind: PipKind, mode: 'full' | 'half' | 'empty'): string {
  const key = `${kind}:${mode}`;
  let v = cache.get(key);
  if (!v) {
    v = paint(kind, mode);
    cache.set(key, v);
  }
  return v;
}
