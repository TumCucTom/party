// ============================================================
// Client-side constants for the 3D world.
// MSG must stay in sync with MSG_TYPES_3D in
// src/shared/constants.js (the 3D client is served as native ES
// modules and can't require() the shared CommonJS file).
// ============================================================

export const MSG = {
  JOIN: 'w3:join',
  INIT: 'w3:init',
  STATE: 'w3:state',
  PLAYER: 'w3:player',
  LEAVE: 'w3:leave',
  BLOCK: 'w3:block',
  TNT: 'w3:tnt',
  CHAT: 'w3:chat',
  FACE: 'w3:face',
  ATTACK: 'w3:attack',
  HIT: 'w3:hit',
  DEATH: 'w3:death',
  RESPAWN: 'w3:respawn',
};

export const COMBAT = {
  MAX_HP: 100,
  SLASH_DAMAGE: 34,
  STAB_DAMAGE: 55,
  SLASH_RANGE: 2.15,
  STAB_RANGE: 2.55,
  SLASH_COOLDOWN_MS: 420,
  STAB_COOLDOWN_MS: 820,
  SLASH_CONE_DEG: 92,
  STAB_CONE_DEG: 58,
  RESPAWN_MS: 3000,
};

// Voice/video range, in blocks (1 block ≈ 1 metre).
export const CALL_DISTANCE = 24;      // start a call when closer than this
export const HANGUP_DISTANCE = 30;    // end it when further than this (hysteresis)
export const VOICE_REF_DISTANCE = 3;  // full volume within this radius

export const STATE_SEND_HZ = 12;      // how often we send our position
