// ============================================================
// Avatars — low-poly tactical silhouettes for remote players.
// The helmet visor is a live webcam VideoTexture when a call is
// up (the spatial video part), otherwise a procedurally painted
// face plate in the player's color. Positions arrive at ~12 Hz
// and are smoothed; arms & legs swing with horizontal speed.
// ============================================================

import * as THREE from 'three';

const HEAD = 0.55;
const BODY_W = 0.5, BODY_H = 0.7, BODY_D = 0.26;
const LIMB = 0.16, LEG_H = 0.65, ARM_H = 0.62;
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
  const grd = g.createLinearGradient(0, 0, 64, 64);
  grd.addColorStop(0, `hsl(${hue}, 35%, 66%)`);
  grd.addColorStop(1, `hsl(${hue}, 30%, 42%)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(21,24,26,0.78)';
  g.beginPath();
  g.roundRect?.(8, 13, 48, 32, 8);
  if (!g.roundRect) g.rect(8, 13, 48, 32);
  g.fill();
  g.strokeStyle = 'rgba(127,183,180,0.95)';
  g.lineWidth = 3;
  g.strokeRect(11, 16, 42, 26);
  g.fillStyle = 'rgba(242,244,243,0.9)';
  g.font = 'bold 24px Rajdhani, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText((name || '?')[0].toUpperCase(), 32, 31);
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
  // Compact radio-callout text with a dark backing, word-wrapped.
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
    g.lineWidth = 4;
    g.strokeStyle = '#101315';
    g.strokeText(l, c.width / 2, y);
    g.fillStyle = '#d9a441';
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
    const cloth = new THREE.MeshBasicMaterial({ color: new THREE.Color(`hsl(${hue}, 22%, 34%)`) });
    const pants = new THREE.MeshBasicMaterial({ color: new THREE.Color(`hsl(${(hue + 210) % 360}, 18%, 24%)`) });
    const armor = new THREE.MeshBasicMaterial({ color: 0x20262b });
    const dark = new THREE.MeshBasicMaterial({ color: 0x101315 });

    // ---- head (own group so it can pitch) ----
    this.headGroup = new THREE.Group();
    this.headGroup.position.y = NECK_Y + HEAD / 2;
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(HEAD * 0.52, 14, 9), armor);
    helmet.scale.set(1.05, 0.86, 0.96);
    this.headGroup.add(helmet);
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(HEAD * 0.72, HEAD * 0.18, HEAD * 0.42), armor);
    jaw.position.set(0, -HEAD * 0.28, -HEAD * 0.08);
    this.headGroup.add(jaw);

    const faceTex = new THREE.CanvasTexture(faceCanvas(hue, this.name));
    faceTex.colorSpace = THREE.SRGBColorSpace;
    this.faceTex = faceTex;
    this.faceMat = new THREE.MeshBasicMaterial({ map: faceTex });
    // front of the avatar is -Z (matches the engine's yaw convention)
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(HEAD * 0.78, HEAD * 0.56), this.faceMat);
    this.face.position.set(0, -HEAD * 0.02, -(HEAD * 0.48 + 0.006));
    this.face.rotation.y = Math.PI;
    this.headGroup.add(this.face);
    this.group.add(this.headGroup);

    // ---- body & limbs ----
    const body = new THREE.Mesh(new THREE.CylinderGeometry(BODY_W * 0.46, BODY_W * 0.34, BODY_H, 8), cloth);
    body.position.y = LEG_H + BODY_H / 2;
    this.group.add(body);
    const vest = new THREE.Mesh(new THREE.BoxGeometry(BODY_W * 0.86, BODY_H * 0.72, BODY_D * 1.2), armor);
    vest.position.set(0, LEG_H + BODY_H * 0.54, -0.015);
    this.group.add(vest);
    const chestLight = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.02), new THREE.MeshBasicMaterial({ color: 0x5fb3b3 }));
    chestLight.position.set(BODY_W * 0.22, LEG_H + BODY_H * 0.76, -(BODY_D * 0.62 + 0.012));
    this.group.add(chestLight);

    const limb = (mat, h) => {
      const pivot = new THREE.Group();
      const m = new THREE.Mesh(new THREE.CylinderGeometry(LIMB / 2, LIMB / 2, h, 8), mat);
      m.position.y = -h / 2;
      pivot.add(m);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(LIMB * 1.22, 0.12, LIMB * 1.45), dark);
      pad.position.y = -h + 0.04;
      pivot.add(pad);
      this.group.add(pivot);
      return pivot;
    };
    this.legL = limb(pants, LEG_H); this.legL.position.set(-BODY_W / 4, LEG_H, 0);
    this.legR = limb(pants, LEG_H); this.legR.position.set(BODY_W / 4, LEG_H, 0);
    this.armL = limb(cloth, ARM_H); this.armL.position.set(-(BODY_W / 2 + LIMB / 2), NECK_Y - 0.05, 0);
    this.armR = limb(cloth, ARM_H); this.armR.position.set(BODY_W / 2 + LIMB / 2, NECK_Y - 0.05, 0);

    // ---- name tag ----
    this.tag = nameSprite(this.name);
    this.tag.position.y = NECK_Y + HEAD + 0.35;
    this.group.add(this.tag);

    // ---- combat state ----
    this.combat = { hp: 100, alive: true, hitT: 0 };
    this.hpGroup = new THREE.Group();
    this.hpGroup.position.y = NECK_Y + HEAD + 0.18;
    const hpBack = new THREE.Mesh(
      new THREE.PlaneGeometry(0.78, 0.07),
      new THREE.MeshBasicMaterial({ color: 0x0b0d10, transparent: true, opacity: 0.78, depthTest: false }),
    );
    this.hpGroup.add(hpBack);
    this.hpFill = new THREE.Mesh(
      new THREE.PlaneGeometry(0.68, 0.038),
      new THREE.MeshBasicMaterial({ color: 0x5fb3b3, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.hpFill.position.z = 0.002;
    this.hpGroup.add(this.hpFill);
    this.hpGroup.visible = false;
    this.group.add(this.hpGroup);

    this.hitFlash = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, 1.9, 0.56),
      new THREE.MeshBasicMaterial({
        color: 0xd94b3d, transparent: true, opacity: 0, depthWrite: false,
      }),
    );
    this.hitFlash.position.y = 0.95;
    this.group.add(this.hitFlash);

    // ---- chat bubble ----
    this.bubble = null;
    this._chatTimer = 0;

    // ---- presentation board (screen share) ----
    this.screen = null;

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

  /**
   * Show a screen share as a slideshow board standing beside the avatar
   * (to their right, facing the same way they face — audience in front
   * of the presenter sees both them and the slides).
   */
  setScreen(videoEl) {
    this.clearScreen();
    const W = 2.4, H = 1.35; // 16:9-ish board

    const tex = new THREE.VideoTexture(videoEl);
    tex.colorSpace = THREE.SRGBColorSpace;

    const group = new THREE.Group();
    const frameMat = new THREE.MeshBasicMaterial({ color: 0x20262b });
    const centerY = 1.45;

    const frame = new THREE.Mesh(new THREE.BoxGeometry(W + 0.14, H + 0.14, 0.07), frameMat);
    frame.position.y = centerY;
    group.add(frame);

    const screenMat = new THREE.MeshBasicMaterial({ map: tex });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), screenMat);
    plane.position.set(0, centerY, -0.04);
    plane.rotation.y = Math.PI; // face -Z, same way the avatar faces
    group.add(plane);

    // easel legs down to the ground
    const legH = centerY - H / 2;
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, legH + 0.05, 0.07), frameMat);
      leg.position.set(side * (W / 2 - 0.1), legH / 2, 0);
      group.add(leg);
    }

    group.position.set(1.9, 0, 0); // beside the avatar (their right)
    this.group.add(group);
    this.screen = { group, tex, screenMat, frameMat };

    // match the real aspect ratio once the stream reports it
    videoEl.addEventListener('loadedmetadata', () => {
      if (this.screen?.tex !== tex) return;
      if (!videoEl.videoWidth || !videoEl.videoHeight) return;
      const aspect = videoEl.videoWidth / videoEl.videoHeight;
      const sx = Math.min(1.25, Math.max(0.6, aspect / (W / H)));
      plane.scale.x = sx;
      frame.scale.x = sx;
    }, { once: true });
  }

  clearScreen() {
    if (!this.screen) return;
    this.group.remove(this.screen.group);
    this.screen.tex.dispose();
    this.screen.screenMat.dispose();
    this.screen.frameMat.dispose();
    this.screen.group.traverse((o) => o.geometry?.dispose());
    this.screen = null;
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

  setCombatState(state = {}) {
    const prevHp = this.combat.hp;
    if (Number.isFinite(state.hp)) this.combat.hp = state.hp;
    if (typeof state.alive === 'boolean') this.combat.alive = state.alive;
    if (this.combat.hp < prevHp) this.combat.hitT = 0.35;

    const frac = Math.max(0, Math.min(1, this.combat.hp / 100));
    this.hpGroup.visible = frac < 1 || !this.combat.alive;
    this.hpFill.scale.x = frac;
    this.hpFill.position.x = -0.34 * (1 - frac);
    this.hpFill.material.color.setHex(frac <= 0.34 ? 0xd94b3d : 0x5fb3b3);
  }

  update(dt) {
    const k = Math.min(1, dt * 10);
    this.group.position.lerp(this.target, k);
    this.yaw += shortestAngle(this.yaw, this.targetYaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
    this.group.rotation.y = this.yaw;
    this.headGroup.rotation.x = this.pitch;
    this.group.scale.y += ((this.combat.alive ? 1 : 0.58) - this.group.scale.y) * k;
    this.group.rotation.z = (this.combat.alive ? 0 : 0.22);
    this.combat.hitT = Math.max(0, this.combat.hitT - dt);
    this.hitFlash.material.opacity = this.combat.hitT * 0.85;

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
    this.clearScreen();
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
  setCombatState(id, state) { this.map.get(id)?.setCombatState(state); }
  setScreen(id, videoEl) { this.map.get(id)?.setScreen(videoEl); }
  clearScreen(id) { this.map.get(id)?.clearScreen(); }

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
