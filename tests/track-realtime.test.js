process.env.JWT_SECRET = 'realtime-loopback-tests-only-secret-32-bytes';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { io: connect } = require('socket.io-client');
const { attachTrackRealtime } = require('../src/realtime/track-realtime');
const events = require('../src/services/track-events.service');
const { createAccessToken } = require('../src/config/jwt');
const A = '507f1f77bcf86cd799439011';
const B = '507f1f77bcf86cd799439012';
const PUBLIC = '507f1f77bcf86cd799439021';
const PRIVATE = '507f1f77bcf86cd799439022';
const OTHER = '507f1f77bcf86cd799439023';

async function setup(t, overrides = {}) {
  const tracks = new Map([
    [PUBLIC, { _id: PUBLIC, artistId: A, isPublic: true, likesCount: 0 }],
    [PRIVATE, { _id: PRIVATE, artistId: A, isPublic: false, likesCount: 2 }],
    [OTHER, { _id: OTHER, artistId: B, isPublic: true, likesCount: 0 }],
  ]);
  const users = new Set([A, B]);
  const server = http.createServer((req, res) => res.end('ok'));
  const realtime = attachTrackRealtime(server, {
    loadUser: async id => users.has(id) ? { _id: id } : null,
    loadTrack: async (id, userId) => {
      const track = tracks.get(id);
      return track && (track.isPublic || track.artistId === userId) ? { ...track } : null;
    }, ...overrides,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  async function socket(token, extra = {}) {
    const client = connect(url, { forceNew: true, reconnection: false,
      auth: token === undefined ? {} : { token }, ...extra });
    sockets.push(client);
    await Promise.race([once(client, 'connect'), once(client, 'connect_error').then(([e]) => { throw e; })]);
    return client;
  }
  t.after(async () => {
    for (const client of sockets) client.disconnect();
    await realtime.close();
    await events.coordinator.idle();
    assert.deepEqual(realtime.inspect(), { rooms: 0, clients: 0, timers: 0, members: 0 });
    assert.equal(events.coordinator.size, 0);
  });
  return { realtime, tracks, users, url, socket };
}
function ack(socket, event, id) {
  return socket.timeout(2000).emitWithAck(event, typeof id === 'string' ? { trackId: id } : id);
}

test('guest public snapshot, duplicate join, duplicate leave and exact event payloads', async t => {
  const f = await setup(t);
  const guest = await f.socket();
  const counts = [];
  guest.on('listeners:count', event => counts.push(event));
  const first = await ack(guest, 'track:join', PUBLIC);
  assert.equal(first.ok, true);
  assert.equal(first.data.listenersCount, 1);
  assert.equal(first.data.likesCount, 0);
  assert.equal(first.data.listenersSeq, 1);
  assert.equal(first.data.likesSeq, 0);
  assert.deepEqual(await ack(guest, 'track:join', PUBLIC), first);
  assert.deepEqual(counts, [{ trackId: PUBLIC, count: 1, epoch: first.data.epoch, seq: 1 }]);
  assert.deepEqual((await ack(guest, 'track:leave', OTHER)).data, { trackId: OTHER, left: false });
  assert.equal((await ack(guest, 'track:leave', PUBLIC)).data.left, true);
  assert.equal((await ack(guest, 'track:leave', PUBLIC)).data.left, false);
  const next = await ack(guest, 'track:join', PUBLIC);
  assert.notEqual(next.data.epoch, first.data.epoch);
});

test('guest/foreign private denied, owner private allowed; no private identity broadcast', async t => {
  const f = await setup(t);
  const guest = await f.socket();
  const owner = await f.socket(createAccessToken(A));
  const foreign = await f.socket(createAccessToken(B));
  for (const client of [guest, foreign]) {
    assert.equal((await ack(client, 'track:join', PRIVATE)).error.code, 'NOT_FOUND');
  }
  const result = await ack(owner, 'track:join', PRIVATE);
  assert.deepEqual(Object.keys(result.data).sort(), ['epoch', 'likesCount', 'likesSeq', 'listenersCount', 'listenersSeq', 'trackId']);
  assert.equal(result.data.likesCount, 2);
  assert.equal(f.realtime.inspect().members, 1);
});

for (const kind of ['invalid', 'empty', 'expired', 'missing-user', 'wrong-audience']) {
  test(`socket handshake rejects ${kind} token without guest fallback`, async t => {
    const f = await setup(t);
    let token = 'bad-token';
    if (kind === 'empty') token = '';
    if (kind === 'missing-user') token = createAccessToken('507f1f77bcf86cd799439099');
    if (kind === 'expired' || kind === 'wrong-audience') token = jwt.sign({}, process.env.JWT_SECRET, {
      subject: A, issuer: 'stemforge-server', audience: kind === 'expired' ? 'stemforge-client' : 'wrong',
      expiresIn: kind === 'expired' ? -1 : 60,
    });
    await assert.rejects(f.socket(token), error => error.data.code === 'UNAUTHENTICATED');
    assert.equal(f.realtime.inspect().clients, 0);
  });
}

test('token expires while joined: notification, disconnect, timer and presence cleanup', { timeout: 5000 }, async t => {
  const f = await setup(t);
  const guest = await f.socket();
  await ack(guest, 'track:join', PUBLIC);
  const token = jwt.sign({}, process.env.JWT_SECRET, { subject: A, issuer: 'stemforge-server', audience: 'stemforge-client', expiresIn: 2 });
  const owner = await f.socket(token);
  await ack(owner, 'track:join', PUBLIC);
  const notice = once(owner, 'auth:expired');
  const disconnected = once(owner, 'disconnect');
  await disconnected;
  assert.deepEqual((await notice)[0], { code: 'UNAUTHENTICATED' });
  assert.equal((await ack(guest, 'track:join', PUBLIC)).data.listenersCount, 1);
  assert.equal(f.realtime.inspect().timers, 0);
});

test('multiple tabs count separately; simultaneous duplicate joins and room switches stay bounded', async t => {
  const f = await setup(t);
  const a = await f.socket(createAccessToken(A));
  const b = await f.socket(createAccessToken(A));
  const joined = await Promise.all([ack(a, 'track:join', PUBLIC), ack(b, 'track:join', PUBLIC), ack(a, 'track:join', PUBLIC)]);
  assert.equal(f.realtime.inspect().members, 2);
  assert.equal(Math.max(...joined.map(result => result.data.listenersCount)), 2);
  assert.equal((await ack(a, 'track:join', PUBLIC)).data.listenersCount, 2);
  await Promise.all([ack(a, 'track:join', OTHER), ack(b, 'track:join', OTHER)]);
  assert.equal(f.realtime.inspect().rooms, 1);
  assert.equal((await ack(a, 'track:join', OTHER)).data.listenersCount, 2);
});

test('reconnect does not restore rooms; fresh join snapshot resynchronizes', async t => {
  const f = await setup(t);
  const client = await f.socket();
  const first = await ack(client, 'track:join', PUBLIC);
  const closed = once(f.realtime.io.sockets.sockets.get(client.id), 'disconnect');
  client.disconnect();
  await closed;
  client.connect();
  await once(client, 'connect');
  assert.equal(f.realtime.inspect().members, 0);
  const fresh = await ack(client, 'track:join', PUBLIC);
  assert.notEqual(fresh.data.epoch, first.data.epoch);
  assert.equal(fresh.data.listenersCount, 1);
});

test('visibility revokes guests/foreign users after coordinated commit; owner stays; delete revokes all', async t => {
  const f = await setup(t);
  const owner = await f.socket(createAccessToken(A));
  const guest = await f.socket();
  const other = await f.socket(createAccessToken(B));
  for (const client of [owner, guest, other]) await ack(client, 'track:join', PUBLIC);
  const unavailable = once(guest, 'track:unavailable');
  await events.coordinator.run(PUBLIC, async () => {
    f.tracks.get(PUBLIC).isPublic = false;
    await events.afterCommit('visibility', PUBLIC, f.tracks.get(PUBLIC));
  });
  assert.deepEqual((await unavailable)[0], { trackId: PUBLIC, code: 'NOT_FOUND' });
  assert.equal(f.realtime.inspect().members, 1);
  assert.equal((await ack(guest, 'track:join', PUBLIC)).error.code, 'NOT_FOUND');
  assert.equal((await ack(owner, 'track:join', PUBLIC)).data.listenersCount, 1);
  const removed = once(owner, 'track:unavailable');
  await events.coordinator.run(PUBLIC, async () => {
    f.tracks.delete(PUBLIC);
    await events.afterCommit('deleted', PUBLIC);
  });
  await removed;
  assert.equal(f.realtime.inspect().rooms, 0);
});

test('join waiting on lookup cannot create a ghost room after disconnect', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { loadTrack: async () => { entered(); await gate; return { likesCount: 0 }; } });
  const client = await f.socket();
  client.emit('track:join', { trackId: PUBLIC }, () => {});
  await started;
  const closed = once(f.realtime.io.sockets.sockets.get(client.id), 'disconnect');
  client.disconnect();
  await closed;
  release();
  await events.coordinator.idle();
  assert.equal(f.realtime.inspect().rooms, 0);
});

test('join queued behind visibility/delete sees committed access and cannot re-add removed members', async t => {
  const f = await setup(t);
  const guest = await f.socket();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const change = events.coordinator.run(PUBLIC, async () => {
    await gate;
    f.tracks.get(PUBLIC).isPublic = false;
    await events.afterCommit('visibility', PUBLIC, f.tracks.get(PUBLIC));
  });
  const joining = ack(guest, 'track:join', PUBLIC);
  release();
  await change;
  assert.equal((await joining).error.code, 'NOT_FOUND');
  assert.equal(f.realtime.inspect().members, 0);
});

test('lookup failure releases queue and returns INTERNAL_ERROR; deleted users are rejected on rejoin', async t => {
  let fail = true;
  const f = await setup(t, { loadTrack: async () => {
    if (fail) throw new Error('lookup unavailable');
    return { likesCount: 0 };
  } });
  const guest = await f.socket();
  assert.equal((await ack(guest, 'track:join', PUBLIC)).error.code, 'INTERNAL_ERROR');
  fail = false;
  assert.equal((await ack(guest, 'track:join', PUBLIC)).ok, true);
  const owner = await f.socket(createAccessToken(A));
  f.users.delete(A);
  assert.equal((await ack(owner, 'track:join', PUBLIC)).error.code, 'UNAUTHENTICATED');
});

test('strict payload and per-socket rate limits reject malformed/oversubscribed requests', async t => {
  const f = await setup(t);
  const guest = await f.socket();
  for (const payload of [null, [], {}, { trackId: 'bad' }, { trackId: PUBLIC, userId: A }, { trackId: { $ne: null } }]) {
    assert.equal((await ack(guest, 'track:join', payload)).error.code, 'INVALID_PAYLOAD');
  }
  for (let i = 0; i < 30; i++) assert.equal((await ack(guest, 'track:leave', PUBLIC)).ok, true);
  assert.equal((await ack(guest, 'track:join', PUBLIC)).error.code, 'RATE_LIMITED');
});

test('like broadcast has only shared state, monotonic topic seq and fresh rejoin snapshot', async t => {
  const f = await setup(t);
  const guest = await f.socket();
  const joined = await ack(guest, 'track:join', PUBLIC);
  const received = [];
  guest.on('like:updated', value => received.push(value));
  for (const count of [1, 2]) await events.coordinator.run(PUBLIC, async () => {
    f.tracks.get(PUBLIC).likesCount = count;
    await events.afterCommit('like', PUBLIC, { likesCount: count });
  });
  const snapshot = await ack(guest, 'track:join', PUBLIC);
  assert.equal(snapshot.data.likesSeq, 2);
  assert.equal(snapshot.data.likesCount, 2);
  assert.deepEqual(received, [1, 2].map(seq => ({ trackId: PUBLIC, likesCount: seq, epoch: joined.data.epoch, seq })));
});

test('coordinator isolates Tracks, preserves order after errors and removes idle queue entries', async () => {
  const queue = events.createCoordinator();
  const order = [];
  let release;
  const first = queue.run(PUBLIC, () => new Promise(resolve => { release = resolve; }));
  const broken = queue.run(PUBLIC, () => { order.push('broken'); throw new Error('failed'); });
  const recovered = queue.run(PUBLIC, () => order.push('recovered'));
  await queue.run(OTHER, () => order.push('independent'));
  release();
  await first;
  await assert.rejects(broken);
  await recovered;
  await queue.idle();
  assert.deepEqual(order, ['independent', 'broken', 'recovered']);
  assert.equal(queue.size, 0);
});

test('WebSocket transport shares HTTP listener and rejects an unexpected browser Origin', async t => {
  const f = await setup(t);
  const client = await f.socket(undefined, { transports: ['websocket'] });
  assert.equal((await ack(client, 'track:join', PUBLIC)).ok, true);
  await assert.rejects(f.socket(undefined, { transports: ['websocket'], extraHeaders: { Origin: 'https://untrusted.invalid' } }));
  assert.equal((await fetch(f.url)).status, 200);
});

test('simultaneous cross-room switches acquire no nested locks or deadlocks', async t => {
  const f = await setup(t);
  const a = await f.socket();
  const b = await f.socket();
  await Promise.all([ack(a, 'track:join', PUBLIC), ack(b, 'track:join', OTHER)]);
  await Promise.all([ack(a, 'track:join', OTHER), ack(b, 'track:join', PUBLIC)]);
  assert.equal(f.realtime.inspect().members, 2);
  assert.equal(f.realtime.inspect().rooms, 2);
});

for (const event of ['visibility', 'deleted']) test(`join already in progress is revoked after queued ${event} commit`, async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { loadTrack: async () => { entered(); await gate; return { likesCount: 0 }; } });
  const guest = await f.socket();
  const joining = ack(guest, 'track:join', PUBLIC);
  await started;
  const unavailable = once(guest, 'track:unavailable');
  const mutation = events.coordinator.run(PUBLIC, () => events.afterCommit(event, PUBLIC, { isPublic: false, artistId: A }));
  release();
  await Promise.all([joining, mutation, unavailable]);
  assert.equal(f.realtime.inspect().members, 0);
});

test('shutdown disconnects clients, clears expiry timers and drains an in-flight join', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { loadTrack: async () => { entered(); await gate; return { likesCount: 0 }; } });
  const owner = await f.socket(createAccessToken(A));
  owner.emit('track:join', { trackId: PUBLIC }, () => {});
  await started;
  const disconnected = once(owner, 'disconnect');
  const closing = f.realtime.close();
  await disconnected;
  assert.equal(f.realtime.inspect().timers, 0);
  release();
  await closing;
  assert.deepEqual(f.realtime.inspect(), { rooms: 0, clients: 0, members: 0, timers: 0 });
});

test('pending request bound rejects the ninth request without poisoning the socket queue', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { loadTrack: async () => { await gate; return { likesCount: 0 }; } });
  const guest = await f.socket();
  const pending = Array.from({ length: 8 }, () => ack(guest, 'track:join', PUBLIC));
  try { assert.equal((await ack(guest, 'track:join', PUBLIC)).error.code, 'RATE_LIMITED'); }
  finally { release(); }
  assert.ok((await Promise.all(pending)).every(result => result.ok));
  assert.equal((await ack(guest, 'track:join', PUBLIC)).data.listenersCount, 1);
});
