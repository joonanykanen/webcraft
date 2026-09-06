/**
 * Renderer: WebGL2 voxel renderer (RD-1 … RD-8), sky dome, day/night, fog, block highlight,
 * mining crack overlay and break particles. Implements the world's MeshSink so the chunk
 * pipeline can upload/evict geometry without knowing anything about Three.js.
 */
import * as THREE from 'three';
import { ATLAS_PX, ATLAS_TILES, CHUNK_SX, CHUNK_SZ, TILE_PX, clamp, smoothstep } from '../core/constants.js';
import { dayNightCurve } from '../core/daynight.js';
import type { MeshData, Settings } from '../core/types.js';
import type { Chunk } from '../world/chunk.js';
import type { MeshSink } from '../world/world.js';
import type { ChunkMesh } from '../world/mesher.js';
import { CRACK_TILES } from '../world/tiles.js';
import { buildAtlasCanvas, tileAverageColor } from './atlas.js';
import { blockHighlightGeometry, voxelCubeGeometry } from './geometry.js';
import { HandViewModel } from './viewmodel.js';
import { CHUNK_FRAG, CHUNK_VERT, SKY_FRAG, SKY_VERT } from './shaders.js';

export interface CameraState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  fov: number;
  /** Walk-bob phase in radians; drives the idle sway of the view model (VII). */
  bob: number;
}

export interface RenderInfo {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  webgl2: boolean;
}

interface ChunkMeshes {
  opaque?: THREE.Mesh;
  water?: THREE.Mesh;
}

const PARTICLE_CAP = 700;

export class Renderer implements MeshSink {
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly webgl2: boolean;

  private atlas: THREE.Texture;
  private uniforms: Record<string, THREE.IUniform>;
  private opaqueMat: THREE.ShaderMaterial;
  private waterMat: THREE.ShaderMaterial;
  private crackMat: THREE.ShaderMaterial;
  private meshes = new Map<number, ChunkMeshes>();
  private skyGroup = new THREE.Group();
  private skyMesh: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private sun: THREE.Sprite;
  private moon: THREE.Sprite;
  private stars: THREE.Points;
  private highlight: THREE.LineSegments;
  private crackMesh: THREE.Mesh | null = null;
  private crackTile = 0;
  private particles: THREE.Points;
  private particlePos: Float32Array;
  private particleCol: Float32Array;
  private particleVel: Float32Array;
  private particleLife: Float32Array;
  private particleHead = 0;
  private particleCount = 0;
  private settings: Settings;
  private timeMs = 0;
  private dayLight = 1;
  private horizonColor = new THREE.Color(0xcfe6ff);
  private topColor = new THREE.Color(0x5b96e0);
  private fogOverride: THREE.Color | null = null;
  private renderDistance = 8;
  private crackGeometry: THREE.BufferGeometry;
  /** Keeps the drawing buffer, the CSS box and the camera aspect in lockstep (see resize()). */
  private resizeObserver: ResizeObserver | null = null;
  /** The player's arm + held item, drawn in its own pass (VII). */
  readonly hand: HandViewModel;

  constructor(private readonly canvas: HTMLCanvasElement, settings: Settings, webgl2: boolean) {
    this.settings = settings;
    this.webgl2 = webgl2;
    const gl = webgl2 ? 'webgl2' : 'webgl';
    this.three = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
      context: (canvas.getContext(gl as WebGLContextType, {
        antialias: false,
        alpha: false,
        stencil: false,
        depth: true,
        powerPreference: 'high-performance',
      }) as WebGLRenderingContext | WebGL2RenderingContext | null) ?? undefined,
    });
    this.three.setPixelRatio(Math.min(window.devicePixelRatio || 1, webgl2 ? 2 : 1.25));
    this.three.setClearColor(0x0a1420, 1);
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.08, 400);
    this.camera.rotation.order = 'YXZ';

    const atlasCanvas = buildAtlasCanvas();
    this.atlas = new THREE.CanvasTexture(atlasCanvas);
    this.atlas.magFilter = THREE.NearestFilter; // RD-3 crisp pixels
    this.atlas.minFilter = THREE.NearestFilter;
    this.atlas.generateMipmaps = false;
    // Keep the atlas un-flipped. The block shader picks a tile as `tilePos = (aTile % 8, floor(aTile / 8))`,
    // i.e. a row counted down the canvas from the top, so a whole-texture flip would resolve every tile
    // to its mirrored row (I tried: magenta checkerboard). The vertical direction is corrected *inside*
    // the tile instead — see the `1.0 - aUV.y` line in CHUNK_VERT.
    this.atlas.flipY = false;
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.needsUpdate = true;

    this.uniforms = {
      uMap: { value: this.atlas },
      uTime: { value: 0 },
      uDayLight: { value: 1 },
      uFogColor: { value: this.horizonColor },
      uFogNear: { value: 120 },
      uFogFar: { value: 200 },
      uAlphaTest: { value: 0.5 },
      uOpacity: { value: 1 },
      uColorEdge: { value: settings.colorblindEdges ? 1 : 0 },
      uAmbient: { value: 0.14 },
    };

    const fancy = settings.quality === 'fancy' && webgl2;
    this.opaqueMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: CHUNK_VERT,
      fragmentShader: CHUNK_FRAG,
      defines: fancy ? { FANCY: '' } : {},
      side: THREE.FrontSide,
    });
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: CHUNK_VERT,
      fragmentShader: CHUNK_FRAG,
      defines: { WATER: '' },
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide, // visible from underneath when swimming
    });
    this.crackMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: CHUNK_VERT,
      fragmentShader: CHUNK_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    // ---- sky (RD-5) ----
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: this.topColor },
        uHorizon: { value: this.horizonColor },
        uSunColor: { value: new THREE.Color(0xfff0c8) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunGlow: { value: 1 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.skyMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.skyMat);
    this.skyMesh.renderOrder = -1000;
    this.skyMesh.frustumCulled = false;
    this.skyGroup.add(this.skyMesh);

    this.sun = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeDiscTexture(false), transparent: true, depthTest: true, depthWrite: false }),
    );
    this.moon = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeDiscTexture(true), transparent: true, depthTest: true, depthWrite: false }),
    );
    this.sun.renderOrder = -990;
    this.moon.renderOrder = -991;
    this.skyGroup.add(this.sun, this.moon);

    this.stars = makeStars();
    this.stars.renderOrder = -995;
    this.skyGroup.add(this.stars);
    this.scene.add(this.skyGroup);

    // ---- block highlight (BI-1) ----
    this.highlight = new THREE.LineSegments(
      blockHighlightGeometry(),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.75, depthTest: true }),
    );
    this.highlight.visible = false;
    this.highlight.frustumCulled = false;
    this.scene.add(this.highlight);

    this.crackGeometry = voxelCubeGeometry({ size: 1.004, top: 0, bottom: 0, side: 0, sky: 15, block: 15, shade: 1 });

    // ---- first-person view model (VII) ----
    this.hand = new HandViewModel(this.opaqueMat);

    // ---- particles ----
    this.particlePos = new Float32Array(PARTICLE_CAP * 3);
    this.particleCol = new Float32Array(PARTICLE_CAP * 3);
    this.particleVel = new Float32Array(PARTICLE_CAP * 3);
    this.particleLife = new Float32Array(PARTICLE_CAP);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.particlePos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(this.particleCol, 3));
    pg.setDrawRange(0, 0);
    this.particles = new THREE.Points(
      pg,
      new THREE.PointsMaterial({
        size: 0.16,
        vertexColors: true,
        sizeAttenuation: true,
        map: makePixelTexture(),
        alphaTest: 0.4,
        transparent: false,
      }),
    );
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);

    this.setRenderDistance(settings.renderDistance);
    // The camera is built with aspect 1. Sizing it here is not optional: until this ran, a fresh
    // world rendered with a square projection on a wide window (everything ~75 % too wide) unless
    // the player happened to resize the window or touch a setting first.
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
    // devicePixelRatio changes with browser zoom and when a window moves to another display; the
    // ResizeObserver only fires when the CSS box changes, so watch the window as well.
    window.addEventListener('resize', this.onWindowResize);
  }

  private onWindowResize = (): void => this.resize();

  // ------------------------------------------------------------ capability probe
  static probe(): { webgl2: boolean; webgl1: boolean; uintIndex: boolean } {
    const c = document.createElement('canvas');
    const gl2 = c.getContext('webgl2');
    if (gl2) return { webgl2: true, webgl1: true, uintIndex: true };
    const gl1 = (c.getContext('webgl') || c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl1) return { webgl2: false, webgl1: false, uintIndex: false };
    return { webgl2: false, webgl1: true, uintIndex: !!gl1.getExtension('OES_element_index_uint') };
  }

  // ------------------------------------------------------------ MeshSink
  upload(chunk: Chunk, mesh: ChunkMesh): void {
    let entry = this.meshes.get(chunk.key);
    if (!entry) this.meshes.set(chunk.key, (entry = {}));
    const maxY = maxColumnHeight(chunk);
    this.applySlot(chunk, entry, 'opaque', mesh.opaque, this.opaqueMat, maxY);
    this.applySlot(chunk, entry, 'water', mesh.water, this.waterMat, maxY);
  }

  private applySlot(
    chunk: Chunk,
    entry: ChunkMeshes,
    slot: 'opaque' | 'water',
    data: MeshData | null,
    material: THREE.ShaderMaterial,
    maxY: number,
  ): void {
    const existing = entry[slot];
    if (!data) {
      if (existing) {
        this.scene.remove(existing);
        existing.geometry.dispose();
        delete entry[slot];
      }
      return;
    }
    let mesh = existing;
    if (mesh) {
      (mesh.geometry as THREE.BufferGeometry).dispose();
      mesh.geometry = toGeometry(data, maxY);
    } else {
      mesh = new THREE.Mesh(toGeometry(data, maxY), material);
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.position.set(chunk.cx * CHUNK_SX, 0, chunk.cz * CHUNK_SZ);
      mesh.updateMatrix();
      mesh.renderOrder = slot === 'water' ? 10 : 0;
      this.scene.add(mesh);
      entry[slot] = mesh;
    }
  }

  remove(chunk: Chunk): void {
    const entry = this.meshes.get(chunk.key);
    if (!entry) return;
    for (const mesh of [entry.opaque, entry.water]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.delete(chunk.key);
    chunk.meshOpaque = null;
    chunk.meshWater = null;
  }

  // ------------------------------------------------------------ settings / time
  setSettings(s: Settings): void {
    const qualityChanged = s.quality !== this.settings.quality;
    const distChanged = s.renderDistance !== this.settings.renderDistance;
    this.settings = s;
    this.uniforms.uColorEdge.value = s.colorblindEdges ? 1 : 0;
    if (qualityChanged) {
      const fancy = s.quality === 'fancy' && this.webgl2;
      this.opaqueMat.defines = fancy ? { FANCY: '' } : {};
      this.opaqueMat.needsUpdate = true;
    }
    if (distChanged) this.setRenderDistance(s.renderDistance);
    this.hand.visible = s.showHand;
  }

  setRenderDistance(chunks: number): void {
    this.renderDistance = chunks;
    const far = chunks * CHUNK_SX * 1.35 + 96;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
    this.uniforms.uFogNear.value = far * 0.55;
    this.uniforms.uFogFar.value = far * 0.95;
    this.skyMesh.scale.setScalar(far * 0.98);
    // Sky bodies live on a shell just inside the far plane, and depth-test against the
    // terrain: with the shell at 42 % of `far` the stars floated in front of distant hills.
    const r = far * 0.9;
    this.sun.scale.setScalar(Math.max(26, r * 0.042));
    this.moon.scale.setScalar(Math.max(20, r * 0.033));
    (this.stars.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.stars.scale.setScalar(r / 400);
  }

  /** 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight (RD-5, 10-minute cycle). */
  setTimeOfDay(t: number): { dayLight: number; night: number } {
    const c = dayNightCurve(t);
    const angle = c.t * Math.PI * 2;
    const { day, sunset, night, elev } = c;

    const dayTop = new THREE.Color(0x4f8fdd);
    const dayHorizon = new THREE.Color(0xc8e2ff);
    const nightTop = new THREE.Color(0x05070f);
    const nightHorizon = new THREE.Color(0x121d33);
    const setHorizon = new THREE.Color(0xff9c51);

    this.topColor.copy(nightTop).lerp(dayTop, day);
    // The warm band is deliberately weaker than it looks in isolation: sunrise/sunset sits at
    // day ≈ 0.5, so a strong lerp here stacked on top of the sky's own brightening and made the
    // minutes after dawn the brightest of the whole cycle (+25 % over noon), which read as the
    // world "jumping to late morning" before settling back down.
    this.horizonColor.copy(nightHorizon).lerp(dayHorizon, day).lerp(setHorizon, sunset * 0.34);
    this.uniforms.uFogColor.value = this.fogOverride ?? this.horizonColor;
    (this.skyMat.uniforms.uSunColor.value as THREE.Color).setHex(0xffe9b0).lerp(new THREE.Color(0xff7a3c), sunset * 0.8);
    // Broad halo + tight core, both tied to the sun's own elevation: previously the halo peaked at
    // 1.1 and washed a ~40-degree patch of sky to white, which read as the world suddenly lighting
    // up. It now stays a glow around the disc, and cannot fire while the sun is under the horizon.
    this.skyMat.uniforms.uSunGlow.value = (0.3 + day * 0.5) * smoothstep(-0.22, 0.06, elev);

    const sunDir = new THREE.Vector3(Math.cos(angle), elev, 0.28).normalize();
    (this.skyMat.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    const r = this.camera.far * 0.9;
    this.sun.position.copy(sunDir).multiplyScalar(r);
    this.moon.position.copy(sunDir).multiplyScalar(-r);
    // Fade rather than pop: a hard `visible` flip made the disc appear/disappear mid-sky.
    const sunFade = smoothstep(-0.3, -0.1, elev);
    const moonFade = 1 - smoothstep(0.1, 0.3, elev);
    this.sun.visible = sunFade > 0.01;
    this.moon.visible = moonFade > 0.01;
    (this.sun.material as THREE.SpriteMaterial).opacity = sunFade;
    (this.moon.material as THREE.SpriteMaterial).opacity = moonFade;
    const mat = this.stars.material as THREE.PointsMaterial;
    mat.opacity = night * 0.9;

    this.dayLight = c.dayLight;
    this.uniforms.uDayLight.value = this.dayLight;
    return { dayLight: this.dayLight, night };
  }

  setUnderwater(under: boolean): void {
    this.fogOverride = under ? new THREE.Color(0x1d3f6e) : null;
    this.uniforms.uFogColor.value = this.fogOverride ?? this.horizonColor;
    this.uniforms.uFogNear.value = under ? 0.5 : this.renderDistance * CHUNK_SX * 1.35 * 0.55 + 50;
    const far = this.renderDistance * CHUNK_SX * 1.35 + 96;
    this.uniforms.uFogFar.value = under ? 18 : far * 0.95;
  }

  getDayLight(): number {
    return this.dayLight;
  }

  getSkyColors(): { top: THREE.Color; horizon: THREE.Color } {
    return { top: this.topColor, horizon: this.horizonColor };
  }

  // ------------------------------------------------------------ overlays
  setTarget(block: { x: number; y: number; z: number } | null): void {
    this.highlight.visible = !!block;
    if (block) this.highlight.position.set(block.x + 0.5, block.y + 0.5, block.z + 0.5);
  }

  setMiningProgress(block: { x: number; y: number; z: number } | null, progress: number): void {
    if (!block || progress <= 0.001) {
      if (this.crackMesh) this.crackMesh.visible = false;
      return;
    }
    const stage = clamp(Math.floor(progress * CRACK_TILES.length), 0, CRACK_TILES.length - 1);
    if (!this.crackMesh) {
      this.crackMesh = new THREE.Mesh(this.crackGeometry, this.crackMat);
      this.crackMesh.renderOrder = 20;
      this.scene.add(this.crackMesh);
    }
    if (stage !== this.crackTile || !this.crackMesh.geometry.attributes.aTile) {
      const tiles = this.crackMesh.geometry.attributes.aTile as THREE.BufferAttribute;
      for (let i = 0; i < tiles.count; i++) tiles.setX(i, CRACK_TILES[stage]);
      tiles.needsUpdate = true;
      this.crackTile = stage;
    }
    this.crackMesh.visible = true;
    this.crackMesh.position.set(block.x, block.y, block.z);
  }

  /** Block-break debris (uses the block's atlas colour). */
  spawnBlockParticles(x: number, y: number, z: number, tile: number, count = 14): void {
    const [r, g, b] = tileAverageColor(tile);
    const light = 0.35 + 0.65 * this.dayLight;
    for (let i = 0; i < count; i++) {
      const h = this.particleHead;
      this.particleHead = (this.particleHead + 1) % PARTICLE_CAP;
      this.particleCount = Math.min(this.particleCount + 1, PARTICLE_CAP);
      const p = h * 3;
      this.particlePos[p] = x + 0.5 + (Math.random() - 0.5) * 0.9;
      this.particlePos[p + 1] = y + 0.5 + (Math.random() - 0.5) * 0.9;
      this.particlePos[p + 2] = z + 0.5 + (Math.random() - 0.5) * 0.9;
      this.particleVel[p] = (Math.random() - 0.5) * 3.4;
      this.particleVel[p + 1] = Math.random() * 3.6 + 0.6;
      this.particleVel[p + 2] = (Math.random() - 0.5) * 3.4;
      const shade = 0.75 + Math.random() * 0.45;
      this.particleCol[p] = (r / 255) * shade * light;
      this.particleCol[p + 1] = (g / 255) * shade * light;
      this.particleCol[p + 2] = (b / 255) * shade * light;
      this.particleLife[h] = 0.55 + Math.random() * 0.5;
    }
  }

  updateParticles(dt: number): void {
    let alive = 0;
    for (let i = 0; i < PARTICLE_CAP; i++) {
      if (this.particleLife[i] <= 0) continue;
      this.particleLife[i] -= dt;
      const p = i * 3;
      if (this.particleLife[i] <= 0) continue;
      this.particleVel[p + 1] -= 14 * dt;
      this.particlePos[p] += this.particleVel[p] * dt;
      this.particlePos[p + 1] += this.particleVel[p + 1] * dt;
      this.particlePos[p + 2] += this.particleVel[p + 2] * dt;
      alive++;
    }
    // keep live particles packed at the front of the buffer for a tight draw range
    if (alive === 0) {
      this.particleCount = 0;
      (this.particles.geometry as THREE.BufferGeometry).setDrawRange(0, 0);
    } else {
      compactParticles(
        this.particlePos,
        this.particleCol,
        this.particleVel,
        this.particleLife,
        this.particleHead,
      );
      const geo = this.particles.geometry as THREE.BufferGeometry;
      geo.setDrawRange(0, Math.min(alive, PARTICLE_CAP));
      (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ entities
  addEntityMesh(mesh: THREE.Object3D): void {
    this.scene.add(mesh);
  }
  removeEntityMesh(mesh: THREE.Object3D): void {
    this.scene.remove(mesh);
  }
  entityCube(opts: Parameters<typeof voxelCubeGeometry>[0]): THREE.Mesh {
    return new THREE.Mesh(voxelCubeGeometry(opts), this.opaqueMat);
  }

  /** Held item of the view model (VII) — `0` shows the bare arm. */
  setHeldItem(id: number): void {
    this.hand.setHeld(id);
  }

  /** One arm swing (mining, attacking, placing). */
  swingHand(): void {
    this.hand.swing();
  }

  setHandVisible(v: boolean): void {
    this.hand.visible = v;
  }

  // ------------------------------------------------------------ frame
  /**
   * The size the browser actually scales the canvas into. Measured from the canvas' own CSS box
   * rather than `window.innerWidth`: the box is the thing the backing store must match, and it is
   * the only number that stays correct under future layout changes (letterboxing, panels, Safari's
   * viewport quirks). Returns 0 when detached/hidden so callers can keep the last good size.
   */
  private cssSize(): { w: number; h: number } {
    const w = this.canvas.clientWidth || this.canvas.getBoundingClientRect().width;
    const h = this.canvas.clientHeight || this.canvas.getBoundingClientRect().height;
    if (w >= 1 && h >= 1) return { w: Math.round(w), h: Math.round(h) };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return vw >= 1 && vh >= 1 ? { w: vw, h: vh } : { w: 0, h: 0 };
  }

  /**
   * `width`/`height` are optional: with no arguments the canvas is measured. Passing them is only a
   * hint — the aspect always comes from the live box, so a stale caller can never stretch the frame.
   */
  resize(width?: number, height?: number): void {
    const { w, h } = this.cssSize();
    const useW = w >= 1 ? w : Math.floor(width ?? 0);
    const useH = h >= 1 ? h : Math.floor(height ?? 0);
    if (useW < 1 || useH < 1) return; // hidden or mid-layout: keep whatever we had
    const aspect = useW / useH;
    if (Math.abs(aspect - this.camera.aspect) > 1e-4) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
      this.hand.setAspect(aspect);
    }
    const dpr = Math.min(window.devicePixelRatio || 1, this.webgl2 ? 2 : 1.25);
    const size = this.three.getSize(new THREE.Vector2());
    if (Math.abs(size.x - useW) > 0.5 || Math.abs(size.y - useH) > 0.5 || this.three.getPixelRatio() !== dpr) {
      this.three.setPixelRatio(dpr);
      this.three.setSize(useW, useH, false);
    }
  }

  /** Aspect actually in use, for tests that need to prove the frame is not distorted. */
  get aspect(): number {
    return this.camera.aspect;
  }

  render(cam: CameraState, dt: number): void {
    // `info` resets on every render() call by default, which would make the debug overlay report
    // the two-drawal view-model pass instead of the world. Reset once per frame, then accumulate.
    this.three.info.autoReset = false;
    this.three.info.reset();
    this.timeMs += dt * 1000;
    this.uniforms.uTime.value = this.timeMs / 1000;
    this.camera.position.set(cam.x, cam.y, cam.z);
    this.camera.rotation.y = cam.yaw;
    this.camera.rotation.x = cam.pitch;
    const fov = clamp(cam.fov, 50, 110);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.skyGroup.position.copy(this.camera.position);
    this.updateParticles(dt);
    this.hand.update(dt, cam.bob, this.dayLight);
    this.three.render(this.scene, this.camera);
    // Second pass for the first-person arm (VII): keep the colour buffer, throw away depth, so the
    // hand is always in front of the block the player is pressed against.
    if (this.hand.visible) {
      this.three.autoClear = false;
      this.three.clearDepth();
      this.three.render(this.hand.scene, this.hand.camera);
      this.three.autoClear = true;
    }
  }

  info(): RenderInfo {
    const i = this.three.info;
    return {
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      webgl2: this.webgl2,
    };
  }

  /** JPEG data-URL of the current view for the world list thumbnails (SV-2). */
  captureThumbnail(width = 160, height = 96): string {
    const src = this.three.domElement;
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    ctx.imageSmoothingEnabled = true;
    try {
      ctx.drawImage(src, 0, 0, width, height);
      return c.toDataURL('image/jpeg', 0.6);
    } catch {
      return '';
    }
  }

  atlasTileAverage(tile: number): [number, number, number] {
    return tileAverageColor(tile);
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener('resize', this.onWindowResize);
    this.hand.dispose();
    for (const key of [...this.meshes.keys()]) {
      const chunk = { key } as Chunk;
      this.remove(chunk);
    }
    this.meshes.clear();
    this.opaqueMat.dispose();
    this.waterMat.dispose();
    this.crackMat.dispose();
    this.skyMat.dispose();
    this.atlas.dispose();
    this.highlight.geometry.dispose();
    (this.highlight.material as THREE.Material).dispose();
    this.crackGeometry.dispose();
    this.particles.geometry.dispose();
    (this.particles.material as THREE.Material).dispose();
    this.three.dispose();
  }
}

function toGeometry(data: MeshData, maxY: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  g.setAttribute('aUV', new THREE.BufferAttribute(data.uv, 2));
  g.setAttribute('aTile', new THREE.BufferAttribute(data.tile, 1));
  g.setAttribute('aLight', new THREE.BufferAttribute(data.light, 2, true));
  g.setAttribute('aTint', new THREE.BufferAttribute(data.tint, 1, true));
  g.setIndex(new THREE.BufferAttribute(data.index, 1));
  const h = Math.max(1, maxY);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(CHUNK_SX / 2, h / 2, CHUNK_SZ / 2), Math.hypot(CHUNK_SX, h, CHUNK_SZ) * 0.5 + 2);
  g.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(CHUNK_SX, h, CHUNK_SZ),
  );
  return g;
}

function maxColumnHeight(chunk: Chunk): number {
  let m = 1;
  for (let i = 0; i < chunk.height.length; i++) if (chunk.height[i] > m) m = chunk.height[i];
  return m;
}

/** Re-pack live particles to the front of the buffers (keeps the draw range tight). */
function compactParticles(
  pos: Float32Array,
  col: Float32Array,
  vel: Float32Array,
  life: Float32Array,
  _head: number,
): void {
  let w = 0;
  for (let i = 0; i < life.length; i++) {
    if (life[i] <= 0) continue;
    if (w !== i) {
      for (let k = 0; k < 3; k++) {
        pos[w * 3 + k] = pos[i * 3 + k];
        col[w * 3 + k] = col[i * 3 + k];
        vel[w * 3 + k] = vel[i * 3 + k];
      }
      life[w] = life[i];
      life[i] = 0;
    }
    w++;
  }
}

function makeStars(): THREE.Points {
  const n = 640;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let s = 20240712;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    let x = rnd() * 2 - 1;
    let y = rnd() * 2 - 1;
    let z = rnd() * 2 - 1;
    const len = Math.max(0.001, Math.sqrt(x * x + y * y + z * z));
    x /= len;
    y /= len;
    z /= len;
    if (y < -0.15) y = -y * 0.6;
    pos[i * 3] = x * 400;
    pos[i * 3 + 1] = y * 400;
    pos[i * 3 + 2] = z * 400;
    const b = 0.55 + rnd() * 0.45;
    col[i * 3] = b;
    col[i * 3 + 1] = b;
    col[i * 3 + 2] = Math.min(1, b + 0.08);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({
    size: 2,
    vertexColors: true,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    // depthTest:false painted stars on top of everything, so the night sky looked like snow
    // on the terrain (they live on a shell inside the far plane, so hills occlude them now)
    depthTest: true,
    depthWrite: false,
    map: makePixelTexture(),
    alphaTest: 0.2,
  });
  return new THREE.Points(g, m);
}

function makePixelTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 4, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

/** Procedural sun / moon disc (RD-5). */
function makeDiscTexture(moon: boolean): THREE.Texture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (ctx) {
    const grd = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.5);
    if (moon) {
      grd.addColorStop(0, 'rgba(236,242,255,1)');
      grd.addColorStop(0.72, 'rgba(206,220,246,0.98)');
      grd.addColorStop(1, 'rgba(150,170,210,0)');
    } else {
      grd.addColorStop(0, 'rgba(255,252,225,1)');
      grd.addColorStop(0.66, 'rgba(255,226,140,0.98)');
      grd.addColorStop(1, 'rgba(255,180,80,0)');
    }
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.5, 0, Math.PI * 2);
    ctx.fill();
    if (moon) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#9fb0d0';
      for (const [cx, cy, r] of [
        [26, 22, 6],
        [40, 36, 4],
        [22, 42, 3],
      ]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

type WebGLContextType = 'webgl2' | 'webgl';

export const ATLAS_DIMS = { ATLAS_PX, ATLAS_TILES, TILE_PX };
