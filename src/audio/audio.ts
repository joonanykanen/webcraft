/**
 * Audio (AM-2). Every sound is synthesised at runtime with the WebAudio API — no audio files are
 * shipped, and nothing is downloaded. Buses: sfx + ambient, each with its own volume (SV-6).
 */
import type { StepSound } from '../world/blocks.js';

type Ctx = AudioContext;

export class AudioBus {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private ambBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private wind: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private drone: { osc: OscillatorNode; gain: GainNode } | null = null;
  private nextBird = 4;
  private nextNight = 6;
  volume = 0.7;
  ambientVolume = 0.45;
  muted = false;

  /** Must be called from a user gesture (browser autoplay policy). */
  ensure(): boolean {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return true;
    }
    const AC: typeof AudioContext | undefined =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      return false;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = this.ambientVolume;
    this.ambBus.connect(this.master);

    // shared noise buffer
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let s = 0x9e3779b9;
    for (let i = 0; i < len; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      data[i] = (s / 2147483648 - 1) * 0.7;
    }
    this.noiseBuf = buf;
    return true;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }
  setAmbientVolume(v: number): void {
    this.ambientVolume = v;
    if (this.ambBus) this.ambBus.gain.value = v;
  }
  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }
  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }
  now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private noise(dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'bandpass'): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || !this.noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxBus);
    src.start();
    src.stop(ctx.currentTime + dur + 0.02);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slideTo?: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slideTo !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur);
    o.connect(g);
    g.connect(this.sfxBus);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  }

  // ---- one-shots ----
  breakBlock(sound: StepSound): void {
    switch (sound) {
      case 'stone':
        this.noise(0.16, 900 + Math.random() * 400, 1.2, 0.5, 'bandpass');
        break;
      case 'wood':
        this.noise(0.18, 420 + Math.random() * 160, 2.2, 0.45, 'bandpass');
        break;
      case 'grass':
        this.noise(0.13, 2600 + Math.random() * 900, 0.8, 0.3, 'highpass');
        break;
      case 'sand':
        this.noise(0.22, 1200, 0.5, 0.35, 'lowpass');
        break;
      case 'gravel':
        this.noise(0.2, 800, 0.6, 0.4, 'bandpass');
        break;
      case 'snow':
        this.noise(0.16, 3200, 0.6, 0.25, 'highpass');
        break;
      case 'glass':
        this.tone(2400, 0.18, 0.22, 'triangle', 1400);
        this.noise(0.14, 5200, 0.9, 0.3, 'highpass');
        break;
      default:
        this.noise(0.14, 700 + Math.random() * 300, 0.9, 0.4, 'lowpass');
    }
  }

  placeBlock(sound: StepSound): void {
    this.noise(0.09, sound === 'stone' || sound === 'grass' ? 1500 : 900, 1.4, 0.34, 'bandpass');
    this.tone(sound === 'wood' ? 180 : 240, 0.07, 0.14, 'square');
  }

  step(sound: StepSound): void {
    const base = { stone: 1400, wood: 620, grass: 2400, sand: 900, gravel: 1100, snow: 3000, glass: 2000, dirt: 1000, none: 900 };
    this.noise(0.07, base[sound] * (0.85 + Math.random() * 0.3), 0.9, sound === 'grass' ? 0.13 : 0.17, 'bandpass');
  }

  splash(): void {
    this.noise(0.4, 700, 0.6, 0.4, 'lowpass');
    this.tone(500, 0.25, 0.1, 'sine', 180);
  }

  hurt(): void {
    this.tone(320, 0.22, 0.3, 'square', 120);
    this.noise(0.12, 500, 0.7, 0.25, 'lowpass');
  }

  craft(): void {
    this.tone(660, 0.09, 0.2, 'triangle');
    setTimeout(() => this.tone(990, 0.12, 0.18, 'triangle'), 70);
  }

  eat(): void {
    for (let i = 0; i < 3; i++) setTimeout(() => this.noise(0.09, 380 + i * 60, 1.6, 0.24, 'bandpass'), i * 110);
  }

  explode(): void {
    this.noise(0.9, 160, 0.5, 0.85, 'lowpass');
    this.tone(90, 0.7, 0.4, 'sawtooth', 40);
  }

  click(): void {
    this.tone(880, 0.05, 0.12, 'square');
  }

  open(): void {
    this.tone(520, 0.07, 0.12, 'triangle', 720);
  }

  mobSound(kind: 'idle' | 'hurt' | 'hostile'): void {
    if (kind === 'hurt') {
      this.tone(420, 0.16, 0.22, 'square', 200);
      return;
    }
    if (kind === 'hostile') {
      this.tone(140 + Math.random() * 30, 0.5, 0.2, 'sawtooth', 90);
      this.noise(0.4, 300, 0.7, 0.2, 'lowpass');
      return;
    }
    this.tone(520 + Math.random() * 120, 0.16, 0.13, 'triangle', 660);
  }

  levelUp(): void {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.22, 0.16, 'triangle'), i * 90));
  }

  // ---- ambience ----
  startAmbience(): void {
    const ctx = this.ctx;
    if (!ctx || this.wind || !this.noiseBuf || !this.ambBus) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0.0;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.ambBus);
    src.start();
    this.wind = { src, filter, gain };

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 68;
    const dg = ctx.createGain();
    dg.gain.value = 0.0;
    osc.connect(dg);
    dg.connect(this.ambBus);
    osc.start();
    this.drone = { osc, gain: dg };
  }

  /** Called from the simulation tick: shapes wind/night character and schedules critter sounds. */
  tickAmbience(dt: number, night: number, underground: number, rain: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.wind || !this.drone) return;
    const t = ctx.currentTime;
    const targetWind = 0.05 + night * 0.05 + underground * 0.1 + rain * 0.2;
    this.wind.gain.gain.setTargetAtTime(targetWind, t, 0.6);
    this.wind.filter.frequency.setTargetAtTime(320 + underground * 220 + rain * 1400, t, 0.8);
    this.drone.gain.gain.setTargetAtTime(0.02 + underground * 0.05 + night * 0.03, t, 1.4);
    this.drone.osc.frequency.setTargetAtTime(62 + underground * 12, t, 1.5);

    this.nextBird -= dt;
    this.nextNight -= dt;
    if (night < 0.3 && this.nextBird <= 0) {
      this.nextBird = 6 + Math.random() * 14;
      this.tone(1800 + Math.random() * 900, 0.1, 0.06, 'sine', 2600 + Math.random() * 600);
    }
    if (night > 0.6 && this.nextNight <= 0) {
      this.nextNight = 4 + Math.random() * 10;
      this.tone(2400 + Math.random() * 400, 0.07, 0.05, 'triangle', 2100);
    }
  }

  dispose(): void {
    try {
      this.wind?.src.stop();
      this.drone?.osc.stop();
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.wind = null;
    this.drone = null;
  }
}
