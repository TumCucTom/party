# CS-Style Arena Visual Redesign

## Goal

Replace the Minecraft-like presentation of the spatial combat room with a tactical first-person shooter arena that reads closer to Counter-Strike or Modern Warfare: concrete, metal, crates, controlled sightlines, restrained HUD, and non-blocky avatars.

## Approved Direction

The user approved building without further review. This spec treats that as approval for a full visual replacement rather than a texture-only reskin.

The implementation must avoid copying CS:GO maps, logos, models, or textures. The target is the genre read: a practical tactical arena with realistic-ish proportions, cover, lighting, and shooter HUD behavior.

## Current Context

The current app already has:

- First-person movement and camera control in `src/client3d/player.js`.
- Spatial video chat, proximity WebRTC, and multiplayer state sync in `src/client3d/main.js`, `net.js`, `rtc.js`, and `avatar.js`.
- Server-validated knife combat and the tactical HUD added in earlier commits.
- A voxel terrain renderer built from generated chunks in `world.js`, `worldgen.js`, `mesher.js`, and `textures.js`.

The Minecraft impression comes from:

- Pixel-art block atlas textures.
- Visible generated voxel terrain, trees, caves, water, and block editing affordances.
- Square sun, moon, and blocky clouds.
- Cube-headed avatars and rectangular limbs.
- Inventory/picker styling that still resembles the sandbox mode.

## Architecture

Add a new client-side `arena.js` module responsible for the shooter-style scene and invisible collision prep.

The visible arena is a Three.js layer installed into the main scene. The existing voxel world remains available for physics, raycasting, chunk readiness, networking, and legacy block edits, but its chunk meshes are hidden in arena mode. The arena module clears and fills a bounded area in the voxel world with invisible floor and wall collision blocks, then renders purpose-built meshes over that collision substrate.

This keeps the risky parts stable:

- No rewrite of movement physics.
- No rewrite of multiplayer synchronization.
- No rewrite of knife combat validation.
- No new external asset pipeline.

## Arena Layout

The default arena is a compact industrial yard centered around the player spawn.

Required layout elements:

- Concrete/asphalt floor plane covering the play area.
- Perimeter concrete or stucco walls high enough to block the horizon.
- Metal gates and warehouse doors as non-interactive visual set pieces.
- Crates, stacked pallets, low cover, and barriers placed in lanes.
- Painted lane markings and caution stripes to break up flat surfaces.
- A few overhead pipes, lamp bars, and antenna silhouettes to sell scale.
- Simple target boards or range markers that support the combat-training read.

The first viewport after joining must not show grass, dirt, trees, pixel blocks, square clouds, or the voxel horizon.

## Visual System

Palette:

- `#15181a` graphite shadow
- `#24292d` gunmetal panel
- `#59564c` worn concrete
- `#b9a16b` dusty tan stucco
- `#d9a441` brass hazard paint
- `#7fb7b4` muted social/video accent
- `#c54b3f` damage accent

Typography and HUD:

- Keep Rajdhani for tactical display labels.
- Keep Inter for body/forms.
- Reduce Minecraft terms in visible copy where possible.
- Keep the HUD dense and utilitarian: small panels, crisp borders, no decorative fantasy styling.

Signature element:

- A warm industrial yard with hazard-striped cover and video-chat avatars wearing tactical silhouettes with a live face plate. The webcam face remains central to the spatial video chat identity.

## Sky And Lighting

Arena mode must suppress or replace:

- Square sun and moon.
- Pixel stars as a dominant visual.
- Blocky cloud sheet.
- Minecraft-like blue day/night color shifts.

Arena mode should use:

- Dusty blue-gray sky/fog.
- Warm side light and cooler ambient fill.
- Fog distances that hide any remaining chunk boundary.
- Optional light fixtures or emissive strips on arena props.

## Avatar Redesign

Remote avatars should stop reading as Minecraft characters.

Required changes:

- Replace cube body and cube limbs with low-poly tactical silhouettes using capsule/cylinder/box combinations.
- Keep the video face plane, but frame it as a helmet visor or face plate rather than a cube face.
- Keep name tags, chat bubbles, screen-share boards, combat HP bars, and smoothing behavior.
- Preserve webcam/video texture behavior and fallback procedural face.

## Controls And Legacy Systems

The project still contains legacy block-building systems. For this visual pass:

- First-person combat remains the primary interaction.
- Scroll wheel and picker should not make the normal combat HUD look like a block-building game.
- The picker may remain available internally, but visible styling should become a subdued "tools" window if opened.
- Block selection/hotbar should stay hidden in combat view unless existing code explicitly shows it for touch.

## Testing Requirements

Automated tests must cover deterministic non-rendering helpers:

- Arena plan has finite dimensions and spawn is inside the playable area.
- Collision edits include a floor and perimeter blockers.
- Cover/prop definitions use finite positions and positive sizes.
- The generated arena avoids Minecraft surface materials by construction.

Manual/browser verification must cover:

- Joining a room still reaches the playable state.
- First viewport looks like a tactical arena instead of Minecraft terrain.
- Knife view model still renders and animates.
- Combat HUD remains visible and unobstructed.
- Self-view remains usable.
- No frame-loop exceptions are logged.

## Out Of Scope

- Photorealistic imported weapon or character models.
- Full CS:GO map clone.
- Projectile weapons, grenades, economy, rounds, buy menu, or team logic.
- Replacing the multiplayer protocol.
- Removing the legacy voxel code from the repository.
