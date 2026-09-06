/** Input: keyboard + captured-mouse look (PH-1), wheel, gamepad (PH-7) and touch overrides (UI-4). */
import { LOOK_PER_PIXEL, MAX_LOOK_PER_EVENT } from '../core/constants.js';

export type KeyHandler = (code: string, evt: KeyboardEvent) => void;

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
  'ControlLeft',
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
  active = false; // false while a menu/screen owns the keyboard
  uiKeys = false; // true while the inventory/chest panel is open (E and Escape still reach the game)
  mining = false;
  placing = false;
  wheel = 0;
  lookDX = 0;
  lookDY = 0;
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
    if (!this.locked || !this.active) {
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.hasLast = false;
      return;
    }
    // movementX/Y is exact; clientX deltas are the fallback (and let tests drive the camera).
    // Some engines report `undefined`/NaN on the first event after a focus change — feeding that
    // into the yaw would make every coordinate NaN (= unplayable world), so sanitise first.
    let dx = Number.isFinite(e.movementX) ? e.movementX : 0;
    let dy = Number.isFinite(e.movementY) ? e.movementY : 0;
    if (dx === 0 && dy === 0 && this.hasLast) {
      dx = e.clientX - this.lastX;
      dy = e.clientY - this.lastY;
    }
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.hasLast = true;
    // One gigantic delta (refocussed tab, a drag resumed far away) used to read as "the
    // sensitivity spikes while the mouse button is held". A single event may never spin the camera.
    const step = LOOK_PER_PIXEL * this.sensitivity;
    this.lookDX += clampStep(dx * step);
    this.lookDY += clampStep(dy * step) * (this.invertY ? -1 : 1);
  };

  private wheelHandler = (e: WheelEvent) => {
    if (!this.active) return;
    this.wheel += Math.sign(e.deltaY);
    this.onWheel?.(Math.sign(e.deltaY));
  };

  private gamepadChange = () => {
    this.gamepadConnected = navigator.getGamepads?.().some((p) => !!p) ?? false;
  };

  /** Take the mouse: hide the cursor, movement drives the camera. No browser banner involved. */
  capture(): void {
    if (this.locked) return;
    this.wantCapture = false;
    this.setCaptured(true, false);
  }

  /** Give the cursor back (menu, panel, focus loss). */
  release(): void {
    this.wantCapture = false;
    if (this.locked) this.setCaptured(false, false);
  }

  /** The world wants the mouse; the next click into it captures (used right after loading). */
  requestCapture(): void {
    if (!this.locked) this.wantCapture = true;
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
  addLook(dx: number, dy: number): void {
    this.lookDX += dx;
    this.lookDY += dy;
  }

  consumeLook(): { dx: number; dy: number } {
    const out = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
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

    // Sprint aliases: Ctrl+W (classic), Caps Lock, or double-tap W. On macOS Ctrl+Space is the
    // system "switch input source" shortcut, so the plain Ctrl combo cannot be the only way.
    const sprint =
      this.isDown('ControlLeft') ||
      this.isDown('ControlRight') ||
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
    }
  }
}
