import { describe, expect, it } from 'vitest';
import { DAY_LENGTH_MS } from '../src/core/constants.js';
import { dayNightCurve } from '../src/core/daynight.js';

/**
 * The curve that drives the sky, the terrain light and mob behaviour (RD-5).
 *
 * Bug regression: the sky went from full day to full night in a couple of seconds, so evening
 * looked skipped. A 10-minute cycle should spend a real amount of time in dusk and dawn.
 */
describe('day/night curve', () => {
  it('is day at noon and night at midnight', () => {
    const noon = dayNightCurve(0.25);
    expect(noon.day).toBeCloseTo(1, 3);
    expect(noon.night).toBe(0);
    expect(noon.dayLight).toBeGreaterThan(0.95);

    const mid = dayNightCurve(0.75);
    expect(mid.night).toBeCloseTo(1, 3);
    expect(mid.day).toBe(0);
  });

  it('wraps t outside [0,1) instead of producing a discontinuity', () => {
    expect(dayNightCurve(1.25).t).toBeCloseTo(0.25);
    expect(dayNightCurve(-0.25).t).toBeCloseTo(0.75);
  });

  it('never snaps: the whole cycle is sampled in fine steps', () => {
    let maxJump = 0;
    let prev = dayNightCurve(0).night;
    for (let i = 1; i <= 2000; i++) {
      const night = dayNightCurve(i / 2000).night;
      maxJump = Math.max(maxJump, Math.abs(night - prev));
      prev = night;
    }
    // 2000 samples = 300 ms apart on a 10-minute cycle; nothing may teleport between them.
    expect(maxJump).toBeLessThan(0.01);
  });

  it('keeps dusk and dawn long enough to be seen', () => {
    const inTwilight = (from: number, to: number): number => {
      let n = 0;
      for (let i = 0; i < 400; i++) {
        const t = from + ((to - from) * i) / 400;
        const night = dayNightCurve(t).night;
        if (night > 0.02 && night < 0.98) n++;
      }
      return (n / 400) * (to - from);
    };
    const dusk = inTwilight(0.45, 0.7); // sunset is at 0.5
    const dawn = inTwilight(0.75, 0.98); // sunrise is at 0.0/1.0
    const cycle = DAY_LENGTH_MS / 1000; // seconds
    // ~80 s of dusk and ~80 s of dawn; anything under half that is the "instant night" bug again.
    expect(dusk * cycle).toBeGreaterThan(45);
    expect(dawn * cycle).toBeGreaterThan(45);
  });

  it('never leaves the world pitch black', () => {
    for (let i = 0; i < 100; i++) {
      expect(dayNightCurve(i / 100).dayLight).toBeGreaterThanOrEqual(0.2);
    }
    expect(dayNightCurve(0.75).dayLight).toBeLessThan(0.35);
  });

  it('peaks the horizon glow around the horizon crossing', () => {
    expect(dayNightCurve(0.5).sunset).toBeGreaterThan(0.9); // sunset
    expect(dayNightCurve(0.0).sunset).toBeGreaterThan(0.9); // sunrise
    expect(dayNightCurve(0.25).sunset).toBeLessThan(0.2); // noon
  });

  it('is monotone from sunset to midnight so mobs cannot flicker in and out', () => {
    let prev = -1;
    for (let i = 0; i <= 120; i++) {
      const t = 0.5 + i / 480; // sunset (0.5) → midnight (0.75)
      const night = dayNightCurve(t).night;
      expect(night).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = night;
    }
  });

  it('is still bright at sunset and dark well before midnight', () => {
    expect(dayNightCurve(0.5).day).toBeGreaterThan(0.6); // golden hour, not black
    expect(dayNightCurve(0.6).night).toBeGreaterThan(0.8); // properly dark by 1/10 of the cycle in
  });
});
