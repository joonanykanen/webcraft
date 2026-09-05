// Scratch: print golden hashes after a deliberate worldgen change (not part of the suite).
import { CHUNK_SX, CHUNK_SZ, CHUNK_VOL } from '../src/core/constants.js';
import { generateChunk } from '../src/world/worldgen.js';

function hashBlocks(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

for (const [cx, cz] of [
  [0, 0],
  [-4, 9],
  [31, -12],
  [1, 0],
  [-2, 3],
  [7, -7],
] as const) {
  const blocks = new Uint8Array(CHUNK_VOL);
  generateChunk(1337, cx, cz, blocks, new Uint8Array(CHUNK_SX * CHUNK_SZ), new Uint8Array(CHUNK_SX * CHUNK_SZ));
  console.log(`  '${cx},${cz}': '${hashBlocks(blocks)}',`);
}
