/// <reference lib="webworker" />
/** Chunk terrain generation worker (§8: generation off the main thread). */
import { CHUNK_SX, CHUNK_SZ, CHUNK_VOL } from '../core/constants.js';
import type { GenRequest, GenResponse } from '../core/types.js';
import { generateChunk } from '../world/worldgen.js';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<GenRequest>) => {
  const req = event.data;
  if (!req || req.type !== 'gen') return;
  try {
    const t0 = performance.now();
    const blocks = new Uint8Array(CHUNK_VOL);
    const biome = new Uint8Array(CHUNK_SX * CHUNK_SZ);
    const height = new Uint8Array(CHUNK_SX * CHUNK_SZ);
    generateChunk(req.seed, req.cx, req.cz, blocks, biome, height);
    // re-apply the player's edits for this chunk so reloads are exact (SV-1)
    const diff = req.diff;
    for (let i = 0; i + 1 < diff.length; i += 2) blocks[diff[i]] = diff[i + 1];

    const res: GenResponse = {
      type: 'data',
      jobId: req.jobId,
      cx: req.cx,
      cz: req.cz,
      blocks: blocks.buffer,
      biome: biome.buffer,
      height: height.buffer,
      ms: performance.now() - t0,
    };
    ctx.postMessage(res, [res.blocks, res.biome, res.height]);
  } catch (err) {
    ctx.postMessage({ type: 'error', jobId: req.jobId, message: String(err) });
  }
};
