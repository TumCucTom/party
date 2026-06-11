const { World3D, hashString, sanitizeRoom, sanitizeName } = require('./world3d');
const Constants = require('../shared/constants');

const MSG = Constants.MSG_TYPES_3D;

function mockSocket(id) {
  return {
    id,
    handlers: {},
    emitted: [],   // [event, payload] sent to this socket
    broadcast: [], // [channel, event, payload] sent to its room
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, msg) { this.emitted.push([ev, msg]); },
    join() {},
    leave() {},
    to(channel) {
      const sock = this;
      return { emit(ev, msg) { sock.broadcast.push([channel, ev, msg]); } };
    },
    lastEmitted(ev) {
      const found = this.emitted.filter(e => e[0] === ev);
      return found.length ? found[found.length - 1][1] : undefined;
    },
  };
}

function makeWorld() {
  return new World3D({}, { sweepIntervalMs: 0 });
}

describe('helpers', () => {
  test('hashString is deterministic and 32-bit unsigned', () => {
    expect(hashString('party:public')).toBe(hashString('party:public'));
    expect(hashString('a')).not.toBe(hashString('b'));
    expect(hashString('party:public')).toBeGreaterThanOrEqual(0);
    expect(hashString('party:public')).toBeLessThanOrEqual(0xffffffff);
  });

  test('sanitizeRoom strips junk and defaults to public', () => {
    expect(sanitizeRoom('My Room!#')).toBe('myroom');
    expect(sanitizeRoom('')).toBe('public');
    expect(sanitizeRoom(undefined)).toBe('public');
    expect(sanitizeRoom('x'.repeat(50))).toHaveLength(32);
  });

  test('sanitizeName trims and defaults', () => {
    expect(sanitizeName('  Steve  ')).toBe('Steve');
    expect(sanitizeName('')).toBe('guest');
    expect(sanitizeName('a'.repeat(40))).toHaveLength(16);
  });
});

describe('joining rooms', () => {
  test('same room code always produces the same world seed', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    const s2 = mockSocket('bbb');
    w.join(s1, { room: 'treehouse', name: 'A' });
    w.join(s2, { room: 'treehouse', name: 'B' });
    expect(s1.lastEmitted(MSG.INIT).seed).toBe(s2.lastEmitted(MSG.INIT).seed);

    const s3 = mockSocket('ccc');
    w.join(s3, { room: 'other', name: 'C' });
    expect(s3.lastEmitted(MSG.INIT).seed).not.toBe(s1.lastEmitted(MSG.INIT).seed);
  });

  test('init lists existing players and new arrivals are broadcast', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'r', name: 'First' });
    expect(s1.lastEmitted(MSG.INIT).players).toEqual([]);

    const s2 = mockSocket('bbb');
    w.join(s2, { room: 'r', name: 'Second' });
    const init = s2.lastEmitted(MSG.INIT);
    expect(init.players).toHaveLength(1);
    expect(init.players[0]).toMatchObject({ id: 'aaa', name: 'First' });
    // the second player's arrival went out to the room channel
    expect(s2.broadcast).toContainEqual(['w3/r', MSG.PLAYER, expect.objectContaining({ id: 'bbb' })]);
  });

  test('players in different rooms are isolated', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    const s2 = mockSocket('bbb');
    w.join(s1, { room: 'one', name: 'A' });
    w.join(s2, { room: 'two', name: 'B' });
    expect(s2.lastEmitted(MSG.INIT).players).toEqual([]);
  });

  test('re-joining moves the player to the new room', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'one', name: 'A' });
    w.join(s1, { room: 'two', name: 'A' });
    expect(w.rooms.get('one').players.size).toBe(0);
    expect(w.rooms.get('two').players.size).toBe(1);
  });
});

describe('block edits', () => {
  test('edits are stored per cell (latest wins) and replayed to late joiners', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'build', name: 'A' });
    w.block(s1, { x: 1, y: 60, z: 2, id: 5 });
    w.block(s1, { x: 1, y: 60, z: 2, id: 7 });   // overwrite same cell
    w.block(s1, { x: 9, y: 61, z: 9, id: 3 });

    const s2 = mockSocket('bbb');
    w.join(s2, { room: 'build', name: 'B' });
    const { edits } = s2.lastEmitted(MSG.INIT);
    expect(edits).toHaveLength(2);
    expect(edits).toContainEqual([1, 60, 2, 7]);
    expect(edits).toContainEqual([9, 61, 9, 3]);
  });

  test('edits are rebroadcast to the room', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'build', name: 'A' });
    w.block(s1, { x: 0, y: 50, z: 0, id: 1 });
    expect(s1.broadcast).toContainEqual(['w3/build', MSG.BLOCK, { x: 0, y: 50, z: 0, id: 1 }]);
  });

  test('malformed edits are dropped', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'build', name: 'A' });
    w.block(s1, { x: 0.5, y: 50, z: 0, id: 1 });
    w.block(s1, { x: 0, y: 50, z: 0, id: 999 });
    w.block(s1, { x: 0, y: 50, z: 0, id: 'stone' });
    w.block(s1, {});
    expect(w.rooms.get('build').edits.size).toBe(0);
  });
});

describe('player state', () => {
  test('valid state is stored and relayed with the sender id', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'r', name: 'A' });
    w.state(s1, { x: 1.5, y: 70, z: -3, yaw: 1.2, pitch: -0.4 });
    const p = w.rooms.get('r').players.get('aaa');
    expect(p).toMatchObject({ x: 1.5, y: 70, z: -3, yaw: 1.2, pitch: -0.4 });
    expect(s1.broadcast).toContainEqual(['w3/r', MSG.STATE, expect.objectContaining({ id: 'aaa', x: 1.5 })]);
  });

  test('non-finite positions are rejected', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'r', name: 'A' });
    w.state(s1, { x: NaN, y: 70, z: 0 });
    w.state(s1, { x: 'over there', y: 70, z: 0 });
    const p = w.rooms.get('r').players.get('aaa');
    expect(p.x).toBe(0);
  });
});

describe('text chat', () => {
  test('chat is sanitized, trimmed and relayed with the sender id', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'r', name: 'A' });
    w.chat(s1, { text: `  hello${String.fromCharCode(0)} there${String.fromCharCode(31)}!  ` });
    const sent = s1.broadcast.filter(b => b[1] === MSG.CHAT);
    expect(sent).toHaveLength(1);
    expect(sent[0][2]).toEqual({ id: 'aaa', text: 'hello  there !' });
  });

  test('empty, non-string and over-long messages are bounded or dropped', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'r', name: 'A' });
    w.chat(s1, { text: '   ' });
    w.chat(s1, { text: 42 });
    w.chat(s1, {});
    expect(s1.broadcast.filter(b => b[1] === MSG.CHAT)).toHaveLength(0);
    w.chat(s1, { text: 'x'.repeat(500) });
    const sent = s1.broadcast.filter(b => b[1] === MSG.CHAT);
    expect(sent[0][2].text).toHaveLength(120);
  });

  test('rapid messages are rate limited', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'r', name: 'A' });
    w.chat(s1, { text: 'one' });
    w.chat(s1, { text: 'two' }); // immediately after → dropped
    expect(s1.broadcast.filter(b => b[1] === MSG.CHAT)).toHaveLength(1);
  });
});

describe('leaving & cleanup', () => {
  test('leave removes the player and notifies the room', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'r', name: 'A' });
    w.leave(s1);
    expect(w.rooms.get('r').players.size).toBe(0);
    expect(s1.broadcast).toContainEqual(['w3/r', MSG.LEAVE, 'aaa']);
  });

  test('TNT events relay only inside the room', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'r', name: 'A' });
    w.tnt(s1, { x: 1, y: 60, z: 1 });
    expect(s1.broadcast).toContainEqual(['w3/r', MSG.TNT, { x: 1, y: 60, z: 1 }]);
    w.tnt(s1, { x: 0.1, y: 60, z: 1 }); // malformed → dropped
    expect(s1.broadcast.filter(b => b[1] === MSG.TNT)).toHaveLength(1);
  });

  test('sweep drops only empty, stale rooms (builds survive a rejoin)', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'r', name: 'A' });
    w.block(s1, { x: 0, y: 50, z: 0, id: 1 });
    w.leave(s1);

    w.sweep(Date.now()); // fresh — kept
    expect(w.rooms.has('r')).toBe(true);

    const s2 = mockSocket('bbb');
    w.join(s2, { room: 'r', name: 'B' });
    expect(s2.lastEmitted(MSG.INIT).edits).toHaveLength(1); // build survived

    w.leave(s2);
    w.sweep(Date.now() + 1000 * 60 * 60 * 25); // a day later — gone
    expect(w.rooms.has('r')).toBe(false);
  });
});
