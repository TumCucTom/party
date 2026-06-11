// ============================================================
// World3D — server-side state for the voxel spatial video chat
// (/world). Each room has a deterministic seed (derived from
// its name, so the same room code always generates the same
// terrain), a log of block edits, and the live player list.
// The server is a relay + source of truth for late joiners:
// clients run the simulation, the server stores edits and
// rebroadcasts positions/edits/TNT to the rest of the room.
// ============================================================

const Constants = require('../shared/constants');

const MSG = Constants.MSG_TYPES_3D;
const DAY_LENGTH = 1200;        // seconds per in-game day (kept in sync by clients)
const MAX_EDITS_PER_ROOM = 250000;
const MAX_PLAYERS_PER_ROOM = 40;

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
  constructor(io, { sweepIntervalMs = 1000 * 60 * 10 } = {}) {
    this.io = io;
    this.rooms = new Map();     // name -> Room
    this.socketRoom = new Map(); // socketId -> room name
    if (sweepIntervalMs > 0) {
      const t = setInterval(() => this.sweep(), sweepIntervalMs);
      if (t.unref) t.unref();
    }
  }

  sweep(now = Date.now()) {
    for (const [name, r] of this.rooms) {
      if (!r.players.size && now - r.lastSeen > ROOM_TTL_MS) this.rooms.delete(name);
    }
  }

  attach(socket) {
    socket.on(MSG.JOIN, (msg) => this.join(socket, msg || {}));
    socket.on(MSG.STATE, (msg) => this.state(socket, msg || {}));
    socket.on(MSG.BLOCK, (msg) => this.block(socket, msg || {}));
    socket.on(MSG.TNT, (msg) => this.tnt(socket, msg || {}));
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
    }
    if (r.players.size >= MAX_PLAYERS_PER_ROOM) {
      socket.emit(MSG.INIT, { error: 'room_full' });
      return;
    }

    const player = {
      id: socket.id, name: sanitizeName(name), x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    };
    r.players.set(socket.id, player);
    r.lastSeen = Date.now();
    this.socketRoom.set(socket.id, roomName);
    socket.join(r.channel());

    socket.emit(MSG.INIT, {
      id: socket.id,
      seed: r.seed,
      time: r.timeOfDay(),
      edits: [...r.edits.values()],
      players: [...r.players.values()].filter((p) => p.id !== socket.id),
    });
    socket.to(r.channel()).emit(MSG.PLAYER, player);
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
    socket.to(r.channel()).emit(MSG.BLOCK, { x, y, z, id });
  }

  tnt(socket, { x, y, z }) {
    const r = this.roomOf(socket);
    if (!r) return;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return;
    socket.to(r.channel()).emit(MSG.TNT, { x, y, z });
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
