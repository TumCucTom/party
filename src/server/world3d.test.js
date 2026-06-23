const os = require('os');
const fs = require('fs');
const path = require('path');
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

describe('face frame relay', () => {
  test('bounded jpeg frames relay only to the sender room with sender id', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'r', name: 'A' });

    const image = `data:image/jpeg;base64,${'a'.repeat(120)}`;
    w.face(s1, { image });

    expect(s1.broadcast).toContainEqual(['w3/r', MSG.FACE, { id: 'aaa', image }]);
    expect(s1.emitted.filter(e => e[0] === MSG.FACE)).toHaveLength(0);
  });

  test('malformed, oversized and rapid face frames are dropped', () => {
    let now = 1000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'r', name: 'A' });

    w.face(s1, { image: 'not an image' });
    w.face(s1, { image: `data:image/jpeg;base64,${'a'.repeat(50000)}` });
    expect(s1.broadcast.filter(b => b[1] === MSG.FACE)).toHaveLength(0);

    w.face(s1, { image: `data:image/jpeg;base64,${'a'.repeat(120)}` });
    w.face(s1, { image: `data:image/jpeg;base64,${'b'.repeat(120)}` });
    expect(s1.broadcast.filter(b => b[1] === MSG.FACE)).toHaveLength(1);

    now += 600;
    w.face(s1, { image: `data:image/jpeg;base64,${'c'.repeat(120)}` });
    expect(s1.broadcast.filter(b => b[1] === MSG.FACE)).toHaveLength(2);
    nowSpy.mockRestore();
  });
});

describe('persistence & room info', () => {
  test('worlds survive a restart via the save file', () => {
    const file = path.join(os.tmpdir(), `w3d-test-${Date.now()}-${Math.random()}.json`);
    const w1 = new World3D({}, { sweepIntervalMs: 0, file, saveIntervalMs: 0 });
    const s1 = mockSocket('aaa');
    w1.join(s1, { room: 'castle', name: 'A' });
    w1.block(s1, { x: 5, y: 70, z: 5, id: 20 });
    const { createdAt } = w1.rooms.get('castle');
    w1.save();

    const w2 = new World3D({}, { sweepIntervalMs: 0, file, saveIntervalMs: 0 });
    expect(w2.rooms.has('castle')).toBe(true);
    expect(w2.rooms.get('castle').createdAt).toBe(createdAt); // day clock survives
    const s2 = mockSocket('bbb');
    w2.join(s2, { room: 'castle', name: 'B' });
    expect(s2.lastEmitted(MSG.INIT).edits).toContainEqual([5, 70, 5, 20]);
    fs.unlinkSync(file);
  });

  test('save is skipped when nothing changed', () => {
    const file = path.join(os.tmpdir(), `w3d-test2-${Date.now()}-${Math.random()}.json`);
    const w = new World3D({}, { sweepIntervalMs: 0, file, saveIntervalMs: 0 });
    w.save();
    expect(fs.existsSync(file)).toBe(false); // not dirty → no write
  });

  test('roomInfo reports players and edit count for the join screen', () => {
    const w = makeWorld();
    expect(w.roomInfo('nowhere')).toEqual({ exists: false, players: [], edits: 0 });
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'plaza', name: 'Ann' });
    w.block(s1, { x: 0, y: 64, z: 0, id: 1 });
    // lookup goes through the same sanitizer as joining
    expect(w.roomInfo('PLAZA!')).toEqual({ exists: true, players: ['Ann'], edits: 1 });
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

describe('combat', () => {
  test('players initialize with combat state in init payloads', () => {
    const w = makeWorld();
    const s1 = mockSocket('aaa');
    w.join(s1, { room: 'arena', name: 'A' });
    const init = s1.lastEmitted(MSG.INIT);
    expect(init.me).toMatchObject({
      id: 'aaa', hp: 100, alive: true, kills: 0, deaths: 0,
    });

    const s2 = mockSocket('bbb');
    w.join(s2, { room: 'arena', name: 'B' });
    expect(s2.lastEmitted(MSG.INIT).players[0]).toMatchObject({
      id: 'aaa', hp: 100, alive: true, kills: 0, deaths: 0,
    });
  });

  test('valid slash damages a target and broadcasts hit', () => {
    const w = makeWorld();
    const a = mockSocket('attacker');
    const v = mockSocket('victim');
    w.join(a, { room: 'arena', name: 'A' });
    w.join(v, { room: 'arena', name: 'V' });
    w.state(a, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.state(v, { x: 0, y: 70, z: -1.6, yaw: Math.PI, pitch: 0 });

    w.attack(a, { kind: 'slash' });

    const victim = w.rooms.get('arena').players.get('victim');
    expect(victim.hp).toBe(66);
    expect(a.broadcast).toContainEqual(['w3/arena', MSG.HIT, expect.objectContaining({
      attackerId: 'attacker', victimId: 'victim', damage: 34, hp: 66, kind: 'slash',
    })]);
    expect(a.emitted).toContainEqual([MSG.HIT, expect.objectContaining({
      attackerId: 'attacker', victimId: 'victim', damage: 34, hp: 66, kind: 'slash',
    })]);
  });

  test('attacks outside range or cone are ignored', () => {
    const w = makeWorld();
    const a = mockSocket('attacker');
    const v = mockSocket('victim');
    w.join(a, { room: 'arena', name: 'A' });
    w.join(v, { room: 'arena', name: 'V' });
    w.state(a, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.state(v, { x: 0, y: 70, z: 4, yaw: 0, pitch: 0 });
    w.attack(a, { kind: 'slash' });
    expect(w.rooms.get('arena').players.get('victim').hp).toBe(100);

    w.state(v, { x: 2, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.attack(a, { kind: 'stab' });
    expect(w.rooms.get('arena').players.get('victim').hp).toBe(100);
    expect(a.broadcast.filter(b => b[1] === MSG.HIT)).toHaveLength(0);
  });

  test('attack cooldown blocks repeated strikes', () => {
    const w = makeWorld();
    const a = mockSocket('attacker');
    const v = mockSocket('victim');
    w.join(a, { room: 'arena', name: 'A' });
    w.join(v, { room: 'arena', name: 'V' });
    w.state(a, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.state(v, { x: 0, y: 70, z: -1.6, yaw: Math.PI, pitch: 0 });
    w.attack(a, { kind: 'slash' });
    w.attack(a, { kind: 'slash' });
    expect(w.rooms.get('arena').players.get('victim').hp).toBe(66);
    expect(a.broadcast.filter(b => b[1] === MSG.HIT)).toHaveLength(1);
  });

  test('death increments score and respawn restores the victim', () => {
    jest.useFakeTimers();
    let now = 1000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const w = makeWorld();
    const a = mockSocket('attacker');
    const v = mockSocket('victim');
    w.join(a, { room: 'arena', name: 'A' });
    w.join(v, { room: 'arena', name: 'V' });
    w.state(a, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.state(v, { x: 0, y: 70, z: -1.6, yaw: Math.PI, pitch: 0 });

    w.attack(a, { kind: 'stab' });
    jest.advanceTimersByTime(900);
    now += 900;
    w.attack(a, { kind: 'stab' });

    const room = w.rooms.get('arena');
    expect(room.players.get('attacker')).toMatchObject({ kills: 1 });
    expect(room.players.get('victim')).toMatchObject({ hp: 0, alive: false, deaths: 1 });
    expect(a.broadcast).toContainEqual(['w3/arena', MSG.DEATH, expect.objectContaining({
      attackerId: 'attacker', victimId: 'victim',
    })]);

    jest.advanceTimersByTime(3000);
    expect(room.players.get('victim')).toMatchObject({ hp: 100, alive: true, deaths: 1 });
    expect(a.broadcast).toContainEqual(['w3/arena', MSG.RESPAWN, expect.objectContaining({
      id: 'victim', hp: 100, alive: true,
    })]);
    nowSpy.mockRestore();
    jest.useRealTimers();
  });

  test('combat events stay inside their room', () => {
    const w = makeWorld();
    const a = mockSocket('attacker');
    const v = mockSocket('victim');
    w.join(a, { room: 'one', name: 'A' });
    w.join(v, { room: 'two', name: 'V' });
    w.state(a, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 });
    w.state(v, { x: 0, y: 70, z: -1.6, yaw: Math.PI, pitch: 0 });
    w.attack(a, { kind: 'slash' });
    expect(w.rooms.get('two').players.get('victim').hp).toBe(100);
    expect(a.broadcast.filter(b => b[1] === MSG.HIT)).toHaveLength(0);
  });
});
