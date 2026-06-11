// ============================================================
// Net — thin socket.io wrapper for the 3D world. The socket.io
// client script is loaded globally by index.html (served by the
// game server itself at /socket.io/socket.io.js).
// ============================================================

import { MSG } from './constants.js';

export class Net {
  constructor() {
    this.socket = null;
    this.id = null;

    // callbacks wired up by main.js
    this.onInit = null;         // ({ id, seed, time, edits, players })
    this.onPlayerJoin = null;   // (player)
    this.onPlayerState = null;  // ({ id, x, y, z, yaw, pitch })
    this.onPlayerLeave = null;  // (id)
    this.onBlock = null;        // ({ x, y, z, id })
    this.onTnt = null;          // ({ x, y, z })
    this.onDisconnect = null;   // ()
  }

  connect() {
    if (this.socket) return Promise.resolve();
    const proto = window.location.protocol.includes('https') ? 'wss' : 'ws';
    this.socket = window.io(`${proto}://${window.location.host}`, { reconnection: false });

    this.socket.on(MSG.INIT, (msg) => { this.id = msg.id; this.onInit?.(msg); });
    this.socket.on(MSG.PLAYER, (msg) => this.onPlayerJoin?.(msg));
    this.socket.on(MSG.STATE, (msg) => this.onPlayerState?.(msg));
    this.socket.on(MSG.LEAVE, (id) => this.onPlayerLeave?.(id));
    this.socket.on(MSG.BLOCK, (msg) => this.onBlock?.(msg));
    this.socket.on(MSG.TNT, (msg) => this.onTnt?.(msg));
    this.socket.on('disconnect', () => this.onDisconnect?.());

    return new Promise((resolve, reject) => {
      this.socket.on('connect', resolve);
      this.socket.on('connect_error', reject);
      this.socket.on('connect_timeout', reject);
    });
  }

  join(room, name) {
    this.socket.emit(MSG.JOIN, { room, name });
  }

  sendState(s) {
    if (this.socket && this.socket.connected) this.socket.emit(MSG.STATE, s);
  }

  sendBlock(x, y, z, id) {
    if (this.socket && this.socket.connected) this.socket.emit(MSG.BLOCK, { x, y, z, id });
  }

  sendTnt(x, y, z) {
    if (this.socket && this.socket.connected) this.socket.emit(MSG.TNT, { x, y, z });
  }
}
