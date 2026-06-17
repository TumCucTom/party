# Spatial Combat Design

## Context

The current 3D client is a spatial video chat inside a Minecraft-like voxel sandbox. It already has the pieces a first-person social combat game needs: pointer lock, first-person movement, proximity voice/video, remote avatar smoothing, world collision, room-based multiplayer, and server room state. It does not yet have combat state, health, respawn, hit validation, or a non-Minecraft HUD and view model.

The shared design reference requested in AGENTS was not available at `/Users/tom/.Codex/design/DESIGN.md` in this environment. The visual work will therefore follow the existing project constraints while moving the 3D client away from Minecraft chrome and toward compact tactical game HUD language.

## Product Goal

Build "Knife Party": a spatial video chat where people still join rooms, walk up to talk, see each other's webcam faces, share screens, and text chat, but the moment-to-moment interaction becomes first-person knife combat rather than mining and placing blocks.

## Chosen Approach

Use the existing voxel world as the collision and networking substrate, but replace the default player-facing loop with server-relayed melee combat.

This gives the largest practical shift in feel without a risky rewrite. Terrain, room seeding, proximity calls, and avatar identity stay intact. Mining, placing, hotbar, and picker leave the default control surface. Knife attacks, health, respawns, scoreboard, hit feedback, and a procedural knife view model become the new primary loop.

## Alternatives Considered

1. **Combat overlay on the current voxel world.** Add melee systems and UI while keeping terrain and avatars. This is the recommended first build because it preserves the social video chat product and has a bounded implementation.
2. **Full arena rewrite.** Replace terrain with mesh-authored FPS maps and build a separate shooter architecture. This would look less Minecraft-like, but it would defer playable combat and risk breaking the working video chat.
3. **Separate combat mode beside sandbox mode.** Keep Block Party and add a new route or toggle for Knife Party. This is clean long-term, but for this pass it duplicates UI paths and delays the requested transformation.

## Gameplay

- Left click performs a quick slash.
- Right click performs a slower stab with higher damage.
- A hit is valid when the attacker is alive, the target is alive, both are in the same room, the target is inside melee range, and the target is within a forward-facing attack cone based on the attacker's last server-known yaw.
- Slash damage is 34. Stab damage is 55.
- Slash cooldown is 420 ms. Stab cooldown is 820 ms.
- Melee range is 2.15 blocks for slash and 2.55 blocks for stab.
- Attack cone is 92 degrees for slash and 58 degrees for stab.
- Players have 100 HP.
- A player who reaches 0 HP dies, increments attacker kills and victim deaths, becomes inactive, and respawns after 3 seconds at full HP.
- Combat does not affect the WebRTC call system. Dead players can still hear and talk while waiting to respawn.
- The first build does not add guns, teams, ranked rounds, buy menus, inventory management, anti-cheat, or authored tactical maps.

## Architecture

### Server

`src/server/world3d.js` becomes the authority for combat outcomes. Each room player stores:

- `hp`
- `alive`
- `kills`
- `deaths`
- `lastAttackAt`
- `respawnAt`

New shared/client message types are added:

- `w3:attack`: client asks to perform `slash` or `stab`.
- `w3:hit`: server broadcasts an accepted hit with attacker, victim, damage, remaining HP, and attack kind.
- `w3:death`: server broadcasts a kill/death outcome.
- `w3:respawn`: server tells the room a player has respawned.

The server validates attack payloads, rate-limits by attack kind, computes range and cone from stored player positions and yaw, applies damage, schedules respawn, and broadcasts results to the room. The client may animate swings immediately, but damage only comes from server events.

### Client Networking

`src/client3d/constants.js` and `src/client3d/net.js` mirror the new message types. `Game.bindNet()` handles combat events and updates local/remote combat state.

Client state tracks:

- local HP, alive/dead state, kills, deaths
- remote player HP/alive state for tags and hit feedback
- last attacker/victim feedback for toasts and HUD notices
- attack cooldown display and view-model animation

### Interaction

`main.js` changes default input:

- Left mouse: quick slash.
- Right mouse: stab.
- Middle click, hotbar selection, block picker, mining progress, crack overlay, and placement repeat are removed from the default combat loop.
- Existing chat, mic, camera, screen share, movement, sprint, jump, and menu controls remain.
- Creative flight remains available for now as a debugging/accessibility escape hatch, but it is not promoted in combat copy.
- Touch controls map mine to slash and place to stab.

### View Model

The held-block mesh is replaced with a procedural knife model built from Three.js primitives in a focused client module. It renders in the existing first-person hand scene. Slash and stab use distinct animation curves:

- Slash arcs across the lower-right field of view.
- Stab lunges forward with brief recoil.
- Hit confirmation adds a short screen pulse and sound.

No external weapon asset is required for this first pass.

### Avatars

The existing webcam-faced avatar remains because it is central to the spatial video chat identity. Combat adds:

- hit flash on the victim avatar
- temporary damage number or compact HP tag near the name tag
- dead/respawning visual state with reduced opacity and lowered posture

The first build keeps the blocky avatar geometry to avoid destabilizing WebRTC video textures. Replacing the body silhouette can be a later visual pass after combat is playable.

### UI And Visual Direction

The visual direction is "social tactical": compact, legible, and game-like without hiding the video chat identity.

Palette:

- `#0b0d10` near-black HUD surfaces
- `#f2f4f3` primary HUD text
- `#e0b04f` brass/score accent
- `#d94b3d` damage accent
- `#5fb3b3` proximity/social accent
- `#2b3138` panel stroke

Typography:

- Replace Minecraft display emphasis with a condensed tactical display face for title/HUD labels.
- Use a readable sans-serif fallback for UI text.
- Keep text compact; no landing-page treatment.

HUD:

- Crosshair stays centered, becomes a small tactical reticle.
- Bottom-left: health and status.
- Bottom-center: knife action/cooldown.
- Top-right or right rail: kills/deaths.
- Room status and minimap remain, styled to match the combat HUD.
- Self-view controls remain usable and visually quieter.

Copy changes:

- "Block Party" becomes "Knife Party".
- "Join World" becomes "Join Room".
- Controls mention slash, stab, proximity talk, text chat, and video controls.
- Minecraft-specific mining/building/TNT tips are removed from the primary UI.

## Data Flow

1. Player joins a room.
2. Server initializes player combat state and includes existing players' combat fields in `w3:init`.
3. Client sends position state at the existing 12 Hz rate.
4. Client sends `w3:attack` on slash/stab input.
5. Server validates cooldown, range, cone, liveness, and room membership.
6. Server broadcasts `w3:hit` when damage lands.
7. Server broadcasts `w3:death` when HP reaches zero and schedules respawn.
8. Server broadcasts `w3:respawn` after the delay.
9. Clients update HUD, avatar effects, and local controls from server events.

## Testing

Server behavior gets Jest coverage:

- new players initialize with full HP and zero score
- valid slash damages a target and broadcasts hit
- attacks outside range fail
- attacks outside cone fail
- cooldown blocks repeated attacks
- death increments attacker kills and victim deaths and broadcasts death
- respawn restores HP and alive state
- combat events do not cross room boundaries
- malformed attack payloads are ignored

Client engine smoke coverage gets focused pure helpers where practical:

- attack direction math and cone validation helper, if extracted
- knife cooldown/state helper, if extracted

Manual/browser verification covers:

- joining the 3D client
- first-person knife visible
- no hotbar/picker in default HUD
- slash/stab animations trigger
- HUD remains readable on desktop and mobile sizes
- console has no runtime errors on load

## Risks And Constraints

- Server hit validation uses last received position/yaw, so fast motion and network latency can make close hits feel conservative. This is acceptable for an MVP; lag compensation is out of scope.
- The world still uses voxel terrain, so the first pass will not fully read as CS/MW. The main behavior and HUD will move in that direction while preserving the working world engine.
- Existing WebRTC/video code stays untouched except where UI copy and avatar visual feedback intersect it.
- Since the design reference file is missing, this pass cannot guarantee global design-system alignment beyond reusing local patterns and the palette above.

## Acceptance Criteria

- The default 3D game loop is spatial video chat plus knife combat, not block mining/building.
- Players can slash/stab each other in multiplayer rooms.
- Server validates hits and owns health, deaths, kills, and respawns.
- Combat state is visible in the HUD and on remote avatars.
- Proximity video/audio, text chat, minimap, room joining, and screen sharing continue to work.
- Existing automated tests pass, with new combat tests added.
