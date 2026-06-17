<h1 align="center">
    Spatial Video Chat
</h1>

Normally only one person can speak at a time in a standard conference call and it only gets worse the more people there are.
This isn't like in real life, where we zone in and out of large groups, form smaller ones as the conversation takes us.

[**Live Demo**](https://party.souradip.com/).

<p float="left">
<img src="https://github.com/souramoo/party/blob/master/public/assets/landing/2020-04-11.png?raw=true" width="49%" />
<img src="https://github.com/souramoo/party/blob/master/public/assets/landing/2020-04-11 (1).png?raw=true" width="49%" />
</p>

Built with [Node.js](https://nodejs.org/), [socket.io](https://socket.io/), and [HTML5 Canvas](https://www.w3schools.com/html/html5_canvas.asp).

## Knife Party — spatial video chat with first-person combat (default at `/`)

The spatial video chat concept, rebuilt with full functionality inside a
first-person 3D room ([Three.js](https://threejs.org/)):

- **Spatial voice & video** — walk up to someone to start a call (WebRTC via
  PeerJS, exactly like the 2D version), walk away to leave it. Voice is
  spatialized with WebAudio `PannerNode`s, so people sound like where they
  stand: quieter with distance, panned by direction.
- **Knife combat** — left click slashes, right click stabs, and the server
  validates range, facing, cooldowns, health, eliminations and respawns.
  The client animates a first-person knife immediately, but damage only
  applies when the room server accepts the hit.
- **Faces on avatars** — every player keeps a webcam-faced avatar while in
  voice range, with combat health bars, hit flashes and respawn posture.
- **Shared rooms** — a room code deterministically seeds the terrain substrate
  and keeps late joiners in sync. The join screen shows who is already in the
  room before you enter.
- **Minimap** — a north-up radar in the corner with height-shaded terrain,
  your view arrow, and a colored dot per player (clamped to the edge when
  they're far) so you can always find people.
- **Screen sharing** — press `P` to present: your screen appears on a
  slideshow board standing next to your avatar, visible to everyone in voice
  range, like presenting at a real meetup.
- **No build step, no assets** — the 3D client (`src/client3d`) is served as
  native ES modules; textures and the knife view-model are generated at
  runtime and every sound is synthesized with WebAudio.
- **Works on phones too** — on touch devices a virtual joystick, drag-to-look
  and on-screen movement/combat buttons appear; the HUD rearranges and scales
  for small screens. Desktop never sees the touch UI.

Open the site, pick a name and a room code, and share the link (the room code
travels in the URL hash, e.g. `/#treehouse`). The same room code always
produces the same terrain layout. In game: left click slashes, right click
stabs, `M`/`V` mute mic/camera, `C` switches cameras, `P` presents your screen,
and `T` chats. The classic 2D experience remains at `/join` and the old landing
page at `/index.html`.

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
