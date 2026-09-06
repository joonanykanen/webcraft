/**
 * First-person view model (BI-3): the player's arm plus whatever is in the hand, drawn in its own
 * scene with its own camera and composited as a second pass. That keeps it immune to terrain depth
 * (no clipping when the player stares at a block) and lets swings animate independently.
 *
 * Geometry of a first-person arm, which is what an earlier version of this file got backwards: the
 * **elbow/sleeve end is closest to the eye** (so it is large and runs off the bottom-right corner of
 * the frame) and the **hand is the far end** (so it is smaller and sits low-centre). The limb is one
 * group laid along its own -z axis, from the near sleeve to the far hand, with the held item gripped
 * at the hand; a punch extends that axis and pitches the wrist.
 */
import * as THREE from 'three';
import { block } from '../world/blocks.js';
import { itemBlockId } from '../world/items.js';
import { TILE } from '../world/tiles.js';
import { paintItem } from '../ui/icons.js';
import { voxelCubeGeometry } from './geometry.js';

const SWING_SECONDS = 0.26;

/* ---- layout in camera space (the camera looks down its own -z; 1 unit ≈ 1 block) ---- */
/** Just outside the bottom-right corner: where the arm "comes from". */
const ELBOW_AT = new THREE.Vector3(0.66, -0.6, -0.4);
/** Low-centre-right, further away: the hand, which is the far end of the limb. */
const HAND_AT = new THREE.Vector3(0.18, -0.24, -1.0);

/* ---- segment sizes, measured on the limb's own axes (all half-extents) ----
 * A first-person arm is a long *sleeve* with a stubby hand cube on the end; making the skin
 * segment long instead is what turned it into a plank. */
const SLEEVE_W = 0.07; // upper arm, seen close up, so a touch wider
const HAND_W = 0.072; // hand cube at the far end — wide enough that the skin stays visible in
// front of a carried block instead of vanishing behind it, stubby enough to read as a fist
const SLEEVE_Z = -0.3; // centre of the sleeve segment on the limb axis
const SLEEVE_LEN = 0.25;
const HAND_Z = -0.55; // centre of the hand segment (overlaps the sleeve: no floating wrist)
const HAND_LEN = 0.045; // ≈ a cube: a long skin segment reads as a plank, not a hand
const HAND_ROLL = 0.55; // spin the fist so its edges face the eye: dead-on, a cube is a flat plate
const GRIP_Z = -0.62; // held item is gripped over the knuckles: near enough that the hand is
// drawn in front of it, far enough that the item still reads as held rather than fused to the arm
const GRIP_X = 0.02; // held items hang slightly outside and below the wrist, not dead-centre
const GRIP_Y = -0.045;
const BLOCK_SIZE = 0.085; // held block cube, about hand-sized (as in vanilla)
const SPRITE_SIZE = 0.17; // held items drawn as flat art: 16 px of atlas, so keep it small and crisp
const TOOL_TILT = -0.2; // a slight lean only: the tool art is already diagonal, and a big second
// tilt turned a 16 px sprite into a staircase of pixels
const BOB_X = 0.016;
const BOB_Y = 0.013;
/** Punch amplitude: how far the arm extends and how far the wrist pitches. */
const PUNCH_REACH = 0.3;
const PUNCH_PITCH = 0.85;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class HandViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** While false the renderer skips the second pass entirely (settings → "First-person hand"). */
  visible = true;

  private readonly limb = new THREE.Group();
  /** Rest orientation: local -z runs from the elbow (near) to the hand (far). */
  private readonly restQuat = new THREE.Quaternion();
  private readonly restAt = new THREE.Vector3();
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

    // Orientation of the whole limb: point local -z from the elbow towards the hand.
    const dir = HAND_AT.clone().sub(ELBOW_AT).normalize();
    this.restQuat.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    this.restAt.copy(ELBOW_AT);
    /** Undo the limb orientation, so children can be aligned with the screen again. */
    const flat = this.restQuat.clone().invert();

    const seg = (halfLen: number, z: number, tile: number, width: number, tint: number) => {
      const mesh = new THREE.Mesh(
        voxelCubeGeometry({
          top: tile,
          bottom: tile,
          side: tile,
          scale: [width, width, halfLen * 2],
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
    // sleeve first (nearest the eye, running off the corner), then the hand at the far end
    this.sleeve = seg(SLEEVE_LEN, SLEEVE_Z, TILE.SLEEVE, SLEEVE_W, 1);
    this.hand = seg(HAND_LEN, HAND_Z, TILE.HAND, HAND_W, 1);
    this.hand.scale.set(1, 0.8, 1); // palm seen from above: flatter than it is wide
    this.hand.rotateZ(HAND_ROLL);

    this.block = new THREE.Mesh(
      voxelCubeGeometry({ top: 3, bottom: 3, side: 3, size: BLOCK_SIZE, centered: true, sky: 15 }),
      this.material,
    );
    this.block.frustumCulled = false;
    this.block.position.set(GRIP_X, GRIP_Y, GRIP_Z);
    this.block.visible = false;
    this.limb.add(this.block);

    this.spriteMat = new THREE.MeshBasicMaterial({
      transparent: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      // Keep depth testing on: the item must be occluded by the hand that holds it, otherwise it
      // floats in mid-air in front of the arm.
      depthTest: true,
      depthWrite: false,
    });
    this.sprite = new THREE.Mesh(new THREE.PlaneGeometry(SPRITE_SIZE, SPRITE_SIZE), this.spriteMat);
    this.sprite.frustumCulled = false;
    this.sprite.position.set(GRIP_X * 0.7, GRIP_Y, GRIP_Z);
    this.sprite.visible = false;
    this.limb.add(this.sprite);

    // Flat art and held cubes must not be seen edge-on: undo the limb's tilt so they face the eye,
    // then add a small tilt of their own so they still look held rather than pasted on.
    const face = (o: THREE.Object3D, tilt: number) => {
      o.quaternion.copy(flat);
      o.rotateZ(tilt);
      o.rotateX(0.16);
    };
    face(this.sprite, 0);
    this.block.quaternion.copy(flat);
    this.block.rotateY(0.62);
    this.block.rotateX(-0.2);

    this.limb.position.copy(this.restAt);
    this.limb.quaternion.copy(this.restQuat);
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
      this.spriteMat.color.setRGB(1, 1, 1);
      const flat = this.restQuat.clone().invert();
      const isTool = id >= 200 && id < 240;
      this.sprite.quaternion.copy(flat);
      // A 16 px sprite skewed in 3D staircases its own pixels (the pickaxe read as a broken
      // zig-zag), so held art stays parallel to the screen and only turns in 2D. Tools are drawn
      // diagonally in the atlas already, so tilting them again doubled the diagonal.
      this.sprite.rotateZ(isTool ? TOOL_TILT : 0.12);
      this.sprite.rotateX(0.1);
      this.sprite.scale.setScalar(isTool ? 1.2 : 1);
      this.sprite.position.set(GRIP_X * 0.7 + (isTool ? 0.028 : 0), GRIP_Y + (isTool ? 0.055 : 0), GRIP_Z);
    }
  }

  /** Kick off a swing (mining tick, attack, placing, eating — BI-2/BI-3). */
  swing(): void {
    this.swingTimer = SWING_SECONDS;
  }

  /** Debug/smoke accessor: camera-space position of the limb root (punch travel check). */
  get limbPosition(): [number, number, number] {
    const p = this.limb.position;
    return [p.x, p.y, p.z];
  }

  get swinging(): boolean {
    return this.swingTimer > 0;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param dt seconds
   * @param bob walk-cycle phase in radians (Game.bobPhase) — the arm sways with the steps
   * @param dayLight sky brightness from the day/night curve, to dim the held item at night
   */
  update(dt: number, bob: number, dayLight: number): void {
    const t = 1 - clamp01(this.swingTimer / SWING_SECONDS);
    const arc = this.swingTimer > 0 ? Math.sin(t * Math.PI) : 0; // out and back in one arc

    // The bob is a walk rhythm; while a punch plays the arm ignores it (otherwise the punch wobbles).
    const step = Math.sin(bob * Math.PI * 2);
    const sway = Math.cos(bob * Math.PI * 2);
    const idle = this.swingTimer > 0 ? 0 : 1;

    this.limb.position.set(
      this.restAt.x + sway * BOB_X * idle,
      this.restAt.y + step * BOB_Y * idle,
      this.restAt.z,
    );
    this.limb.quaternion.copy(this.restQuat);
    this.limb.rotateX(-PUNCH_PITCH * arc); // wrist comes down and the arm straightens
    this.limb.rotateZ(-0.18 * arc);
    this.limb.translateZ(-PUNCH_REACH * arc); // extend along the arm's own axis
    this.limb.updateMatrixWorld();

    const shade = 0.4 + clamp01(dayLight) * 0.6;
    this.spriteMat.color.setRGB(shade, shade, shade);

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
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace; // the icon art is sRGB; without this it washes out
    this.spriteCache.set(id, tex);
    return tex;
  }
}
