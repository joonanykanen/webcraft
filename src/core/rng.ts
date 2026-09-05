/**
 * Deterministic pseudo-random helpers.
 *
 * WG-7 / Risk-5: world generation must produce byte-identical results across browsers.
 * Only integer ops (Math.imul, shifts, |0) and exact IEEE-753 double ops (+ - * / sqrt floor)
 * are used — never Math.random(), trig, pow or log.
 */

/** 32-bit integer mixer (splitmix-style). Returns unsigned 32-bit. */
export function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return (h ^ (h >>> 14)) >>> 0;
}

/** Hash up to 4 integers + a seed into a 32-bit value. */
export function hashInts(a: number, b: number, c: number, d: number, seed: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (a | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (c | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h ^ (d | 0), 0x165667b1);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Deterministic 32-bit hash of a chunk column + a domain salt. */
export function hash2(x: number, y: number, seed: number): number {
  return hashInts(x, y, 0, 0, seed);
}

/** Uniform float in [0,1). */
export function hashFloat(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967296;
}

/** Deterministic PRNG (mulberry32). Used for per-chunk decoration & non-worldgen needs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n) from a rng. */
export function randInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

/** Pick a string seed's numeric hash, so text seeds are portable. */
export function seedFromString(text: string): number {
  const t = text.trim();
  if (t.length === 0) return (Date.now() % 0x7fffffff) | 0;
  const asNumber = Number(t);
  if (Number.isFinite(asNumber) && /^-?\d+$/.test(t)) return (asNumber | 0) ^ 0x51f2b3;
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** FNV-1a string hash — used for save-record checksums (Risk-2). */
export function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
