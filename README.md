<h1 align="center">
    Spatial Video Chat
</h1>

Normally only one person can speak at a time in a standard conference call and it only gets worse the more people there are.
This isn't like in real life, where we zone in and out of large groups, form smaller ones as the conversation takes us.

[**Live Demo**](https://party.mookerj.ee/join).

<p float="left">
<img src="https://github.com/souramoo/party/blob/master/public/assets/landing/2020-04-11.png?raw=true" width="49%" />
<img src="https://github.com/souramoo/party/blob/master/public/assets/landing/2020-04-11 (1).png?raw=true" width="49%" />
</p>

Built with [Node.js](https://nodejs.org/), [socket.io](https://socket.io/), and [HTML5 Canvas](https://www.w3schools.com/html/html5_canvas.asp).

## 🧊 Block Party — the 3D world (now the default at `/`)

The spatial video chat concept, rebuilt with full functionality inside a
Minecraft-like voxel world ([Three.js](https://threejs.org/) + the procedural
voxel engine from [Fable5-mc](https://github.com/souramoo/Fable5-mc)):

- **Spatial voice & video** — walk up to someone to start a call (WebRTC via
  PeerJS, exactly like the 2D version), walk away to leave it. Voice is
  spatialized with WebAudio `PannerNode`s, so people sound like where they
  stand — quieter with distance, panned by direction.
- **Faces on avatars** — every player is a blocky Minecraft-style avatar whose
  head shows their live webcam feed while you're in range.
- **Shared persistent worlds** — a room code deterministically seeds the
  terrain, and every block anyone places or breaks is stored on the server,
  replayed to late joiners, and **saved to disk** (`data/world3d.json`, or set
  `WORLD3D_FILE`) so builds survive server restarts. The join screen shows a
  live preview of the room — who's in there right now and how many blocks
  have been built.
- **Minimap** — a north-up radar in the corner with height-shaded terrain,
  your view arrow, and a colored dot per player (clamped to the edge when
  they're far) so you can always find people.
- **A full voxel sandbox** — infinite procedural terrain with biomes, caves and
  ores, a day/night cycle (shared per room), mining and placing with 35 block
  types, falling sand, TNT (synchronized explosions!), swimming, sprinting,
  sneaking and flying.
- **No build step, no assets** — the 3D client (`src/client3d`) is served as
  native ES modules; every texture is painted onto canvases at startup and
  every sound is synthesized with WebAudio.
- **Works on phones too** — on touch devices a virtual joystick, drag-to-look
  and on-screen jump/sneak/mine/place buttons appear (double-tap jump to fly);
  the HUD rearranges and scales for small screens. Desktop never sees the
  touch UI.

Open the site, pick a name and a room code, and share the link (the room code
travels in the URL hash, e.g. `/#treehouse`). The same room code always
produces the same world. In game: `M`/`V` mute mic/camera, `C` switches between
cameras, `T` chats. The classic 2D experience remains at `/join` and the old
landing page at `/index.html`.

## Development

To get started, make sure you have Node and NPM installed. Then,

```bash
$ npm install
$ npm run develop
```

on your local machine.

To run the project in a production setting, simply

```bash
$ npm install
$ npm run build
$ npm start
```

> Note: the webpack 4 build of the classic 2D client needs Node ≤ 16 (as in the
> Dockerfile) or `NODE_OPTIONS=--openssl-legacy-provider` on newer Node. The 3D
> world has no build step and the production server runs on any modern Node.

## Tests

To run the tests for this this project, simply

```bash
$ npm install
$ npm test
```

This runs the jest suite (multiplayer room/edit/state logic of the 3D world
server) followed by headless engine smoke tests (worldgen determinism, chunk
meshing, editing, raycasting, player physics and multiplayer edit sync).
