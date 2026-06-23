// ============================================================
// Headless smoke tests (node): worldgen determinism, chunk
// streaming + meshing integrity, block editing, raycasting,
// player physics landing. Run: npm install && npm test
// ============================================================

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { SimplexNoise, hashString } from '../src/client3d/noise.js';
import { B, BLOCKS, PALETTE } from '../src/client3d/blocks.js';
import { WorldGen, CHUNK, WORLD_H, SEA, BIOME_NAMES } from '../src/client3d/worldgen.js';
import { World } from '../src/client3d/world.js';
import { buildBlockGeometry } from '../src/client3d/mesher.js';
import { Player, raycastVoxel } from '../src/client3d/player.js';
import { RTC_CONFIG } from '../src/client3d/rtc.js';
import {
  applyDeath,
  applyHit,
  applyRespawn,
  cooldownFraction,
  createCombatState,
  upsertCombatPlayer,
} from '../src/client3d/combat.js';
import {
  ARENA_MATERIAL_TAGS,
  arenaCollisionEdits,
  createArenaPlan,
} from '../src/client3d/arena.js';

const fakeScene = { add() {}, remove() {} };
const fakeMaterials = { solid: {}, water: {} };
const styleCss = readFileSync(new URL('../src/client3d/style.css', import.meta.url), 'utf8');
const mainJs = readFileSync(new URL('../src/client3d/main.js', import.meta.url), 'utf8');
const touchJs = readFileSync(new URL('../src/client3d/touch.js', import.meta.url), 'utf8');
const rtcJs = readFileSync(new URL('../src/client3d/rtc.js', import.meta.url), 'utf8');
const avatarJs = readFileSync(new URL('../src/client3d/avatar.js', import.meta.url), 'utf8');
const clientHtml = readFileSync(new URL('../src/client3d/index.html', import.meta.url), 'utf8');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('— noise —');
ok('simplex deterministic + bounded', () => {
  const a = new SimplexNoise(123), b = new SimplexNoise(123), c = new SimplexNoise(124);
  let differs = false;
  for (let i = 0; i < 500; i++) {
    const x = i * 0.13, y = i * 0.07;
    assert.strictEqual(a.noise2(x, y), b.noise2(x, y));
    if (a.noise2(x, y) !== c.noise2(x, y)) differs = true;
    assert.ok(Math.abs(a.noise2(x, y)) <= 1.01);
    assert.ok(Math.abs(a.noise3(x, y, x + y)) <= 1.01);
  }
  assert.ok(differs, 'different seeds must differ');
});

console.log('— worldgen —');
const gen = new WorldGen(hashString('test-seed'));
ok('column heights within world bounds', () => {
  for (let x = -200; x <= 200; x += 7) {
    for (let z = -200; z <= 200; z += 11) {
      const c = gen.columnInfo(x, z);
      assert.ok(c.h >= 8 && c.h < WORLD_H, `h=${c.h}`);
      assert.ok(c.biome >= 0 && c.biome < BIOME_NAMES.length);
    }
  }
});
ok('spawn is on dry land', () => {
  const s = gen.findSpawn();
  const c = gen.columnInfo(Math.floor(s.x), Math.floor(s.z));
  assert.ok(c.h >= SEA + 1);
});

console.log('— world streaming & meshing —');
const world = new World({ seed: 42, scene: fakeScene, materials: fakeMaterials, viewRadius: 2 });
// operate around the (dry land) spawn column
const spawn = new WorldGen(42).findSpawn();
const SX = Math.floor(spawn.x), SZ = Math.floor(spawn.z);
const SCX = Math.floor(SX / CHUNK), SCZ = Math.floor(SZ / CHUNK);

ok('chunks generate and mesh', () => {
  for (let i = 0; i < 300; i++) world.update(spawn.x, spawn.z, 50);
  const c = world.getChunk(SCX, SCZ);
  assert.ok(c, 'chunk exists');
  assert.strictEqual(c.state, 'ready');
  assert.ok(c.solidMesh, 'has solid mesh');
  const pos = c.solidMesh.geometry.getAttribute('position');
  assert.ok(pos.count > 100, 'has vertices');
  for (let i = 0; i < pos.array.length; i++) assert.ok(Number.isFinite(pos.array[i]), 'no NaN positions');
  const col = c.solidMesh.geometry.getAttribute('color');
  for (let i = 0; i < col.array.length; i++) {
    assert.ok(col.array[i] >= 0 && col.array[i] <= 1.001, `color in range, got ${col.array[i]}`);
  }
});
ok('world mesh visibility can be toggled for arena mode', () => {
  world.setMeshesVisible(false);
  for (const c of world.chunks.values()) {
    if (c.solidMesh) assert.strictEqual(c.solidMesh.visible, false);
    if (c.waterMesh) assert.strictEqual(c.waterMesh.visible, false);
  }
  world.setMeshesVisible(true);
  for (const c of world.chunks.values()) {
    if (c.solidMesh) assert.strictEqual(c.solidMesh.visible, true);
    if (c.waterMesh) assert.strictEqual(c.waterMesh.visible, true);
  }
});
ok('bedrock floor everywhere', () => {
  for (let x = 0; x < 16; x++)
    for (let z = 0; z < 16; z++)
      assert.strictEqual(world.getBlock(SCX * CHUNK + x, 0, SCZ * CHUNK + z), B.BEDROCK);
});
ok('terrain matches heightmap sanity', () => {
  const h = world.surfaceHeight(SX, SZ);
  assert.ok(h > 4 && h < WORLD_H);
  assert.notStrictEqual(world.getBlock(SX, h, SZ), B.AIR);
});

console.log('— editing —');
ok('setBlock + heightmap + dirty marking', () => {
  const h = world.surfaceHeight(SX, SZ);
  const y = h + 3;
  world.setBlock(SX, y, SZ, B.STONE);
  assert.strictEqual(world.getBlock(SX, y, SZ), B.STONE);
  assert.strictEqual(world.surfaceHeight(SX, SZ), y, 'heightmap raised');
  assert.ok(world.dirty.size > 0, 'chunk marked dirty');
  world.setBlock(SX, y, SZ, B.AIR);
  assert.strictEqual(world.surfaceHeight(SX, SZ), h, 'heightmap restored');
});
ok('torch tracking', () => {
  const h = world.surfaceHeight(SX, SZ);
  world.setBlock(SX, h + 1, SZ, B.TORCH);
  assert.strictEqual(world.getTorchesNear(SCX, SCZ).length, 1);
  world.setBlock(SX, h + 1, SZ, B.AIR);
  assert.strictEqual(world.getTorchesNear(SCX, SCZ).length, 0);
});
ok('edit persistence roundtrip', () => {
  const h = world.surfaceHeight(SX + 1, SZ + 1);
  world.setBlock(SX + 1, h + 1, SZ + 1, B.BRICKS);
  const ser = world.serializeEdits();
  assert.ok(ser.length > 0);
  const world2 = new World({ seed: 42, scene: fakeScene, materials: fakeMaterials, viewRadius: 2 });
  world2.loadEdits(ser);
  for (let i = 0; i < 300; i++) world2.update(spawn.x, spawn.z, 50);
  assert.strictEqual(world2.getBlock(SX + 1, h + 1, SZ + 1), B.BRICKS, 'edit survives regen');
});

console.log('— raycast —');
ok('downward ray hits terrain', () => {
  const hit = raycastVoxel(world, new THREE.Vector3(SX + 0.5, 120, SZ + 0.5), new THREE.Vector3(0, -1, 0), 140);
  assert.ok(hit, 'hit something');
  assert.strictEqual(hit.ny, 1, 'entered from the top face');
  assert.notStrictEqual(hit.id, B.AIR);
});
ok('sideways ray reports the entry face', () => {
  const y = 110; // well above any terrain
  for (let x = SX - 4; x < SX; x++) world.setBlock(x, y, SZ, B.AIR); // ensure clear path
  world.setBlock(SX, y, SZ, B.STONE);
  const hit = raycastVoxel(world, new THREE.Vector3(SX - 3.5, y + 0.5, SZ + 0.5), new THREE.Vector3(1, 0, 0), 10);
  assert.ok(hit);
  assert.strictEqual(hit.x, SX);
  assert.strictEqual(hit.nx, -1);
  world.setBlock(SX, y, SZ, B.AIR);
});

console.log('— player physics —');
// clear a drop zone above the spawn surface (trees etc.)
const groundH = world.surfaceHeight(SX, SZ);
for (let y = groundH + 1; y < groundH + 12; y++)
  for (let dx = -1; dx <= 2; dx++)
    for (let dz = -1; dz <= 1; dz++)
      world.setBlock(SX + dx, y, SZ + dz, B.AIR);

ok('player falls and lands on the surface', () => {
  const p = new Player(world);
  p.teleport(SX + 0.5, groundH + 8, SZ + 0.5);
  const input = { forward: false, back: false, left: false, right: false, jump: false, sneak: false };
  for (let i = 0; i < 600; i++) p.update(1 / 60, input);
  assert.ok(p.onGround, 'landed');
  assert.ok(Math.abs(p.pos.y - (groundH + 1)) < 0.1, `rests on surface (y=${p.pos.y}, h=${groundH})`);
});
ok('player collides with walls', () => {
  const p = new Player(world);
  // build a wall two blocks to the +x side
  world.setBlock(SX + 2, groundH + 1, SZ, B.STONE);
  world.setBlock(SX + 2, groundH + 2, SZ, B.STONE);
  p.teleport(SX + 0.5, groundH + 1, SZ + 0.5);
  const input = { forward: false, back: false, left: false, right: true, jump: false, sneak: false };
  for (let i = 0; i < 300; i++) p.update(1 / 60, input); // yaw=0 → "right" pushes +x
  assert.ok(p.pos.x < SX + 2, `stopped by wall (x=${p.pos.x})`);
  assert.ok(p.pos.x > SX + 1.5, `actually walked up to it (x=${p.pos.x})`);
  world.setBlock(SX + 2, groundH + 1, SZ, B.AIR);
  world.setBlock(SX + 2, groundH + 2, SZ, B.AIR);
});

ok('sprinting covers more than 7 blocks per second on flat ground', () => {
  for (let dz = -12; dz <= 2; dz++) {
    world.setBlock(SX, groundH, SZ + dz, B.STONE);
    for (let y = groundH + 1; y <= groundH + 3; y++) {
      world.setBlock(SX, y, SZ + dz, B.AIR);
    }
  }
  const p = new Player(world);
  p.teleport(SX + 0.5, groundH + 1, SZ + 0.5);
  p.sprinting = true;
  const input = { forward: true, back: false, left: false, right: false, jump: false, sneak: false };
  for (let i = 0; i < 60; i++) p.update(1 / 60, input);
  const distance = (SZ + 0.5) - p.pos.z;
  assert.ok(distance > 7, `sprint distance should feel fast, got ${distance.toFixed(2)} blocks`);
});


console.log('— rtc —');
ok('WebRTC config includes a TURN relay for restrictive networks', () => {
  const servers = RTC_CONFIG.iceServers || [];
  assert.ok(
    servers.some((server) => String(server.urls || server.url || '').startsWith('turn:')),
    'expected at least one TURN relay',
  );
});

ok('remote webcam videos are prepared for mobile WebGL textures', () => {
  assert.match(rtcJs, /webkit-playsinline/);
  assert.match(rtcJs, /video\.style\.cssText\s*=\s*'[^']*width:\s*160px[^']*height:\s*120px/s);
  assert.match(rtcJs, /ensureVideoPlayback\(video\)/);
  assert.match(avatarJs, /new THREE\.MeshBasicMaterial\(\{[^}]*side:\s*THREE\.DoubleSide/s);
  assert.match(avatarJs, /tex\.needsUpdate\s*=\s*true/);
});


console.log('— multiplayer edit sync —');
ok('local edits fire onEdit; remote edits do not', () => {
  const sent = [];
  world.onEdit = (x, y, z, id) => sent.push([x, y, z, id]);
  const h = world.surfaceHeight(SX, SZ);

  world.setBlock(SX, h + 2, SZ, B.PLANKS);
  assert.deepStrictEqual(sent, [[SX, h + 2, SZ, B.PLANKS]], 'local edit broadcast');

  world.applyRemoteEdit(SX + 1, h + 2, SZ, B.GLASS);
  assert.strictEqual(sent.length, 1, 'remote edit not echoed back');
  assert.strictEqual(world.getBlock(SX + 1, h + 2, SZ), B.GLASS, 'remote edit applied');

  world.setBlock(SX, h + 2, SZ, B.AIR);
  world.applyRemoteEdit(SX + 1, h + 2, SZ, B.AIR);
  world.onEdit = null;
});
ok('remote edits in unloaded chunks apply once generated', () => {
  const farX = SX + CHUNK * 50, farZ = SZ + CHUNK * 50; // far outside view radius
  assert.ok(!world.isLoaded(farX, farZ), 'target chunk not loaded');
  world.applyRemoteEdit(farX, 90, farZ, B.BRICKS);
  for (let i = 0; i < 300; i++) world.update(farX, farZ, 50); // stream over there
  assert.strictEqual(world.getBlock(farX, 90, farZ), B.BRICKS, 'edit applied on generation');
  for (let i = 0; i < 300; i++) world.update(spawn.x, spawn.z, 50); // come back
});
ok('server edit list (world coords) loads into a fresh world', () => {
  const h = world.surfaceHeight(SX, SZ);
  const w3 = new World({ seed: 42, scene: fakeScene, materials: fakeMaterials, viewRadius: 2 });
  w3.loadWorldEdits([[SX, h + 5, SZ, B.TNT]]);
  for (let i = 0; i < 300; i++) w3.update(spawn.x, spawn.z, 50);
  assert.strictEqual(w3.getBlock(SX, h + 5, SZ), B.TNT);
});

console.log('— block geometry —');
ok('standalone geometry for every palette block', () => {
  for (const id of PALETTE) {
    const g = buildBlockGeometry(id);
    const pos = g.getAttribute('position');
    assert.ok(pos.count >= 4, `${BLOCKS[id].name} has vertices`);
    for (let i = 0; i < pos.array.length; i++) assert.ok(Number.isFinite(pos.array[i]));
  }
});

console.log('— combat helpers —');
ok('hit updates the local victim and records feedback', () => {
  const state = createCombatState({ id: 'me', hp: 100, alive: true });
  applyHit(state, {
    attackerId: 'them', victimId: 'me', damage: 34, hp: 66, kind: 'slash',
  }, 'me');
  assert.strictEqual(state.me.hp, 66);
  assert.strictEqual(state.me.alive, true);
  assert.strictEqual(state.lastHit.damage, 34);
  assert.strictEqual(state.feed[0].type, 'hit');
});

ok('death and respawn update local score state', () => {
  const state = createCombatState({ id: 'me', hp: 10, alive: true, deaths: 0 });
  applyDeath(state, {
    attackerId: 'them', victimId: 'me', attackerKills: 2, victimDeaths: 1, respawnMs: 3000,
  }, 'me');
  assert.strictEqual(state.me.hp, 0);
  assert.strictEqual(state.me.alive, false);
  assert.strictEqual(state.me.deaths, 1);
  assert.strictEqual(state.respawnMs, 3000);

  applyRespawn(state, {
    id: 'me', hp: 100, alive: true, deaths: 1, kills: 0,
  }, 'me');
  assert.strictEqual(state.me.hp, 100);
  assert.strictEqual(state.me.alive, true);
  assert.strictEqual(state.respawnMs, 0);
});

ok('remote combat players are upserted and updated', () => {
  const state = createCombatState({ id: 'me' });
  upsertCombatPlayer(state, { id: 'them', hp: 100, alive: true, kills: 0, deaths: 0 });
  applyHit(state, {
    attackerId: 'me', victimId: 'them', damage: 55, hp: 45, kind: 'stab',
  }, 'me');
  assert.strictEqual(state.players.get('them').hp, 45);
});

ok('cooldown fraction is clamped', () => {
  assert.strictEqual(cooldownFraction(1000, 1000, 400), 0);
  assert.strictEqual(cooldownFraction(1200, 1000, 400), 0.5);
  assert.strictEqual(cooldownFraction(2000, 1000, 400), 1);
  assert.strictEqual(cooldownFraction(2000, 0, 400), 1);
});

console.log('— tactical arena —');
ok('arena plan is finite and keeps spawn inside bounds', () => {
  const plan = createArenaPlan({ x: SX, y: groundH, z: SZ });
  assert.ok(Number.isFinite(plan.center.x));
  assert.ok(Number.isFinite(plan.center.y));
  assert.ok(Number.isFinite(plan.center.z));
  assert.ok(plan.bounds.minX < plan.bounds.maxX);
  assert.ok(plan.bounds.minZ < plan.bounds.maxZ);
  assert.ok(plan.spawn.x > plan.bounds.minX && plan.spawn.x < plan.bounds.maxX);
  assert.ok(plan.spawn.z > plan.bounds.minZ && plan.spawn.z < plan.bounds.maxZ);
  for (const prop of plan.props) {
    for (const n of [...prop.position, ...prop.size]) assert.ok(Number.isFinite(n));
    assert.ok(prop.size[0] > 0 && prop.size[1] > 0 && prop.size[2] > 0);
  }
});

ok('arena collision edits include floor and perimeter blockers', () => {
  const plan = createArenaPlan({ x: SX, y: groundH, z: SZ });
  const edits = arenaCollisionEdits(plan);
  assert.ok(edits.length > 1000, 'collision substrate is substantial');
  const floor = edits.filter((e) => e.y === plan.floorY && e.id !== B.AIR);
  const wall = edits.filter((e) => e.y > plan.floorY && e.id !== B.AIR);
  const clear = edits.filter((e) => e.y > plan.floorY && e.id === B.AIR);
  assert.ok(floor.length > 100, 'floor blockers exist');
  assert.ok(wall.length > 100, 'wall/cover blockers exist');
  assert.ok(clear.length > 100, 'play volume is cleared');
});

ok('arena material tags avoid minecraft terrain surfaces', () => {
  for (const tag of ARENA_MATERIAL_TAGS) {
    assert.ok(!/grass|dirt|leaves|ore|flower|log/i.test(tag), tag);
  }
});

console.log('— mobile hud —');
ok('touch combat HUD is docked above the mobile controls', () => {
  assert.match(styleCss, /body\.touch #combat-hud\s*{[^}]*top:\s*calc\(env\(safe-area-inset-top\)\s*\+\s*56px\)/s);
  assert.match(styleCss, /body\.touch #combat-hud\s*{[^}]*bottom:\s*auto/s);
  assert.match(styleCss, /body\.touch #combat-hud\s*{[^}]*grid-template-columns:\s*minmax\(92px,\s*116px\)\s*minmax\(150px,\s*1fr\)/s);
});

ok('flying controls are not exposed in the 3D client UI', () => {
  assert.doesNotMatch(mainJs, /player\.flying\s*=\s*!this\.player\.flying/);
  assert.doesNotMatch(touchJs, /onToggleFly|_lastJumpTap/);
  assert.doesNotMatch(clientHtml, /Freecam|Double-tap SPACE/i);
});

ok('touch devices are steered into landscape play', () => {
  assert.match(clientHtml, /id="orientation-lock"/);
  assert.match(styleCss, /@media\s*\(pointer:\s*coarse\)\s*and\s*\(orientation:\s*portrait\)/);
  assert.match(styleCss, /body\.touch #orientation-lock\s*{[^}]*display:\s*flex/s);
  assert.match(styleCss, /@media\s*\(pointer:\s*coarse\)\s*and\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*520px\)/);
  assert.match(mainJs, /requestLandscapePlayMode\(\)/);
  assert.match(mainJs, /screen\.orientation\.lock\('landscape'\)/);
});

console.log(`\nAll ${passed} smoke tests passed ✔`);
