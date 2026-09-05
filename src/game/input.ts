/** Input: keyboard + Pointer-Lock mouse (PH-1), wheel, gamepad (PH-7) and touch overrides (UI-4). */

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

export class Input {
  readonly down = new Set<string>();
  locked = false;
  active = false; // false while a menu/screen owns the keyboard
  uiKeys = false; // true while the inventory/chest panel is open (E and Escape still reach the game)
  mining = false;
  placing = false;
  wheel = 0;
  lookDX = 0;
  lookDY = 0;
  /** True while we intentionally give up the pointer (panel, tutorial card). */
  expectUnlock = false;
  /** Timestamp of the last Space press; a tap can begin and end between two sim steps. */
  jumpPressedAt = -1e12;
  sensitivity = 1;
  invertY = false;
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
  onLockChange: ((locked: boolean) => void) | null = null;
  onWheel: ((delta: number) => void) | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private lastShiftTap = -1;
  private lastWTap = -1;
  private sprintHold = false;
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
    document.addEventListener('pointerlockchange', this.lockChange);
    window.addEventListener('gamepadconnected', this.gamepadChange);
    window.addEventListener('gamepaddisconnected', this.gamepadChange);
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
    document.removeEventListener('pointerlockchange', this.lockChange);
    window.removeEventListener('gamepadconnected', this.gamepadChange);
    window.removeEventListener('gamepaddisconnected', this.gamepadChange);
  }

  private contextMenu = (e: Event) => e.preventDefault();

  private keyDown = (e: KeyboardEvent) => {
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
    if (this.active || this.uiKeys) this.onKeyDown?.(e.code, e);
  };

  private keyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
    // releasing the forward key ends a double-tap sprint
    if (e.code === 'KeyW' && !this.isDown('KeyW')) this.sprintHold = false;
  };

  private blur = () => {
    this.down.clear();
    this.mining = false;
    this.placing = false;
    this.sprintHold = false;
  };

  private mouseDown = (e: MouseEvent) => {
    if (!this.active) return;
    if (!this.locked) {
      this.requestLock();
      return;
    }
    if (e.button === 0) this.mining = true;
    if (e.button === 2) this.placing = true;
    if (e.button === 1) this.onKeyDown?.('MouseMiddle', e as unknown as KeyboardEvent);
  };

  private mouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mining = false;
    if (e.button === 2) this.placing = false;
  };

  private mouseMove = (e: MouseEvent) => {
    if (!this.locked || !this.active) return;
    this.lookDX += e.movementX * 0.0022 * this.sensitivity;
    this.lookDY += e.movementY * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1);
  };

  private wheelHandler = (e: WheelEvent) => {
    if (!this.active) return;
    this.wheel += Math.sign(e.deltaY);
    this.onWheel?.(Math.sign(e.deltaY));
  };

  private lockChange = () => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) {
      this.mining = false;
      this.placing = false;
      this.down.clear();
    }
    if (this.expectUnlock) {
      // We handed the mouse to a panel / tutorial card on purpose; the app already knows
      // and must not read this as "the player lost the pointer" (= open the pause screen).
      this.expectUnlock = false;
      return;
    }
    this.onLockChange?.(this.locked);
  };

  private gamepadChange = () => {
    this.gamepadConnected = navigator.getGamepads?.().some((p) => !!p) ?? false;
  };

  requestLock(): void {
    if (!this.canvas || this.locked) return;
    const p = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
  }

  exitLock(): void {
    if (!document.pointerLockElement) return;
    this.expectUnlock = true;
    document.exitPointerLock();
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
    let jump = this.isDown('Space') || this.touch.jump;
    let sneak = this.isDown('ShiftLeft') || this.touch.sneak;
    let up = this.touch.up;
    let down = this.touch.down || this.isDown('KeyC');

    if (this.gamepadConnected) this.pollGamepad();
    if (this.gamepadConnected) {
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
        this.lookDY += ly * 0.045;
      }
    }

    if (this.touch.x !== 0 || this.touch.y !== 0) {
      forward = -this.touch.y;
      right = this.touch.x;
    }
    if (this.touch.mine) this.mining = true;
    if (this.touch.place) this.placing = true;

    const sprint = this.isDown('ControlLeft') || this.sprintHold || this.touch.sprint;
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
   * Take or give up keyboard/mouse ownership (menus, panels, tutorial cards).
   * Handing ownership over clears every held key, otherwise a player who opens a panel
   * while running keeps running forever.
   */
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (!on) {
      this.down.clear();
      this.endActions();
      this.sprintHold = false;
    }
  }
}
