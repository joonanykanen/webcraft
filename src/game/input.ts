/** Input: keyboard + captured-mouse look (PH-1), wheel, gamepad (PH-7) and touch overrides (UI-4). */
import {
  LOCK_SETTLE_MS,
  LOOK_PER_PIXEL,
  MAX_CLIENT_JUMP,
  MAX_LOOK_PER_EVENT,
  MAX_LOOK_PER_FRAME,
} from '../core/constants.js';

export type KeyHandler = (code: string, evt: KeyboardEvent) => void;

/**
 * Every place that can rotate the camera. `consumeLook()` reports how much each contributed since
 * the last read, because the "sensitivity rises while I hold the mouse button" bug was two look
 * sources adding up — and with no accounting there was no way to see which one was lying.
 */
export type LookSource = 'mouse' | 'touchDrag' | 'gamepad' | 'ui';
export type LookMix = Record<LookSource, number>;

/** How much the look pipeline mediates the incoming stream — see `Input.lookMode`. */
export type LookMode = 'session' | 'adaptive' | 'raw';

/** Look totals for one button state (nothing held / some button held). */
export interface LookWindow {
  /** mousemove events measured in this state */
  events: number;
  /** movement counts (or client px, when the event carried none) summed in this state */
  counts: number;
  /** radians actually handed to the camera in this state */
  rad: number;
  /** events trimmed by the ceiling, or dropped while pointer lock settled */
  rejected: number;
  /**
   * Events measured but NOT handed to the camera, because the world did not own the mouse at that
   * moment. Counted on purpose: "held shows 40 events and 200 counts but 0 rad" is the fingerprint of
   * losing capture while a button is down — one of the hypotheses for the spike — and an instrument that
   * recorded nothing in that state would make the bug look absent.
   */
  discarded: number;
}

export interface LookStats {
  free: LookWindow;
  held: LookWindow;
  /** events seen twice (same timeStamp and payload) — the fingerprint of a duplicated listener */
  dupEvents: number;
  /** most mousemove events observed between two consumeLook() calls (input coalescing) */
  maxPerFrame: number;
  /** events swallowed because they arrived inside LOCK_SETTLE_MS of the lock being granted */
  settleDropped: number;
  /** pointerlockchange/pointerlockerror transitions, and how many landed just after a button press */
  lockChanges: number;
  lockChangesWhileHeld: number;
  /** the `buttons` bitmask of the most recent mousemove */
  buttons: number;
}

const emptyWindow = (): LookWindow => ({ events: 0, counts: 0, rad: 0, rejected: 0, discarded: 0 });

export function newLookStats(): LookStats {
  return {
    free: emptyWindow(),
    held: emptyWindow(),
    dupEvents: 0,
    maxPerFrame: 0,
    settleDropped: 0,
    lockChanges: 0,
    lockChangesWhileHeld: 0,
    buttons: 0,
  };
}
export const emptyLookMix = (): LookMix => ({ mouse: 0, touchDrag: 0, gamepad: 0, ui: 0 });

const GAME_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyE',
  'KeyQ',
  'KeyF',
  'KeyR',
  'KeyC',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'AltLeft',
  'AltRight',
  'Tab',
  'F3',
  'Escape',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
]);

export interface MoveState {
  forward: number;
  right: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
  up: boolean;
  down: boolean;
}

/**
 * One mousemove event may never turn the camera further than this (radians).
 * Also drops garbage: a non-finite delta once turned the whole player NaN — an unplayable world.
 */
export function clampStep(radians: number): number {
  if (!Number.isFinite(radians)) return 0;
  if (radians > MAX_LOOK_PER_EVENT) return MAX_LOOK_PER_EVENT;
  if (radians < -MAX_LOOK_PER_EVENT) return -MAX_LOOK_PER_EVENT;
  return radians;
}

/** A press of this key still counts as "just pressed" for this long (taps can fit between ticks). */
const JUMP_BUFFER_MS = 140;

/**
 * Mouse look **without** the Pointer Lock API.
 *
 * `requestPointerLock()` is what made Chrome paint its "Your mouse pointer is hidden…" banner, and
 * the first Escape was eaten by the browser to dismiss that banner — so pausing needed two presses.
 * Here we only hide the cursor over the page and read raw movement deltas: in the world the pointer
 * is invisible and drives the camera, in any menu it is visible again, and Escape always means
 * "pause" on the very first press.
 */
export class Input {
  readonly down = new Set<string>();
  /** True while the world owns the mouse (cursor hidden, movement drives the camera). */
  locked = false;
  /** True specifically while the *Pointer Lock* API owns the cursor (rather than the fallback). */
  usingLock = false;
  active = false; // false while a menu/screen owns the keyboard
  uiKeys = false; // true while the inventory/chest panel is open (E and Escape still reach the game)
  mining = false;
  placing = false;
  wheel = 0;
  lookDX = 0;
  lookDY = 0;
  private lookBySource: LookMix = emptyLookMix();
  /** How many mousemove events have actually reached the handler — divides into the look total to
   * give rad/px, which is the number that exposes double-counted input (see the F3 `look` line). */
  movesSeen = 0;
  /** `mousemove` events that drove the camera from `movementX/Y` vs from `clientX/Y` deltas. The two
   * are not the same animal: movement deltas are device counts, clientX deltas measure the pointer's
   * travel — which can be warped by focus changes, other monitors, or an engine that never really
   * captured the mouse. If `movesFromClient` is nonzero while you think you are locked, the look input
   * is coming from the wrong place. F3 prints both. */
  movesFromMovement = 0;
  movesFromClient = 0;
  /** Accumulated mouse-derived look in radians (|dx| + |dy|), for rad/px above and the F3 line. */
  sessionLookFromMouse = 0;

  /**
   * Look accounting split by whether a mouse button is held (BI-2).
   *
   * The report: *any* button — left, right, middle, browser-back/forward — makes the mouse far more
   * sensitive while it is down, and releasing it puts things back. That rules out the actions bound to
   * the buttons (nothing is bound to middle/back/forward) and leaves two families of cause, which need
   * different fixes:
   *
   *   (a) the *deltas* get bigger during a drag — the OS re-applies pointer acceleration to a
   *       button-held drag, or pointer lock quietly falls back to the cursor-hidden path;
   *   (b) *we* apply them differently — a listener attached twice, a second look source, or a ceiling
   *       that only bites in one of the two states.
   *
   * `rad / count` separates them, because it is computed per state: unchanged between free and held
   * means the events themselves changed (a); different means our maths changed (b). Reading it needs no
   * measurement of the physical mouse, and needs nothing from a test environment that cannot reproduce
   * the bug — just wiggle the mouse the same way with and without a button held, and read the F3 lines.
   */
  lookStats: LookStats = newLookStats();
  /**
   * 'session': today's behaviour, fixed ceilings (MAX_LOOK_PER_EVENT per event).
   * 'adaptive': cap against recent button-free motion — if an OS inflates drag deltas, this shaves
   *           them back to the size a free move of the same effort produces.
   * 'raw':    no ceilings at all. A diagnostic, not a mode: if the spike survives 'raw', nothing we do
   *           to the numbers is responsible for it.
   */
  lookMode: LookMode = 'session';
  /** Multiplier on look deltas while a button is held; 1 = off. The one-line test for hypothesis (a):
   * if 0.34 makes the spike go away, the deltas themselves are the problem and the fix is a
   * compensation, not a clamp. */
  dragComp = 1;
  private freeMag: number[] = [];
  private seenEvents = new WeakSet<object>();
  private pressTimes: number[] = [0, 0, 0, 0, 0];
  private lastPressAt = -1e12;
  private eventsThisFrame = 0;
  /** True while we hand the cursor back on purpose (a panel opened) — the app must not pause. */
  expectUnlock = false;
  /** Timestamp of the last Space press so a tap shorter than one tick still jumps. */
  jumpPressedAt = -1e12;
  sensitivity = 1;
  invertY = false;
  /** True when the world asked for the mouse and the player has not clicked into it yet. */
  wantCapture = false;
  /** touch overrides (UI-4) */
  touch = {
    enabled: false,
    x: 0,
    y: 0,
    jump: false,
    sneak: false,
    sprint: false,
    up: false,
    down: false,
    mine: false,
    place: false,
  };
  onKeyDown: KeyHandler | null = null;
  /** Fires when the world gains or loses the mouse (the app pauses on loss). */
  onLockChange: ((locked: boolean) => void) | null = null;
  onWheel: ((delta: number) => void) | null = null;
  private canvas: HTMLCanvasElement | null = null;
  /** -1e9 so the first tap after load is never mistaken for a double-tap. */
  private lastShiftTap = -1e9;
  private lastWTap = -1e9;
  private sprintHold = false;
  /** Caps Lock doubles as sprint: macOS steals Ctrl+Space, so "Ctrl+W then jump" is a dead end there. */
  private capsSprint = false;
  private lastX = 0;
  private lastY = 0;
  private hasLast = false;
  /** When the lock was granted; movement right after it is the browser re-centring the cursor. */
  private lockSettledAt = -1e9;
  /** Prefer Pointer Lock (unbounded look, no second-monitor escape). Falls back automatically. */
  private lockMouse = true;
  private gamepadButtons: boolean[] = [];
  private gamepadAxes = [0, 0, 0, 0];
  private gamepadConnected = false;

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.blur);
    canvas.addEventListener('mousedown', this.mouseDown);
    window.addEventListener('mouseup', this.mouseUp);
    window.addEventListener('mousemove', this.mouseMove);
    document.addEventListener('pointerlockchange', this.lockChanged);
    document.addEventListener('pointerlockerror', this.lockFailed);
    window.addEventListener('wheel', this.wheelHandler, { passive: true });
    window.addEventListener('contextmenu', this.contextMenu);
    // the pointer left the window: the world no longer has it
    document.addEventListener('mouseleave', this.windowLeft);
    window.addEventListener('gamepadconnected', this.gamepadChange);
    window.addEventListener('gamepaddisconnected', this.gamepadChange);
  }

  /** Only the canvas matters for capturing; listeners stay with attach() (tests, embeds). */
  setCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  detach(): void {
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.blur);
    this.canvas?.removeEventListener('mousedown', this.mouseDown);
    window.removeEventListener('mouseup', this.mouseUp);
    window.removeEventListener('mousemove', this.mouseMove);
    document.removeEventListener('pointerlockchange', this.lockChanged);
    document.removeEventListener('pointerlockerror', this.lockFailed);
    window.removeEventListener('wheel', this.wheelHandler);
    window.removeEventListener('contextmenu', this.contextMenu);
    document.removeEventListener('mouseleave', this.windowLeft);
    window.removeEventListener('gamepadconnected', this.gamepadChange);
    window.removeEventListener('gamepaddisconnected', this.gamepadChange);
    this.setCaptured(false, true);
  }

  private contextMenu = (e: Event) => e.preventDefault();

  private keyDown = (e: KeyboardEvent) => {
    this.capsSprint = e.getModifierState?.('CapsLock') ?? this.capsSprint;
    if (e.repeat) {
      if (GAME_KEYS.has(e.code) && this.active) e.preventDefault();
      return;
    }
    if (GAME_KEYS.has(e.code) && this.active) e.preventDefault();
    this.down.add(e.code);
    if (e.code === 'Space' && this.active) this.jumpPressedAt = performance.now();
    if (e.code === 'ShiftLeft') {
      const now = performance.now();
      if (now - this.lastShiftTap < 300) this.sprintHold = true;
      this.lastShiftTap = now;
    }
    if (e.code === 'KeyW') {
      const now = performance.now();
      if (now - this.lastWTap < 300) this.sprintHold = true;
      this.lastWTap = now;
    }
    // Escape always reaches the app — even while a menu owns the keyboard — so ONE press pauses
    // and one press resumes.
    if (this.active || this.uiKeys || e.code === 'Escape') this.onKeyDown?.(e.code, e);
  };

  private keyUp = (e: KeyboardEvent) => {
    this.capsSprint = e.getModifierState?.('CapsLock') ?? this.capsSprint;
    this.down.delete(e.code);
    // releasing the forward key ends a double-tap sprint
    if (e.code === 'KeyW' && !this.isDown('KeyW')) this.sprintHold = false;
  };

  private blur = () => {
    this.down.clear();
    this.mining = false;
    this.placing = false;
    this.sprintHold = false;
    this.release(); // alt-tab: the mouse is gone, and the app pauses on the resulting change
  };

  private windowLeft = () => {
    if (!this.locked) return;
    this.down.clear();
    this.release();
  };

  private mouseDown = (e: MouseEvent) => {
    if (!this.active) return;
    this.pressTimes[e.button] = (this.pressTimes[e.button] ?? 0) + 1;
    this.lastPressAt = performance.now();
    // The action starts even when the cursor is still visible: the click that captures the mouse
    // must also swing the arm, otherwise the very first hit "does nothing".
    if (e.button === 0) this.mining = true;
    if (e.button === 2) this.placing = true;
    if (e.button === 1) this.onKeyDown?.('MouseMiddle', e as unknown as KeyboardEvent);
    if (!this.locked) this.capture();
  };

  private mouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mining = false;
    if (e.button === 2) this.placing = false;
  };

  private mouseMove = (e: MouseEvent) => {
    this.capsSprint = e.getModifierState?.('CapsLock') ?? this.capsSprint;
    // NOTE: there used to be an early "the world does not own the mouse" return here. It is after the
    // button-split accounting now, because an instrument that records nothing while capture is missing
    // cannot distinguish "no events arrived" from "events arrived and were thrown away" — and the second
    // one is a candidate explanation for the button-held spike.
    // movementX/Y is exact; clientX deltas are the fallback (and let tests drive the camera).
    // Some engines report `undefined`/NaN on the first event after a focus change — feeding that
    // into the yaw would make every coordinate NaN (= unplayable world), so sanitise first.
    // ONE measurement source per capture state — this used to switch sources *between events*, and that
    // is how "the mouse gets much more sensitive while the button is held" happens on engines where the
    // two disagree. They are different quantities:
    //   • `movementX/Y` — device counts. Under pointer lock the cursor cannot move, so this is the only
    //     source there is (and with `unadjustedMovement` it is deliberately *not* screen pixels).
    //   • `clientX/Y` deltas — the pointer's travel across the page, in CSS px, with the OS's own
    //     pointer acceleration applied. The only source available when the mouse is merely hidden.
    // Rule: movement deltas are the measurement, `clientX/Y` is a fallback for events that carry none
    // (some engines leave movementX at 0 during a button-held drag, and Safari is unreliable about it).
    // Picking by capture state instead — "locked means movement, free means client" — was tried and is
    // wrong: it throws away the exact measurement in the cursor-hidden fallback, and it makes the look
    // gain depend on what the engine happens to fill in. The per-event and per-frame caps below, plus the
    // source counters, are what actually keep the reported sensitivity spikes from reaching the camera.
    const rawX = Number.isFinite(e.movementX) ? e.movementX : 0;
    const rawY = Number.isFinite(e.movementY) ? e.movementY : 0;
    // Some engines report `undefined`/NaN on the first event after a focus change — feeding that into
    // the yaw would make every coordinate NaN (= unplayable world), so sanitise before using it.
    let dx = 0;
    let dy = 0;
    let usedClient = false;
    if (rawX !== 0 || rawY !== 0) {
      dx = rawX;
      dy = rawY;
    } else if (this.hasLast) {
      dx = e.clientX - this.lastX;
      dy = e.clientY - this.lastY;
      usedClient = true;
      // A jump this big is the cursor teleporting (focus change, another monitor, a drag handed over
      // from outside the window), not a swing of the wrist. Believing it is what used to feel like
      // "the sensitivity rises on its own".
      if (Math.abs(dx) > MAX_CLIENT_JUMP || Math.abs(dy) > MAX_CLIENT_JUMP) {
        dx = 0;
        dy = 0;
      }
    }
    const buttons = typeof e.buttons === 'number' ? e.buttons : 0;
    const win = buttons === 0 ? this.lookStats.free : this.lookStats.held;
    this.lookStats.buttons = buttons;
    // A handler that runs twice for one event feels exactly like a mouse that is twice as sensitive, and
    // nothing else here would show it. Keyed on the event *object*, not its contents: two real events can
    // legitimately carry identical deltas in the same millisecond, while the same object reaching this
    // handler twice can only mean the listener is attached twice.
    if (this.seenEvents.has(e)) this.lookStats.dupEvents++;
    else this.seenEvents.add(e);

    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.hasLast = true;
    this.movesSeen++;
    this.eventsThisFrame++;
    if (this.eventsThisFrame > this.lookStats.maxPerFrame) this.lookStats.maxPerFrame = this.eventsThisFrame;
    if (usedClient) this.movesFromClient++;
    else this.movesFromMovement++;

    const counts = Math.abs(dx) + Math.abs(dy);
    win.events++;
    win.counts += counts;
    if (!this.locked || !this.active) {
      // Measured, not used. Clearing `hasLast` when the world is inactive keeps the next event's
      // client-delta fallback from spanning a long gap.
      win.discarded++;
      if (!this.active) this.hasLast = false;
      return;
    }
    // Reference for 'adaptive': how big are ordinary, button-free movement deltas? Only events that
    // actually drove the camera count as evidence about what the player sees.
    if (buttons === 0 && !usedClient && counts > 0) {
      this.freeMag.push(counts);
      if (this.freeMag.length > 64) this.freeMag.shift();
    }

    // Pointer lock re-centres the cursor on grant; that warp arrives as one enormous delta.
    if (this.usingLock && performance.now() - this.lockSettledAt < LOCK_SETTLE_MS) {
      win.rejected++;
      this.lookStats.settleDropped++;
      return;
    }
    // One gigantic delta (refocussed tab, a drag resumed far away) must never spin the camera.
    const step = LOOK_PER_PIXEL * this.sensitivity;
    const cap = this.lookCap();
    const drag = buttons === 0 ? 1 : this.dragComp;
    const lx = this.capStep(dx * step * drag, cap, win);
    const ly = this.capStep(dy * step * drag, cap, win) * (this.invertY ? -1 : 1);
    win.rad += Math.abs(lx) + Math.abs(ly);
    this.sessionLookFromMouse += Math.abs(lx) + Math.abs(ly);
    this.addLook(lx, ly, 'mouse');
  };

  /** Radians allowed per event in the current look mode (see `lookMode`). */
  private lookCap(): number {
    if (this.lookMode === 'raw') return Infinity;
    if (this.lookMode === 'adaptive') {
      const ref = this.freeMedian() * this.sensitivity * LOOK_PER_PIXEL;
      // Four times the largest ordinary free movement, never below something a slow glance needs,
      // never above the ceiling the game has always used. Ordinary flicks are untouched; a delta that
      // is 6x the biggest free move of comparable effort gets shaved back.
      if (ref <= 0) return MAX_LOOK_PER_EVENT;
      return Math.min(MAX_LOOK_PER_EVENT, Math.max(0.05, ref * 4));
    }
    return MAX_LOOK_PER_EVENT;
  }

  private capStep(v: number, cap: number, win: LookWindow): number {
    if (!Number.isFinite(v)) return 0; // NaN into the yaw = an unplayable world
    const a = Math.abs(v);
    if (a > cap) {
      win.rejected++;
      return Math.sign(v) * cap;
    }
    return v;
  }

  /** Median |counts| of the most recent button-free events (0 when none seen yet). */
  freeMedian(): number {
    if (this.freeMag.length === 0) return 0;
    const sorted = [...this.freeMag].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  /** Radians applied per unit of measured movement, for one state. Compare free vs held on F3. */
  radPerCount(state: 'free' | 'held'): number {
    const w = state === 'free' ? this.lookStats.free : this.lookStats.held;
    return w.counts > 0 ? w.rad / w.counts : 0;
  }

  /** Start the experiment again from zero (so a state comparison is not polluted by history). */
  resetLookStats(): void {
    this.lookStats = newLookStats();
    this.freeMag = [];
    this.seenEvents = new WeakSet<object>();
    this.eventsThisFrame = 0;
  }

  /** Press counts per mouse button index, and how often losing the mouse happened mid-drag. */
  pressCount(button: number): number {
    return this.pressTimes[button] ?? 0;
  }
  lastPressElapsed(): number {
    return performance.now() - this.lastPressAt;
  }

  private wheelHandler = (e: WheelEvent) => {
    if (!this.active) return;
    this.wheel += Math.sign(e.deltaY);
    this.onWheel?.(Math.sign(e.deltaY));
  };

  private gamepadChange = () => {
    this.gamepadConnected = navigator.getGamepads?.().some((p) => !!p) ?? false;
  };

  /** Take the mouse: hide the cursor, movement drives the camera. */
  capture(): void {
    if (this.lockMouse && this.active && typeof document !== 'undefined') {
      this.requestLock();
      return;
    }
    this.setCaptured(true, false);
  }

  /**
   * Ask for Pointer Lock. Needs a user gesture (click, key press); if the browser refuses we keep
   * playing in cursor-hidden mode rather than leaving the player with a dead mouse.
   */
  requestLock(): void {
    if (typeof document === 'undefined' || !this.canvas) return;
    if (document.pointerLockElement === this.canvas) {
      this.lockChanged();
      return;
    }
    this.wantCapture = false;
    try {
      // `unadjustedMovement` asks for raw device deltas (no OS pointer acceleration).
      const req = this.canvas.requestPointerLock({ unadjustedMovement: true }) as unknown;
      if (req && typeof (req as Promise<void>).catch === 'function') {
        (req as Promise<void>).catch(() => this.setCaptured(true, false));
      }
    } catch {
      try {
        this.canvas.requestPointerLock();
      } catch {
        this.setCaptured(true, false);
      }
    }
    // If the engine never answers (no pointerlockchange at all), fall back rather than freeze.
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        if (!this.usingLock && this.active) this.setCaptured(true, false);
      }, 400);
    }
  }

  private lockChanged = (): void => {
    const owned = typeof document !== 'undefined' && document.pointerLockElement === this.canvas;
    this.lookStats.lockChanges++;
    // A lock change within a blink of a button press is the signature of "press the button, lose the
    // exact-delta source, carry on with the accelerated one" — hypothesis (a)'s other form.
    if (performance.now() - this.lastPressAt < 400) this.lookStats.lockChangesWhileHeld++;
    this.usingLock = owned;
    if (owned) {
      this.lockSettledAt = performance.now();
      this.setCaptured(true, false);
    } else {
      // The browser took the cursor back: Escape, an OS switch, a dialog, a drag out of the window.
      // `setCaptured` notifies the app, which is what makes one Escape press pause the game.
      this.setCaptured(false, false);
    }
  };

  private lockFailed = (): void => {
    this.usingLock = false;
    // Locked mode is unavailable — carry on with the cursor-hidden fallback.
    this.setCaptured(true, false);
  };

  /** Give the cursor back (menu, panel, focus loss). */
  release(): void {
    this.wantCapture = false;
    if (typeof document !== 'undefined' && document.pointerLockElement === this.canvas) {
      this.expectUnlock = true;
      document.exitPointerLock();
    }
    this.usingLock = false;
    if (this.locked) this.setCaptured(false, false);
  }

  /** The world wants the mouse; the next click into it captures (used right after loading). */
  requestCapture(): void {
    if (!this.locked) this.wantCapture = true;
  }

  /** Settings: switch between Pointer Lock and the cursor-hidden fallback. */
  /** Radians of mouse-derived look per mousemove event seen, over the whole session. A number that
   * drifts up with a button held (or doubles after reloading a world) means two look sources. */
  radPerMove(): number {
    return this.movesSeen > 0 ? this.sessionLookFromMouse / this.movesSeen : 0;
  }

  setLockMouse(on: boolean): void {
    if (this.lockMouse === on) return;
    this.lockMouse = on;
    if (!this.active) return;
    if (on) {
      this.requestLock();
      return;
    }
    // Turning lock *off* mid-game: give the cursor up first, then take the fallback mode. Doing it
    // in the other order means the arriving pointerlockchange would unlock the world (and pause it)
    // right after we handed it to the fallback.
    if (typeof document !== 'undefined' && document.pointerLockElement === this.canvas) {
      this.expectUnlock = true; // the upcoming lockchange is ours, not a focus loss
      document.exitPointerLock();
      if (typeof window !== 'undefined') window.setTimeout(() => this.setCaptured(true, true), 60);
    } else {
      this.setCaptured(true, true);
    }
    this.usingLock = false;
  }

  private setCaptured(on: boolean, silent: boolean): void {
    const changed = this.locked !== on;
    this.locked = on;
    this.lookDX = 0;
    this.lookDY = 0;
    this.hasLast = false;
    if (!on) {
      this.mining = false;
      this.placing = false;
    }
    if (typeof document !== 'undefined') document.body?.classList.toggle('mouse-captured', on);
    if (silent || this.expectUnlock) {
      this.expectUnlock = false;
      return;
    }
    if (changed) this.onLockChange?.(on);
  }
  /** Public event seams: `attach()` binds these, and tests/embedders can drive them directly. */
  handleKeyDown(e: KeyboardEvent): void {
    this.keyDown(e);
  }

  handleKeyUp(e: KeyboardEvent): void {
    this.keyUp(e);
  }

  handleMouseMove(e: MouseEvent): void {
    this.mouseMove(e);
  }

  handleWheel(e: WheelEvent): void {
    this.wheelHandler(e);
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** Feed synthetic look deltas (touch drag-to-look, UI-4). */
  addLook(dx: number, dy: number, from: LookSource = 'ui'): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.lookDX += dx;
    this.lookDY += dy;
    this.lookBySource[from] += Math.abs(dx) + Math.abs(dy);
  }

  /** Radians per source accumulated since the last `consumeLook()`. */
  lookMix(): LookMix {
    return { ...this.lookBySource };
  }

  /** Frames where the accumulated look hit `MAX_LOOK_PER_FRAME`. Nonzero means the input stream was
   * wilder than a wrist can produce — see the `look` line on the F3 overlay. */
  framesClamped = 0;

  consumeLook(): { dx: number; dy: number; sources: LookMix } {
    // The single funnel every consumer reads from, so this is also the only place a frame-level ceiling
    // can be enforced. Both axes are capped against the same budget: a diagonal sweep carries the
    // larger magnitude and must not slip a rotation through that the frame could not show.
    // 'raw' is the diagnostic mode: nothing mediated, so the ceiling is off as well. F3 says which mode
    // is active, so a reader of these numbers always knows whether they are looking at raw input.
    const magnitude = this.lookMode === 'raw' ? 0 : Math.hypot(this.lookDX, this.lookDY);
    if (magnitude > MAX_LOOK_PER_FRAME) {
      const scale = MAX_LOOK_PER_FRAME / magnitude;
      this.lookDX *= scale;
      this.lookDY *= scale;
      this.framesClamped++;
    }
    const out = { dx: this.lookDX, dy: this.lookDY, sources: this.lookBySource };
    this.lookDX = 0;
    this.lookDY = 0;
    this.lookBySource = emptyLookMix();
    this.eventsThisFrame = 0;
    return out;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Merge keyboard, gamepad and touch into a single movement state. */
  move(): MoveState {
    let forward = (this.isDown('KeyW') ? 1 : 0) - (this.isDown('KeyS') ? 1 : 0);
    let right = (this.isDown('KeyD') ? 1 : 0) - (this.isDown('KeyA') ? 1 : 0);
    let jump = this.isDown('Space') || performance.now() - this.jumpPressedAt < JUMP_BUFFER_MS || this.touch.jump;
    let sneak = this.isDown('ShiftLeft') || this.touch.sneak;
    let up = this.touch.up;
    let down = this.touch.down || this.isDown('KeyC');

    if (this.gamepadConnected) {
      this.pollGamepad();
      const dead = (v: number) => (Math.abs(v) > 0.22 ? v : 0);
      const ax = dead(this.gamepadAxes[0]);
      const ay = dead(this.gamepadAxes[1]);
      if (ax !== 0 || ay !== 0) {
        forward = -ay;
        right = ax;
      }
      jump = jump || !!this.gamepadButtons[0];
      sneak = sneak || !!this.gamepadButtons[1];
      up = up || !!this.gamepadButtons[3];
      down = down || !!this.gamepadButtons[2];
      if (this.gamepadButtons[7]) this.mining = true;
      if (this.gamepadButtons[6]) this.placing = true;
      const lx = dead(this.gamepadAxes[2]);
      const ly = dead(this.gamepadAxes[3]);
      if (lx !== 0 || ly !== 0) {
        this.lookDX += lx * 0.055;
        this.lookDY += ly * 0.044;
      }
    }

    if (this.touch.x !== 0 || this.touch.y !== 0) {
      forward = -this.touch.y;
      right = this.touch.x;
    }
    if (this.touch.mine) this.mining = true;
    if (this.touch.place) this.placing = true;

    // Sprint aliases, because the classic combo is not portable:
    //  - Ctrl+W: works on Windows/Linux; on macOS Ctrl+ combos are claimed by the system/browser
    //    (Ctrl+W can close a tab, and Ctrl+Space is the "select previous input source" shortcut,
    //    which is why the old Ctrl+Space never reached the game).
    //  - Alt/Option+W: free on macOS, and safe on Windows because we preventDefault game keys.
    //  - Caps Lock, and double-tap W: pure page-side state, so they work on every platform.
    const sprint =
      this.isDown('ControlLeft') ||
      this.isDown('ControlRight') ||
      this.isDown('AltLeft') ||
      this.isDown('AltRight') ||
      this.capsSprint ||
      this.sprintHold ||
      this.touch.sprint;
    return { forward, right, jump, sneak, sprint, up, down };
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad) continue;
      for (let i = 0; i < 16; i++) this.gamepadButtons[i] = !!pad.buttons[i]?.pressed;
      for (let i = 0; i < 4; i++) this.gamepadAxes[i] = pad.axes[i] ?? 0;
      return;
    }
  }

  endActions(): void {
    this.mining = false;
    this.placing = false;
  }

  /**
   * Take or give up keyboard/mouse ownership (menus, panels). Handing ownership over clears every
   * held key, otherwise a player who opens a panel while running keeps running forever.
   */
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (!on) {
      this.down.clear();
      this.endActions();
      this.sprintHold = false;
      this.release(); // menus need a visible, clickable cursor
    } else if (this.wantCapture && this.lockMouse && !this.usingLock) {
      // A key press is a guaranteed user gesture: if the mouse got away while playing, take it back
      // the moment the player touches the keyboard so WASD can never look dead.
      this.requestLock();
    }
  }
}
