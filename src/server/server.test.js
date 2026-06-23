const http = require('http');

describe('server entrypoint', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    VERCEL: process.env.VERCEL,
  };

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    process.env.PORT = originalEnv.PORT;
    process.env.VERCEL = originalEnv.VERCEL;
  });

  test('exports the HTTP server for Vercel without listening during import', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.PORT = '0';
    process.env.VERCEL = '1';
    const listen = jest.spyOn(http.Server.prototype, 'listen').mockImplementation(function listen() {
      return this;
    });
    jest.doMock('socket.io', () => jest.fn((server) => {
      server.on('upgrade', () => {});
      return {
        on: jest.fn(),
        sockets: { emit: jest.fn() },
      };
    }));

    const server = require('./server');

    expect(server).toBeInstanceOf(http.Server);
    expect(server.listening).toBe(false);
    expect(server.listeners('upgrade').length).toBeGreaterThan(0);
    expect(listen).not.toHaveBeenCalled();
  });
});
