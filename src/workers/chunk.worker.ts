/// <reference lib="webworker" />
/** Chunk terrain generation worker (§8: generation off the main thread). */
import { CHUNK_SX, CHUNK_SZ, CHUNK_VOL } from '../core/constants.js';
import type { GenRequest, GenResponse } from '../core/types.js';
import { generateEditedChunk } from '../world/worldgen.js';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<GenRequest>) => {
  const req = event.data;
  if (!req || req.type !== 'gen') return;
  try {
    const t0 = performance.now();
    const blocks = new Uint8Array(CHUNK_VOL);
    const biome = new Uint8Array(CHUNK_SX * CHUNK_SZ);
    const height = new Uint8Array(CHUNK_SX * CHUNK_SZ);
    // terrain + the player's edits, heights included, so reloads are exact (SV-1)
    generateEditedChunk(req.seed, req.cx, req.cz, blocks, biome, height, req.diff);

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
