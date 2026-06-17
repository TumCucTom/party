// ============================================================
// Main — Block Party: the spatial video chat rebuilt inside a
// Minecraft-like world. Bootstraps the renderer and the voxel
// engine, owns the state machine (join → loading → playing ⇄
// menu), and wires the multiplayer layer: socket.io world sync
// (seed + shared block edits + player positions), blocky
// avatars with live webcam faces, and proximity video calls
// with WebAudio-spatialized voice.
// ============================================================

import * as THREE from 'three';
import {
  buildAtlasCanvas, buildCrackCanvases, buildWaterCanvas, tileIconCanvas,
} from './textures.js';
import { B, BLOCKS, PALETTE, DEFAULT_HOTBAR } from './blocks.js';
import { CHUNK, WORLD_H, BIOME_NAMES } from './worldgen.js';
import { World } from './world.js';
import { Player, raycastVoxel } from './player.js';
import { buildBlockGeometry } from './mesher.js';
import { Sky } from './sky.js';
import { Particles } from './particles.js';
import { AudioFX } from './audio.js';
import { Entities } from './entities.js';
import { UI } from './ui.js';
import { hashString } from './noise.js';
import { Net } from './net.js';
import { Rtc } from './rtc.js';
import { Avatars } from './avatar.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { Minimap } from './minimap.js';
import { COMBAT, STATE_SEND_HZ, CALL_DISTANCE } from './constants.js';
import {
  applyDeath,
  applyHit,
  applyRespawn,
  createCombatState,
  cooldownFraction,
  upsertCombatPlayer,
} from './combat.js';

const SETTINGS_KEY = 'party3d:settings';
const HOTBAR_KEY = 'party3d:hotbar';
const NAME_KEY = 'party3d:name';
const REACH = 5;

const DEFAULT_SETTINGS = {
  render: 7, fov: 70, sens: 100, vol: 70,
  bob: true, clouds: true, music: true, smooth: true,
};

const loadJSON = (k) => {
  try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
};
const saveJSON = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ }
};

class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.settings = { ...DEFAULT_SETTINGS, ...(loadJSON(SETTINGS_KEY) || {}) };

    // ---------- UI ----------
    this.ui = new UI({
      onPlay: () => this.join(),
      onResume: () => this.resume(),
      onQuit: () => this.leaveWorld(),
      onSetting: (k, v) => this.applySetting(k, v),
      getSettings: () => this.settings,
      onPickBlock: (id) => this.assignBlock(id),
      onHotbarSelect: (i) => { this.selectSlot(i); },
      onClosePicker: () => this.closePicker(true),
      onUiClick: () => { this.audio.ensure(); this.audio.click(); },
    });

    // ---------- renderer ----------
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, antialias: false, powerPreference: 'high-performance',
      });
    } catch (e) {
      this.ui.showWebglError();
      throw e;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.autoClear = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, innerWidth / innerHeight, 0.1, 1500);
    this.camera.rotation.order = 'YXZ';
    this.fovCurrent = this.settings.fov;

    // global light uniforms shared by every world material
    this.uniforms = { uDayLight: { value: 1 }, uMinLight: { value: 0.05 } };

    // ---------- textures & materials ----------
    const atlasTex = new THREE.CanvasTexture(buildAtlasCanvas());
    atlasTex.magFilter = THREE.NearestFilter;
    atlasTex.minFilter = THREE.NearestFilter;
    atlasTex.generateMipmaps = false;
    atlasTex.colorSpace = THREE.SRGBColorSpace;
    this.atlasTex = atlasTex;

    const waterTex = new THREE.CanvasTexture(buildWaterCanvas());
    waterTex.magFilter = THREE.NearestFilter;
    waterTex.minFilter = THREE.NearestFilter;
    waterTex.generateMipmaps = false;
    waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
    waterTex.colorSpace = THREE.SRGBColorSpace;
    this.waterTex = waterTex;

    this.materials = {
      solid: this.makeWorldMaterial({ map: atlasTex, alphaTest: 0.5 }),
      water: this.makeWorldMaterial({
        map: waterTex, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide,
      }),
    };

    // ---------- target outline + crack overlay ----------
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.75 }),
    );
    this.outline.visible = false;
    this.scene.add(this.outline);

    this.crackTextures = buildCrackCanvases().map((c) => {
      const t = new THREE.CanvasTexture(c);
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      return t;
    });
    this.crackMat = new THREE.MeshBasicMaterial({
      map: this.crackTextures[0], transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.crack = new THREE.Mesh(new THREE.BoxGeometry(1.004, 1.004, 1.004), this.crackMat);
    this.crack.visible = false;
    this.scene.add(this.crack);

    // ---------- subsystems ----------
    this.audio = new AudioFX();
    this.audio.setVolume(this.settings.vol / 100);
    this.audio.setMusicOn(this.settings.music);

    this.sky = new Sky(this.scene, this.uniforms);
    this.sky.setViewDistance(this.settings.render);
    this.sky.setCloudsVisible(this.settings.clouds);

    this.particles = new Particles(this.scene, this.materials.solid);
    this.entities = new Entities({
      scene: this.scene, world: null, particles: this.particles,
      audio: this.audio, material: this.materials.solid,
    });
    this.entities.getPlayer = () => this.player;
    this.entities.onExplosion = (x, y, z) => {
      this.shakeT = Math.max(this.shakeT, 0.45);
      const d = this.player.pos.distanceTo(new THREE.Vector3(x, y, z));
      if (d < 7) this.ui.flashDamage();
    };

    // ---------- multiplayer ----------
    this.avatars = new Avatars(this.scene);
    this.minimap = new Minimap(document.getElementById('minimap'));
    this.net = new Net();
    this.rtc = null;             // created after join (needs the AudioContext)
    this.localStream = null;     // cam + mic, requested below
    this.room = 'public';
    this.joining = false;
    this.stateSendTimer = 0;
    this.proximityTimer = 0;
    this.lastSentState = null;
    this.combat = createCombatState();
    this.lastAttackAt = { slash: 0, stab: 0 };
    this.attackAnim = { kind: 'slash', t: 1 };
    this.hitMarkerT = 0;
    this.bindNet();
    this.initMedia();

    // ---------- first-person knife (separate pass over the world) ----------
    this.handScene = new THREE.Scene();
    this.handCamera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.01, 10);
    this.handGroup = new THREE.Group();
    this.handScene.add(this.handGroup);
    this.heldMesh = null;
    this.knifeMesh = null;
    this.heldGeoCache = new Map();
    this.swingT = 1;  // 1 = idle
    this.dipT = 1;

    // ---------- inventory state ----------
    this.hotbar = [...DEFAULT_HOTBAR];
    this.selected = 0;
    const savedBar = loadJSON(HOTBAR_KEY);
    if (savedBar?.hotbar?.length === 9) this.hotbar = savedBar.hotbar.slice();
    if (Number.isInteger(savedBar?.slot)) this.selected = savedBar.slot;

    // ---------- icons ----------
    this.icons = this.makeIcons();
    this.ui.setIcons(this.icons);
    this.ui.updateHotbar(this.hotbar, this.selected);

    // ---------- touch controls (phones / tablets only) ----------
    this.touchMode = isTouchDevice();
    this.touch = null;
    this._touchMinePrev = false;
    this._touchPlacePrev = false;
    if (this.touchMode) {
      document.body.classList.add('touch');
      this.touch = new TouchControls({
        onLook: (dx, dy) => this.touchLook(dx, dy),
        onToggleFly: () => {
          if (this.state !== 'playing') return;
          this.player.flying = !this.player.flying;
          if (this.player.flying) this.player.vel.y = 0;
          this.ui.showToast(this.player.flying ? 'Flying enabled' : 'Flying disabled');
        },
        onMenu: () => { if (this.state === 'playing') this.pause(); },
        onChat: () => {
          if (this.state === 'playing' && !this.pickerOpen && !this.chatOpen) this.openChat();
        },
        onPicker: () => {
          if (this.state !== 'playing' || this.chatOpen) return;
          if (this.pickerOpen) this.closePicker(false);
          else this.openPicker();
        },
      });
    }

    // ---------- game state ----------
    this.state = 'title';
    this.pickerOpen = false;
    this.chatOpen = false;
    this.locked = false;
    this.keys = new Set();
    this.sprintLatch = false;
    this.lastW = 0;
    this.lastSpace = 0;
    this.mining = false;
    this.miningCell = null;
    this.miningProgress = 0;
    this.placeTimer = 0;
    this.rmbHeld = false;
    this.shakeT = 0;
    this.debugVisible = false;
    this.debugTimer = 0;
    this.titleAngle = Math.random() * Math.PI * 2;
    this.fps = 0;
    this.fpsAccum = 0;
    this.fpsFrames = 0;
    this.lastDrawInfo = { calls: 0, triangles: 0 };

    // local backdrop world for the join screen (replaced by the
    // server's seeded world once we join a room)
    this.createWorld((Math.random() * 0xffffffff) >>> 0, null);

    // prefill name / room
    const savedName = loadJSON(NAME_KEY);
    if (savedName) document.getElementById('name-input').value = savedName;
    if (window.location.hash.length > 1) this.ui.setJoinRoom(window.location.hash.slice(1));

    // live preview of the room you're about to join (who's there, how built)
    this._roomInfoSeq = 0;
    this._roomInfoDebounce = 0;
    document.getElementById('room-input').addEventListener('input', () => {
      clearTimeout(this._roomInfoDebounce);
      this._roomInfoDebounce = setTimeout(() => this.refreshRoomInfo(), 350);
    });
    this.refreshRoomInfo();
    setInterval(() => { if (this.state === 'title') this.refreshRoomInfo(); }, 4000);

    this.bindInput();
    this.lastT = performance.now();
    this._rafPending = false;
    this.scheduleFrame();
    // RAF is suspended in hidden/occluded tabs; this watchdog keeps the
    // simulation (loading, networking, time of day) ticking at ~10 Hz there.
    setInterval(() => {
      if (performance.now() - this.lastT > 350) this.frame(performance.now());
    }, 100);
  }

  scheduleFrame() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame((t) => { this._rafPending = false; this.frame(t); });
  }

  // ============================================================
  // Local media (webcam + mic)
  // ============================================================

  async initMedia() {
    const joinCam = document.getElementById('join-cam');
    const selfVideo = document.getElementById('self-video');
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 } },
        audio: true,
      });
      joinCam.srcObject = this.localStream;
      selfVideo.srcObject = this.localStream;
      this.ui.setCamStatus('');
    } catch (err) {
      console.warn('[media]', err);
      this.ui.setCamStatus('No camera/mic — you can still join and listen!');
    }

    this.micBtn = document.getElementById('btn-mic');
    this.camBtn = document.getElementById('btn-cam');
    this.micBtn.addEventListener('click', () => this.toggleMic());
    this.camBtn.addEventListener('click', () => this.toggleCam());
    this.switchingCam = false;
    document.getElementById('btn-switch-cam').addEventListener('click', () => this.switchCamera());
    this.screenBtn = document.getElementById('btn-screen');
    this.screenStream = null;
    this.screenBtn.addEventListener('click', () => this.toggleScreenShare());
  }

  /** Present your screen on a board next to your avatar. */
  async toggleScreenShare() {
    if (this.screenStream) { this.stopScreenShare(); return; }
    if (this.state !== 'playing' && this.state !== 'paused') return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.ui.showToast('Screen sharing is not supported in this browser');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 15 } },
        audio: false,
      });
      this.screenStream = stream;
      // the browser's own "stop sharing" bar ends the track
      stream.getVideoTracks()[0].addEventListener('ended', () => this.stopScreenShare());
      this.rtc?.startScreenShare(stream);
      this.screenBtn.classList.add('live');
      this.ui.showToast('Presenting — people nearby can see your screen');
    } catch (err) {
      console.warn('[media] screen share', err);
      this.ui.showToast('Screen share cancelled');
    }
  }

  stopScreenShare() {
    if (!this.screenStream) return;
    for (const t of this.screenStream.getTracks()) t.stop();
    this.screenStream = null;
    this.rtc?.stopScreenShare();
    this.screenBtn.classList.remove('live');
    this.ui.showToast('Stopped presenting');
  }

  /** Cycle to the next video input device (front/back camera, webcams…). */
  async switchCamera() {
    if (this.switchingCam) return;
    const current = this.localStream?.getVideoTracks()[0];
    if (!current) { this.ui.showToast('No camera available'); return; }
    this.switchingCam = true;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === 'videoinput');
      if (devices.length < 2) {
        this.ui.showToast('Only one camera found');
        return;
      }
      const curId = current.getSettings().deviceId;
      const idx = devices.findIndex((d) => d.deviceId === curId);
      const next = devices[(idx + 1) % devices.length];

      const fresh = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: next.deviceId }, width: { ideal: 320 }, height: { ideal: 240 } },
      });
      const newTrack = fresh.getVideoTracks()[0];
      newTrack.enabled = current.enabled; // keep the mute state

      this.localStream.removeTrack(current);
      current.stop();
      this.localStream.addTrack(newTrack);
      // re-attach so the previews pick up the new track everywhere
      document.getElementById('self-video').srcObject = this.localStream;
      document.getElementById('join-cam').srcObject = this.localStream;
      this.rtc?.replaceVideoTrack(newTrack);
      this.ui.showToast(`Camera: ${next.label || `#${((idx + 1) % devices.length) + 1}`}`);
    } catch (err) {
      console.warn('[media] switch camera failed', err);
      this.ui.showToast('Could not switch camera');
    } finally {
      this.switchingCam = false;
    }
  }

  toggleMic() {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) { this.ui.showToast('No microphone available'); return; }
    track.enabled = !track.enabled;
    this.micBtn.textContent = track.enabled ? '🎙️' : '🔇';
    this.micBtn.classList.toggle('off', !track.enabled);
    this.ui.showToast(track.enabled ? 'Microphone on' : 'Microphone muted');
  }

  toggleCam() {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) { this.ui.showToast('No camera available'); return; }
    track.enabled = !track.enabled;
    this.camBtn.textContent = track.enabled ? '📷' : '🚫';
    this.camBtn.classList.toggle('off', !track.enabled);
    this.ui.showToast(track.enabled ? 'Camera on' : 'Camera off');
  }

  // ============================================================
  // Multiplayer wiring
  // ============================================================

  bindNet() {
    this.net.onInit = ({ seed, time, edits, players, me }) => {
      this.createWorld(seed, edits);
      this.combat = createCombatState(me || { id: this.net.id });
      this.sky.setTimeOfDay(time ?? 0.1);
      for (const p of players) {
        this.avatars.add(p);
        upsertCombatPlayer(this.combat, p);
        this.avatars.setCombatState?.(p.id, p);
      }
      this.joining = false;
      this.ui.hideAllMenus();
      this.ui.show('loading');
      this.ui.updateCombatHud?.(this.combat, this.combatHudSnapshot());
      this.state = 'loading';
      this.lockPointer();
    };

    this.net.onPlayerJoin = (p) => {
      this.avatars.add(p);
      upsertCombatPlayer(this.combat, p);
      this.avatars.setCombatState?.(p.id, p);
      this.ui.updateCombatHud?.(this.combat, this.combatHudSnapshot());
      if (this.state === 'playing') this.ui.showToast(`${p.name} joined`);
    };

    this.net.onPlayerState = (s) => this.avatars.setState(s.id, s);

    this.net.onPlayerLeave = (id) => {
      const a = this.avatars.map.get(id);
      if (a && this.state === 'playing') this.ui.showToast(`${a.name} left`);
      this.rtc?.hangUp(id);
      this.avatars.remove(id);
      this.combat.players.delete(id);
      this.ui.updateCombatHud?.(this.combat, this.combatHudSnapshot());
    };

    this.net.onBlock = ({ x, y, z, id }) => {
      this.world.applyRemoteEdit(x, y, z, id);
    };

    this.net.onTnt = ({ x, y, z }) => {
      // mark remote so the ignition's own block removal isn't echoed back
      this.world._applyingRemote = true;
      try { this.entities.igniteTNT(x, y, z); } finally { this.world._applyingRemote = false; }
    };

    this.net.onChat = ({ id, text }) => this.avatars.setChat(id, text);

    this.net.onHit = (event) => {
      applyHit(this.combat, event, this.net.id);
      this.avatars.setCombatState?.(event.victimId, this.combat.players.get(event.victimId));
      if (event.victimId === this.net.id) this.ui.flashDamage();
      if (event.attackerId === this.net.id) {
        this.hitMarkerT = 0.22;
        this.ui.showToast(`${event.kind === 'stab' ? 'Stab' : 'Slash'} hit: ${event.damage}`);
      }
      this.ui.updateCombatHud?.(this.combat, this.combatHudSnapshot());
    };

    this.net.onDeath = (event) => {
      applyDeath(this.combat, event, this.net.id);
      this.avatars.setCombatState?.(event.victimId, this.combat.players.get(event.victimId));
      if (event.victimId === this.net.id) {
        this.keys.clear();
        this.ui.showToast('Down — respawning');
      } else if (event.attackerId === this.net.id) {
        this.ui.showToast('Eliminated opponent');
      }
      this.ui.updateCombatHud?.(this.combat, this.combatHudSnapshot());
    };

    this.net.onRespawn = (event) => {
      applyRespawn(this.combat, event, this.net.id);
      this.avatars.setCombatState?.(event.id, this.combat.players.get(event.id));
      if (event.id === this.net.id) {
        this.player.teleport(this.spawn.x + 0.5, this.spawn.y + 1, this.spawn.z + 0.5);
        this.player.vel.set(0, 0, 0);
        this.ui.showToast('Back in');
      }
      this.ui.updateCombatHud?.(this.combat, this.combatHudSnapshot());
    };

    this.net.onDisconnect = () => {
      if (this.state === 'title') return;
      this.rtc?.dispose();
      this.ui.showDisconnected();
    };
  }

  async refreshRoomInfo() {
    if (this.state !== 'title') return;
    const room = this.ui.getJoinRoom().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'public';
    const seq = ++this._roomInfoSeq;
    try {
      const res = await fetch(`/world-info/${encodeURIComponent(room)}`);
      const info = await res.json();
      if (seq !== this._roomInfoSeq || this.state !== 'title') return; // stale
      if (!info.exists) {
        this.ui.setRoomInfo('✨ a fresh, untouched world awaits');
      } else {
        const n = info.players.length;
        const who = n
          ? `👥 ${n} ${n === 1 ? 'person' : 'people'} here now: ${info.players.slice(0, 4).join(', ')}${n > 4 ? '…' : ''}`
          : '👥 nobody here right now';
        this.ui.setRoomInfo(`${who} · 🧱 ${info.edits} block ${info.edits === 1 ? 'edit' : 'edits'}`);
      }
    } catch {
      if (seq === this._roomInfoSeq) this.ui.setRoomInfo('');
    }
  }

  join() {
    if (this.joining) return;
    const name = this.ui.getJoinName();
    if (!name) {
      this.ui.setJoinStatus('Pick a name first!', true);
      document.getElementById('name-input').focus();
      return;
    }
    let room = this.ui.getJoinRoom().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!room) room = 'public';
    this.ui.setJoinRoom(room);
    this.room = room;
    saveJSON(NAME_KEY, name);
    if (window.history.pushState) window.history.pushState(null, null, `#${room}`);

    this.audio.ensure();
    this.joining = true;
    this.ui.setJoinStatus('Connecting…');
    this.net.connect()
      .then(() => this.net.join(room, name))
      .catch((err) => {
        console.error('[net]', err);
        this.joining = false;
        this.ui.setJoinStatus('Could not reach the server :(', true);
      });
  }

  startRtc() {
    if (this.rtc || !this.audio.ctx) return;
    this.rtc = new Rtc(this.audio.ctx);
    this.rtc.onVideo = (id, video) => this.avatars.setVideo(id, video);
    this.rtc.onVideoEnd = (id) => this.avatars.clearVideo(id);
    this.rtc.onScreen = (id, video) => this.avatars.setScreen(id, video);
    this.rtc.onScreenEnd = (id) => this.avatars.clearScreen(id);
    this.rtc.init(this.net.id, this.localStream);
    if (this.screenStream) this.rtc.startScreenShare(this.screenStream);
  }

  sendStateNow() {
    const p = this.player;
    const s = {
      x: Math.round(p.pos.x * 100) / 100,
      y: Math.round(p.pos.y * 100) / 100,
      z: Math.round(p.pos.z * 100) / 100,
      yaw: Math.round(p.yaw * 1000) / 1000,
      pitch: Math.round(p.pitch * 1000) / 1000,
    };
    const key = `${s.x},${s.y},${s.z},${s.yaw},${s.pitch}`;
    if (key === this.lastSentState) return;
    this.lastSentState = key;
    this.net.sendState(s);
  }

  updateMultiplayer(dt) {
    this.avatars.update(dt);

    this.stateSendTimer -= dt;
    if (this.stateSendTimer <= 0) {
      this.stateSendTimer = 1 / STATE_SEND_HZ;
      this.sendStateNow();
    }

    this.proximityTimer -= dt;
    if (this.proximityTimer <= 0) {
      this.proximityTimer = 0.5;
      const others = this.avatars.byDistance(this.player.pos);
      this.rtc?.updateProximity(others);
      const nearby = others.filter((o) => o.distance < CALL_DISTANCE).length;
      const total = this.avatars.count() + 1;
      let hint = '';
      if (nearby) hint = ` · ${nearby} in earshot`;
      else if (this.avatars.count()) hint = ' · walk up to someone to talk';
      else hint = ' · invite friends to this room!';
      this.ui.setRoomStatus(`#${this.room} — ${total} ${total === 1 ? 'person' : 'people'}${hint}`);
    }

    if (this.rtc) {
      this.rtc.updateListener(this.camera);
      for (const a of this.avatars.map.values()) {
        _headPos.set(a.group.position.x, a.group.position.y + 1.65, a.group.position.z);
        this.rtc.setPeerPosition(a.id, _headPos);
      }
    }

    this.minimap.update(dt, this.player, this.avatars);
  }

  // ============================================================
  // Materials (day/night + torch light shader injection)
  // ============================================================

  makeWorldMaterial(params) {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, ...params });
    const uniforms = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDayLight = uniforms.uDayLight;
      shader.uniforms.uMinLight = uniforms.uMinLight;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          'uniform float uDayLight;\nuniform float uMinLight;\n#include <common>',
        )
        .replace(
          '#include <color_fragment>',
          `#if defined( USE_COLOR )
            vec3 mcLight = max(vec3(vColor.r * uDayLight), vec3(1.0, 0.82, 0.55) * vColor.g);
            mcLight = max(mcLight, vec3(uMinLight));
            diffuseColor.rgb *= mcLight;
          #endif`,
        );
    };
    mat.customProgramCacheKey = () => 'mc-world-light';
    return mat;
  }

  // ============================================================
  // World / player lifecycle
  // ============================================================

  createWorld(seed, worldEdits) {
    if (this.world) {
      this.world.dispose();
      this.entities.clear();
    }
    this.worldSeed = seed >>> 0;
    this.world = new World({
      seed: this.worldSeed,
      scene: this.scene,
      materials: this.materials,
      viewRadius: this.settings.render,
      smoothLighting: this.settings.smooth,
    });
    if (worldEdits) this.world.loadWorldEdits(worldEdits);
    this.world.onEdit = (x, y, z, id) => this.net.sendBlock(x, y, z, id);
    this.entities.setWorld(this.world);

    this.minimap.setWorld(this.world);
    this.player = new Player(this.world);
    this.spawn = this.world.gen.findSpawn();
    // scatter players around the spawn so a full room doesn't stack up
    if (this.net.id) {
      const h = hashString(this.net.id);
      this.spawn.x += (h % 17) - 8;
      this.spawn.z += ((h >>> 5) % 17) - 8;
    }
    this.player.teleport(this.spawn.x + 0.5, this.spawn.y + 1, this.spawn.z + 0.5);
  }

  // ============================================================
  // State machine
  // ============================================================

  finishLoading() {
    // snap to the real surface (caves may have carved under the estimate)
    const bx = Math.floor(this.player.pos.x), bz = Math.floor(this.player.pos.z);
    let y = WORLD_H - 2;
    while (y > 1 && !BLOCKS[this.world.getBlock(bx, y, bz)].solid) y--;
    this.player.teleport(bx + 0.5, y + 1, bz + 0.5);

    this.state = 'playing';
    this.ui.hideAllMenus();
    this.ui.show('hud');
    this.ui.updateCombatHud?.(this.combat, this.combatHudSnapshot());
    this.startRtc();
    this.sendStateNow();
    this.ui.showToast(`Joined #${this.room}`);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.mining = false;
    this.rmbHeld = false;
    this.ui.show('pause');
  }

  resume() {
    this.ui.hideAllMenus();
    if (this.pickerOpen) this.closePicker(false);
    this.state = 'playing';
    this.lockPointer();
  }

  leaveWorld() {
    // a reload is the cleanest way to tear down the socket, the peer
    // connections and the world in one go
    window.location.reload();
  }

  applySetting(key, value) {
    this.settings[key] = value;
    saveJSON(SETTINGS_KEY, this.settings);
    switch (key) {
      case 'render':
        this.world.viewRadius = value;
        this.sky.setViewDistance(value);
        break;
      case 'fov': break; // applied smoothly each frame
      case 'vol': this.audio.setVolume(value / 100); break;
      case 'music': this.audio.setMusicOn(value); break;
      case 'clouds': this.sky.setCloudsVisible(value); break;
      case 'smooth':
        this.world.smoothLighting = value;
        this.world.remeshAll();
        break;
    }
  }

  saveHotbar() {
    saveJSON(HOTBAR_KEY, { hotbar: this.hotbar, slot: this.selected });
  }

  // ============================================================
  // Input
  // ============================================================

  touchLook(dx, dy) {
    if (this.state !== 'playing' || this.pickerOpen || this.chatOpen) return;
    const sens = (this.settings.sens / 100) * 0.0045;
    this.player.yaw -= dx * sens;
    this.player.pitch -= dy * sens;
    const lim = Math.PI / 2 - 0.001;
    this.player.pitch = Math.max(-lim, Math.min(lim, this.player.pitch));
  }

  lockPointer() {
    if (this.touchMode) return; // no pointer lock on touch devices
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
    } catch {
      this.canvas.requestPointerLock();
    }
  }

  bindInput() {
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.mining = false;
        this.rmbHeld = false;
        // ESC always exits pointer lock; with the chat bar open that just
        // means "keep typing with a visible cursor", not "pause"
        if (this.state === 'playing' && !this.pickerOpen && !this.chatOpen) this.pause();
      }
    });

    window.addEventListener('resize', () => {
      this.renderer.setSize(innerWidth, innerHeight);
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.handCamera.aspect = innerWidth / innerHeight;
      this.handCamera.updateProjectionMatrix();
    });

    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerdown', () => this.audio.ensure(), { capture: true });

    document.addEventListener('keydown', (e) => {
      if (this.state === 'title') return; // typing in the join form
      if (this.chatOpen) return;          // typing in the chat bar
      if (e.repeat) {
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
        return;
      }
      this.keys.add(e.code);

      if (this.state === 'playing' && this.pickerOpen && (e.code === 'KeyE' || e.code === 'Escape')) {
        e.preventDefault();
        this.closePicker(true);
        return;
      }
      if (this.state !== 'playing' || this.pickerOpen) return;

      switch (e.code) {
        case 'F3':
          e.preventDefault();
          this.debugVisible = !this.debugVisible;
          if (!this.debugVisible) this.ui.setDebug(false);
          break;
        case 'KeyF':
          this.player.flying = !this.player.flying;
          this.ui.showToast(this.player.flying ? 'Flying enabled' : 'Flying disabled');
          break;
        case 'KeyM':
          this.toggleMic();
          break;
        case 'KeyV':
          this.toggleCam();
          break;
        case 'KeyC':
          this.switchCamera();
          break;
        case 'KeyP':
          this.toggleScreenShare();
          break;
        case 'KeyT':
        case 'Enter':
          e.preventDefault();
          this.openChat();
          break;
        case 'Space': {
          e.preventDefault();
          const now = performance.now();
          if (now - this.lastSpace < 320) {
            this.player.flying = !this.player.flying;
            if (this.player.flying) this.player.vel.y = 0;
            this.ui.showToast(this.player.flying ? 'Flying enabled' : 'Flying disabled');
          }
          this.lastSpace = now;
          break;
        }
        case 'KeyW': {
          const now = performance.now();
          if (now - this.lastW < 300) this.sprintLatch = true;
          this.lastW = now;
          break;
        }
      }
    });

    document.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyW') this.sprintLatch = false;
    });

    // submit the join form with Enter
    for (const id of ['name-input', 'room-input']) {
      document.getElementById(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.join();
      });
    }

    // chat bar
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.closeChat(true); }
      else if (e.key === 'Escape') this.closeChat(false);
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked || this.state !== 'playing') return;
      const sens = (this.settings.sens / 100) * 0.0023;
      this.player.yaw -= e.movementX * sens;
      this.player.pitch -= e.movementY * sens;
      const lim = Math.PI / 2 - 0.001;
      this.player.pitch = Math.max(-lim, Math.min(lim, this.player.pitch));
    });

    document.addEventListener('mousedown', (e) => {
      if (this.state !== 'playing' || this.pickerOpen || this.chatOpen) return;
      if (!this.locked) { this.lockPointer(); return; }
      if (e.button === 0) {
        this.performAttack('slash');
      } else if (e.button === 2) {
        this.performAttack('stab');
      }
    });

    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mining = false;
      if (e.button === 2) this.rmbHeld = false;
    });

    document.addEventListener('wheel', (e) => {
      if (this.state !== 'playing' || !this.locked) return;
      if (Math.abs(e.deltaY) > 0) this.ui.showToast('Knife equipped');
    }, { passive: true });
  }

  // ============================================================
  // Hotbar / picker
  // ============================================================

  selectSlot(i) {
    this.selected = i;
    this.ui.updateHotbar(this.hotbar, i);
    this.ui.setPickerSelected(i);
    this.ui.showToast(BLOCKS[this.hotbar[i]].name);
    this.dipT = 0;
    this.audio.pop();
    this.saveHotbar();
  }

  assignBlock(id) {
    this.hotbar[this.selected] = id;
    this.ui.updateHotbar(this.hotbar, this.selected);
    this.ui.showToast(BLOCKS[id].name);
    this.audio.click();
    this.dipT = 0;
    this.saveHotbar();
  }

  openPicker() {
    this.pickerOpen = true;
    this.mining = false;
    this.rmbHeld = false;
    this.ui.show('picker');
    this.ui.setPickerSelected(this.selected);
    document.exitPointerLock?.();
  }

  closePicker(relock) {
    this.pickerOpen = false;
    this.ui.hide('picker');
    if (relock) this.lockPointer();
  }

  // ============================================================
  // Text chat (Runescape-style bubbles above heads)
  // ============================================================

  openChat() {
    this.chatOpen = true;
    this.mining = false;
    this.rmbHeld = false;
    this.keys.clear(); // stop walking while typing
    const input = document.getElementById('chat-input');
    input.value = '';
    document.getElementById('chat-bar').classList.remove('hidden');
    input.focus();
  }

  closeChat(send) {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (send && text) {
      this.net.sendChat(text);
      this.ui.showToast(`You: ${text}`);
    }
    input.value = '';
    input.blur();
    document.getElementById('chat-bar').classList.add('hidden');
    this.chatOpen = false;
    if (!this.locked && this.state === 'playing') this.lockPointer();
  }

  // ============================================================
  // Interaction: knife combat
  // ============================================================

  currentTarget() {
    const eye = this.player.eyePosition(new THREE.Vector3());
    const dir = this.player.lookDir(new THREE.Vector3());
    return raycastVoxel(this.world, eye, dir, REACH);
  }

  swing() { this.swingT = 0; }

  performAttack(kind) {
    if (this.combat.me.alive === false) return;
    const cooldown = kind === 'stab' ? COMBAT.STAB_COOLDOWN_MS : COMBAT.SLASH_COOLDOWN_MS;
    const now = performance.now();
    if (cooldownFraction(now, this.lastAttackAt[kind], cooldown) < 1) return;
    this.lastAttackAt[kind] = now;
    this.attackAnim = { kind, t: 0 };
    this.swingT = 0;
    this.sendStateNow();
    this.net.sendAttack(kind);
    this.ui.updateCombatHud?.(this.combat, this.combatHudSnapshot());
  }

  combatHudSnapshot() {
    const now = performance.now();
    return {
      slashReady: cooldownFraction(now, this.lastAttackAt.slash, COMBAT.SLASH_COOLDOWN_MS),
      stabReady: cooldownFraction(now, this.lastAttackAt.stab, COMBAT.STAB_COOLDOWN_MS),
      hitMarker: this.hitMarkerT > 0,
    };
  }

  updateCombat(dt) {
    this.outline.visible = false;
    this.crack.visible = false;
    this.hitMarkerT = Math.max(0, this.hitMarkerT - dt);
    this.ui.updateCombatHud?.(this.combat, this.combatHudSnapshot());
  }

  updateInteraction(dt) {
    const target = this.currentTarget();

    // ---- outline ----
    if (target) {
      this.outline.visible = true;
      this.outline.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
    } else {
      this.outline.visible = false;
    }

    // ---- mining ----
    if (this.mining && target) {
      const key = `${target.x},${target.y},${target.z}`;
      if (this.miningCell !== key) {
        this.miningCell = key;
        this.miningProgress = 0;
      }
      const def = BLOCKS[target.id];
      if (def.hardness !== Infinity) {
        const speed = this.player.headInWater ? 0.35 : 1;
        this.miningProgress += dt * speed;
        if (this.swingT > 0.7) this.swing(); // keep punching
        const frac = Math.min(1, this.miningProgress / def.hardness);
        const stage = Math.min(7, Math.floor(frac * 8));
        if (frac > 0.02 && def.hardness > 0.12) {
          this.crack.visible = true;
          this.crack.position.copy(this.outline.position);
          this.crackMat.map = this.crackTextures[stage];
          this.crackMat.needsUpdate = true;
        } else {
          this.crack.visible = false;
        }
        if (this.miningProgress >= def.hardness) {
          this.breakBlock(target);
          this.miningCell = null;
          this.miningProgress = -0.08; // tiny grace before next block
          this.crack.visible = false;
        }
      } else {
        this.crack.visible = false;
      }
    } else {
      this.crack.visible = false;
      if (!this.mining) { this.miningProgress = 0; this.miningCell = null; }
    }

    // ---- place repeat ----
    if (this.rmbHeld) {
      this.placeTimer -= dt;
      if (this.placeTimer <= 0) {
        this.placeTimer = 0.24;
        this.placeBlock();
      }
    }
  }

  breakBlock(target) {
    const id = target.id;
    if (id === B.TNT) {
      this.net.sendTnt(target.x, target.y, target.z);
      this.entities.igniteTNT(target.x, target.y, target.z);
      return;
    }
    this.world.setBlock(target.x, target.y, target.z, B.AIR);
    this.particles.spawnBlockBreak(target.x, target.y, target.z, id);
    this.audio.blockBreak(id);
  }

  placeBlock() {
    const target = this.currentTarget();
    if (!target) return;
    const id = this.hotbar[this.selected];
    const def = BLOCKS[id];
    const targetDef = BLOCKS[target.id];

    let cx, cy, cz;
    if (targetDef.replaceable) {
      cx = target.x; cy = target.y; cz = target.z;
    } else {
      if (target.nx === 0 && target.ny === 0 && target.nz === 0) return;
      cx = target.x + target.nx; cy = target.y + target.ny; cz = target.z + target.nz;
    }
    if (cy < 1 || cy >= WORLD_H) return;

    const cellId = this.world.getBlock(cx, cy, cz);
    const cellDef = BLOCKS[cellId];
    if (cellId !== B.AIR && !cellDef.replaceable) return;
    if (def.solid && this.player.intersectsCell(cx, cy, cz)) return;
    // don't place a block inside another player
    if (def.solid && this.avatarIntersectsCell(cx, cy, cz)) return;

    // support rules
    const below = this.world.getBlock(cx, cy - 1, cz);
    if (def.support === 'floor') {
      if (id === B.TORCH) {
        if (!BLOCKS[below].solid) return;
      } else if (below !== B.GRASS && below !== B.DIRT && below !== B.SNOW_GRASS && below !== B.SAND) {
        return; // plants need soil
      }
    }
    if (def.support === 'sand' && below !== B.SAND && below !== B.CACTUS) return;

    this.world.setBlock(cx, cy, cz, id);
    this.audio.blockPlace(id);
    this.swing();
  }

  avatarIntersectsCell(cx, cy, cz) {
    for (const a of this.avatars.map.values()) {
      const p = a.group.position;
      if (Math.abs(p.x - (cx + 0.5)) < 0.8 &&
          Math.abs(p.z - (cz + 0.5)) < 0.8 &&
          cy + 1 > p.y && cy < p.y + 1.9) return true;
    }
    return false;
  }

  pickTargetBlock() {
    const target = this.currentTarget();
    if (!target) return;
    if (PALETTE.includes(target.id)) {
      this.assignBlock(target.id);
    }
  }

  // ============================================================
  // Support / gravity checks (queued by world.setBlock)
  // ============================================================

  processSupportChecks() {
    const list = this.world.supportChecks;
    if (!list.length) return;
    const batch = list.splice(0, 128);
    for (const [x, y, z] of batch) {
      const id = this.world.getBlock(x, y, z);
      if (id === B.AIR) continue;
      const def = BLOCKS[id];
      const below = this.world.getBlock(x, y - 1, z);
      const belowSolid = BLOCKS[below].solid;

      if (def.gravity && !belowSolid) {
        this.entities.spawnFallingBlock(x, y, z, id);
      } else if (def.support === 'floor' && !belowSolid) {
        this.world.setBlock(x, y, z, B.AIR);
        this.particles.spawnBlockBreak(x, y, z, id);
        this.audio.blockBreak(id);
      } else if (def.support === 'sand' && below !== B.SAND && below !== B.CACTUS) {
        this.world.setBlock(x, y, z, B.AIR);
        this.particles.spawnBlockBreak(x, y, z, id);
        this.audio.blockBreak(id);
      }
    }
  }

  // ============================================================
  // Knife (first-person view model)
  // ============================================================

  heldGeometry(id) {
    let g = this.heldGeoCache.get(id);
    if (!g) { g = buildBlockGeometry(id); this.heldGeoCache.set(id, g); }
    return g;
  }

  createKnifeViewModel() {
    const group = new THREE.Group();
    const bladeMat = new THREE.MeshBasicMaterial({ color: 0xd9dee7 });
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xf7f8f6 });
    const handleMat = new THREE.MeshBasicMaterial({ color: 0x20242a });
    const gripMat = new THREE.MeshBasicMaterial({ color: 0x5fb3b3 });

    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.72, 0.026), bladeMat);
    blade.position.y = 0.34;
    blade.rotation.z = -0.08;
    group.add(blade);

    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.66, 0.031), edgeMat);
    edge.position.set(0.045, 0.35, 0.004);
    edge.rotation.z = -0.08;
    group.add(edge);

    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 4), bladeMat);
    tip.position.set(-0.028, 0.74, 0);
    tip.rotation.set(0, Math.PI / 4, -0.08);
    group.add(tip);

    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.05, 0.06), handleMat);
    guard.position.y = -0.04;
    group.add(guard);

    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.44, 0.085), handleMat);
    handle.position.y = -0.27;
    group.add(handle);

    for (let i = 0; i < 4; i++) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.025, 0.095), gripMat);
      band.position.y = -0.11 - i * 0.09;
      group.add(band);
    }

    group.rotation.set(-0.18, 0.25, -0.16);
    return group;
  }

  updateHand(dt) {
    if (!this.knifeMesh) {
      this.knifeMesh = this.createKnifeViewModel();
      this.handGroup.add(this.knifeMesh);
    }

    const duration = this.attackAnim.kind === 'stab' ? 0.34 : 0.28;
    this.attackAnim.t = Math.min(1, this.attackAnim.t + dt / duration);
    this.swingT = this.attackAnim.t;
    this.dipT = Math.min(1, this.dipT + dt / 0.22);

    const p = this.player;
    const bobX = Math.sin(p.walkCycle * 1.0) * 0.022 * p.bobStrength;
    const bobY = -Math.abs(Math.sin(p.walkCycle * 1.0)) * 0.018 * p.bobStrength;
    const swing = Math.sin(Math.min(1, this.attackAnim.t) * Math.PI);
    const dip = Math.sin(Math.min(1, this.dipT) * Math.PI);
    const stab = this.attackAnim.kind === 'stab' ? swing : 0;
    const slash = this.attackAnim.kind === 'slash' ? swing : 0;

    this.handGroup.position.set(
      0.47 + bobX - slash * 0.28,
      -0.43 + bobY - dip * 0.16 - slash * 0.08,
      -0.82 - stab * 0.46,
    );
    this.handGroup.rotation.set(
      -0.34 - stab * 0.18 + slash * 0.22,
      0.52 - slash * 0.95,
      -0.18 - slash * 1.15,
    );
  }

  // ============================================================
  // Icons (rendered with the real block geometry + atlas)
  // ============================================================

  makeIcons() {
    const icons = new Map();
    const SIZE = 64;
    const rt = new THREE.WebGLRenderTarget(SIZE, SIZE);
    const iconScene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-0.82, 0.82, 0.82, -0.82, 0.1, 10);
    cam.position.set(1.84, 1.5, 1.84);
    cam.lookAt(0, 0, 0);

    const buf = new Uint8Array(SIZE * SIZE * 4);
    const cnv = document.createElement('canvas');
    cnv.width = cnv.height = SIZE;
    const ctx = cnv.getContext('2d');

    for (const id of PALETTE) {
      const def = BLOCKS[id];
      if (def.shape === 'cross' || def.shape === 'torch' || def.shape === 'liquid') {
        icons.set(id, tileIconCanvas(def.tex.py, SIZE).toDataURL());
        continue;
      }
      const mesh = new THREE.Mesh(this.heldGeometry(id), this.materials.solid);
      iconScene.add(mesh);
      this.renderer.setRenderTarget(rt);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
      this.renderer.render(iconScene, cam);
      this.renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, buf);
      this.renderer.setRenderTarget(null);
      iconScene.remove(mesh);

      // flip vertically + linear -> sRGB-ish gamma
      const img = ctx.createImageData(SIZE, SIZE);
      for (let y = 0; y < SIZE; y++) {
        const src = (SIZE - 1 - y) * SIZE * 4;
        const dst = y * SIZE * 4;
        for (let x = 0; x < SIZE * 4; x += 4) {
          img.data[dst + x] = Math.round(255 * Math.pow(buf[src + x] / 255, 1 / 2.2));
          img.data[dst + x + 1] = Math.round(255 * Math.pow(buf[src + x + 1] / 255, 1 / 2.2));
          img.data[dst + x + 2] = Math.round(255 * Math.pow(buf[src + x + 2] / 255, 1 / 2.2));
          img.data[dst + x + 3] = buf[src + x + 3];
        }
      }
      ctx.putImageData(img, 0, 0);
      icons.set(id, cnv.toDataURL());
    }
    rt.dispose();
    return icons;
  }

  // ============================================================
  // Frame loop
  // ============================================================

  frame(t) {
    // never let a single bad frame kill the whole game loop
    try {
      this.frameInner(t);
    } catch (err) {
      console.error('[frame]', err);
      window.__lastFrameError = (err && err.stack) || String(err);
    }
    this.scheduleFrame();
  }

  frameInner(t) {
    const dt = Math.min(0.1, (t - this.lastT) / 1000);
    this.lastT = t;

    // fps tracking
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    switch (this.state) {
      case 'title': this.frameTitle(dt); break;
      case 'loading': this.frameLoading(dt); break;
      case 'playing': this.framePlaying(dt, false); break;
      // the party keeps going while the menu is open — others still
      // move and talk and the world still streams; only input is ignored
      case 'paused': this.framePlaying(dt, true); break;
    }

    this.renderer.render(this.scene, this.camera);
    this.lastDrawInfo.calls = this.renderer.info.render.calls;
    this.lastDrawInfo.triangles = this.renderer.info.render.triangles;

    if (this.state === 'playing') {
      // overlay pass: keep the world pixels, only reset depth
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.handScene, this.handCamera);
      this.renderer.autoClear = true;
    }
  }

  frameTitle(dt) {
    this.titleAngle += dt * 0.05;
    this.world.update(this.spawn.x, this.spawn.z, 10);
    const r = 42;
    this.camera.position.set(
      this.spawn.x + Math.cos(this.titleAngle) * r,
      this.spawn.y + 22,
      this.spawn.z + Math.sin(this.titleAngle) * r,
    );
    this.camera.lookAt(this.spawn.x, this.spawn.y + 2, this.spawn.z);
    this.sky.update(dt, this.camera.position);
  }

  frameLoading(dt) {
    this.world.update(this.player.pos.x, this.player.pos.z, 14);
    const radius = Math.min(4, this.settings.render);
    const { ready, total } = this.world.readiness(this.player.pos.x, this.player.pos.z, radius);
    this.ui.setLoadingProgress(total ? ready / total : 0);
    this.sky.update(dt, this.camera.position);
    this.avatars.update(dt);
    if (ready >= total) this.finishLoading();
  }

  framePlaying(dt, menuOpen) {
    const p = this.player;

    // ---- input snapshot ----
    const alive = this.combat.me.alive !== false;
    const inputActive = alive && !this.pickerOpen && !menuOpen && !this.chatOpen;
    const input = {
      forward: inputActive && this.keys.has('KeyW'),
      back: inputActive && this.keys.has('KeyS'),
      left: inputActive && this.keys.has('KeyA'),
      right: inputActive && this.keys.has('KeyD'),
      jump: inputActive && this.keys.has('Space'),
      sneak: inputActive && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')),
    };
    // merge touch input (joystick + on-screen buttons)
    let touchSprint = false;
    if (this.touch) {
      const t = this.touch;
      if (inputActive) {
        input.forward = input.forward || t.moveY < -0.25;
        input.back = input.back || t.moveY > 0.25;
        input.left = input.left || t.moveX < -0.25;
        input.right = input.right || t.moveX > 0.25;
        input.jump = input.jump || t.jump;
        input.sneak = input.sneak || t.sneak;
        touchSprint = t.wantsSprint();
      }
      // Touch mine/place buttons become quick slash / committed stab.
      const mineNow = inputActive && t.mine;
      if (mineNow !== this._touchMinePrev) {
        if (mineNow) this.performAttack('slash');
        this._touchMinePrev = mineNow;
      }
      const placeNow = inputActive && t.place;
      if (placeNow !== this._touchPlacePrev) {
        if (placeNow) this.performAttack('stab');
        this._touchPlacePrev = placeNow;
      }
    }

    const wantSprint = inputActive &&
      (this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.sprintLatch || touchSprint);
    p.sprinting = wantSprint && input.forward && !input.sneak;

    // ---- simulate ----
    p.update(dt, input);

    // void rescue
    if (p.pos.y < -14) {
      p.teleport(this.spawn.x, Math.max(this.spawn.y + 2, 70), this.spawn.z);
      p.vel.set(0, 0, 0);
    }

    // ---- player audio events ----
    for (const ev of p.events) {
      if (ev.type === 'step') this.audio.step(ev.id);
      else if (ev.type === 'land') { this.audio.land(ev.impact); if (ev.impact > 22) this.ui.flashDamage(); }
      else if (ev.type === 'splash') this.audio.splash();
    }
    p.events.length = 0;

    // ---- interaction & world streaming ----
    const canInteract = (this.locked || this.touchMode) &&
      !this.pickerOpen && !menuOpen && !this.chatOpen;
    if (canInteract) this.updateCombat(dt);
    else { this.outline.visible = false; this.crack.visible = false; }

    this.world.update(p.pos.x, p.pos.z, 5);
    this.processSupportChecks();
    this.entities.update(dt);

    // ---- multiplayer ----
    this.updateMultiplayer(dt);

    // ---- camera ----
    const eye = p.eyePosition(new THREE.Vector3());
    let bobY = 0, bobRoll = 0;
    if (this.settings.bob && !p.flying) {
      bobY = Math.abs(Math.sin(p.walkCycle)) * 0.052 * p.bobStrength;
      bobRoll = Math.sin(p.walkCycle) * 0.004 * p.bobStrength;
    }
    this.shakeT = Math.max(0, this.shakeT - dt);
    const sh = this.shakeT * this.shakeT * 0.35;
    this.camera.position.set(
      eye.x + (Math.random() - 0.5) * sh,
      eye.y + bobY + (Math.random() - 0.5) * sh,
      eye.z + (Math.random() - 0.5) * sh,
    );
    this.camera.rotation.set(p.pitch, p.yaw, bobRoll);

    // smooth FOV (sprint kick)
    const targetFov = this.settings.fov * (p.sprinting ? (p.flying ? 1.18 : 1.12) : 1);
    this.fovCurrent += (targetFov - this.fovCurrent) * Math.min(1, 10 * dt);
    if (Math.abs(this.fovCurrent - this.camera.fov) > 0.05) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }

    // ---- environment ----
    this.sky.setUnderwater(p.headInWater);
    this.ui.setUnderwater(p.headInWater);
    this.sky.update(dt, this.camera.position);
    this.waterTex.offset.x = (t_now() * 0.018) % 1;
    this.waterTex.offset.y = (t_now() * 0.011) % 1;

    this.updateHand(dt);

    // ---- debug ----
    if (this.debugVisible) {
      this.debugTimer -= dt;
      if (this.debugTimer <= 0) {
        this.debugTimer = 0.2;
        this.ui.setDebug(true, this.debugText());
      }
    }
  }

  debugText() {
    const p = this.player;
    const bx = Math.floor(p.pos.x), by = Math.floor(p.pos.y), bz = Math.floor(p.pos.z);
    const cx = Math.floor(bx / CHUNK), cz = Math.floor(bz / CHUNK);
    const yawDeg = ((THREE.MathUtils.radToDeg(p.yaw) % 360) + 360) % 360;
    const dirs = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
    const facing = dirs[Math.round(yawDeg / 45) % 8];
    const target = this.currentTarget();
    const biome = BIOME_NAMES[this.world.biomeAt(bx, bz)] ?? '?';
    return [
      `Block Party (Three.js) — ${this.fps} fps`,
      `Room: #${this.room}   Players: ${this.avatars.count() + 1}   Calls: ${this.rtc ? this.rtc.calls.size : 0}`,
      `XYZ: ${p.pos.x.toFixed(2)} / ${p.pos.y.toFixed(2)} / ${p.pos.z.toFixed(2)}`,
      `Block: ${bx} ${by} ${bz}   Chunk: ${cx} ${cz} [${bx & 15} ${bz & 15}]`,
      `Facing: ${facing} (yaw ${yawDeg.toFixed(1)}°, pitch ${THREE.MathUtils.radToDeg(p.pitch).toFixed(1)}°)`,
      `Biome: ${biome}   Time: ${this.sky.clockString()}`,
      `Seed: ${this.worldSeed}`,
      `Chunks: ${this.world.countLoaded()} ready / ${this.world.chunks.size} loaded   Edits: ${this.world.editCount}`,
      `Entities: ${this.entities.list.length}   Particles: ${this.particles.list.length}`,
      `Draw calls: ${this.lastDrawInfo.calls}   Tris: ${(this.lastDrawInfo.triangles / 1000).toFixed(1)}k`,
      `Flags: ${p.onGround ? 'ground ' : ''}${p.flying ? 'flying ' : ''}${p.inWater ? 'water ' : ''}${p.sprinting ? 'sprint ' : ''}${p.sneaking ? 'sneak' : ''}`,
      target ? `Target: ${BLOCKS[target.id].name} @ ${target.x} ${target.y} ${target.z}` : 'Target: —',
    ].join('\n');
  }
}

const t_now = () => performance.now() / 1000;
const _headPos = new THREE.Vector3();

// ------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  try {
    window.game = new Game(); // exposed for debugging / tinkering
  } catch (err) {
    console.error('Failed to start:', err);
    document.getElementById('webgl-error')?.classList.remove('hidden');
    throw err;
  }
});
