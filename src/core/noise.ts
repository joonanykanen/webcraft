/**
 * Deterministic gradient (Perlin-style) noise.
 *
 * Everything is integer hashing plus exact-IEEE double arithmetic (add / sub / mul / floor).
 * No trigonometry, no Math.pow, no Math.random — this is what makes WG-7 (identical worlds on
 * every browser) hold. Golden-value tests live in `tests/worldgen.test.ts`.
 */

/** Build a 512-entry permutation table from a seed (Fisher–Yates with our own rng). */
export function makePerm(seed: number): Uint8Array {
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = (seed ^ 0x1a2b3c4d) >>> 0;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 256; i++) p[256 + i] = p[i];
  return p;
}

function fade(t: number): number {
  // 6t^5 - 15t^4 + 10t^3, written as nested multiplies (no pow)
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

const GRAD2_X = [1, 1, -1, -1, 1, -1, 0, 0];
const GRAD2_Y = [1, -1, 1, -1, 0, 0, 1, -1];

function grad2(hash: number, x: number, y: number): number {
  const g = hash & 7;
  return GRAD2_X[g] * x + GRAD2_Y[g] * y;
}

/** 2D gradient noise, roughly in [-1, 1]. */
export function noise2(perm: Uint8Array, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const X = xi & 255;
  const Y = yi & 255;
  const u = fade(xf);
  const v = fade(yf);
  const aa = perm[perm[X] + Y];
  const ab = perm[perm[X] + Y + 1];
  const ba = perm[perm[X + 1] + Y];
  const bb = perm[perm[X + 1] + Y + 1];
  const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
  const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v) * 1.35;
}

function grad3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** 3D gradient noise, roughly in [-1, 1]. */
export function noise3(perm: Uint8Array, x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const X = xi & 255;
  const Y = yi & 255;
  const Z = zi & 255;
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);
  const A = perm[X] + Y;
  const AA = perm[A] + Z;
  const AB = perm[A + 1] + Z;
  const B = perm[X + 1] + Y;
  const BA = perm[B] + Z;
  const BB = perm[B + 1] + Z;
  const l1 = lerp(grad3(perm[AA], xf, yf, zf), grad3(perm[BA], xf - 1, yf, zf), u);
  const l2 = lerp(grad3(perm[AB], xf, yf - 1, zf), grad3(perm[BB], xf - 1, yf - 1, zf), u);
  const l3 = lerp(grad3(perm[AA + 1], xf, yf, zf - 1), grad3(perm[BA + 1], xf - 1, yf, zf - 1), u);
  const l4 = lerp(grad3(perm[AB + 1], xf, yf - 1, zf - 1), grad3(perm[BB + 1], xf - 1, yf - 1, zf - 1), u);
  return lerp(lerp(l1, l2, v), lerp(l3, l4, v), w) * 1.12;
}

/** Fractal sum of 2D octaves; returns a value in roughly [-1, 1]. */
export function fbm2(
  perm: Uint8Array,
  x: number,
  y: number,
  octaves: number,
  frequency = 1,
  persistence = 0.5,
  lacunarity = 2,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x * frequency;
  let fy = y * frequency;
  const oct = Math.min(octaves, 8);
  for (let i = 0; i < oct; i++) {
    sum += noise2(perm, fx, fy) * amp;
    norm += amp;
    amp *= persistence;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Fractal sum of 3D octaves; returns a value in roughly [-1, 1]. */
export function fbm3(
  perm: Uint8Array,
  x: number,
  y: number,
  z: number,
  octaves: number,
  frequency = 1,
  persistence = 0.5,
  lacunarity = 2,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x * frequency;
  let fy = y * frequency;
  let fz = z * frequency;
  const oct = Math.min(octaves, 6);
  for (let i = 0; i < oct; i++) {
    sum += noise3(perm, fx, fy, fz) * amp;
    norm += amp;
    amp *= persistence;
    fx *= lacunarity;
    fy *= lacunarity;
    fz *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** |noise| "ridge" shaping — good for mountain ridgelines. */
export function ridged2(perm: Uint8Array, x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  const oct = Math.min(octaves, 5);
  for (let i = 0; i < oct; i++) {
    const n = noise2(perm, fx, fy);
    sum += (1 - (n < 0 ? -n : n)) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}
