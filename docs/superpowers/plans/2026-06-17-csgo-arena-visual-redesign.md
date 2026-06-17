# CS-Style Arena Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the visible Minecraft-like voxel room with a tactical FPS arena while preserving spatial video chat, movement, and knife combat.

**Architecture:** Add a deterministic `arena.js` module that defines the visible arena plan, pure collision-edit helpers, and a Three.js tactical arena renderer. Keep the voxel world as an invisible physics substrate, add mesh-visibility controls to `World`, and install the arena from `main.js` after chunk readiness. Finish with arena sky, tactical avatar silhouettes, and HUD/menu polish.

**Tech Stack:** JavaScript ES modules, Three.js, existing Node smoke tests, existing Jest suite, CSS.

## Global Constraints

- Do not copy CS:GO maps, logos, models, or textures.
- The first viewport after joining must not show grass, dirt, trees, pixel blocks, square clouds, or the voxel horizon.
- Preserve existing multiplayer, WebRTC, movement physics, and server-validated knife combat.
- Keep webcam/video identity visible on remote avatars.
- Use deterministic helper tests for arena plan and collision behavior.
- Shared design file `/Users/tom/.Codex/design/DESIGN.md` is missing; use the spec palette and existing app typography.

---

## File Structure

- Create `src/client3d/arena.js`: pure arena plan/collision helpers plus a browser-only `TacticalArena` renderer.
- Modify `test/engine.smoke.mjs`: add arena helper tests and `World#setMeshesVisible` tests.
- Modify `src/client3d/world.js`: add chunk mesh visibility control.
- Modify `src/client3d/main.js`: enable arena mode, rebuild the visible arena, hide voxel meshes, and prepare collision.
- Modify `src/client3d/sky.js`: add arena sky mode that hides Minecraft celestial/cloud visuals.
- Modify `src/client3d/avatar.js`: replace blocky avatar geometry with tactical low-poly silhouettes while keeping video face plates.
- Modify `src/client3d/style.css` and `src/client3d/index.html`: remove visible Minecraft styling/copy from menus, picker, HUD chrome, and room text.

---

### Task 1: Arena Plan And Collision Helpers

**Files:**
- Create: `src/client3d/arena.js`
- Modify: `test/engine.smoke.mjs`

**Interfaces:**
- Produces: `createArenaPlan(center: {x:number, y:number, z:number}, options?: object): ArenaPlan`
- Produces: `arenaCollisionEdits(plan: ArenaPlan): Array<{x:number,y:number,z:number,id:number}>`
- Produces: `prepareArenaCollision(world: World, plan: ArenaPlan): number`
- Produces: `TacticalArena` class for browser rendering in later tasks

- [ ] **Step 1: Write the failing smoke tests**

Add imports:

```js
import {
  ARENA_MATERIAL_TAGS,
  arenaCollisionEdits,
  createArenaPlan,
} from '../src/client3d/arena.js';
```

Add tests after the combat helper section:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/engine.smoke.mjs`

Expected: FAIL with module-not-found for `src/client3d/arena.js`.

- [ ] **Step 3: Implement helpers and renderer shell**

Create `src/client3d/arena.js` with pure plan/collision exports and a `TacticalArena` class that can be filled in further without changing the helper API.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/engine.smoke.mjs`

Expected: PASS, including the new `— tactical arena —` section.

- [ ] **Step 5: Commit**

```bash
git add src/client3d/arena.js test/engine.smoke.mjs
git commit --author="Thomas Bale <hf23482@bristol.ac.uk>" -m "feat: add tactical arena plan helpers" -m "Co-authored-by: Zippy AI <tomkinsbale@icloud.com>"
```

---

### Task 2: Invisible Voxel Substrate And Main Integration

**Files:**
- Modify: `src/client3d/world.js`
- Modify: `src/client3d/main.js`
- Modify: `test/engine.smoke.mjs`

**Interfaces:**
- Consumes: `createArenaPlan`, `prepareArenaCollision`, `TacticalArena`
- Produces: `World#setMeshesVisible(visible: boolean): void`

- [ ] **Step 1: Write failing world visibility test**

Add a smoke test after `chunks generate and mesh`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/engine.smoke.mjs`

Expected: FAIL with `world.setMeshesVisible is not a function`.

- [ ] **Step 3: Add mesh visibility support**

Add `this.meshesVisible = true` to the `World` constructor, set mesh visibility in `placeMesh`, and add `setMeshesVisible(visible)` that updates all existing chunk meshes.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/engine.smoke.mjs`

Expected: PASS.

- [ ] **Step 5: Integrate arena mode in main**

Import the arena module, instantiate `TacticalArena`, set the sky to arena mode, store an unscattered room spawn, hide world meshes, rebuild the arena preview from room spawn, and in `finishLoading()` prepare the invisible collision substrate before teleporting the player to an arena spawn.

- [ ] **Step 6: Run test suite**

Run: `npm test`

Expected: Jest and smoke tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/client3d/world.js src/client3d/main.js test/engine.smoke.mjs
git commit --author="Thomas Bale <hf23482@bristol.ac.uk>" -m "feat: render combat over invisible arena substrate" -m "Co-authored-by: Zippy AI <tomkinsbale@icloud.com>"
```

---

### Task 3: Tactical Sky, Avatars, HUD, And Menu Styling

**Files:**
- Modify: `src/client3d/arena.js`
- Modify: `src/client3d/sky.js`
- Modify: `src/client3d/avatar.js`
- Modify: `src/client3d/ui.js`
- Modify: `src/client3d/style.css`
- Modify: `src/client3d/index.html`

**Interfaces:**
- Consumes: arena mode from `main.js`
- Produces: first viewport that reads as a tactical FPS yard, not a voxel sandbox

- [ ] **Step 1: Add arena visual meshes**

Fill out `TacticalArena` with floor, perimeter walls, cover, crates, barriers, doors, target boards, lane markings, light bars, and material disposal.

- [ ] **Step 2: Add arena sky mode**

Add `Sky#setArenaMode(visible: boolean)`. In arena mode, hide sun/moon/stars/clouds, set dusty blue-gray background/fog, set stable lighting uniforms, and ignore cloud toggles.

- [ ] **Step 3: Replace blocky avatar geometry**

Update `avatar.js` body construction to use low-poly tactical silhouettes: helmet shell, visor/video plate, vest, cylindrical limbs, boots, and non-pixel fallback face texture. Preserve name tags, chat bubbles, screen share boards, HP bars, video texture switching, and animation pivots.

- [ ] **Step 4: Polish HUD and menu styling**

Update visible copy and CSS so title, join card, controls, picker, minimap, self-view, and combat panels use tactical styling and no Minecraft-like beveled inventory chrome.

- [ ] **Step 5: Run tests**

Run: `npm test`

Expected: Jest and smoke tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/client3d/arena.js src/client3d/sky.js src/client3d/avatar.js src/client3d/ui.js src/client3d/style.css src/client3d/index.html
git commit --author="Thomas Bale <hf23482@bristol.ac.uk>" -m "feat: restyle combat room as tactical fps arena" -m "Co-authored-by: Zippy AI <tomkinsbale@icloud.com>"
```

---

### Task 4: Browser Verification And Finish

**Files:**
- Verify only unless a bug is found.

**Interfaces:**
- Consumes: completed arena integration
- Produces: verified local dev URL and final commit state

- [ ] **Step 1: Run full automated checks**

Run: `npm test`

Expected: PASS.

Run: `npm run lint`

Expected: Known pre-existing failure may remain because ESLint 5.16.0 cannot find a config; record exact result.

- [ ] **Step 2: Start local dev server**

Run: `nohup env NODE_OPTIONS=--openssl-legacy-provider npm run develop > /tmp/spatial-combat-dev.log 2>&1 & echo $! > /tmp/spatial-combat-dev.pid`

Expected: `/tmp/spatial-combat-dev.log` contains `Server listening on port 3000`.

- [ ] **Step 3: Browser verify**

Open `http://localhost:3000/`, join a room, wait for the HUD, and check:

- First viewport shows arena floor/walls/cover rather than terrain.
- No grass/dirt/tree/square-cloud horizon is visible.
- Knife view model renders.
- HUD/self-view/minimap are not overlapping incoherently.
- Console has no frame-loop exceptions.

- [ ] **Step 4: Fix any discovered issues**

If verification finds a regression, write the smallest relevant test first when the issue is testable, then patch and re-run the affected checks.

- [ ] **Step 5: Final status**

Report commits, verification commands, known lint status, and local URL.
