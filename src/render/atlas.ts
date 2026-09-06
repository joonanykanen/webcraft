/**
 * Procedural texture atlas (RD-3): a 8×8 grid of 16×16 pixel-art tiles drawn at runtime.
 * Every texture in WebCraft is generated here — no third-party image assets are shipped.
 * NearestFilter + no mipmaps keeps the pixels crisp (RD-3).
 */
import { ATLAS_PX, ATLAS_TILES, TILE_PX } from '../core/constants.js';
import { mulberry32 } from '../core/rng.js';
import { TILE } from '../world/tiles.js';

type RGB = [number, number, number];

class Tile {
  private data: Uint8ClampedArray;
  rng: () => number;
  constructor(readonly index: number, seed: number) {
    this.data = new Uint8ClampedArray(TILE_PX * TILE_PX * 4);
    this.rng = mulberry32(((index + 1) * 1664525 + seed) >>> 0);
  }
  set(x: number, y: number, c: RGB, a = 255): void {
    if (x < 0 || y < 0 || x >= TILE_PX || y >= TILE_PX) return;
    const i = (y * TILE_PX + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }
  fill(fn: (x: number, y: number) => [RGB, number]): void {
    for (let y = 0; y < TILE_PX; y++) for (let x = 0; x < TILE_PX; x++) {
      const [c, a] = fn(x, y);
      this.set(x, y, c, a);
    }
  }
  base(color: RGB, variance: number, a = 255): void {
    this.fill(() => [jitter(color, variance, this.rng), a]);
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 255): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, c, a);
  }
  blob(cx: number, cy: number, r: number, c: RGB, jitterAmt = 0, a = 255): void {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        if (x * x + y * y > r * r + r * 0.6) continue;
        this.set(cx + x, cy + y, jitterAmt ? jitter(c, jitterAmt, this.rng) : c, a);
      }
    }
  }
  build(): Uint8ClampedArray {
    return this.data;
  }
}

function jitter(c: RGB, v: number, rng: () => number): RGB {
  const d = Math.round((rng() - 0.5) * 2 * v);
  return [c[0] + d, c[1] + d, c[2] + d];
}

const C = {
  grass: [104, 166, 62] as RGB,
  grassDark: [82, 136, 48] as RGB,
  dirt: [134, 104, 68] as RGB,
  dirtDark: [108, 82, 54] as RGB,
  stone: [140, 142, 147] as RGB,
  stoneDark: [106, 108, 114] as RGB,
  log: [108, 80, 48] as RGB,
  logDark: [78, 56, 34] as RGB,
  logTop: [168, 130, 82] as RGB,
  plank: [176, 134, 84] as RGB,
  plankDark: [128, 94, 58] as RGB,
  leaf: [72, 128, 50] as RGB,
  sand: [222, 205, 152] as RGB,
  sandDark: [196, 178, 128] as RGB,
  water: [52, 108, 186] as RGB,
  bedrock: [68, 70, 76] as RGB,
  cobble: [126, 128, 133] as RGB,
  glass: [206, 238, 248] as RGB,
  brick: [160, 86, 66] as RGB,
  mortar: [186, 176, 160] as RGB,
  snow: [246, 250, 255] as RGB,
  torch: [114, 86, 52] as RGB,
  flame: [255, 206, 96] as RGB,
  flameHot: [255, 246, 196] as RGB,
  gravel: [124, 120, 116] as RGB,
  coal: [42, 44, 50] as RGB,
  iron: [206, 168, 130] as RGB,
  gold: [240, 196, 60] as RGB,
  gem: [82, 214, 200] as RGB,
  tnt: [174, 74, 56] as RGB,
  tntDark: [58, 52, 50] as RGB,
  cactus: [66, 126, 66] as RGB,
  metal: [96, 100, 108] as RGB,
  white: [238, 242, 246] as RGB,
  black: [26, 26, 30] as RGB,
};

function drawTile(t: Tile): void {
  const r = t.rng;
  switch (t.index) {
    case TILE.GRASS_TOP: {
      t.base(C.grass, 16);
      for (let i = 0; i < 26; i++) t.set((r() * 16) | 0, (r() * 16) | 0, jitter(C.grassDark, 10, r));
      for (let i = 0; i < 10; i++) t.set((r() * 16) | 0, (r() * 16) | 0, [138, 194, 82]);
      break;
    }
    case TILE.GRASS_SIDE: {
      t.base(C.dirt, 14);
      for (let i = 0; i < 14; i++) t.set((r() * 16) | 0, 5 + ((r() * 11) | 0), jitter(C.dirtDark, 8, r));
      for (let x = 0; x < 16; x++) {
        const h = 3 + (r() < 0.45 ? 1 : 0) + (r() < 0.18 ? 1 : 0);
        for (let y = 0; y < h; y++) t.set(x, y, jitter(y === h - 1 ? C.grassDark : C.grass, 12, r));
      }
      break;
    }
    case TILE.DIRT: {
      t.base(C.dirt, 14);
      for (let i = 0; i < 18; i++) t.set((r() * 16) | 0, (r() * 16) | 0, jitter(C.dirtDark, 8, r));
      break;
    }
    case TILE.STONE: {
      t.base(C.stone, 9);
      for (let i = 0; i < 4; i++) {
        let x = (r() * 16) | 0;
        let y = (r() * 16) | 0;
        for (let k = 0; k < 5; k++) {
          t.set(x, y, C.stoneDark);
          x += r() < 0.5 ? 1 : 0;
          y += r() < 0.6 ? 1 : 0;
        }
      }
      for (let i = 0; i < 12; i++) t.set((r() * 16) | 0, (r() * 16) | 0, [158, 160, 164]);
      break;
    }
    case TILE.LOG_SIDE: {
      t.base(C.log, 8);
      for (let x = 0; x < 16; x++) {
        if (x % 4 === 0 || x % 7 === 3) for (let y = 0; y < 16; y++) t.set(x, y, jitter(C.logDark, 6, r));
      }
      t.blob(4 + ((r() * 6) | 0), 4 + ((r() * 8) | 0), 2, C.logDark, 6);
      break;
    }
    case TILE.LOG_TOP: {
      t.base(C.logTop, 6);
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
          if (d > 6.6) t.set(x, y, jitter(C.logDark, 6, r));
          else if ((d * 2) % 2 < 1) t.set(x, y, jitter(C.plankDark, 6, r));
        }
      break;
    }
    case TILE.PLANKS: {
      t.base(C.plank, 8);
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          if (y % 4 === 3) t.set(x, y, C.plankDark);
          const seam = ((y / 4) | 0) % 2 === 0 ? 5 : 11;
          if (x === seam && y % 4 !== 3) t.set(x, y, C.plankDark);
        }
      for (let i = 0; i < 10; i++) t.set((r() * 16) | 0, (r() * 16) | 0, jitter(C.plankDark, 4, r), 200);
      break;
    }
    case TILE.LEAVES: {
      t.fill(() => {
        const n = r();
        if (n < 0.2) return [C.leaf, 0];
        if (n < 0.4) return [jitter([48, 96, 36], 12, r), 255];
        if (n > 0.92) return [jitter([118, 176, 68], 10, r), 255];
        return [jitter(C.leaf, 18, r), 255];
      });
      break;
    }
    case TILE.COAL_ORE:
    case TILE.IRON_ORE:
    case TILE.GOLD_ORE:
    case TILE.GEM_ORE: {
      t.base(C.stone, 9);
      const ore =
        t.index === TILE.COAL_ORE ? C.coal : t.index === TILE.IRON_ORE ? C.iron : t.index === TILE.GOLD_ORE ? C.gold : C.gem;
      const blobs = 3 + ((r() * 2) | 0);
      for (let i = 0; i < blobs; i++) {
        const cx = 2 + ((r() * 12) | 0);
        const cy = 2 + ((r() * 12) | 0);
        t.blob(cx, cy, 1 + ((r() * 2) | 0), jitter(ore, 12, r), 8);
        t.set(cx, cy, jitter(C.white, 10, r));
      }
      break;
    }
    case TILE.WATER: {
      t.base(C.water, 7, 255);
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          if ((x + y * 2) % 7 === 0) t.set(x, y, jitter([78, 138, 210], 8, r));
          if ((x * 2 + y) % 11 === 0) t.set(x, y, jitter([40, 92, 166], 6, r));
        }
      break;
    }
    case TILE.BEDROCK: {
      t.base(C.bedrock, 10);
      for (let by = 0; by < 16; by += 4)
        for (let bx = 0; bx < 16; bx += 4) {
          const c = r() < 0.45 ? [40, 42, 46] : r() < 0.8 ? [92, 94, 100] : [58, 60, 66];
          t.rect(bx, by, bx + 3, by + 3, c as RGB);
        }
      break;
    }
    case TILE.COBBLE: {
      t.base([70, 72, 76], 8);
      for (let i = 0; i < 9; i++) {
        const cx = 2 + ((r() * 13) | 0);
        const cy = 2 + ((r() * 13) | 0);
        const rad = 2 + ((r() * 2) | 0);
        t.blob(cx, cy, rad, jitter(C.cobble, 18, r), 10);
      }
      break;
    }
    case TILE.GLASS: {
      t.fill(() => [[0, 0, 0], 0]);
      for (let i = 0; i < 16; i++) {
        t.set(i, 0, C.glass, 235);
        t.set(i, 15, C.glass, 235);
        t.set(0, i, C.glass, 235);
        t.set(15, i, C.glass, 235);
      }
      for (let i = 2; i < 9; i++) t.set(i, i + 1, [236, 250, 255], 150);
      for (let i = 9; i < 13; i++) t.set(i + 2, i - 6, [236, 250, 255], 90);
      break;
    }
    case TILE.BRICK: {
      t.base(C.brick, 10);
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const row = (y / 4) | 0;
          if (y % 4 === 3) t.set(x, y, jitter(C.mortar, 6, r));
          else if ((x + row * 8) % 8 === 0) t.set(x, y, jitter(C.mortar, 6, r));
        }
      break;
    }
    case TILE.SNOW_TOP: {
      t.base(C.snow, 5);
      for (let i = 0; i < 14; i++) t.set((r() * 16) | 0, (r() * 16) | 0, [222, 236, 252]);
      break;
    }
    case TILE.TORCH: {
      t.fill(() => [[0, 0, 0], 0]);
      t.rect(6, 7, 9, 15, jitter(C.torch, 6, r));
      t.rect(6, 7, 6, 15, C.logDark);
      t.rect(9, 7, 9, 15, [138, 106, 66]);
      t.blob(7, 5, 2, C.flame, 12);
      t.rect(7, 4, 8, 5, C.flameHot);
      t.set(7, 2, [255, 250, 220]);
      break;
    }
    case TILE.GRAVEL: {
      t.base(C.gravel, 10);
      for (let i = 0; i < 16; i++) t.blob((r() * 16) | 0, (r() * 16) | 0, 1 + ((r() * 2) | 0), jitter([96, 92, 88], 24, r), 14);
      for (let i = 0; i < 8; i++) t.blob((r() * 16) | 0, (r() * 16) | 0, 1, jitter([168, 158, 146], 14, r), 10);
      break;
    }
    case TILE.CRAFT_TOP: {
      t.base(C.plank, 8);
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          if (y % 4 === 3) t.set(x, y, C.plankDark);
          if (x === 3 || x === 12) t.set(x, y, C.plankDark);
        }
      t.rect(0, 0, 15, 1, C.logDark);
      t.rect(0, 14, 15, 15, C.logDark);
      for (let i = 0; i < 12; i++) t.set(2 + ((r() * 12) | 0), 3 + ((r() * 10) | 0), [96, 72, 44]);
      break;
    }
    case TILE.CRAFT_SIDE: {
      t.base(C.plank, 8);
      t.rect(0, 3, 15, 5, C.logDark);
      for (let x = 0; x < 16; x += 3) t.set(x, 4, [196, 160, 108]);
      for (let y = 8; y < 16; y++)
        for (let x = 0; x < 16; x++) if (x % 5 === 0) t.set(x, y, C.plankDark);
      break;
    }
    case TILE.CHEST_TOP: {
      t.base([146, 106, 62], 10);
      t.rect(0, 6, 15, 9, C.logDark);
      t.rect(7, 5, 8, 10, [46, 34, 22]);
      t.set(7, 7, C.metal);
      break;
    }
    case TILE.CHEST_SIDE: {
      t.base([140, 102, 60], 10);
      t.rect(0, 0, 15, 1, C.logDark);
      t.rect(0, 5, 15, 7, [98, 72, 44]);
      for (let x = 0; x < 16; x++) if (x % 4 === 0) t.set(x, 12, C.logDark);
      break;
    }
    case TILE.CHEST_FRONT: {
      t.base([140, 102, 60], 10);
      t.rect(0, 0, 15, 1, C.logDark);
      t.rect(0, 5, 15, 7, [98, 72, 44]);
      t.rect(6, 4, 9, 9, [58, 44, 28]);
      t.rect(7, 6, 8, 8, C.metal);
      t.set(7, 7, [40, 40, 44]);
      for (let x = 0; x < 16; x++) if (x % 4 === 0) t.set(x, 12, C.logDark);
      break;
    }
    case TILE.TNT_SIDE: {
      t.base(C.tnt, 8);
      t.rect(0, 5, 15, 10, [228, 226, 218]);
      for (let x = 2; x < 14; x += 3) {
        t.set(x, 6, C.black);
        t.set(x, 7, C.black);
        t.set(x + 1, 8, C.black);
        t.set(x, 9, C.black);
        t.set(x + 1, 6, C.black);
      }
      t.rect(0, 0, 15, 1, C.tntDark);
      t.rect(0, 14, 15, 15, C.tntDark);
      break;
    }
    case TILE.TNT_TOP: {
      t.base(C.tntDark, 8);
      t.rect(3, 3, 12, 12, [92, 82, 76]);
      t.blob(8, 8, 2, C.tnt, 10);
      t.rect(7, 1, 8, 4, [196, 186, 170]);
      break;
    }
    case TILE.CACTUS_SIDE: {
      t.base(C.cactus, 8);
      for (let x = 0; x < 16; x++)
        for (let y = 0; y < 16; y++) {
          if (x % 5 === 0) t.set(x, y, [48, 100, 52]);
          if (x % 5 === 1 && y % 4 === 1) t.set(x, y, [226, 236, 210]);
        }
      break;
    }
    case TILE.CACTUS_TOP: {
      t.base(C.cactus, 8);
      t.blob(7, 7, 4, [96, 158, 90], 10);
      t.blob(7, 7, 1, [132, 190, 116]);
      break;
    }
    case TILE.CRACK_0:
    case TILE.CRACK_1:
    case TILE.CRACK_2:
    case TILE.CRACK_3:
    case TILE.CRACK_4: {
      const stage = t.index - TILE.CRACK_0;
      t.fill(() => [[0, 0, 0], 0]);
      const lines = 1 + stage;
      for (let i = 0; i < lines; i++) {
        let x = 2 + ((r() * 12) | 0);
        let y = 2 + ((r() * 12) | 0);
        const steps = 4 + stage * 4;
        for (let k = 0; k < steps; k++) {
          t.set(x, y, [16, 16, 18], 210);
          if (r() < 0.5) t.set(x + 1, y, [16, 16, 18], 150);
          x += r() < 0.5 ? 1 : 0;
          y += r() < 0.5 ? 1 : r() < 0.5 ? -1 : 0;
          x = Math.max(0, Math.min(15, x));
          y = Math.max(0, Math.min(15, y));
        }
      }
      break;
    }
    case TILE.LEAVES_SNOW: {
      t.base(C.leaf, 16);
      for (let i = 0; i < 40; i++) t.set((r() * 16) | 0, (r() * 16) | 0, C.snow);
      break;
    }
    case TILE.MOSSY_COBBLE: {
      t.base([70, 72, 76], 8);
      for (let i = 0; i < 9; i++) t.blob(2 + ((r() * 13) | 0), 2 + ((r() * 13) | 0), 2, jitter(C.cobble, 18, r), 10);
      for (let i = 0; i < 30; i++) t.set((r() * 16) | 0, (r() * 16) | 0, jitter([84, 126, 60], 12, r));
      break;
    }
    case TILE.SAND: {
      t.base(C.sand, 7);
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          if ((x + y * 2) % 7 === 0) t.set(x, y, C.sandDark);
          if (r() < 0.05) t.set(x, y, [236, 222, 176]);
        }
      break;
    }
    case TILE.SANDSTONE: {
      t.base(C.sand, 6);
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          if (y % 5 === 4) t.set(x, y, C.sandDark);
          if ((x + y) % 9 === 0) t.set(x, y, [232, 216, 168]);
        }
      break;
    }
    // ---- mob skins (MO-1 … MO-3): flat-coloured hides with a few distinguishing marks ----
    // Heads carry fur/ear detail only; the *face* tiles carry the eyes and are mapped onto the
    // front face alone. Faces without eyes on every side looked like a smeared pink cube.
    case TILE.PIG: {
      t.base([226, 158, 148], 8);
      for (let i = 0; i < 12; i++) t.blob((r() * 16) | 0, (r() * 16) | 0, 1, [206, 132, 124], 5);
      break;
    }
    case TILE.PIG_HEAD: {
      t.base([232, 170, 158], 7);
      t.rect(0, 0, 15, 1, [208, 142, 132]); // brow
      t.rect(1, 2, 3, 4, [206, 136, 128]); // ear shading
      t.rect(12, 2, 14, 4, [206, 136, 128]);
      break;
    }
    case TILE.PIG_FACE: {
      t.base([232, 170, 158], 7);
      t.rect(0, 0, 15, 1, [208, 142, 132]);
      t.rect(2, 4, 4, 6, [246, 244, 240]); // eye whites
      t.rect(11, 4, 13, 6, [246, 244, 240]);
      t.rect(3, 5, 4, 6, [26, 20, 24]); // pupils
      t.rect(11, 5, 12, 6, [26, 20, 24]);
      t.rect(5, 9, 10, 13, [206, 128, 122]); // snout
      t.rect(6, 10, 7, 11, [126, 70, 66]);
      t.rect(8, 10, 9, 11, [126, 70, 66]);
      break;
    }
    case TILE.COW: {
      t.base([56, 48, 44], 8);
      for (let i = 0; i < 5; i++) t.blob((r() * 16) | 0, (r() * 16) | 0, 2 + ((r() * 2) | 0), [232, 228, 220], 6);
      break;
    }
    case TILE.COW_HEAD: {
      t.base([58, 50, 46], 7);
      t.rect(0, 0, 2, 2, [222, 214, 196]); // horn nub
      t.rect(13, 0, 15, 2, [222, 214, 196]);
      t.rect(1, 3, 4, 5, [236, 232, 224]); // forehead patch
      t.rect(10, 2, 14, 4, [236, 232, 224]);
      break;
    }
    case TILE.COW_FACE: {
      t.base([58, 50, 46], 7);
      t.rect(0, 0, 2, 1, [222, 214, 196]);
      t.rect(13, 0, 15, 1, [222, 214, 196]);
      t.rect(2, 4, 4, 6, [244, 240, 232]); // eye whites
      t.rect(11, 4, 13, 6, [244, 240, 232]);
      t.rect(2, 5, 3, 6, [16, 14, 16]); // pupils
      t.rect(12, 5, 13, 6, [16, 14, 16]);
      t.rect(4, 10, 11, 15, [196, 158, 150]); // muzzle
      t.rect(5, 11, 6, 12, [110, 76, 72]);
      t.rect(9, 11, 10, 12, [110, 76, 72]);
      break;
    }
    case TILE.SHEEP: {
      t.base([238, 238, 234], 7);
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) if ((x * 3 + y * 5) % 11 < 2) t.set(x, y, [218, 218, 214]);
      break;
    }
    case TILE.SHEEP_HEAD: {
      t.base([214, 202, 190], 7);
      for (let x = 0; x < 16; x++) if (x % 3 !== 1) t.set(x, 0, [236, 236, 232]); // wool tuft
      t.rect(1, 1, 4, 3, [228, 216, 204]);
      t.rect(11, 1, 14, 3, [228, 216, 204]);
      break;
    }
    case TILE.SHEEP_FACE: {
      t.base([214, 202, 190], 7);
      for (let x = 0; x < 16; x++) if (x % 3 !== 1) t.set(x, 0, [236, 236, 232]);
      t.rect(2, 5, 4, 7, [246, 244, 240]); // eye whites
      t.rect(11, 5, 13, 7, [246, 244, 240]);
      t.rect(3, 6, 4, 7, [28, 24, 26]); // pupils
      t.rect(11, 6, 12, 7, [28, 24, 26]);
      t.rect(6, 12, 9, 14, [176, 162, 150]); // muzzle
      t.rect(7, 13, 8, 13, [126, 112, 102]);
      break;
    }
    case TILE.ZOMBIE: {
      t.base([86, 128, 92], 8);
      t.rect(0, 6, 15, 11, [56, 78, 96]); // torn shirt
      for (let i = 0; i < 8; i++) t.set((r() * 16) | 0, 6 + ((r() * 5) | 0), [42, 62, 78]);
      for (let i = 0; i < 10; i++) t.set((r() * 16) | 0, (r() * 6) | 0, [66, 104, 74]);
      break;
    }
    case TILE.ZOMBIE_HEAD: {
      t.base([92, 134, 96], 7);
      t.rect(0, 0, 15, 1, [74, 112, 80]);
      for (let i = 0; i < 10; i++) t.set((r() * 16) | 0, (r() * 16) | 0, [72, 112, 80]);
      break;
    }
    case TILE.ZOMBIE_FACE: {
      t.base([92, 134, 96], 7);
      t.rect(0, 0, 15, 1, [74, 112, 80]);
      t.rect(2, 4, 5, 7, [22, 30, 24]); // sunken sockets
      t.rect(10, 4, 13, 7, [22, 30, 24]);
      t.rect(3, 5, 4, 6, [255, 198, 72]); // glowing eyes: readable even at night
      t.rect(11, 5, 12, 6, [255, 198, 72]);
      t.rect(5, 12, 10, 14, [46, 66, 50]); // mouth
      t.rect(6, 12, 7, 13, [216, 214, 200]); // teeth
      t.rect(8, 13, 9, 14, [216, 214, 200]);
      break;
    }
    // ---- view model (the player's own arm/sleeve, VII) ----
    case TILE.HAND: {
      // The view model maps this over a small cube: keep it mostly skin so it reads as a hand and
      // not as a wood block (one knuckle line is all that survives at that size).
      t.base([232, 186, 148], 5);
      t.rect(2, 6, 13, 7, [214, 166, 128]);
      t.rect(2, 13, 13, 14, [244, 204, 168]);
      break;
    }
    case TILE.SLEEVE: {
      t.base([72, 116, 164], 6);
      t.rect(0, 0, 15, 2, [56, 92, 136]); // shoulder seam
      t.rect(0, 13, 15, 15, [92, 138, 186]); // cuff
      break;
    }
    default: {
      // bright checker so an unimplemented tile is immediately obvious
      t.fill((x, y) => [((x >> 2) + (y >> 2)) % 2 === 0 ? [224, 48, 200] : [30, 30, 34], 255]);
      break;
    }
  }
}

let cachedCanvas: HTMLCanvasElement | null = null;

/** Build (once) and return the atlas canvas. */
export function buildAtlasCanvas(seed = 1337): HTMLCanvasElement {
  if (cachedCanvas) return cachedCanvas;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_PX;
  canvas.height = ATLAS_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const img = ctx.createImageData(ATLAS_PX, ATLAS_PX);
  // seed the whole sheet with the "missing texture" checker
  for (let y = 0; y < ATLAS_PX; y++)
    for (let x = 0; x < ATLAS_PX; x++) {
      const i = (y * ATLAS_PX + x) * 4;
      const c = ((x >> 3) + (y >> 3)) % 2 === 0 ? [224, 48, 200] : [30, 30, 34];
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);

  const tileCount = ATLAS_TILES * ATLAS_TILES;
  for (let index = 0; index < tileCount; index++) {
    const t = new Tile(index, seed);
    drawTile(t);
    const data = t.build();
    const col = index % ATLAS_TILES;
    const row = (index / ATLAS_TILES) | 0;
    const tileImg = new ImageData(new Uint8ClampedArray(data), TILE_PX, TILE_PX);
    ctx.putImageData(tileImg, col * TILE_PX, row * TILE_PX);
  }
  cachedCanvas = canvas;
  return canvas;
}

/** Average colour of a tile — used for break particles and item badges. */
export function tileAverageColor(tile: number): [number, number, number] {
  const canvas = buildAtlasCanvas();
  const ctx = canvas.getContext('2d');
  if (!ctx) return [200, 200, 200];
  const col = tile % ATLAS_TILES;
  const row = (tile / ATLAS_TILES) | 0;
  const d = ctx.getImageData(col * TILE_PX, row * TILE_PX, TILE_PX, TILE_PX).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 40) continue;
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    n++;
  }
  if (n === 0) return [210, 210, 210];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Crop a tile to a standalone data-URL image (used for DOM icons / recipe book). */
export function tileDataURL(tile: number, size = TILE_PX * 2): string {
  const canvas = buildAtlasCanvas();
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d');
  if (!ctx) return '';
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    canvas,
    (tile % ATLAS_TILES) * TILE_PX,
    ((tile / ATLAS_TILES) | 0) * TILE_PX,
    TILE_PX,
    TILE_PX,
    0,
    0,
    size,
    size,
  );
  return out.toDataURL();
}
