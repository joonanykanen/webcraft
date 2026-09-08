/**
 * Mouse capture, look scaling and the movement snapshot (PH-1, PH-2, PH-6).
 *
 * The world takes the mouse with Pointer Lock, and falls back to cursor-hidden raw deltas when the
 * browser refuses or never answers: the mouse must never be dead. Lock is preferred because it is the
 * only thing that survives multi-monitor setups and cursor travel; the banner Chrome paints for it
 * cannot be suppressed and is documented in README. While locked, deltas come from movementX/Y; while
 * free, from clientX/Y — one measurement source per capture state, never both. Runs in the node
 * environment, so events are fed through Input's public seams instead of a DOM.
 */
import { describe, expect, it } from 'vitest';
import { LOOK_PER_PIXEL, MAX_LOOK_PER_EVENT, MAX_LOOK_PER_FRAME } from '../src/core/constants.js';
import { Input, clampStep } from '../src/game/input.js';

const key = (code: string, opts: { repeat?: boolean; caps?: boolean } = {}) =>
  ({
    code,
    repeat: opts.repeat ?? false,
    getModifierState: (name: string) => (name === 'CapsLock' ? !!opts.caps : false),
    preventDefault: () => {},
  }) as KeyboardEvent;

const pointer = (init: { movementX?: number; movementY?: number; clientX?: number; clientY?: number }) =>
  ({ movementX: 0, movementY: 0, clientX: 0, clientY: 0, getModifierState: () => false, ...init }) as unknown as MouseEvent;

describe('input (PH-1 capture without the Pointer Lock API)', () => {
  it('captures and releases without a canvas or a DOM', () => {
    const input = new Input();
    expect(input.locked).toBe(false);
    expect(() => input.capture()).not.toThrow();
    expect(input.locked).toBe(true);
    input.release();
    expect(input.locked).toBe(false);
  });

  it('Escape reaches the app even while a menu owns the keyboard', () => {
    const input = new Input();
    const seen: string[] = [];
    input.onKeyDown = (code) => seen.push(code);
    // while a panel owns the keyboard the app still sees its own keys...
    input.uiKeys = true;
    input.handleKeyDown(key('KeyE'));
    expect(seen).toEqual(['KeyE']);
    // ...and Escape is never swallowed: one press pauses, one press resumes
    input.handleKeyDown(key('Escape'));
    expect(seen).toEqual(['KeyE', 'Escape']);
  });

  it('an intentional release (menu opened) does not notify the app', () => {
    const input = new Input();
    input.capture();
    const notices: boolean[] = [];
    input.onLockChange = (locked) => notices.push(locked);
    input.expectUnlock = true;
    input.release();
    expect(notices).toHaveLength(0);
    input.capture();
    input.release(); // focus left the window: the app must hear about it and pause
    expect(notices).toEqual([true, false]);
  });

  it('handing ownership to a menu clears held keys and stops actions', () => {
    const input = new Input();
    input.setActive(true);
    input.handleKeyDown(key('KeyW'));
    input.mining = true;
    input.capture();
    input.setActive(false);
    expect(input.active).toBe(false);
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.mining).toBe(false);
    expect(input.locked).toBe(false);
    expect(input.move().forward).toBe(0);
  });

  it('consumeLook drains the accumulator', () => {
    const input = new Input();
    input.addLook(0.1, 0.05);
    const drained = input.consumeLook();
    expect({ dx: drained.dx, dy: drained.dy }).toEqual({ dx: 0.1, dy: 0.05 });
    // and the per-source accounting saw it as UI input, twice
    expect(drained.sources.ui).toBeCloseTo(0.15, 5);
    expect(drained.sources.mouse).toBe(0);
    expect(input.consumeLook().sources.ui).toBe(0);
    const empty = input.consumeLook();
    expect({ dx: empty.dx, dy: empty.dy }).toEqual({ dx: 0, dy: 0 });
  });
});

describe('mouse look (PH-6, sensitivity spikes)', () => {
  it('defaults to roughly one degree of look per pixel', () => {
    // 0.0044 felt laggy, 0.0088 was still half as fast as requested; ~1°/px is the tuned default.
    // Any further doubling has to be a deliberate decision, not an accident, hence the guard rail.
    expect(LOOK_PER_PIXEL).toBeGreaterThanOrEqual(0.017);
    expect(LOOK_PER_PIXEL).toBeLessThanOrEqual(0.02);
  });

  it('turns the camera only while the world owns the mouse', () => {
    const input = new Input();
    input.setActive(true);
    input.handleMouseMove(pointer({ movementX: 40, movementY: 40 }));
    expect(input.lookDX).toBe(0); // a menu is open: the cursor moves buttons, not the camera

    input.capture();
    input.handleMouseMove(pointer({ movementX: 10, movementY: -20 }));
    expect(input.lookDX).toBeCloseTo(10 * LOOK_PER_PIXEL);
    expect(input.lookDY).toBeCloseTo(-20 * LOOK_PER_PIXEL);
  });

  it('looks the same whether or not a mouse button is held (no spike while mining)', () => {
    const input = new Input();
    input.setActive(true);
    input.capture();
    input.handleMouseMove(pointer({ movementX: 25, movementY: 0 }));
    const free = input.consumeLook().dx;
    input.mining = true;
    input.handleMouseMove(pointer({ movementX: 25, movementY: 0 }));
    const whileMining = input.consumeLook().dx;
    expect(whileMining).toBeCloseTo(free);
  });

  it('falls back to pointer deltas when movementX/Y is unavailable', () => {
    const input = new Input();
    input.setActive(true);
    input.capture();
    input.handleMouseMove(pointer({ clientX: 100, clientY: 100 })); // seeds the reference point
    input.handleMouseMove(pointer({ clientX: 112, clientY: 106 }));
    expect(input.lookDX).toBeCloseTo(12 * LOOK_PER_PIXEL);
    expect(input.lookDY).toBeCloseTo(6 * LOOK_PER_PIXEL);
  });

  it('a zero-movement event never invents a look delta', () => {
    const input = new Input();
    input.setActive(true);
    input.capture();
    input.handleMouseMove(pointer({ clientX: 100, clientY: 100 }));
    input.handleMouseMove(pointer({ clientX: 100, clientY: 100 }));
    expect(input.lookDX).toBe(0);
    expect(input.lookDY).toBe(0);
  });

  it('respects the invert-Y setting', () => {
    const input = new Input();
    input.setActive(true);
    input.invertY = true;
    input.capture();
    input.handleMouseMove(pointer({ movementX: 0, movementY: 10 }));
    expect(input.lookDY).toBeCloseTo(-10 * LOOK_PER_PIXEL);
  });

  it('ignores an implausible coordinate jump in fallback mode', () => {
    // Without pointer lock the deltas come from clientX/Y. A 900 px jump between two events is the
    // cursor appearing on another monitor, and it used to snap the camera around.
    const input = new Input();
    input.setActive(true);
    input.capture(); // no document in node => the cursor-hidden fallback
    input.handleMouseMove(pointer({ clientX: 100, clientY: 100 }));
    expect(input.consumeLook().dx).toBe(0);
    input.handleMouseMove(pointer({ clientX: 140, clientY: 100 })); // 40 px = 0.70 rad, event-capped
    expect(input.consumeLook().dx).toBeGreaterThan(0.3);
    input.handleMouseMove(pointer({ clientX: 1000, clientY: 100 })); // a teleport, not a swing
    expect(input.consumeLook().dx).toBe(0);
  });

  it('clamps one event so a stray warp cannot spin the world', () => {
    expect(4000 * LOOK_PER_PIXEL).toBeGreaterThan(MAX_LOOK_PER_EVENT);
    const input = new Input();
    input.setActive(true);
    input.capture();
    input.handleMouseMove(pointer({ movementX: 4000, movementY: -4000 }));
    expect(input.lookDX).toBe(MAX_LOOK_PER_EVENT);
    expect(input.lookDY).toBe(-MAX_LOOK_PER_EVENT);
  });

  it('drops garbage deltas instead of poisoning the camera with NaN', () => {
    expect(clampStep(NaN)).toBe(0);
    expect(clampStep(Infinity)).toBe(0);
    expect(clampStep(0.2)).toBe(0.2);

    const input = new Input();
    input.setActive(true);
    input.capture();
    input.handleMouseMove({
      movementX: NaN,
      movementY: undefined as unknown as number,
      clientX: 10,
      clientY: 10,
      getModifierState: () => false,
    } as unknown as MouseEvent);
    expect(Number.isFinite(input.lookDX)).toBe(true);
    expect(Number.isFinite(input.lookDY)).toBe(true);
  });

  it('caps a whole frame, so a backlog of events cannot turn into a spin', () => {
    // Per-event clamping (above) rejects one absurd event. This rejects the other shape of the report
    // "sensitivity jumps while holding the mouse button": many ordinary events arriving between two
    // frames — a hitch, a background tab, a browser that queues input while the button is held — whose
    // sum would be several full turns of the head in a single frame.
    const input = new Input();
    input.setActive(true);
    input.capture();
    for (let i = 0; i < 40; i++) input.addLook(0.05, 0);
    const drained = input.consumeLook();
    expect(Math.abs(drained.dx)).toBeLessThanOrEqual(MAX_LOOK_PER_FRAME + 1e-9);
    expect(input.framesClamped).toBe(1);
    // The excess is dropped, not deferred: a look the player did not ask for must not arrive next frame.
    expect(input.consumeLook().dx).toBe(0);
    // Ordinary look — anything under the cap — must pass through untouched.
    input.addLook(0.02, -0.01);
    const normal = input.consumeLook();
    expect({ dx: normal.dx, dy: normal.dy }).toEqual({ dx: 0.02, dy: -0.01 });
    expect(input.framesClamped).toBe(1);
  });

  it('accounts for look by source, which is how the double-count was caught', () => {
    // The F3 overlay prints these numbers; the regression this guards is a second look source adding
    // itself to the same gesture (a viewport drag-look that also ran for mouse pointers).
    const input = new Input();
    input.setActive(true);
    input.capture();
    for (let i = 0; i < 10; i++) input.handleMouseMove(pointer({ movementX: 10, movementY: 0 }));
    expect(input.movesSeen).toBe(10);
    expect(input.movesFromMovement).toBe(10);
    expect(input.movesFromClient).toBe(0); // locked: one source, not movementX *and* clientX
    expect(input.radPerMove()).toBeCloseTo(10 * LOOK_PER_PIXEL * input.sensitivity, 6);
    const drained = input.consumeLook();
    expect(drained.sources.ui).toBe(0);
    expect(drained.sources.mouse).toBeCloseTo(10 * 10 * LOOK_PER_PIXEL * input.sensitivity, 5);
    // Nothing arrived through the UI path: a stray viewport drag-look would show up here as `ui` look
    // added on top of the same gesture, which is what made the mouse feel 30% faster while LMB was held.
    expect(drained.sources.ui).toBe(0);
  });
});

describe('movement snapshot (PH-2 sprint, PH-3 jump)', () => {
  it('sprints from Alt/Option+W too (macOS owns the Ctrl combos)', () => {
    // Ctrl+W can close a tab and Ctrl+Space is macOS' input-source switcher, so the page needs an
    // alias that no browser or OS binds: Alt/Option held while moving forward.
    const input = new Input();
    input.setActive(true);
    input.handleKeyDown(key('KeyW'));
    expect(input.move().sprint).toBe(false);
    input.handleKeyDown(key('AltLeft'));
    expect(input.move().sprint).toBe(true);
    input.handleKeyUp(key('AltLeft'));
    expect(input.move().sprint).toBe(false);
  });

  it('sprints from Ctrl+W, from Caps Lock, and from a double-tapped W', () => {
    const input = new Input();
    input.setActive(true);
    input.handleKeyDown(key('KeyW'));
    expect(input.move().sprint).toBe(false);

    input.handleKeyDown(key('ControlLeft'));
    expect(input.move().sprint).toBe(true);
    input.handleKeyUp(key('ControlLeft'));
    expect(input.move().sprint).toBe(false);

    // Ctrl+Space is a system shortcut on macOS, so the classic combo cannot be the only way in
    input.handleKeyDown(key('KeyW', { caps: true }));
    expect(input.move().sprint).toBe(true);
    input.handleKeyDown(key('KeyW', { caps: false }));
    input.handleKeyUp(key('CapsLock'));

    // double-tap W (the Minecraft convention)
    const tap = new Input();
    tap.setActive(true);
    tap.handleKeyDown(key('KeyW'));
    tap.handleKeyUp(key('KeyW'));
    tap.handleKeyDown(key('KeyW'));
    expect(tap.move().sprint).toBe(true);
    tap.handleKeyUp(key('KeyW'));
    expect(tap.move().sprint).toBe(false);
  });

  it('sprint and jump are independent: Ctrl+W held + Space taps', () => {
    const input = new Input();
    input.setActive(true);
    input.handleKeyDown(key('ControlLeft'));
    input.handleKeyDown(key('KeyW'));
    expect(input.move().sprint).toBe(true);
    expect(input.move().jump).toBe(false);
    input.handleKeyDown(key('Space'));
    const held = input.move();
    expect(held.sprint && held.jump).toBe(true);
  });

  it('a short Space tap still counts between two simulation ticks', () => {
    const input = new Input();
    input.setActive(true);
    input.handleKeyDown(key('Space'));
    input.handleKeyUp(key('Space')); // released before the next tick sampled it
    expect(input.move().jump).toBe(true);
  });

  it('a stale tap does not fire seconds later', () => {
    const input = new Input();
    input.setActive(true);
    input.handleKeyDown(key('Space'));
    input.handleKeyUp(key('Space'));
    (input as unknown as { jumpPressedAt: number }).jumpPressedAt -= 10_000;
    expect(input.move().jump).toBe(false);
  });

  it('merges touch controls with the keyboard', () => {
    const input = new Input();
    input.setActive(true);
    input.touch.x = 0.4;
    input.touch.y = -1;
    input.touch.sprint = true;
    const m = input.move();
    expect(m.forward).toBeCloseTo(1);
    expect(m.right).toBeCloseTo(0.4);
    expect(m.sprint).toBe(true);
  });

  it('sneak is Shift and descend-in-flight is C', () => {
    const input = new Input();
    input.setActive(true);
    input.handleKeyDown(key('ShiftLeft'));
    input.handleKeyDown(key('KeyC'));
    const m = input.move();
    expect(m.sneak).toBe(true);
    expect(m.down).toBe(true);
  });

  it('wheel and digits reach the app as hotbar changes', () => {
    const input = new Input();
    input.setActive(true);
    const wheel: number[] = [];
    input.onWheel = (d) => wheel.push(d);
    input.handleWheel({ deltaY: 12 } as WheelEvent);
    input.handleWheel({ deltaY: -30 } as WheelEvent);
    expect(wheel).toEqual([1, -1]);
    expect(input.consumeWheel()).toBe(0); // the app reads the accumulated value once per tick
  });
});

/**
 * The Safari report: the mouse goes wild while *any* button is held — right, middle, even the browser
 * back/forward buttons — and is normal the instant the button comes up. Chrome never shows it.
 *
 * The cause is not in this file's look maths; it is the engine's own pointer-lock emulation giving up
 * during a button-held drag. On macOS a lock is implemented by hiding the cursor and pinning it, and a
 * press can hand the mouse stream over to the engine's drag machinery, where the pinning and the
 * raw-delta substitution stop applying. The page is never told: `pointerlockchange` stays quiet,
 * `pointerLockElement` stays set, and `movementX` becomes cursor travel with the OS's acceleration curve
 * on it — accumulating, because nothing is recentring any more. That is what makes it a skyrocket rather
 * than a percentage, why any button does it, and why no ceiling applied to the numbers can help: the
 * numbers are the lie.
 *
 * So the game detects the one observable consequence — the cursor moving while we are told it is pinned —
 * and stops using the lock, keeping the player in the world rather than pausing them out of it.
 */
describe('a pointer lock that is not really holding (BI-2)', () => {
  const move = (o: { mx?: number; my?: number; cx?: number; cy?: number; buttons?: number; t?: number }) =>
    ({
      movementX: o.mx ?? 0,
      movementY: o.my ?? 0,
      clientX: o.cx ?? 400,
      clientY: o.cy ?? 300,
      buttons: o.buttons ?? 0,
      timeStamp: o.t ?? 1000,
      getModifierState: () => false,
    }) as unknown as MouseEvent;

  /**
   * Under a working lock: the world owns the mouse, device counts flow, and the cursor is pinned. There is
   * no document in Node, so `capture()` takes the cursor-hidden path — which sets the same `locked` flag the
   * locked path would, and `usingLock` is set by hand to describe the state under test.
   */
  const lockedInput = () => {
    const input = new Input();
    input.setActive(true);
    input.capture();
    input.usingLock = true;
    return input;
  };

  it('looks around normally while the cursor stays pinned', () => {
    const input = lockedInput();
    for (let i = 0; i < 20; i++) input.handleMouseMove(move({ mx: 8, my: 0, t: 100 + i }));
    expect(input.pointerLockUnreliable).toBe(false);
    expect(input.lockDriftEvents).toBe(0);
    expect(input.movesSeen).toBe(20);
    expect(input.consumeLook().dx).toBeGreaterThan(0);
  });

  it('does not mistake the browser re-centring the cursor for a broken lock', () => {
    const input = lockedInput();
    input.handleMouseMove(move({ mx: 6, cx: 400, t: 1 }));
    input.handleMouseMove(move({ mx: 6, cx: 400, t: 2 }));
    // One enormous step: this is what the lock grant itself looks like.
    input.handleMouseMove(move({ mx: 6, cx: 900, t: 3 }));
    input.handleMouseMove(move({ mx: 6, cx: 900, t: 4 }));
    input.handleMouseMove(move({ mx: 6, cx: 900, t: 5 }));
    expect(input.pointerLockUnreliable).toBe(false);
  });

  it('gives up on the lock when the cursor runs, and keeps the player in the world', () => {
    const input = lockedInput();
    let degraded = 0;
    input.onLookDegraded = () => degraded++;
    // The signature of the bug: the page's own coordinates advance event after event while `movementX`
    // keeps arriving, which is only possible if the cursor is being drawn and moved.
    for (let i = 0; i < 10; i++) input.handleMouseMove(move({ mx: 34 + i * 12, cx: 400 + i * 90, t: 200 + i }));
    expect(input.pointerLockUnreliable).toBe(true);
    expect(input.usingLock).toBe(false);
    expect(input.locked).toBe(true); // our correction, not the player's Escape: no pause, no loss of game
    expect(input.onLookDegraded).toBeTruthy();
    expect(degraded).toBe(1);
    expect(input.lockDriftPx).toBeGreaterThan(100);
    // ...and look still works, now measured off the cursor itself.
    input.handleMouseMove(move({ mx: 0, cx: 1100, cy: 300, t: 900 }));
    expect(Math.abs(input.lookDX) + Math.abs(input.lookDY)).toBeGreaterThan(0);
  });

  it('never asks for the lock again after giving up on it', () => {
    // A minimal stand-in for the browser: enough surface for attach()/capture() to run against.
    let requests = 0;
    const canvas = {
      addEventListener: () => {},
      removeEventListener: () => {},
      requestPointerLock: () => {
        requests++;
        return undefined;
      },
    } as unknown as HTMLCanvasElement;
    const doc = {
      pointerLockElement: null,
      body: { classList: { toggle: () => {} } },
      addEventListener: () => {},
      removeEventListener: () => {},
      exitPointerLock: () => {},
    } as unknown as Document;
    const had = 'document' in globalThis;
    const before = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = doc;
    try {
      const input = new Input();
      input.setCanvas(canvas);
      input.setActive(true);
      input.pointerLockUnreliable = true;
      input.capture();
      expect(requests).toBe(0); // straight to the cursor-hidden path, quietly
      expect(input.locked).toBe(true);
      // Turning it back on is the player's call, and the detection gets to re-earn the verdict.
      input.setLockMouse(true);
      expect(input.pointerLockUnreliable).toBe(false);
    } finally {
      if (had) (globalThis as Record<string, unknown>).document = before;
      else delete (globalThis as Record<string, unknown>).document;
    }
  });

  it('takes the button press away from the browser instead of letting it start a drag', () => {
    // The other half of the fix, and the cheaper one: a press must not become a text-selection or element
    // drag session, because that reroute is what breaks the engine's own lock handling in the first place.
    let prevented = 0;
    const input = new Input();
    input.setActive(true);
    input.handleMouseDown({
      button: 0,
      preventDefault: () => prevented++,
    } as unknown as MouseEvent);
    expect(prevented).toBe(1);
    expect(input.mining).toBe(true);
    input.handleMouseUp({ button: 0, preventDefault: () => {} } as unknown as MouseEvent);
    expect(input.mining).toBe(false);
    // Right button drives placing; middle and the browser back/forward buttons drive nothing, which is
    // exactly why "any button does it" pointed at the press rather than at an action.
    input.handleMouseDown({ button: 2, preventDefault: () => prevented++ } as unknown as MouseEvent);
    expect(input.placing).toBe(true);
    input.handleMouseDown({ button: 1, preventDefault: () => prevented++ } as unknown as MouseEvent);
    expect(input.mining).toBe(false);
  });
});

/**
 * The dead-mouse report: *"when I create a new world the mouse doesn't get activated — I can't look
 * around, even clicking the screen does nothing; only pressing Escape and resuming fixes it."*
 *
 * A world starts out already on screen `none`, so the `setScreen('none')` transition that normally
 * hands the mouse over never runs, and `setActive(true)` after the load was a no-op because starting
 * the loop had already handed the keyboard over. `wantCapture` — "the world wants the mouse and the
 * player has not clicked into it yet" — was raised by nothing and answered by nobody, so the mouse
 * stayed free and `mouseMove` threw every delta away. Escape-and-resume worked because *that* path
 * goes through `setScreen('none')`, which does capture.
 *
 * Browsers only hand over the pointer inside a user gesture, so the fix is the missing handshake: ask
 * for the capture when the world comes up (`requestCapture()`), and take it at the first click or key
 * press. Escape is deliberately excluded — its job is to pause, which wants the cursor back.
 */
describe('a fresh world takes the mouse on the first gesture (dead-mouse regression)', () => {
  const press = (button = 0) => ({ button, preventDefault: () => {} }) as unknown as MouseEvent;

  it('a click into the world takes the mouse that requestCapture() asked for', () => {
    const input = new Input();
    input.setActive(true);
    // The world is on screen and owns the keyboard, but no browser hands over a pointer without a
    // gesture, so nothing is captured yet.
    expect(input.locked).toBe(false);

    input.requestCapture();
    input.handleMouseDown(press());
    expect(input.locked).toBe(true);
    expect(input.wantCapture).toBe(false);
    // The press that hands over the mouse is not also a swing of the pick…
    expect(input.mining).toBe(false);
    // …the next one is, and look has been live since the click.
    input.handleMouseDown(press());
    expect(input.mining).toBe(true);
    input.handleMouseMove(pointer({ movementX: 12, movementY: -6 }));
    expect(input.lookDX).toBeCloseTo(12 * LOOK_PER_PIXEL);
    expect(input.lookDY).toBeCloseTo(-6 * LOOK_PER_PIXEL);
  });

  it('a key press takes it too, so a working keyboard never comes with a dead mouse', () => {
    const input = new Input();
    input.setActive(true);
    input.requestCapture();
    input.handleKeyDown(key('KeyW'));
    expect(input.locked).toBe(true);
  });

  it('Escape does not take it, because it is about to pause and needs the cursor back', () => {
    const input = new Input();
    input.setActive(true);
    input.requestCapture();
    input.onKeyDown = (code) => {
      if (code === 'Escape') input.setActive(false); // what Game.setScreen('pause') does
    };
    input.handleKeyDown(key('Escape'));
    expect(input.locked).toBe(false);
    expect(input.wantCapture).toBe(false);
  });

  it('no capture is requested while touch controls are on: a tap is not a cursor', () => {
    // A tap reaches the page as a `mousedown` as well. Grabbing the pointer for a finger would hide a
    // cursor that was never there and switch the look source out from under drag-to-look.
    const input = new Input();
    input.setActive(true);
    input.touch.enabled = true;
    input.requestCapture();
    input.handleMouseDown(press());
    input.handleKeyDown(key('KeyW'));
    expect(input.locked).toBe(false);
  });

  it('handing the keyboard to a menu cancels a pending request', () => {
    const input = new Input();
    input.setActive(true);
    input.requestCapture();
    input.setActive(false); // the pause menu took over before the player clicked
    expect(input.wantCapture).toBe(false);
    input.setActive(true);
    expect(input.locked).toBe(false); // re-owning the keyboard is not itself a capture
    input.handleMouseDown(press());
    expect(input.mining).toBe(true); // a click that is not a capture is a normal click again
  });

  it('capturing directly (resume from pause) needs no pending request', () => {
    const input = new Input();
    input.setActive(true);
    input.capture();
    expect(input.locked).toBe(true);
    expect(input.wantCapture).toBe(false);
  });
});
