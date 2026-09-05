/** Item & block icons, drawn procedurally from the generated atlas (no image assets). */
import { ATLAS_TILES, TILE_PX } from '../core/constants.js';
import { block } from '../world/blocks.js';
import { iconOf, toolOf } from '../world/items.js';
import { buildAtlasCanvas } from '../render/atlas.js';

let atlas: HTMLCanvasElement | null = null;
function atlasCanvas(): HTMLCanvasElement {
  if (!atlas) atlas = buildAtlasCanvas();
  return atlas;
}

function tileRect(ctx: CanvasRenderingContext2D, tile: number, dx: number, dy: number, dw: number, dh: number): void {
  const col = (tile % ATLAS_TILES) * TILE_PX;
  const row = Math.floor(tile / ATLAS_TILES) * TILE_PX;
  ctx.drawImage(atlasCanvas(), col, row, TILE_PX, TILE_PX, dx, dy, dw, dh);
}

const TIER_COLOR = ['#b58a52', '#a9b0b8', '#e2e6ea', '#5fe3d4'];

/** Draw an item icon into a 2D context at (0,0,size,size). */
export function drawItemIcon(ctx: CanvasRenderingContext2D, id: number, size: number): void {
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = false;
  const spec = iconOf(id);
  const pad = Math.round(size * 0.08);
  const box = size - pad * 2;

  if (spec.kind === 'block' && spec.blockId !== undefined) {
    const d = block(spec.blockId);
    const faces = d ? d.faces : [3, 3, 3];
    if (d && d.cross) {
      tileRect(ctx, faces[2], pad, pad, box, box);
    } else {
      // fake isometric: side face + top strip + bottom shading
      const topH = Math.round(box * 0.34);
      tileRect(ctx, faces[2], pad, pad + topH, box, box - topH);
      tileRect(ctx, faces[0], pad, pad, box, topH);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(pad, pad, box, topH);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(pad, size - pad - Math.round(box * 0.12), box, Math.round(box * 0.12));
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(pad + 0.5, pad + 0.5, box - 1, box - 1);
    }
    ctx.restore();
    return;
  }

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  switch (spec.kind) {
    case 'stick': {
      ctx.strokeStyle = '#a3763f';
      ctx.lineWidth = Math.max(2, size * 0.11);
      ctx.beginPath();
      ctx.moveTo(size * 0.3, size * 0.75);
      ctx.lineTo(size * 0.72, size * 0.28);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(size * 0.36, size * 0.62);
      ctx.lineTo(size * 0.52, size * 0.46);
      ctx.stroke();
      break;
    }
    case 'apple': {
      ctx.fillStyle = '#c8443a';
      ctx.beginPath();
      ctx.arc(size * 0.46, size * 0.58, size * 0.27, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(size * 0.62, size * 0.54, size * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#6b4423';
      ctx.lineWidth = Math.max(2, size * 0.06);
      ctx.beginPath();
      ctx.moveTo(size * 0.52, size * 0.34);
      ctx.lineTo(size * 0.56, size * 0.2);
      ctx.stroke();
      ctx.fillStyle = '#5aa24a';
      ctx.beginPath();
      ctx.ellipse(size * 0.68, size * 0.24, size * 0.12, size * 0.06, -0.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'meat': {
      ctx.fillStyle = '#c9605f';
      roundRect(ctx, size * 0.24, size * 0.3, size * 0.5, size * 0.42, size * 0.16);
      ctx.fill();
      ctx.fillStyle = '#e8b1ac';
      roundRect(ctx, size * 0.32, size * 0.38, size * 0.24, size * 0.16, size * 0.07);
      ctx.fill();
      ctx.fillStyle = '#f2efe6';
      ctx.beginPath();
      ctx.arc(size * 0.24, size * 0.72, size * 0.08, 0, Math.PI * 2);
      ctx.arc(size * 0.33, size * 0.78, size * 0.08, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'coal': {
      ctx.fillStyle = '#3a3d45';
      poly(ctx, size, [
        [0.28, 0.34],
        [0.66, 0.24],
        [0.78, 0.56],
        [0.56, 0.78],
        [0.26, 0.68],
      ]);
      ctx.fillStyle = '#565b66';
      poly(ctx, size, [
        [0.36, 0.4],
        [0.6, 0.34],
        [0.66, 0.52],
        [0.46, 0.6],
      ]);
      break;
    }
    case 'ingot': {
      const c = spec.color ?? '#dfe3e8';
      ctx.fillStyle = c;
      poly(ctx, size, [
        [0.2, 0.66],
        [0.32, 0.4],
        [0.72, 0.4],
        [0.84, 0.66],
      ]);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      poly(ctx, size, [
        [0.32, 0.4],
        [0.72, 0.4],
        [0.68, 0.47],
        [0.35, 0.47],
      ]);
      break;
    }
    case 'gem': {
      ctx.fillStyle = '#4fd6c9';
      poly(ctx, size, [
        [0.5, 0.18],
        [0.78, 0.45],
        [0.5, 0.84],
        [0.22, 0.45],
      ]);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      poly(ctx, size, [
        [0.5, 0.18],
        [0.62, 0.42],
        [0.5, 0.5],
        [0.36, 0.42],
      ]);
      break;
    }
    case 'tool': {
      const tier = Math.max(1, Math.min(4, spec.tier ?? 1));
      const head = TIER_COLOR[tier - 1];
      // handle
      ctx.strokeStyle = '#a3763f';
      ctx.lineWidth = Math.max(2.5, size * 0.11);
      ctx.beginPath();
      ctx.moveTo(size * 0.28, size * 0.8);
      ctx.lineTo(size * 0.62, size * 0.42);
      ctx.stroke();
      ctx.fillStyle = head;
      const kind = spec.tool ?? 'pickaxe';
      if (kind === 'pickaxe') {
        ctx.beginPath();
        ctx.moveTo(size * 0.24, size * 0.3);
        ctx.quadraticCurveTo(size * 0.6, size * 0.12, size * 0.82, size * 0.36);
        ctx.lineTo(size * 0.7, size * 0.44);
        ctx.quadraticCurveTo(size * 0.56, size * 0.3, size * 0.34, size * 0.42);
        ctx.closePath();
        ctx.fill();
      } else if (kind === 'axe') {
        roundRectRot(ctx, size * 0.5, size * 0.18, size * 0.3, size * 0.36, 0.2);
        ctx.beginPath();
        ctx.moveTo(size * 0.5, size * 0.2);
        ctx.lineTo(size * 0.82, size * 0.3);
        ctx.lineTo(size * 0.66, size * 0.52);
        ctx.lineTo(size * 0.46, size * 0.4);
        ctx.closePath();
        ctx.fill();
      } else if (kind === 'shovel') {
        roundRectRot(ctx, size * 0.55, size * 0.2, size * 0.26, size * 0.3, 0.3);
      } else {
        ctx.beginPath();
        ctx.moveTo(size * 0.78, size * 0.2);
        ctx.lineTo(size * 0.86, size * 0.34);
        ctx.lineTo(size * 0.42, size * 0.7);
        ctx.lineTo(size * 0.32, size * 0.56);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#6c5232';
        roundRectRot(ctx, size * 0.24, size * 0.62, size * 0.2, size * 0.16, 0.6);
      }
      // tier pip
      ctx.fillStyle = head;
      ctx.fillRect(size * 0.1, size * 0.86, size * 0.06 * tier, size * 0.07);
      break;
    }
    default: {
      ctx.fillStyle = '#8a8f96';
      ctx.fillRect(pad, pad, box, box);
    }
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function roundRectRot(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rot: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  roundRect(ctx, 0, 0, w, h, Math.min(w, h) * 0.3);
  ctx.fill();
  ctx.restore();
}

function poly(ctx: CanvasRenderingContext2D, size: number, pts: [number, number][]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x * size, y * size);
    else ctx.lineTo(x * size, y * size);
  });
  ctx.closePath();
  ctx.fill();
}

/** Paint an item into a canvas element (creates the 2D context once per call). */
export function paintItem(canvas: HTMLCanvasElement, id: number): void {
  const size = canvas.width || 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (canvas.dataset.item === String(id)) return;
  canvas.dataset.item = String(id);
  drawItemIcon(ctx, id, size);
}

/** Data URL for a slot icon (used where an <img> is styled rather than a <canvas>). */
export function itemDataURL(id: number, size = 32): string {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (ctx) drawItemIcon(ctx, id, size);
  return c.toDataURL();
}

/** Small durability bar drawn under tool icons (IN-6). */
export function durabilityFrac(id: number, left: number | undefined): number | null {
  const tool = toolOf(id);
  if (!tool) return null;
  const l = left ?? tool.durability;
  return Math.max(0, Math.min(1, l / tool.durability));
}
