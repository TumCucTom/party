# Spatial Combat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-validated first-person knife combat to the 3D spatial video chat while preserving proximity video, chat, room joining, minimap, and screen sharing.

**Architecture:** The server owns health, kill/death score, hit validation, death, and respawn. The client owns immediate input feel, knife animations, HUD display, and visual feedback, but only applies damage from server combat events.

**Tech Stack:** Node.js, Jest, socket.io 2.x, native browser ES modules, Three.js r169, CSS/HTML HUD.

## Global Constraints

- Preserve the existing spatial video chat mechanics: proximity WebRTC, webcam-faced avatars, text chat, room join, minimap, and screen sharing.
- Default 3D gameplay should read as knife combat, not Minecraft mining/building.
- Do not add new runtime dependencies.
- Keep combat MVP scoped to slash, stab, health, kills, deaths, death, and respawn.
- Server validates hits using last known position and yaw; no client-authoritative damage.
- Shared design reference `/Users/tom/.Codex/design/DESIGN.md` was missing, so use existing local UI patterns plus the design spec palette.
- Use author `Thomas Bale <hf23482@bristol.ac.uk>` and co-author `Zippy AI <tomkinsbale@icloud.com>` for commits.

---

## File Structure

- `src/shared/constants.js`: Add combat message names and combat tuning constants for server tests and implementation.
- `src/client3d/constants.js`: Mirror 3D message names and combat tuning values for the native-module client.
- `src/server/world3d.js`: Store combat state per room player, validate attacks, broadcast hit/death/respawn events.
- `src/server/world3d.test.js`: Add Jest coverage for combat initialization, hits, misses, cooldowns, deaths, respawns, and room isolation.
- `src/client3d/net.js`: Add attack sender and combat event callbacks.
- `src/client3d/combat.js`: New pure helpers for client combat state transitions and cooldown display.
- `test/engine.smoke.mjs`: Add smoke tests for client combat helpers.
- `src/client3d/main.js`: Replace default mining/placing input with slash/stab, bind combat network events, update HUD and avatar feedback, render knife view model.
- `src/client3d/avatar.js`: Add health/alive/hit visual state for remote avatars.
- `src/client3d/ui.js`: Add combat HUD methods and remove block-picker/hotbar as the default combat UI.
- `src/client3d/index.html`: Rename the experience and add combat HUD DOM.
- `src/client3d/style.css`: Restyle the 3D client toward compact tactical combat HUD.
- `README.md`: Update the 3D world description to mention spatial combat instead of voxel sandbox as the default loop.

---

### Task 1: Server Combat Protocol And Tests

**Files:**
- Modify: `src/shared/constants.js`
- Modify: `src/server/world3d.test.js`

**Interfaces:**
- Produces: `Constants.MSG_TYPES_3D.ATTACK`, `HIT`, `DEATH`, `RESPAWN`.
- Produces: `Constants.COMBAT_3D` with `MAX_HP`, `SLASH_DAMAGE`, `STAB_DAMAGE`, `SLASH_RANGE`, `STAB_RANGE`, `SLASH_COOLDOWN_MS`, `STAB_COOLDOWN_MS`, `RESPAWN_MS`.

- [ ] **Step 1: Add failing Jest tests**

Add these tests to `src/server/world3d.test.js` under a new `describe('combat', ...)` block:

```js
describe('combat', () => {
  test('players initialize with combat state in init payloads', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'arena', name: 'A' });
    const init = s1.lastEmitted(MSG.INIT);
    expect(init.me).toMatchObject({
      id: 'aaa', hp: 100, alive: true, kills: 0, deaths: 0,
    });

    const s2 = mockSocket('bbb');
    w.join(s2, { room: 'arena', name: 'B' });
    expect(s2.lastEmitted(MSG.INIT).players[0]).toMatchObject({
      id: 'aaa', hp: 100, alive: true, kills: 0, deaths: 0,
    });
  });

  test('valid slash damages a target and broadcasts hit', () => {
    const w = makeWorld();
    const a = mockSocket('attacker');
    const v = mockSocket('victim');
    w.join(a, { room: 'arena', name: 'A' });
    w.join(v, { room: 'arena', name: 'V' });
    w.state(a, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.state(v, { x: 0, y: 70, z: -1.6, yaw: Math.PI, pitch: 0 });

    w.attack(a, { kind: 'slash' });

    const victim = w.rooms.get('arena').players.get('victim');
    expect(victim.hp).toBe(66);
    expect(a.broadcast).toContainEqual(['w3/arena', MSG.HIT, expect.objectContaining({
      attackerId: 'attacker', victimId: 'victim', damage: 34, hp: 66, kind: 'slash',
    })]);
    expect(a.emitted).toContainEqual([MSG.HIT, expect.objectContaining({
      attackerId: 'attacker', victimId: 'victim', damage: 34, hp: 66, kind: 'slash',
    })]);
  });

  test('attacks outside range or cone are ignored', () => {
    const w = makeWorld();
    const a = mockSocket('attacker');
    const v = mockSocket('victim');
    w.join(a, { room: 'arena', name: 'A' });
    w.join(v, { room: 'arena', name: 'V' });
    w.state(a, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.state(v, { x: 0, y: 70, z: 4, yaw: 0, pitch: 0 });
    w.attack(a, { kind: 'slash' });
    expect(w.rooms.get('arena').players.get('victim').hp).toBe(100);

    w.state(v, { x: 2, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.attack(a, { kind: 'stab' });
    expect(w.rooms.get('arena').players.get('victim').hp).toBe(100);
    expect(a.broadcast.filter(b => b[1] === MSG.HIT)).toHaveLength(0);
  });

  test('attack cooldown blocks repeated strikes', () => {
    const w = makeWorld();
    const a = mockSocket('attacker');
    const v = mockSocket('victim');
    w.join(a, { room: 'arena', name: 'A' });
    w.join(v, { room: 'arena', name: 'V' });
    w.state(a, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.state(v, { x: 0, y: 70, z: -1.6, yaw: Math.PI, pitch: 0 });
    w.attack(a, { kind: 'slash' });
    w.attack(a, { kind: 'slash' });
    expect(w.rooms.get('arena').players.get('victim').hp).toBe(66);
    expect(a.broadcast.filter(b => b[1] === MSG.HIT)).toHaveLength(1);
  });

  test('death increments score and respawn restores the victim', () => {
    jest.useFakeTimers();
    const w = makeWorld();
    const a = mockSocket('attacker');
    const v = mockSocket('victim');
    w.join(a, { room: 'arena', name: 'A' });
    w.join(v, { room: 'arena', name: 'V' });
    w.state(a, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.state(v, { x: 0, y: 70, z: -1.6, yaw: Math.PI, pitch: 0 });

    w.attack(a, { kind: 'stab' });
    jest.advanceTimersByTime(900);
    w.attack(a, { kind: 'stab' });

    const room = w.rooms.get('arena');
    expect(room.players.get('attacker')).toMatchObject({ kills: 1 });
    expect(room.players.get('victim')).toMatchObject({ hp: 0, alive: false, deaths: 1 });
    expect(a.broadcast).toContainEqual(['w3/arena', MSG.DEATH, expect.objectContaining({
      attackerId: 'attacker', victimId: 'victim',
    })]);

    jest.advanceTimersByTime(3000);
    expect(room.players.get('victim')).toMatchObject({ hp: 100, alive: true, deaths: 1 });
    expect(a.broadcast).toContainEqual(['w3/arena', MSG.RESPAWN, expect.objectContaining({
      id: 'victim', hp: 100, alive: true,
    })]);
    jest.useRealTimers();
  });

  test('combat events stay inside their room', () => {
    const w = makeWorld();
    const a = mockSocket('attacker');
    const v = mockSocket('victim');
    w.join(a, { room: 'one', name: 'A' });
    w.join(v, { room: 'two', name: 'V' });
    w.state(a, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.state(v, { x: 0, y: 70, z: -1.6, yaw: Math.PI, pitch: 0 });
    w.attack(a, { kind: 'slash' });
    expect(w.rooms.get('two').players.get('victim').hp).toBe(100);
    expect(a.broadcast.filter(b => b[1] === MSG.HIT)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify red**

Run: `npx jest src/server/world3d.test.js --runInBand`

Expected: FAIL because `init.me`, `MSG.HIT`, and `w.attack` do not exist.

- [ ] **Step 3: Add protocol constants only**

Add `ATTACK`, `HIT`, `DEATH`, and `RESPAWN` to `MSG_TYPES_3D`, plus `COMBAT_3D` constants in `src/shared/constants.js`.

- [ ] **Step 4: Run tests**

Run: `npx jest src/server/world3d.test.js --runInBand`

Expected: still FAIL because combat behavior is not implemented.

### Task 2: Server Combat Implementation

**Files:**
- Modify: `src/server/world3d.js`
- Modify: `src/server/world3d.test.js` only if fake timers need cleanup fixes.

**Interfaces:**
- Consumes: `Constants.COMBAT_3D`.
- Produces: `World3D.attack(socket, { kind })`.
- Produces: join init payload `me`.

- [ ] **Step 1: Implement combat state and attack validation**

In `src/server/world3d.js`, add helper functions for combat player state, yaw forward vector, target selection, attack tuning, hit application, and respawn scheduling. Keep validation inside the server.

- [ ] **Step 2: Run combat tests**

Run: `npx jest src/server/world3d.test.js --runInBand`

Expected: PASS.

- [ ] **Step 3: Run full tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 4: Commit server combat**

Commit message: `feat: add server-validated melee combat`.

### Task 3: Client Combat Helpers And Networking

**Files:**
- Create: `src/client3d/combat.js`
- Modify: `src/client3d/constants.js`
- Modify: `src/client3d/net.js`
- Modify: `test/engine.smoke.mjs`

**Interfaces:**
- Produces: `createCombatState()`, `applyHit(state, event, localId)`, `applyDeath(state, event, localId)`, `applyRespawn(state, event, localId)`, `cooldownFraction(now, lastAt, cooldownMs)`.
- Produces: `Net.sendAttack(kind)`.
- Produces callbacks: `net.onHit`, `net.onDeath`, `net.onRespawn`.

- [ ] **Step 1: Add failing smoke tests for combat helpers**

In `test/engine.smoke.mjs`, import helpers from `src/client3d/combat.js` and add tests for hit, death, respawn, and cooldown fraction.

- [ ] **Step 2: Run smoke test to verify red**

Run: `node test/engine.smoke.mjs`

Expected: FAIL because `src/client3d/combat.js` does not exist.

- [ ] **Step 3: Implement helpers and network protocol**

Create `src/client3d/combat.js`; mirror constants in `src/client3d/constants.js`; add `sendAttack()` and combat callbacks in `src/client3d/net.js`.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit client combat utilities**

Commit message: `feat: add client combat state helpers`.

### Task 4: First-Person Knife Interaction

**Files:**
- Modify: `src/client3d/main.js`

**Interfaces:**
- Consumes: `Net.sendAttack(kind)`.
- Consumes: client combat helpers from `src/client3d/combat.js`.
- Produces: slash/stab input and procedural knife view model.

- [ ] **Step 1: Replace mining input with attack input**

Change mouse/touch handlers so left click triggers `performAttack('slash')` and right click triggers `performAttack('stab')`. Do not send block edits from default combat controls.

- [ ] **Step 2: Add knife view model**

Replace held block geometry with a procedural knife group in `handScene`. Animate slash and stab with `attackAnim.kind`, `attackAnim.t`, and cooldown timing.

- [ ] **Step 3: Bind combat events**

Update `bindNet()` so hit/death/respawn events update local combat state, avatar state, HUD, and feedback.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit interaction**

Commit message: `feat: add first-person knife interactions`.

### Task 5: Avatar Combat Feedback And HUD

**Files:**
- Modify: `src/client3d/avatar.js`
- Modify: `src/client3d/ui.js`
- Modify: `src/client3d/index.html`
- Modify: `src/client3d/style.css`
- Modify: `README.md`

**Interfaces:**
- Produces: `Avatars.setCombatState(id, state)` or equivalent wrapper.
- Produces: `UI.updateCombatHud(combatState)`.
- Produces: title/copy/control updates for Knife Party.

- [ ] **Step 1: Add combat HUD DOM and UI methods**

Add health, score, weapon status, combat feed, and cooldown display. Hide hotbar/picker by default.

- [ ] **Step 2: Add avatar visual state**

Add HP/alive state, victim hit flash, and dead opacity/lowered posture.

- [ ] **Step 3: Restyle to tactical HUD**

Apply the design spec palette and replace Minecraft-specific title/control/tip copy.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit UI**

Commit message: `feat: add spatial combat hud`.

### Task 6: Browser Verification And Final Checks

**Files:**
- No planned source edits unless verification exposes bugs.

**Interfaces:**
- Verifies: dev server loads the 3D client without console errors.
- Verifies: combat HUD and knife view model render.

- [ ] **Step 1: Run automated verification**

Run: `npm test`

Expected: PASS.

- [ ] **Step 2: Start dev server**

Run: `npm run develop`

Expected: server starts and serves `/`.

- [ ] **Step 3: Browser-check the page**

Open `http://localhost:3000/` or the port printed by the server. Verify the title screen, join UI, HUD after joining, knife model, and console output.

- [ ] **Step 4: Commit any verification fixes**

If source fixes were needed, commit them with a focused message.

- [ ] **Step 5: Final status**

Report changed files, commits, tests run, dev server URL, and any remaining limitations.
