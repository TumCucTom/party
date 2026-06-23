const server = require('./src/server/server');

if (require.main === module) {
  server.start();
}

module.exports = server;
