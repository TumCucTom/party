// ============================================================
// World3D — server-side state for the voxel spatial video chat
// (/world). Each room has a deterministic seed (derived from
// its name, so the same room code always generates the same
// terrain), a log of block edits, and the live player list.
// The server is a relay + source of truth for late joiners:
// clients run the simulation, the server stores edits and
// rebroadcasts positions/edits/TNT to the rest of the room.
// ============================================================

const fs = require('fs');
const path = require('path');

const Constants = require('../shared/constants');

const MSG = Constants.MSG_TYPES_3D;
const COMBAT = Constants.COMBAT_3D;
const DAY_LENGTH = 1200;        // seconds per in-game day (kept in sync by clients)
const MAX_EDITS_PER_ROOM = 250000;
const MAX_PLAYERS_PER_ROOM = 40;
const FACE_FRAME_MIN_MS = 450;
const MAX_FACE_FRAME_CHARS = 40000;
const FACE_FRAME_RE = /^data:image\/jpe?g;base64,[A-Za-z0-9+/=]+$/;

/** FNV-1a — must match hashString in src/client3d/noise.js. */
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function sanitizeRoom(room) {
  const r = String(room || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return r || 'public';
}

function sanitizeName(name) {
  const n = String(name || '').trim().slice(0, 16);
  return n || 'guest';
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

const ATTACKS = {
  slash: {
    damage: COMBAT.SLASH_DAMAGE,
    range: COMBAT.SLASH_RANGE,
    cooldownMs: COMBAT.SLASH_COOLDOWN_MS,
    coneCos: Math.cos((COMBAT.SLASH_CONE_DEG * Math.PI / 180) / 2),
  },
  stab: {
    damage: COMBAT.STAB_DAMAGE,
    range: COMBAT.STAB_RANGE,
    cooldownMs: COMBAT.STAB_COOLDOWN_MS,
    coneCos: Math.cos((COMBAT.STAB_CONE_DEG * Math.PI / 180) / 2),
  },
};

function withCombatState(player) {
  return Object.assign(player, {
    hp: COMBAT.MAX_HP,
    alive: true,
    kills: 0,
    deaths: 0,
    lastAttackAt: 0,
    respawnAt: 0,
  });
}

function serializePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch,
    hp: player.hp,
    alive: player.alive,
    kills: player.kills,
    deaths: player.deaths,
  };
}

function forwardFromYaw(yaw) {
  return {
    x: -Math.sin(yaw || 0),
    z: -Math.cos(yaw || 0),
  };
}

function isInAttackCone(attacker, target, attack) {
  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  if (horizontal < 0.001) return true;
  const f = forwardFromYaw(attacker.yaw);
  const dot = ((dx / horizontal) * f.x) + ((dz / horizontal) * f.z);
  return dot >= attack.coneCos;
}

function distanceBetweenPlayers(a, b) {
  const dx = b.x - a.x;
  const dy = (b.y + 0.9) - (a.y + 0.9);
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

class Room {
  constructor(name) {
    this.name = name;
    this.seed = hashString(`party:${name}`);
    this.edits = new Map();     // "x,y,z" -> [x, y, z, blockId]
    this.players = new Map();   // socketId -> { id, name, x, y, z, yaw, pitch }
    this.createdAt = Date.now();
    this.lastSeen = Date.now();
  }

  /** Time of day in [0, 1) — rooms start mid-morning and share a clock. */
  timeOfDay() {
    return (0.1 + ((Date.now() - this.createdAt) / 1000) / DAY_LENGTH) % 1;
  }

  channel() {
    return `w3/${this.name}`;
  }
}

// empty rooms (and their builds) are kept for a day so a world
// survives everyone briefly stepping out, then swept to bound memory
const ROOM_TTL_MS = 1000 * 60 * 60 * 24;

class World3D {
  /**
   * @param {object} opts
   * @param {string|null} opts.file  JSON file to persist rooms + edits to,
   *                                 so worlds survive server restarts
   */
  constructor(io, { sweepIntervalMs = 1000 * 60 * 10, file = null, saveIntervalMs = 30000 } = {}) {
    this.io = io;
    this.rooms = new Map();     // name -> Room
    this.socketRoom = new Map(); // socketId -> room name
    this.file = file;
    this.dirty = false;
    if (file) this.load();
    if (sweepIntervalMs > 0) {
      const t = setInterval(() => this.sweep(), sweepIntervalMs);
      if (t.unref) t.unref();
    }
    if (file && saveIntervalMs > 0) {
      const t = setInterval(() => this.save(), saveIntervalMs);
      if (t.unref) t.unref();
      // flush builds on shutdown (Ctrl-C, docker stop, dyno cycling)
      for (const sig of ['SIGINT', 'SIGTERM']) {
        process.once(sig, () => { this.save(); process.exit(0); });
      }
    }
  }

  sweep(now = Date.now()) {
    for (const [name, r] of this.rooms) {
      if (!r.players.size && now - r.lastSeen > ROOM_TTL_MS) {
        this.rooms.delete(name);
        this.dirty = true;
      }
    }
  }

  // ----------------------------------------------------------
  // Persistence (worlds survive server restarts)
  // ----------------------------------------------------------

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [name, saved] of Object.entries(data.rooms || {})) {
        const room = new Room(name);
        room.createdAt = saved.createdAt || Date.now();
        room.lastSeen = saved.lastSeen || Date.now();
        for (const e of saved.edits || []) room.edits.set(`${e[0]},${e[1]},${e[2]}`, e);
        this.rooms.set(name, room);
      }
      console.log(`[world3d] loaded ${this.rooms.size} room(s) from ${this.file}`);
    } catch (err) {
      console.error('[world3d] failed to load worlds:', err.message);
    }
  }

  save() {
    if (!this.file || !this.dirty) return;
    try {
      const rooms = {};
      for (const [name, r] of this.rooms) {
        rooms[name] = {
          createdAt: r.createdAt,
          lastSeen: r.lastSeen,
          edits: [...r.edits.values()],
        };
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, rooms }));
      fs.renameSync(tmp, this.file); // atomic — never a half-written file
      this.dirty = false;
    } catch (err) {
      console.error('[world3d] failed to save worlds:', err.message);
    }
  }

  /** Live snapshot of a room for the join screen preview. */
  roomInfo(roomName) {
    const r = this.rooms.get(sanitizeRoom(roomName));
    if (!r) return { exists: false, players: [], edits: 0 };
    return {
      exists: true,
      players: [...r.players.values()].map((p) => p.name),
      edits: r.edits.size,
    };
  }

  attach(socket) {
    socket.on(MSG.JOIN, (msg) => this.join(socket, msg || {}));
    socket.on(MSG.STATE, (msg) => this.state(socket, msg || {}));
    socket.on(MSG.BLOCK, (msg) => this.block(socket, msg || {}));
    socket.on(MSG.TNT, (msg) => this.tnt(socket, msg || {}));
    socket.on(MSG.CHAT, (msg) => this.chat(socket, msg || {}));
    socket.on(MSG.FACE, (msg) => this.face(socket, msg || {}));
    socket.on(MSG.ATTACK, (msg) => this.attack(socket, msg || {}));
    socket.on('disconnect', () => this.leave(socket));
  }

  roomOf(socket) {
    const name = this.socketRoom.get(socket.id);
    return name ? this.rooms.get(name) : null;
  }

  join(socket, { room, name }) {
    this.leave(socket); // joining twice = move rooms

    const roomName = sanitizeRoom(room);
    let r = this.rooms.get(roomName);
    if (!r) {
      r = new Room(roomName);
      this.rooms.set(roomName, r);
      this.dirty = true; // persist createdAt → the room's day/night clock
    }
    if (r.players.size >= MAX_PLAYERS_PER_ROOM) {
      socket.emit(MSG.INIT, { error: 'room_full' });
      return;
    }

    const player = withCombatState({
      id: socket.id, name: sanitizeName(name), x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    });
    r.players.set(socket.id, player);
    r.lastSeen = Date.now();
    this.socketRoom.set(socket.id, roomName);
    socket.join(r.channel());

    socket.emit(MSG.INIT, {
      id: socket.id,
      me: serializePlayer(player),
      seed: r.seed,
      time: r.timeOfDay(),
      edits: [...r.edits.values()],
      players: [...r.players.values()].filter((p) => p.id !== socket.id).map(serializePlayer),
    });
    socket.to(r.channel()).emit(MSG.PLAYER, serializePlayer(player));
  }

  state(socket, s) {
    const r = this.roomOf(socket);
    if (!r) return;
    const p = r.players.get(socket.id);
    if (!p) return;
    if (!isFiniteNumber(s.x) || !isFiniteNumber(s.y) || !isFiniteNumber(s.z)) return;
    p.x = s.x; p.y = s.y; p.z = s.z;
    p.yaw = isFiniteNumber(s.yaw) ? s.yaw : 0;
    p.pitch = isFiniteNumber(s.pitch) ? s.pitch : 0;
    socket.to(r.channel()).emit(MSG.STATE, {
      id: socket.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
    });
  }

  block(socket, { x, y, z, id }) {
    const r = this.roomOf(socket);
    if (!r) return;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return;
    if (!Number.isInteger(id) || id < 0 || id > 255) return;
    if (r.edits.size >= MAX_EDITS_PER_ROOM && !r.edits.has(`${x},${y},${z}`)) return;
    r.edits.set(`${x},${y},${z}`, [x, y, z, id]);
    this.dirty = true;
    socket.to(r.channel()).emit(MSG.BLOCK, { x, y, z, id });
  }

  tnt(socket, { x, y, z }) {
    const r = this.roomOf(socket);
    if (!r) return;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return;
    socket.to(r.channel()).emit(MSG.TNT, { x, y, z });
  }

  chat(socket, { text }) {
    const r = this.roomOf(socket);
    if (!r) return;
    const p = r.players.get(socket.id);
    if (!p || typeof text !== 'string') return;
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120);
    if (!clean) return;
    const now = Date.now();
    if (p.lastChatAt && now - p.lastChatAt < 750) return; // rate limit
    p.lastChatAt = now;
    socket.to(r.channel()).emit(MSG.CHAT, { id: socket.id, text: clean });
  }

  face(socket, { image }) {
    const r = this.roomOf(socket);
    if (!r) return;
    const p = r.players.get(socket.id);
    if (!p) return;
    if (typeof image !== 'string') return;
    if (image.length > MAX_FACE_FRAME_CHARS || !FACE_FRAME_RE.test(image)) return;
    const now = Date.now();
    if (p.lastFaceFrameAt && now - p.lastFaceFrameAt < FACE_FRAME_MIN_MS) return;
    p.lastFaceFrameAt = now;
    socket.to(r.channel()).emit(MSG.FACE, { id: socket.id, image });
  }

  attack(socket, { kind }) {
    const attack = ATTACKS[kind];
    if (!attack) return;
    const r = this.roomOf(socket);
    if (!r) return;
    const attacker = r.players.get(socket.id);
    if (!attacker || !attacker.alive) return;

    const now = Date.now();
    if (attacker.lastAttackAt && now - attacker.lastAttackAt < attack.cooldownMs) return;
    attacker.lastAttackAt = now;

    const target = this.findAttackTarget(r, attacker, attack);
    if (!target) return;

    target.hp = Math.max(0, target.hp - attack.damage);
    const hit = {
      attackerId: attacker.id,
      victimId: target.id,
      damage: attack.damage,
      hp: target.hp,
      kind,
    };
    this.emitToRoom(socket, r, MSG.HIT, hit);

    if (target.hp <= 0 && target.alive) {
      target.alive = false;
      target.deaths += 1;
      attacker.kills += 1;
      target.respawnAt = now + COMBAT.RESPAWN_MS;
      const death = {
        attackerId: attacker.id,
        victimId: target.id,
        attackerKills: attacker.kills,
        victimDeaths: target.deaths,
        respawnMs: COMBAT.RESPAWN_MS,
      };
      this.emitToRoom(socket, r, MSG.DEATH, death);
      this.scheduleRespawn(socket, r.name, target.id);
    }
  }

  findAttackTarget(room, attacker, attack) {
    let best = null;
    let bestDist = Infinity;
    for (const target of room.players.values()) {
      if (target.id === attacker.id || !target.alive) continue;
      const dist = distanceBetweenPlayers(attacker, target);
      if (dist > attack.range || dist >= bestDist) continue;
      if (!isInAttackCone(attacker, target, attack)) continue;
      best = target;
      bestDist = dist;
    }
    return best;
  }

  scheduleRespawn(sourceSocket, roomName, playerId) {
    setTimeout(() => {
      const r = this.rooms.get(roomName);
      if (!r) return;
      const p = r.players.get(playerId);
      if (!p || p.alive) return;
      p.hp = COMBAT.MAX_HP;
      p.alive = true;
      p.respawnAt = 0;
      const msg = {
        id: p.id,
        hp: p.hp,
        alive: p.alive,
        deaths: p.deaths,
        kills: p.kills,
      };
      this.emitToRoom(sourceSocket, r, MSG.RESPAWN, msg);
    }, COMBAT.RESPAWN_MS);
  }

  emitToRoom(socket, room, event, payload) {
    socket.emit(event, payload);
    socket.to(room.channel()).emit(event, payload);
  }

  leave(socket) {
    const roomName = this.socketRoom.get(socket.id);
    if (!roomName) return;
    this.socketRoom.delete(socket.id);
    const r = this.rooms.get(roomName);
    if (!r) return;
    r.players.delete(socket.id);
    r.lastSeen = Date.now();
    socket.leave(r.channel());
    socket.to(r.channel()).emit(MSG.LEAVE, socket.id);
  }
}

module.exports = { World3D, Room, hashString, sanitizeRoom, sanitizeName };
