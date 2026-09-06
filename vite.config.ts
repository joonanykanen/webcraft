/// <reference types="vitest" />
import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

/**
 * Which build is this? Enough times one bug report turned out to be a stale `dist/` (a copy served from
 * a different port, an old tab, a saved bookmark) that the running commit has to be visible in the game
 * itself, not in a terminal somewhere. Shown on the main menu and on the F3 overlay.
 */
function buildId(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    return `${sha}${dirty ? '*' : ''}`;
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(`${buildId()} built ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * Every world-generating test pays for real terrain, and the default 5 s is a statement about the
     * machine running it: the first explosion case takes ~1.4 s on a laptop, ~2.3 s when pinned to two
     * threads, and timed out past 5 s on CI's two shared cores. A suite that fails there and passes
     * here teaches people to ignore it, so the ceiling is 30 s — a hung test now costs half a minute
     * instead of a red build nobody trusts.
     */
    testTimeout: 30_000,
    hooksTimeout: 30_000,
  },
});
