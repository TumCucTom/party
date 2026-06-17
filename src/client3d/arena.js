// ============================================================
// Tactical arena — visible FPS-style yard plus deterministic
// collision edits for the hidden voxel substrate.
// ============================================================

import * as THREE from 'three';
import { B } from './blocks.js';

const DEFAULT_HALF_X = 34;
const DEFAULT_HALF_Z = 26;
const DEFAULT_WALL_HEIGHT = 6;
const DEFAULT_CLEAR_HEIGHT = 9;

const FLOOR_BLOCK = B.STONE;
const WALL_BLOCK = B.BRICKS;
const COVER_BLOCK = B.STONE;

export const ARENA_MATERIAL_TAGS = Object.freeze([
  'worn_concrete',
  'dusty_tan_stucco',
  'gunmetal_panel',
  'weathered_crate',
  'brass_hazard_paint',
  'muted_video_accent',
  'damage_mark',
  'target_board',
]);

const finite = (n, fallback = 0) => (Number.isFinite(n) ? n : fallback);
const int = (n, fallback = 0) => Math.floor(finite(n, fallback));

function prop(center, floorY, name, kind, dx, dz, w, h, d, material, rotation = 0, solid = true) {
  return {
    name,
    kind,
    position: [center.x + dx, floorY + h / 2, center.z + dz],
    size: [w, h, d],
    material,
    rotation,
    solid,
  };
}

export function createArenaPlan(center = {}, options = {}) {
  const c = {
    x: int(center.x),
    y: Math.max(2, int(center.y, 64)),
    z: int(center.z),
  };
  const halfX = Math.max(16, int(options.halfX, DEFAULT_HALF_X));
  const halfZ = Math.max(14, int(options.halfZ, DEFAULT_HALF_Z));
  const wallHeight = Math.max(4, int(options.wallHeight, DEFAULT_WALL_HEIGHT));
  const clearHeight = Math.max(wallHeight + 2, int(options.clearHeight, DEFAULT_CLEAR_HEIGHT));

  const bounds = {
    minX: c.x - halfX,
    maxX: c.x + halfX,
    minZ: c.z - halfZ,
    maxZ: c.z + halfZ,
  };

  const props = [
    prop(c, c.y, 'alpha crate stack', 'crateStack', -12, -7, 4, 2.2, 3.4, 'weathered_crate', 0.08),
    prop(c, c.y, 'bravo crate stack', 'crateStack', 11, 8, 4.5, 2.2, 3.2, 'weathered_crate', -0.12),
    prop(c, c.y, 'mid concrete barricade', 'barrier', 0, -12, 9, 1.35, 1.2, 'worn_concrete', 0),
    prop(c, c.y, 'right lane barricade', 'barrier', 17, -1, 1.4, 1.25, 9, 'worn_concrete', 0.08),
    prop(c, c.y, 'left lane barricade', 'barrier', -18, 5, 1.4, 1.25, 8, 'worn_concrete', -0.05),
    prop(c, c.y, 'long metal container', 'container', -2, 13, 12, 2.7, 3.2, 'gunmetal_panel', 0),
    prop(c, c.y, 'short metal container', 'container', 19, -15, 8, 2.7, 3.2, 'gunmetal_panel', Math.PI / 2),
    prop(c, c.y, 'training target a', 'target', -24, -18, 2, 2.8, 0.25, 'target_board', 0, false),
    prop(c, c.y, 'training target b', 'target', 24, 18, 2, 2.8, 0.25, 'target_board', Math.PI, false),
  ];

  return {
    center: c,
    floorY: c.y,
    bounds,
    halfX,
    halfZ,
    wallHeight,
    clearHeight,
    spawn: { x: c.x + 0.5, y: c.y + 1, z: c.z + 0.5 },
    props,
  };
}

function addEdit(out, x, y, z, id) {
  out.push({ x, y, z, id });
}

function propCellBounds(plan, p) {
  const [px, , pz] = p.position;
  const [sx, sy, sz] = p.size;
  return {
    minX: Math.floor(px - sx / 2),
    maxX: Math.ceil(px + sx / 2) - 1,
    minY: plan.floorY + 1,
    maxY: plan.floorY + Math.ceil(sy),
    minZ: Math.floor(pz - sz / 2),
    maxZ: Math.ceil(pz + sz / 2) - 1,
  };
}

export function arenaCollisionEdits(plan) {
  const edits = [];
  const { bounds, floorY, wallHeight, clearHeight } = plan;

  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
      addEdit(edits, x, floorY, z, FLOOR_BLOCK);
      for (let y = floorY + 1; y <= floorY + clearHeight; y++) addEdit(edits, x, y, z, B.AIR);
      const perimeter = x === bounds.minX || x === bounds.maxX || z === bounds.minZ || z === bounds.maxZ;
      if (!perimeter) continue;
      for (let y = floorY + 1; y <= floorY + wallHeight; y++) addEdit(edits, x, y, z, WALL_BLOCK);
    }
  }

  for (const p of plan.props) {
    if (!p.solid) continue;
    const b = propCellBounds(plan, p);
    for (let x = b.minX; x <= b.maxX; x++)
      for (let z = b.minZ; z <= b.maxZ; z++)
        for (let y = b.minY; y <= b.maxY; y++)
          addEdit(edits, x, y, z, COVER_BLOCK);
  }

  return edits;
}

export function prepareArenaCollision(world, plan) {
  let changed = 0;
  for (const edit of arenaCollisionEdits(plan)) {
    if (world.setBlock(edit.x, edit.y, edit.z, edit.id, { record: false, silent: true }) !== null) changed++;
  }
  world.dirty?.clear?.();
  if (Array.isArray(world.supportChecks)) world.supportChecks.length = 0;
  return changed;
}

function canUseCanvas() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function makeTexture(draw, repeatX = 1, repeatY = 1) {
  if (!canUseCanvas()) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  draw(ctx, canvas.width, canvas.height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 2;
  return tex;
}

function noiseTexture(base, fleck, line, repeatX = 1, repeatY = 1) {
  return makeTexture((ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 850; i++) {
      const x = (i * 47) % w;
      const y = (i * 91) % h;
      const a = 0.05 + ((i * 13) % 12) / 100;
      ctx.fillStyle = `${fleck}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
      ctx.fillRect(x, y, 1 + (i % 3), 1 + ((i >> 1) % 3));
    }
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    for (let y = 32; y < h; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y + ((y * 7) % 11));
      ctx.lineTo(w, y - 6 + ((y * 3) % 9));
      ctx.stroke();
    }
  }, repeatX, repeatY);
}

function stripeTexture() {
  return makeTexture((ctx, w, h) => {
    ctx.fillStyle = '#15181a';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(-w / 2, 0);
    ctx.rotate(-Math.PI / 8);
    for (let x = -w; x < w * 2; x += 52) {
      ctx.fillStyle = '#d9a441';
      ctx.fillRect(x, -h, 24, h * 3);
    }
  }, 1, 1);
}

function targetTexture() {
  return makeTexture((ctx, w, h) => {
    ctx.fillStyle = '#d9d1b4';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#15181a';
    ctx.lineWidth = 10;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    const cx = w / 2, cy = h / 2;
    for (const r of [88, 58, 30]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#c54b3f';
    ctx.beginPath();
    ctx.arc(cx, cy, 12, 0, Math.PI * 2);
    ctx.fill();
  }, 1, 1);
}

function disposeMaterial(material, seen) {
  if (!material || seen.has(material)) return;
  seen.add(material);
  if (material.map) material.map.dispose();
  material.dispose();
}

function disposeObject(root) {
  const materials = new Set();
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (Array.isArray(obj.material)) obj.material.forEach((m) => disposeMaterial(m, materials));
    else disposeMaterial(obj.material, materials);
  });
}

export class TacticalArena {
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this.plan = null;
  }

  dispose() {
    if (!this.group) return;
    this.scene.remove(this.group);
    disposeObject(this.group);
    this.group = null;
    this.plan = null;
  }

  rebuild(plan) {
    this.dispose();
    this.plan = plan;
    const group = new THREE.Group();
    group.name = 'tactical-fps-arena';
    this.group = group;

    const mats = this.createMaterials(plan);
    this.addLighting(group, plan, mats);
    this.addFloor(group, plan, mats);
    this.addWalls(group, plan, mats);
    this.addProps(group, plan, mats);
    this.addLaneMarkings(group, plan, mats);
    this.addOverheadDetails(group, plan, mats);

    this.scene.add(group);
    return group;
  }

  createMaterials(plan) {
    const width = plan.bounds.maxX - plan.bounds.minX + 1;
    const depth = plan.bounds.maxZ - plan.bounds.minZ + 1;
    return {
      concrete: new THREE.MeshStandardMaterial({
        color: 0x6a675c,
        map: noiseTexture('#59564c', '#ffffff', 'rgba(30,28,25,0.22)', width / 10, depth / 10),
        roughness: 0.92,
        metalness: 0.02,
      }),
      stucco: new THREE.MeshStandardMaterial({
        color: 0xb9a16b,
        map: noiseTexture('#b9a16b', '#ffffff', 'rgba(72,61,44,0.22)', 7, 2),
        roughness: 0.88,
        metalness: 0.01,
      }),
      metal: new THREE.MeshStandardMaterial({
        color: 0x24292d,
        map: noiseTexture('#24292d', '#dfe7e7', 'rgba(0,0,0,0.28)', 3, 2),
        roughness: 0.58,
        metalness: 0.44,
      }),
      crate: new THREE.MeshStandardMaterial({
        color: 0x675941,
        map: noiseTexture('#675941', '#f1dba0', 'rgba(33,25,16,0.25)', 2, 2),
        roughness: 0.78,
        metalness: 0.04,
      }),
      dark: new THREE.MeshStandardMaterial({ color: 0x15181a, roughness: 0.7, metalness: 0.35 }),
      hazard: new THREE.MeshStandardMaterial({
        color: 0xd9a441,
        map: stripeTexture(),
        roughness: 0.72,
        metalness: 0.08,
      }),
      accent: new THREE.MeshStandardMaterial({
        color: 0x7fb7b4,
        emissive: 0x294f50,
        emissiveIntensity: 0.45,
        roughness: 0.42,
        metalness: 0.18,
      }),
      target: new THREE.MeshStandardMaterial({
        color: 0xd9d1b4,
        map: targetTexture(),
        roughness: 0.82,
      }),
      line: new THREE.MeshBasicMaterial({ color: 0xd9a441, transparent: true, opacity: 0.84 }),
    };
  }

  addLighting(group, plan, mats) {
    const hemi = new THREE.HemisphereLight(0x9fb7c0, 0x4f4537, 1.7);
    group.add(hemi);
    const sun = new THREE.DirectionalLight(0xffd39b, 2.2);
    sun.position.set(plan.center.x - 24, plan.floorY + 34, plan.center.z + 18);
    group.add(sun);

    const lamp = new THREE.Mesh(new THREE.BoxGeometry(10, 0.12, 0.22), mats.accent);
    lamp.position.set(plan.center.x, plan.floorY + plan.wallHeight + 1.25, plan.center.z - plan.halfZ + 2.2);
    group.add(lamp);
  }

  addBox(group, name, size, position, material, rotationY = 0) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
    mesh.name = name;
    mesh.position.set(position[0], position[1], position[2]);
    mesh.rotation.y = rotationY;
    group.add(mesh);
    return mesh;
  }

  addFloor(group, plan, mats) {
    const width = plan.bounds.maxX - plan.bounds.minX + 1;
    const depth = plan.bounds.maxZ - plan.bounds.minZ + 1;
    this.addBox(
      group,
      'brushed concrete floor',
      [width, 0.14, depth],
      [plan.center.x, plan.floorY - 0.075, plan.center.z],
      mats.concrete,
    );
  }

  addWalls(group, plan, mats) {
    const width = plan.bounds.maxX - plan.bounds.minX + 1;
    const depth = plan.bounds.maxZ - plan.bounds.minZ + 1;
    const h = plan.wallHeight;
    const y = plan.floorY + h / 2;
    const t = 0.7;
    this.addBox(group, 'north stucco wall', [width + t, h, t], [plan.center.x, y, plan.bounds.minZ - t / 2], mats.stucco);
    this.addBox(group, 'south stucco wall', [width + t, h, t], [plan.center.x, y, plan.bounds.maxZ + t / 2], mats.stucco);
    this.addBox(group, 'west stucco wall', [t, h, depth + t], [plan.bounds.minX - t / 2, y, plan.center.z], mats.stucco);
    this.addBox(group, 'east stucco wall', [t, h, depth + t], [plan.bounds.maxX + t / 2, y, plan.center.z], mats.stucco);

    this.addBox(group, 'north metal gate', [10, 3.4, 0.24], [plan.center.x - 16, plan.floorY + 1.8, plan.bounds.minZ - 0.9], mats.metal);
    this.addBox(group, 'south warehouse door', [12, 4.1, 0.24], [plan.center.x + 14, plan.floorY + 2.15, plan.bounds.maxZ + 0.9], mats.metal);
    this.addBox(group, 'east service panel', [0.24, 3.2, 7.5], [plan.bounds.maxX + 0.9, plan.floorY + 1.7, plan.center.z - 11], mats.metal);

    const capY = plan.floorY + h + 0.13;
    this.addBox(group, 'north wall cap', [width + 1.2, 0.26, 0.9], [plan.center.x, capY, plan.bounds.minZ - 0.35], mats.dark);
    this.addBox(group, 'south wall cap', [width + 1.2, 0.26, 0.9], [plan.center.x, capY, plan.bounds.maxZ + 0.35], mats.dark);
    this.addBox(group, 'west wall cap', [0.9, 0.26, depth + 1.2], [plan.bounds.minX - 0.35, capY, plan.center.z], mats.dark);
    this.addBox(group, 'east wall cap', [0.9, 0.26, depth + 1.2], [plan.bounds.maxX + 0.35, capY, plan.center.z], mats.dark);
  }

  addProps(group, plan, mats) {
    for (const p of plan.props) {
      if (p.kind === 'crateStack') {
        const crate = this.addBox(group, p.name, p.size, p.position, mats.crate, p.rotation);
        crate.castShadow = false;
        const [w, h, d] = p.size;
        this.addBox(group, `${p.name} vertical band`, [0.16, h + 0.03, d + 0.04], p.position, mats.dark, p.rotation);
        this.addBox(group, `${p.name} cross band`, [w + 0.05, 0.16, d + 0.05], [p.position[0], p.position[1] + h * 0.16, p.position[2]], mats.dark, p.rotation);
      } else if (p.kind === 'barrier') {
        this.addBox(group, p.name, p.size, p.position, mats.concrete, p.rotation);
        this.addBox(
          group,
          `${p.name} hazard face`,
          [p.size[0] + 0.05, 0.46, 0.04],
          [p.position[0], p.position[1] + p.size[1] * 0.1, p.position[2] - p.size[2] / 2 - 0.03],
          mats.hazard,
          p.rotation,
        );
      } else if (p.kind === 'container') {
        this.addBox(group, p.name, p.size, p.position, mats.metal, p.rotation);
        for (let i = -1; i <= 1; i++) {
          this.addBox(
            group,
            `${p.name} rib ${i}`,
            [0.12, p.size[1] + 0.05, p.size[2] + 0.08],
            [p.position[0] + i * p.size[0] * 0.3, p.position[1], p.position[2]],
            mats.dark,
            p.rotation,
          );
        }
      } else if (p.kind === 'target') {
        const target = this.addBox(group, p.name, p.size, p.position, mats.target, p.rotation);
        target.position.y = plan.floorY + 1.75;
        this.addBox(group, `${p.name} stand`, [0.16, 1.35, 0.16], [p.position[0], plan.floorY + 0.68, p.position[2]], mats.dark, p.rotation);
      }
    }
  }

  addLaneMarkings(group, plan, mats) {
    const y = plan.floorY + 0.018;
    this.addBox(group, 'center lane stripe', [0.16, 0.018, plan.halfZ * 1.55], [plan.center.x, y, plan.center.z], mats.line);
    this.addBox(group, 'left lane stripe', [0.12, 0.018, plan.halfZ * 1.15], [plan.center.x - 12, y, plan.center.z + 2], mats.line);
    this.addBox(group, 'right lane stripe', [0.12, 0.018, plan.halfZ * 1.15], [plan.center.x + 12, y, plan.center.z - 2], mats.line);
    this.addBox(group, 'spawn box north', [8, 0.018, 0.18], [plan.center.x, y, plan.center.z - 4], mats.line);
    this.addBox(group, 'spawn box south', [8, 0.018, 0.18], [plan.center.x, y, plan.center.z + 4], mats.line);
    this.addBox(group, 'spawn box west', [0.18, 0.018, 8], [plan.center.x - 4, y, plan.center.z], mats.line);
    this.addBox(group, 'spawn box east', [0.18, 0.018, 8], [plan.center.x + 4, y, plan.center.z], mats.line);
  }

  addOverheadDetails(group, plan, mats) {
    const pipeGeo = new THREE.CylinderGeometry(0.18, 0.18, plan.halfX * 1.3, 12);
    for (let i = 0; i < 3; i++) {
      const pipe = new THREE.Mesh(pipeGeo, mats.dark);
      pipe.position.set(plan.center.x - 12 + i * 12, plan.floorY + plan.wallHeight + 0.9, plan.center.z - plan.halfZ + 3.5);
      pipe.rotation.z = Math.PI / 2;
      group.add(pipe);
    }
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 4.4, 8), mats.metal);
    antenna.position.set(plan.bounds.maxX - 4, plan.floorY + plan.wallHeight + 2.2, plan.bounds.maxZ - 4);
    group.add(antenna);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.9, 8), mats.dark);
    cone.position.set(antenna.position.x, antenna.position.y + 2.45, antenna.position.z);
    group.add(cone);
  }
}
