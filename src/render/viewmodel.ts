/**
 * First-person view model (BI-3): the player's arm plus whatever is in the hand, drawn in its own
 * scene with its own camera and composited as a second pass. That keeps it immune to terrain depth
 * (no clipping when the player stares at a block) and lets swings animate independently.
 *
 * The arm is a single group laid along its own -z: sleeve (far) → hand (near) → held item at the
 * grip, so one transform brings the limb in from the bottom-right corner and reaches it up-left —
 * which is how a first-person arm reads. Blocks are voxel cubes; tools and food reuse the flat
 * atlas art the inventory already shows.
 */
import * as THREE from 'three';
import { block } from '../world/blocks.js';
import { itemBlockId } from '../world/items.js';
import { TILE } from '../world/tiles.js';
import { paintItem } from '../ui/icons.js';
import { voxelCubeGeometry } from './geometry.js';

const SWING_SECONDS = 0.3;

/* View-model proportions in view units (the camera's near plane is 0.01). */
const ARM_W = 0.07; // limb cross-section
const SLEEVE_LEN = 0.24; // half-length of the sleeve segment (upper arm, farthest away)
const HAND_LEN = 0.19; // half-length of the skin segment (forearm + hand, nearest)
const SLEEVE_Z = -0.92; // segment centres measured along the limb
const HAND_Z = -0.52;
const GRIP_Z = -0.5; // held item sits at the hand's tip, in front of the sleeve
const LIMB_AT: [number, number, number] = [0.34, -0.36, -0.34];
const LIMB_SCALE = 0.85; // one knob for the overall size of the arm in frame
const LIMB_ROT: [number, number, number] = [0.22, 0.42, -0.2];
const BLOCK_SIZE = 0.075; // half-size of a held block cube
const SPRITE_SIZE = 0.17; // held items drawn as flat art
const TOOL_TILT = -0.5; // rotate tools so they read as gripped, not stuck on

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class HandViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** While false the renderer skips the second pass entirely (settings → "First-person hand"). */
  visible = true;

  private readonly limb = new THREE.Group();
  private readonly sleeve: THREE.Mesh;
  private readonly hand: THREE.Mesh;
  private readonly block: THREE.Mesh;
  private readonly sprite: THREE.Mesh;
  private readonly spriteMat: THREE.MeshBasicMaterial;
  private readonly spriteCache = new Map<number, THREE.Texture>();
  private swingTimer = 0;
  private heldId = -1;

  /**
   * @param material the chunk material — the arm's own voxels then take world lighting for free
   *     (its `aLight` attribute is full sky, so brightness follows the day/night curve RD-5).
   */
  constructor(private readonly material: THREE.ShaderMaterial) {
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.01, 6);

    const seg = (halfLen: number, z: number, tile: number, tint: number) => {
      const mesh = new THREE.Mesh(
        voxelCubeGeometry({
          top: tile,
          bottom: tile,
          side: tile,
          scale: [ARM_W, ARM_W, halfLen * 2],
          centered: true,
          shade: 1,
          sky: 15,
          tints: [tint * 0.95, tint * 0.6, tint * 0.8, tint, tint * 0.72, tint * 0.88],
        }),
        this.material,
      );
      mesh.frustumCulled = false; // always on screen, never worth culling
      mesh.position.set(0, 0, z);
      this.limb.add(mesh);
      return mesh;
    };
    // sleeve first: the hand's near end overlaps it, and both share the cross-section
    this.sleeve = seg(SLEEVE_LEN, SLEEVE_Z, TILE.SLEEVE, 1);
    this.hand = seg(HAND_LEN, HAND_Z, TILE.HAND, 1);

    this.block = new THREE.Mesh(
      voxelCubeGeometry({ top: 3, bottom: 3, side: 3, size: BLOCK_SIZE, centered: true, sky: 15 }),
      this.material,
    );
    this.block.frustumCulled = false;
    this.block.rotation.set(-0.3, 0.6, 0.1);
    this.block.position.set(0.02, 0.06, GRIP_Z);
    this.block.visible = false;
    this.limb.add(this.block);

    this.spriteMat = new THREE.MeshBasicMaterial({
      transparent: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.sprite = new THREE.Mesh(new THREE.PlaneGeometry(SPRITE_SIZE, SPRITE_SIZE), this.spriteMat);
    this.sprite.frustumCulled = false;
    // sit it at the tip of the hand and counter-rotate the limb's yaw, otherwise the flat art is
    // seen edge-on and collapses into a sliver
    this.sprite.position.set(-0.02, 0.07, GRIP_Z + 0.08);
    this.sprite.rotation.set(0, -LIMB_ROT[1] + 0.15, 0);
    this.sprite.visible = false;
    this.limb.add(this.sprite);

    this.limb.position.set(...LIMB_AT);
    this.limb.rotation.set(...LIMB_ROT);
    this.limb.scale.setScalar(LIMB_SCALE);
    this.scene.add(this.limb);
  }

  /** Show whatever is in the selected slot (id 0 = bare hand). */
  setHeld(id: number): void {
    if (id === this.heldId) return;
    this.heldId = id;
    this.block.visible = false;
    this.sprite.visible = false;
    if (!id) return;

    const blockId = itemBlockId(id);
    if (blockId !== undefined) {
      const def = block(blockId);
      this.block.geometry.dispose();
      this.block.geometry = voxelCubeGeometry({
        top: def.faces[0],
        bottom: def.faces[1],
        side: def.faces[2],
        size: BLOCK_SIZE,
        centered: true,
        sky: 15,
      });
      this.block.visible = true;
      return;
    }

    const tex = this.spriteFor(id);
    if (tex) {
      this.spriteMat.map = tex;
      this.spriteMat.needsUpdate = true;
      this.sprite.visible = true;
      // tools read better tilted (a gripped handle); food and misc stay face-on
      this.sprite.rotation.z = id >= 200 && id < 240 ? TOOL_TILT : 0;
    }
  }

  /** Kick off a swing (mining tick, attack, placing, eating — BI-2/BI-3). */
  swing(): void {
    this.swingTimer = SWING_SECONDS;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param dt seconds
   * @param bob walk-cycle phase in [0,1) (Player.bobPhase) — the arm sways with the steps
   * @param dayLight sky brightness from the day/night curve, to dim the held item at night
   */
  update(dt: number, bob: number, dayLight: number): void {
    const t = 1 - clamp01(this.swingTimer / SWING_SECONDS);
    const arc = this.swingTimer > 0 ? Math.sin(t * Math.PI) : 0; // fast down, slow recovery
    const walking = bob >= 0;
    const step = walking ? Math.sin(bob * Math.PI * 2) : 0;
    const sway = walking ? Math.cos(bob * Math.PI * 2) : 0;

    this.limb.position.set(
      LIMB_AT[0] + sway * 0.014,
      LIMB_AT[1] + step * 0.018 - 0.17 * arc,
      LIMB_AT[2] + 0.1 * arc,
    );
    this.limb.rotation.set(LIMB_ROT[0] - 1.0 * arc, LIMB_ROT[1] - 0.3 * arc, LIMB_ROT[2] - 0.1 * arc);
    this.limb.updateMatrixWorld();

    const shade = 0.35 + clamp01(dayLight) * 0.65;
    this.spriteMat.color.setScalar(shade);

    if (this.swingTimer > 0) this.swingTimer = Math.max(0, this.swingTimer - dt);
  }

  dispose(): void {
    this.block.geometry.dispose();
    this.hand.geometry.dispose();
    this.sleeve.geometry.dispose();
    this.sprite.geometry.dispose();
    this.spriteMat.dispose();
    for (const t of this.spriteCache.values()) t.dispose();
    this.spriteCache.clear();
  }

  /** Cached 64px canvas texture per item id, painted with the inventory's own art. */
  private spriteFor(id: number): THREE.Texture | null {
    const cached = this.spriteCache.get(id);
    if (cached) return cached;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    paintItem(canvas, id);
    const tex = new THREE.CanvasTexture(canvas);
    // the canvas holds sRGB bytes; without this the sprite is treated as linear and washes out
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    this.spriteCache.set(id, tex);
    return tex;
  }
}
