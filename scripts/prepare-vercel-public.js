const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'package.json') continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isFile()) copyFile(src, dest);
  }
}

copyDir(path.join(root, 'src/client3d'), path.join(publicDir, 'world'));
copyFile(path.join(root, 'src/client3d/index.html'), path.join(publicDir, 'index.html'));
copyFile(
  path.join(root, 'node_modules/three/build/three.module.js'),
  path.join(publicDir, 'vendor/three/three.module.js'),
);
copyFile(
  path.join(root, 'node_modules/peerjs/dist/peerjs.min.js'),
  path.join(publicDir, 'vendor/peerjs/peerjs.min.js'),
);
copyFile(
  path.join(root, 'node_modules/socket.io-client/dist/socket.io.js'),
  path.join(publicDir, 'socket.io/socket.io.js'),
);

console.log('Prepared Vercel static assets in public/.');
