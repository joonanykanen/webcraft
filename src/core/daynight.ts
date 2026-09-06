/**
 * The day/night curve (RD-5), shared by the renderer (sky, fog, stars) and the simulation
 * (mob spawning and sun burning) so what the player *sees* and what the world *does* agree.
 */
import { clamp, smoothstep } from './constants.js';

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
