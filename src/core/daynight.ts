/**
 * The day/night curve (RD-5), shared by the renderer (sky, fog, stars) and the simulation
 * (mob spawning and sun burning) so what the player *sees* and what the world *does* agree.
 */
import { DAY_LENGTH_MS, clamp, smoothstep } from './constants.js';

export interface DayNight {
  /** `t` as-is, wrapped into [0,1). */
  t: number;
  /** Solar elevation, sin(2πt): +1 at noon, -1 at midnight. */
  elev: number;
  /** Daytime weight 0..1. */
  day: number;
  /** Horizon glow 0..1, peaks as the sun crosses the horizon. */
  sunset: number;
  /** Night weight 0..1 — exactly `1 - day`. */
  night: number;
  /** Terrain light multiplier, 0.2 (deep night) .. 1.06 (noon). */
  dayLight: number;
}

/**
 * A full cycle is 10 minutes, so 1 % of `t` is 6 seconds. The ramps below deliberately span
 * ~13 % of the cycle (≈80 s) on each side: the previous steep clamps burned through dusk in
 * about 25 s, which read as the game "skipping" the evening and snapping into night.
 */
/**
 * A full cycle is 10 minutes, so 1 % of `t` is 6 seconds. The ramp below deliberately spans most
 * of the way between the horizon and the deep-night low: the previous steep clamps (`elev * 1.7 +
 * 0.12`, `-elev * 2 + 0.2`) burned through dusk in about 25 s *and* reached full night right at
 * sunset, which read as the game skipping the evening.
 *
 * `night` is defined as `1 - day` on purpose: sky colour, star opacity, terrain light and mob
 * behaviour all read one parameter, so they can never disagree.
 */
export function dayNightCurve(t: number): DayNight {
  const tt = t - Math.floor(t);
  const elev = Math.sin(tt * Math.PI * 2);
  // Centred on the horizon: half bright exactly at sunrise/sunset, ~115 s of dawn and dusk.
  const day = smoothstep(-0.62, 0.5, elev);
  const night = 1 - day;
  // Horizon glow peaks as the sun crosses the horizon, independent of how dark it already is.
  const sunset = clamp(1 - Math.abs(elev) / 0.42, 0, 1);
  return { t: tt, elev, day, sunset, night, dayLight: clamp(0.2 + day * 0.86, 0.2, 1) };
}

/**
 * The world clock: `t` as a function of elapsed time, with an explicit origin.
 *
 * This used to be two fields on `Game` (`baseTime` read live from the *save record*, plus an
 * accumulated `timeMs`). Saving writes the current `timeOfDay` into that record, so every autosave
 * moved the origin to the current time while the elapsed term kept growing — and the clock jumped
 * forward by the entire session length, once per autosave. That is the "evening suddenly jumps a
 * quarter of the way into the night" bug, and it is why the origin is now a private, explicit value
 * that only `advance()` and `pin()` may touch.
 */
export class DayClock {
  private originT: number;
  private elapsedMs = 0;

  constructor(startT = 0.25) {
    this.originT = wrapT(startT);
  }

  /** Current time of day, 0..1 (0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight). */
  get t(): number {
    return wrapT(this.originT + this.elapsedMs / DAY_LENGTH_MS);
  }

  /** Elapsed milliseconds since the origin (useful for tests and for re-pinning). */
  get elapsed(): number {
    return this.elapsedMs;
  }

  /** Move the clock by `dtMs`. Frame deltas are clamped by the caller, as they must be. */
  advance(dtMs: number): number {
    if (Number.isFinite(dtMs) && dtMs > 0) this.elapsedMs += dtMs;
    return this.t;
  }

  /**
   * Pin the clock to an absolute time (loading a save, or a test wanting a specific moment).
   * Whatever elapsed before is discarded, so this can never introduce a jump by itself.
   */
  pin(t: number): number {
    this.originT = wrapT(t);
    this.elapsedMs = 0;
    return this.originT;
  }
}

function wrapT(t: number): number {
  if (!Number.isFinite(t)) return 0.25;
  return t - Math.floor(t);
}
