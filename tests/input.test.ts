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
 * The "any mouse button held makes the mouse far too sensitive" report (BI-2). That cannot be reproduced
 * in a headless browser, so what is tested here is the *instrument* that measures it in the player's own
 * hands: the button-split accounting, the duplicated-event detector, and the two dials (F7 look mode,
 * F8 held-drag multiplier) that turn a report into an experiment. If those work, the two F3 lines
 * (`free` / `held`) are trustworthy, and their `rad/ct` figures say whether the deltas changed or our
 * maths changed — without needing a machine that can feel the bug.
 */
describe('button-held look probe (BI-2)', () => {
  const move = (opts: {
    mx?: number;
    my?: number;
    cx?: number;
    cy?: number;
    buttons?: number;
    t?: number;
  }) =>
    ({
      movementX: opts.mx ?? 0,
      movementY: opts.my ?? 0,
      clientX: opts.cx ?? 100,
      clientY: opts.cy ?? 100,
      buttons: opts.buttons ?? 0,
      timeStamp: opts.t ?? 1000,
      getModifierState: () => false,
    }) as unknown as MouseEvent;

  const captured = () => {
    const input = new Input();
    input.setActive(true);
    input.capture();
    return input;
  };

  it('is symmetric: identical input gives identical rad/ct held or free', () => {
    // The instrument's own baseline. If this ever fails, the harness is lying and its numbers must not
    // be used to judge anything.
    const input = captured();
    for (let i = 0; i < 5; i++) input.handleMouseMove(move({ mx: 4, my: 0, t: 100 + i }));
    for (let i = 0; i < 5; i++) input.handleMouseMove(move({ mx: 4, my: 0, buttons: 1, t: 200 + i }));
    expect(input.radPerCount('free')).toBeCloseTo(input.radPerCount('held'), 12);
    expect(input.lookStats.free.events).toBe(5);
    expect(input.lookStats.held.events).toBe(5);
    expect(input.lookStats.free.counts).toBe(20);
    expect(input.lookStats.held.counts).toBe(20);
  });

  it('counts the same event arriving twice, which is what duplicated listeners look like', () => {
    const input = captured();
    const evt = move({ mx: 6, my: 2, t: 555 });
    input.handleMouseMove(evt);
    input.handleMouseMove(evt); // a second listener attached to the same event
    expect(input.lookStats.dupEvents).toBe(1);
    input.handleMouseMove(move({ mx: 6, my: 2, t: 556 })); // new timeStamp = a real second event
    expect(input.lookStats.dupEvents).toBe(1);
  });

  it('scales only the held state when the drag multiplier is on', () => {
    const input = captured();
    input.dragComp = 0.5;
    input.handleMouseMove(move({ mx: 8, my: 0, t: 10 }));
    const free = input.lookDX;
    input.handleMouseMove(move({ mx: 8, my: 0, buttons: 2, t: 20 }));
    const total = input.lookDX;
    expect(total - free).toBeCloseTo(free * 0.5, 10);
    expect(input.radPerCount('held')).toBeCloseTo(input.radPerCount('free') * 0.5, 10);
  });

  it('shaves oversized deltas back to the size of ordinary free motion when adaptive', () => {
    const input = captured();
    input.lookMode = 'adaptive';
    for (let i = 0; i < 64; i++) input.handleMouseMove(move({ mx: 2, my: 0, t: 1000 + i }));
    expect(input.freeMedian()).toBe(2);
    input.consumeLook(); // drain the reference motion, then measure one event in isolation
    const cap = 2 * LOOK_PER_PIXEL * 4; // four times an ordinary move, in radians
    input.handleMouseMove(move({ mx: 400, my: 0, buttons: 1, t: 5000 }));
    expect(input.lookDX).toBeLessThanOrEqual(cap + 1e-12);
    expect(input.lookDX).toBeGreaterThan(0);
    expect(input.lookStats.held.rejected).toBe(1);
  });

  it('passes a huge delta through untouched in raw mode', () => {
    // The point of the mode: if the spike survives with every ceiling off, nothing we do to the numbers
    // is responsible for it.
    const input = captured();
    input.lookMode = 'raw';
    input.handleMouseMove(move({ mx: 400, my: 0, buttons: 1, t: 4000 }));
    expect(input.lookDX).toBeCloseTo(400 * LOOK_PER_PIXEL, 10);
    expect(input.consumeLook().dx).toBeCloseTo(400 * LOOK_PER_PIXEL, 10); // frame ceiling off too
    expect(input.framesClamped).toBe(0);
  });

  it('counts events it cannot use, so losing capture cannot look like no input', () => {
    // A button press that silently costs us pointer lock is one hypothesis for the spike. If the
    // instrument recorded nothing in that state, the hypothesis would be unfalsifiable from the F3
    // overlay — so events are counted whether or not the world owned the mouse, and the ones it threw
    // away are tallied separately.
    const input = captured();
    input.handleMouseMove(move({ mx: 3, my: 0, buttons: 1, t: 3 }));
    input.setActive(false); // the world let go of the mouse (menu opened, lock lost, focus gone)
    input.handleMouseMove(move({ mx: 9, my: 0, buttons: 1, t: 4 }));
    expect(input.lookStats.held.events).toBe(2);
    expect(input.lookStats.held.counts).toBe(12);
    expect(input.lookStats.held.discarded).toBe(1);
    // The applied total therefore under-counts the measured total: rad/ct drops below what the raw
    // stream would give, which is what "held but no control" looks like on screen.
    expect(input.radPerCount('held')).toBeLessThan(input.lookStats.held.counts * LOOK_PER_PIXEL);
  });

  it('resets without disturbing the session totals that other diagnostics depend on', () => {
    const input = captured();
    input.handleMouseMove(move({ mx: 5, my: 0, buttons: 1, t: 7 }));
    const seen = input.movesSeen;
    input.resetLookStats();
    expect(input.lookStats.held.events).toBe(0);
    expect(input.movesSeen).toBe(seen);
    expect(input.sessionLookFromMouse).toBeGreaterThan(0);
  });
});
