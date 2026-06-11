const fs = require('fs');
const path = require('path');
const express = require('express');
const socketio = require('socket.io');

const Constants = require('../shared/constants');
const Game = require('./game');
const { World3D } = require('./world3d');

// Setup an Express server
const app = express();

// This lets us go to /join not /join.html
const publicdir = `${__dirname}/../../dist`;
app.use((req, res, next) => {
  if (req.path.indexOf('.') === -1) {
    const file = `${publicdir + req.path}.html`;
    fs.exists(file, exists => {
      if (exists) req.url += '.html';
      next();
    });
  } else next();
});
app.use(express.static('public'));

// The 3D world client (/world) is served as native ES modules — no build
// step. Its two runtime dependencies are vendored straight from node_modules.
app.use('/world', express.static(path.join(__dirname, '../client3d')));
app.use('/vendor/three', express.static(path.join(__dirname, '../../node_modules/three/build')));
app.use('/vendor/peerjs', express.static(path.join(__dirname, '../../node_modules/peerjs/dist')));

if (process.env.NODE_ENV === 'development') {
  // Setup Webpack for development (required lazily so production
  // doesn't need to load the webpack toolchain to boot)
  // eslint-disable-next-line global-require
  const webpack = require('webpack');
  // eslint-disable-next-line global-require
  const webpackDevMiddleware = require('webpack-dev-middleware');
  // eslint-disable-next-line global-require
  const webpackConfig = require('../../webpack.dev.js');
  const compiler = webpack(webpackConfig);
  app.use(webpackDevMiddleware(compiler, { writeToDisk: true }));
} else {
  // Static serve the dist/ folder in production
  app.use(express.static('dist'));
}

// Listen on port
const port = process.env.PORT || 3000;
const server = app.listen(port);
console.log(`Server listening on port ${port}`);

// Setup socket.io
const io = socketio(server);

// Setup the Game (classic 2D) and the voxel world (3D)
const game = new Game();
const world3d = new World3D(io);

// Listen for socket.io connections
io.on('connection', socket => {
  console.log('Player connected!', socket.id);

  socket.on(Constants.MSG_TYPES.JOIN_GAME, joinGame);
  socket.on(Constants.MSG_TYPES.INPUT, handleInput);
  socket.on(Constants.MSG_TYPES.EMOTE, handleEmote);
  socket.on('disconnect', onDisconnect);

  world3d.attach(socket);
});

function joinGame(joinData) {
  game.addPlayer(this, joinData);
  io.sockets.emit(Constants.MSG_TYPES.BRDCST_PLAYER_ENTERED, game.getPlayers());
}

function handleInput(dir) {
  game.handleInput(this, dir.dir, dir.dis);
}

function handleEmote(emote) {
  game.handleEmote(this, emote);
}

function onDisconnect() {
  game.removePlayer(this);
  this.broadcast.emit(Constants.MSG_TYPES.BRDCST_PLAYER_LEFT, this.id);
  console.log(`Player left! ${this.id}`);
}

// return photo
app.get('/photo/:id', (req, res) => {
  const im = game.getPhoto(req.params.id).split(',')[1];
  if (im) {
    const img = Buffer.from(im, 'base64');

    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': img.length,
    });
    res.end(img);
  } else {
    res.sendStatus(404);
  }
});
