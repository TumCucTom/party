// ============================================================
// Avatars — blocky Minecraft-style bodies for remote players.
// The head's front face is a live webcam VideoTexture when a
// call is up (the "spatial video" part of spatial video chat),
// otherwise a procedurally painted face in the player's color.
// Positions arrive at ~12 Hz and are smoothed; arms & legs
// swing with horizontal speed; a name tag floats above.
// ============================================================

import * as THREE from 'three';

const HEAD = 0.55;            // head cube edge (slightly chunky for visibility)
const BODY_W = 0.5, BODY_H = 0.7, BODY_D = 0.26;
const LIMB = 0.22, LEG_H = 0.65, ARM_H = 0.62;
const NECK_Y = LEG_H + BODY_H; // top of body, where the head sits

function hueFromId(id) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 8) % 360;
}

function faceCanvas(hue, name) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = `hsl(${hue}, 45%, 62%)`;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = `hsl(${hue}, 45%, 50%)`;          // pixel noise, steve-ish
  for (let i = 0; i < 26; i++) g.fillRect((Math.random() * 8 | 0) * 8, (Math.random() * 8 | 0) * 8, 8, 8);
  g.fillStyle = '#fff';                            // eyes
  g.fillRect(12, 26, 12, 8); g.fillRect(40, 26, 12, 8);
  g.fillStyle = '#3b2d63';
  g.fillRect(18, 26, 6, 8); g.fillRect(40, 26, 6, 8);
  g.fillStyle = 'rgba(40,20,20,0.8)';              // mouth
  g.fillRect(24, 46, 16, 5);
  g.fillStyle = '#fff';                            // initial on the forehead
  g.font = 'bold 14px monospace';
  g.textAlign = 'center';
  g.fillText((name || '?')[0].toUpperCase(), 32, 16);
  return c;
}

function nameSprite(name) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = 'bold 28px monospace';
  const w = Math.min(360, Math.max(80, g.measureText(name).width + 24));
  c.width = w; c.height = 44;
  g.font = 'bold 28px monospace';
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(0, 0, w, 44);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name, w / 2, 23);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false,
  }));
  sprite.scale.set(w / 44 * 0.32, 0.32, 1);
  return sprite;
}

function chatSprite(text) {
  // Runescape-style: yellow text with a black outline, word-wrapped
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > 26 && line) {
      lines.push(line);
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
    if (lines.length === 3) break;
  }
  if (line && lines.length < 3) lines.push(line);

  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = 'bold 26px monospace';
  g.font = font;
  const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 16;
  const lineH = 32;
  c.width = Math.ceil(w);
  c.height = lines.length * lineH + 8;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((l, i) => {
    const y = 4 + lineH * i + lineH / 2;
    g.lineWidth = 5;
    g.strokeStyle = '#000';
    g.strokeText(l, c.width / 2, y);
    g.fillStyle = '#ffff5e';
    g.fillText(l, c.width / 2, y);
  });

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false,
  }));
  const scale = 0.011;
  sprite.scale.set(c.width * scale, c.height * scale, 1);
  return sprite;
}

class Avatar {
  constructor(id, name) {
    this.id = id;
    this.name = name || 'guest';
    this.group = new THREE.Group();

    const hue = hueFromId(id);
    const shirt = new THREE.MeshBasicMaterial({ color: new THREE.Color(`hsl(${hue}, 42%, 48%)`) });
    const pants = new THREE.MeshBasicMaterial({ color: new THREE.Color(`hsl(${(hue + 200) % 360}, 30%, 35%)`) });
    const skin = new THREE.MeshBasicMaterial({ color: new THREE.Color(`hsl(${hue}, 45%, 62%)`) });

    // ---- head (own group so it can pitch) ----
    this.headGroup = new THREE.Group();
    this.headGroup.position.y = NECK_Y + HEAD / 2;
    const head = new THREE.Mesh(new THREE.BoxGeometry(HEAD, HEAD, HEAD), skin);
    this.headGroup.add(head);

    const faceTex = new THREE.CanvasTexture(faceCanvas(hue, this.name));
    faceTex.colorSpace = THREE.SRGBColorSpace;
    faceTex.magFilter = THREE.NearestFilter;
    this.faceTex = faceTex;
    this.faceMat = new THREE.MeshBasicMaterial({ map: faceTex });
    // front of the avatar is -Z (matches the engine's yaw convention)
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(HEAD * 0.96, HEAD * 0.96), this.faceMat);
    this.face.position.z = -(HEAD / 2 + 0.004);
    this.face.rotation.y = Math.PI;
    this.headGroup.add(this.face);
    this.group.add(this.headGroup);

    // ---- body & limbs ----
    const body = new THREE.Mesh(new THREE.BoxGeometry(BODY_W, BODY_H, BODY_D), shirt);
    body.position.y = LEG_H + BODY_H / 2;
    this.group.add(body);

    const limb = (mat, h) => {
      const pivot = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(LIMB, h, LIMB), mat);
      m.position.y = -h / 2;
      pivot.add(m);
      this.group.add(pivot);
      return pivot;
    };
    this.legL = limb(pants, LEG_H); this.legL.position.set(-BODY_W / 4, LEG_H, 0);
    this.legR = limb(pants, LEG_H); this.legR.position.set(BODY_W / 4, LEG_H, 0);
    this.armL = limb(shirt, ARM_H); this.armL.position.set(-(BODY_W / 2 + LIMB / 2), NECK_Y - 0.05, 0);
    this.armR = limb(shirt, ARM_H); this.armR.position.set(BODY_W / 2 + LIMB / 2, NECK_Y - 0.05, 0);

    // ---- name tag ----
    this.tag = nameSprite(this.name);
    this.tag.position.y = NECK_Y + HEAD + 0.35;
    this.group.add(this.tag);

    // ---- chat bubble ----
    this.bubble = null;
    this._chatTimer = 0;

    // ---- motion state ----
    this.target = new THREE.Vector3();
    this.targetYaw = 0;
    this.targetPitch = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.walkCycle = 0;
    this.speed = 0;
    this._lastTarget = new THREE.Vector3();
    this._first = true;

    this.videoTex = null;
  }

  setState(s) {
    if (this._first) {
      this.group.position.set(s.x, s.y, s.z);
      this.target.set(s.x, s.y, s.z);
      this._lastTarget.copy(this.target);
      this.yaw = this.targetYaw = s.yaw || 0;
      this.pitch = this.targetPitch = s.pitch || 0;
      this._first = false;
      return;
    }
    this._lastTarget.copy(this.target);
    this.target.set(s.x, s.y, s.z);
    this.targetYaw = s.yaw || 0;
    this.targetPitch = s.pitch || 0;
    const dx = this.target.x - this._lastTarget.x;
    const dz = this.target.z - this._lastTarget.z;
    this.speed = Math.sqrt(dx * dx + dz * dz) * 12; // updates arrive ~12 Hz
  }

  setVideo(videoEl) {
    this.clearVideo();
    const tex = new THREE.VideoTexture(videoEl);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.videoTex = tex;
    this.faceMat.map = tex;
    this.faceMat.needsUpdate = true;
  }

  clearVideo() {
    if (!this.videoTex) return;
    this.videoTex.dispose();
    this.videoTex = null;
    this.faceMat.map = this.faceTex;
    this.faceMat.needsUpdate = true;
  }

  setChat(text) {
    this.clearChat();
    this.bubble = chatSprite(text);
    this.bubble.position.y = NECK_Y + HEAD + 0.62 + this.bubble.scale.y / 2;
    this.group.add(this.bubble);
    this._chatTimer = setTimeout(() => this.clearChat(), 6500);
  }

  clearChat() {
    clearTimeout(this._chatTimer);
    if (!this.bubble) return;
    this.group.remove(this.bubble);
    this.bubble.material.map.dispose();
    this.bubble.material.dispose();
    this.bubble = null;
  }

  update(dt) {
    const k = Math.min(1, dt * 10);
    this.group.position.lerp(this.target, k);
    this.yaw += shortestAngle(this.yaw, this.targetYaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
    this.group.rotation.y = this.yaw;
    this.headGroup.rotation.x = this.pitch;

    // walk swing
    this.walkCycle += this.speed * dt * 2.4;
    this.speed *= Math.pow(0.02, dt); // decay between updates
    const swing = Math.sin(this.walkCycle) * Math.min(1, this.speed / 4) * 0.7;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.8;
    this.armR.rotation.x = swing * 0.8;
  }

  dispose() {
    this.clearVideo();
    this.clearChat();
    this.group.parent?.remove(this.group);
  }
}

function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Avatars {
  constructor(scene) {
    this.scene = scene;
    this.map = new Map(); // socketId -> Avatar
  }

  add(player) {
    if (this.map.has(player.id)) return this.map.get(player.id);
    const a = new Avatar(player.id, player.name);
    a.setState(player);
    this.scene.add(a.group);
    this.map.set(player.id, a);
    return a;
  }

  setState(id, s) {
    this.map.get(id)?.setState(s);
  }

  setVideo(id, videoEl) { this.map.get(id)?.setVideo(videoEl); }
  clearVideo(id) { this.map.get(id)?.clearVideo(); }
  setChat(id, text) { this.map.get(id)?.setChat(text); }

  remove(id) {
    const a = this.map.get(id);
    if (!a) return;
    a.dispose();
    this.map.delete(id);
  }

  update(dt) {
    for (const a of this.map.values()) a.update(dt);
  }

  /** [{id, position, distance}] sorted nearest first, relative to pos. */
  byDistance(pos) {
    const out = [];
    for (const a of this.map.values()) {
      out.push({ id: a.id, position: a.group.position, distance: a.group.position.distanceTo(pos) });
    }
    out.sort((m, n) => m.distance - n.distance);
    return out;
  }

  count() { return this.map.size; }

  clear() {
    for (const id of [...this.map.keys()]) this.remove(id);
  }
}
