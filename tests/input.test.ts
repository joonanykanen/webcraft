import { describe, expect, it } from 'vitest';
import { LOCK_SETTLE_MS, LOOK_PER_PIXEL } from '../src/core/constants.js';
import { Input } from '../src/game/input.js';

/**
 * Pointer lock and look scaling (PH-1). The browser only hands over the mouse in response to a
 * gesture; grabbing it after an `await` both fails and paints Chrome's "mouse pointer is hidden"
 * banner, which the player reads as an error.
 */
describe('input (PH-1)', () => {
  it('knows when a pointer-lock request is allowed to happen', () => {
    const input = new Input();
    // no gesture has happened yet in this test environment
    expect(input.hasGesture()).toBe(false);
    input.markGesture();
    expect(input.hasGesture()).toBe(true);
  });

  it('does not fire a lock request without a gesture (no browser banner)', () => {
    const input = new Input();
    let requested = 0;
    const fakeCanvas = {
      requestPointerLock: () => {
        requested++;
        return undefined;
      },
    } as unknown as HTMLCanvasElement;
    // no canvas attached at all: the request is a no-op rather than an exception
    input.requestLock();
    expect(requested).toBe(0);
    input.setCanvas(fakeCanvas);
    input.requestLock(); // still no gesture → remembered, not requested
    expect(requested).toBe(0);
    expect(input.wantLock).toBe(true);
    input.markGesture();
    input.requestLock();
    expect(requested).toBe(1);
    expect(input.wantLock).toBe(false);
  });

  it('looks twice as fast per pixel as the first build at sensitivity 1.0', () => {
    // 0.0022 was the original scale; at 1.0 the aim lagged behind the hand.
    expect(LOOK_PER_PIXEL).toBeGreaterThanOrEqual(0.004);
    expect(LOOK_PER_PIXEL).toBeLessThanOrEqual(0.01);
  });

  it('gives the pointer a moment to settle after it is captured', () => {
    // entering pointer lock reports the recentring as one enormous movement delta
    expect(LOCK_SETTLE_MS).toBeGreaterThanOrEqual(80);
    expect(LOCK_SETTLE_MS).toBeLessThanOrEqual(400);
  });

  it('reports sprint from the touch control as well as the keyboard', () => {
    const input = new Input();
    input.setActive(true);
    expect(input.move().sprint).toBe(false);
    input.touch.sprint = true;
    expect(input.move().sprint).toBe(true);
    input.touch.sprint = false;
    expect(input.move().sprint).toBe(false);
  });
});
