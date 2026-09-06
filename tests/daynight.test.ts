import { describe, expect, it } from 'vitest';
import { DAY_LENGTH_MS } from '../src/core/constants.js';
import { DayClock, dayNightCurve } from '../src/core/daynight.js';

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
    const dusk = inTwilight(0.4, 0.75); // sunset is at 0.5
    const dawn = inTwilight(0.72, 1.0) + inTwilight(0, 0.12); // sunrise is at 0.0/1.0, ramp wraps
    const cycle = DAY_LENGTH_MS / 1000; // seconds
    // ~115 s of dusk and dawn each; anything under a minute is the "instant night" bug again.
    expect(dusk * cycle).toBeGreaterThan(60);
    expect(dawn * cycle).toBeGreaterThan(60);
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

  it('is half bright at the horizon and dark well before midnight', () => {
    // The ramp is centred on elev 0 on purpose, so sunrise/sunset is the middle of the change
    // rather than its end. That is what stops the world from lurching from dark to daylight.
    expect(dayNightCurve(0.5).day).toBeGreaterThan(0.4);
    expect(dayNightCurve(0.5).day).toBeLessThan(0.6);
    expect(dayNightCurve(0.6).night).toBeGreaterThan(0.9); // properly dark 1/10 of a cycle later
    expect(dayNightCurve(0.9).night).toBeGreaterThan(0.9); // and still dark just before dawn
  });

  it('does the brightening while the sun is actually rising', () => {
    // Regression for "night suddenly jumps to day": most of the day/night change must happen while
    // the sun is near the horizon (visible), and no single second may change the light much.
    const cycle = DAY_LENGTH_MS / 1000;
    let maxPerSec = 0;
    let tOfMax = 0;
    let prev = dayNightCurve(0).day;
    for (let i = 1; i <= 4000; i++) {
      const t = i / 4000;
      const day = dayNightCurve(t).day;
      const rate = Math.abs(day - prev) / (cycle / 4000);
      if (rate > maxPerSec) {
        maxPerSec = rate;
        tOfMax = t;
      }
      prev = day;
    }
    expect(maxPerSec).toBeLessThan(0.02); // ≤ 2 % of the full range per second (of 600 s)
    // The steepest moment must be within ~10 % of the cycle of a horizon crossing (0.0 / 0.5).
    const distToSunrise = Math.min(Math.abs(tOfMax), Math.abs(tOfMax - 0.5), Math.abs(tOfMax - 1));
    expect(distToSunrise).toBeLessThan(0.1);
    // And at sunrise itself the world is mid-transition, not already fully lit.
    expect(dayNightCurve(0).day).toBeGreaterThan(0.35);
    expect(dayNightCurve(0).day).toBeLessThan(0.65);
  });
});

describe('world clock (DayClock)', () => {
  const CYCLE = DAY_LENGTH_MS / 1000; // seconds

  it('advances at exactly one cycle per DAY_LENGTH_MS and wraps', () => {
    const c = new DayClock(0);
    expect(c.advance(1000)).toBeCloseTo(1 / CYCLE, 6);
    c.advance((CYCLE - 1) * 1000);
    expect(c.t).toBeCloseTo(0, 6); // a full cycle lands back on sunrise
    expect(c.advance(60_000)).toBeCloseTo(60 / CYCLE, 6);
  });

  it('ignores garbage frames instead of poisoning the clock', () => {
    const c = new DayClock(0.3);
    const before = c.t;
    c.advance(Number.NaN);
    c.advance(-5000);
    expect(c.t).toBeCloseTo(before, 9);
  });

  it('pinning to the current time is a no-op — saving cannot move the sky', () => {
    // The bug this pins out: the clock's origin was read live from the save record, and a save wrote
    // the current time into that record while the elapsed term kept growing. Every autosave therefore
    // jumped the clock forward by the whole session — a quarter cycle in a single frame.
    const c = new DayClock(0.45);
    c.advance(150_000); // five minutes of play
    const t = c.t;
    c.pin(t); // what "save, then carry on playing" looks like
    expect(Math.abs(c.t - t)).toBeLessThan(1e-9);
    c.advance(1000);
    const expected = (t + 1 / CYCLE) % 1;
    expect(Math.abs(c.t - expected)).toBeLessThan(1e-6);
  });

  it('never moves more than one second of the cycle per second of play', () => {
    const c = new DayClock(0.5); // sunset
    let prev = c.t;
    for (let i = 0; i < 600; i++) {
      const t = c.advance(16.7); // 60 fps for ten seconds
      const delta = (t - prev + 1) % 1; // forward distance, wrap-safe
      expect(delta).toBeLessThanOrEqual(16.7 / DAY_LENGTH_MS + 1e-12);
      prev = t;
    }
  });
});
