import { COMBAT } from './constants.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function normalizePlayer(player = {}) {
  return {
    id: player.id || null,
    name: player.name || 'guest',
    hp: Number.isFinite(player.hp) ? player.hp : COMBAT.MAX_HP,
    alive: player.alive !== false,
    kills: Number.isFinite(player.kills) ? player.kills : 0,
    deaths: Number.isFinite(player.deaths) ? player.deaths : 0,
  };
}

export function createCombatState(me = {}) {
  return {
    me: normalizePlayer(me),
    players: new Map(),
    feed: [],
    lastHit: null,
    respawnMs: 0,
  };
}

export function upsertCombatPlayer(state, player) {
  if (!player || !player.id) return null;
  const normalized = normalizePlayer({
    ...(state.players.get(player.id) || {}),
    ...player,
  });
  state.players.set(player.id, normalized);
  return normalized;
}

function playerForEvent(state, id, localId) {
  if (id === localId) return state.me;
  return state.players.get(id) || upsertCombatPlayer(state, { id });
}

function pushFeed(state, entry) {
  state.feed.unshift(entry);
  if (state.feed.length > 5) state.feed.length = 5;
}

export function applyHit(state, event, localId = state.me.id) {
  const victim = playerForEvent(state, event.victimId, localId);
  if (!victim) return state;
  victim.hp = Math.max(0, event.hp);
  victim.alive = victim.hp > 0;
  state.lastHit = { ...event };
  pushFeed(state, { type: 'hit', ...event });
  return state;
}

export function applyDeath(state, event, localId = state.me.id) {
  const victim = playerForEvent(state, event.victimId, localId);
  const attacker = playerForEvent(state, event.attackerId, localId);
  if (victim) {
    victim.hp = 0;
    victim.alive = false;
    if (Number.isFinite(event.victimDeaths)) victim.deaths = event.victimDeaths;
  }
  if (attacker && Number.isFinite(event.attackerKills)) attacker.kills = event.attackerKills;
  if (event.victimId === localId) state.respawnMs = event.respawnMs || COMBAT.RESPAWN_MS;
  pushFeed(state, { type: 'death', ...event });
  return state;
}

export function applyRespawn(state, event, localId = state.me.id) {
  const player = playerForEvent(state, event.id, localId);
  if (!player) return state;
  player.hp = Number.isFinite(event.hp) ? event.hp : COMBAT.MAX_HP;
  player.alive = event.alive !== false;
  if (Number.isFinite(event.kills)) player.kills = event.kills;
  if (Number.isFinite(event.deaths)) player.deaths = event.deaths;
  if (event.id === localId) state.respawnMs = 0;
  pushFeed(state, { type: 'respawn', ...event });
  return state;
}

export function cooldownFraction(now, lastAt, cooldownMs) {
  if (!lastAt || !cooldownMs) return 1;
  return clamp01((now - lastAt) / cooldownMs);
}
