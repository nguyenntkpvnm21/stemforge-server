const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: connect } = require('socket.io-client');
const mongoose = require('mongoose');
const { createFrontendOriginPolicy } = require('../src/config/frontend-origins');

const LOCAL = 'http://localhost:5173';
const PREVIEW = 'https://stemforge-client-54d9dz4cg-ngoc-phuc.vercel.app';
const EXISTING = 'https://existing-client.example.invalid';

// This isolated test worker never loads .env or connects to external services.
process.env.JWT_SECRET = 'cors-loopback-tests-only-secret-at-least-32-bytes';
process.env.CLOUDINARY_CLOUD_NAME = 'cors-test-cloud';
process.env.CLOUDINARY_API_KEY = 'cors-test-key';
process.env.CLOUDINARY_API_SECRET = 'cors-test-secret';
process.env.FRONTEND_URL = EXISTING;
process.env.ADDITIONAL_FRONTEND_ORIGINS = PREVIEW;
process.env.TRUST_PROXY_HOPS = '0';
process.env.PROXY_DEBUG = 'false';
mongoose.set('bufferCommands', false);

const app = require('../src/app');
const { attachTrackRealtime } = require('../src/realtime/track-realtime');
const Track = require('../src/models/Track');
const User = require('../src/models/User');
const sample = require('./fixtures/track-contract-draft.json');

async function setup(t) {
  t.mock.method(Track, 'find', () => ({
    sort() { return this; }, skip() { return this; }, limit() { return this; },
    async exec() { return [{ ...sample }]; },
  }));
  t.mock.method(Track, 'countDocuments', () => ({ async exec() { return 1; } }));
  t.mock.method(User, 'find', () => ({
    select() { return this; }, lean() { return this; },
    async exec() { return [{ _id: sample.artistId, username: 'CORS test author', avatarUrl: null }]; },
  }));
  const server = http.createServer(app);
  const realtime = attachTrackRealtime(server, {
    loadUser: async () => null,
    loadTrack: async id => id === sample._id
      ? { _id: id, artistId: sample.artistId, isPublic: true, likesCount: 0 }
      : null,
  });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.disconnect();
    server.closeIdleConnections();
    await realtime.close();
    server.closeAllConnections();
    assert.deepEqual(realtime.inspect(), { rooms: 0, clients: 0, timers: 0, members: 0 });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    realtime,
    async send(path, origin, options = {}) {
      const response = await fetch(url + path, {
        ...options,
        headers: { ...(origin === undefined ? {} : { Origin: origin }), ...options.headers },
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    },
    socket(origin, transport) {
      const client = connect(url, {
        forceNew: true, reconnection: false, timeout: 2000,
        transports: [transport],
        extraHeaders: origin === undefined ? {} : { Origin: origin },
      });
      clients.push(client);
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          client.off('connect', connected);
          client.off('connect_error', failed);
        };
        const connected = () => { cleanup(); resolve(client); };
        const failed = error => { cleanup(); reject(error); };
        client.once('connect', connected);
        client.once('connect_error', failed);
      });
    },
  };
}

function assertCors(response, origin) {
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.match(response.headers.get('vary'), /(?:^|,\s*)Origin(?:,|$)/i);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
}

test('unconfigured origin policy allows localhost and clients without Origin only', () => {
  const policy = createFrontendOriginPolicy({});
  assert.deepEqual(policy.origins, [LOCAL]);
  assert.equal(policy.isAllowedOrigin(LOCAL), true);
  assert.equal(policy.isAllowedOrigin(undefined), true);
  assert.equal(policy.isAllowedOrigin(PREVIEW), false);
  assert.equal(policy.isAllowedOrigin('null'), false);
  assert.equal(policy.isAllowedOrigin(''), false);
});

test('legacy origin is preserved while additional origins are normalized, trimmed and deduplicated', () => {
  const policy = createFrontendOriginPolicy({
    FRONTEND_URL: EXISTING,
    ADDITIONAL_FRONTEND_ORIGINS: ` ${PREVIEW}/, ${LOCAL}, ${EXISTING}/ `,
  });
  assert.deepEqual(new Set(policy.origins), new Set([LOCAL, EXISTING, PREVIEW]));
  assert.equal(policy.isAllowedOrigin(PREVIEW + '/'), false);
  assert.equal(policy.isAllowedOrigin(PREVIEW + '.attacker.invalid'), false);
});

test('empty optional settings retain localhost without introducing another origin', () => {
  assert.deepEqual(createFrontendOriginPolicy({
    FRONTEND_URL: '', ADDITIONAL_FRONTEND_ORIGINS: '   ',
  }).origins, [LOCAL]);
});

const invalidSettings = [
  ['FRONTEND_URL', `${LOCAL},${PREVIEW}`],
  ['ADDITIONAL_FRONTEND_ORIGINS', '*'],
  ['ADDITIONAL_FRONTEND_ORIGINS', 'https://*.vercel.app'],
  ['ADDITIONAL_FRONTEND_ORIGINS', 'null'],
  ['ADDITIONAL_FRONTEND_ORIGINS', 'ftp://example.invalid'],
  ['ADDITIONAL_FRONTEND_ORIGINS', 'https:example.invalid'],
  ['ADDITIONAL_FRONTEND_ORIGINS', 'https://example.invalid/path'],
  ['ADDITIONAL_FRONTEND_ORIGINS', 'https://example.invalid?query=1'],
  ['ADDITIONAL_FRONTEND_ORIGINS', 'https://example.invalid#fragment'],
  ['ADDITIONAL_FRONTEND_ORIGINS', 'https://private-config@example.invalid'],
  ['ADDITIONAL_FRONTEND_ORIGINS', `${PREVIEW},`],
  ['ADDITIONAL_FRONTEND_ORIGINS', 42],
];
for (const [index, [variable, value]] of invalidSettings.entries()) {
  test(`invalid origin configuration ${index + 1} fails without exposing its value`, () => {
    assert.throws(() => createFrontendOriginPolicy({ [variable]: value }), error => {
      assert.match(error.message, new RegExp(variable));
      assert.equal(error.message.includes(String(value)), false);
      return true;
    });
  });
}

for (const [label, origin] of [['localhost', LOCAL], ['Vercel preview', PREVIEW], ['existing FRONTEND_URL', EXISTING]]) {
  test(`REST and Engine.IO polling reflect only ${label}, including preflight and REST errors`, async t => {
    const f = await setup(t);
    const list = await f.send('/api/tracks', origin);
    assert.equal(list.status, 200);
    assertCors(list, origin);
    const json = JSON.parse(list.text);
    assert.equal(json.data[0].artist.username, 'CORS test author');
    assert.equal(json.data[0].likedByMe, false);
    assert.equal(json.pagination.total, 1);

    const preflights = [
      ['/api/tracks', 'GET'],
      ['/api/tracks', 'POST'],
      [`/api/tracks/${sample._id}`, 'PATCH'],
      [`/api/tracks/${sample._id}`, 'DELETE'],
      [`/api/tracks/${sample._id}/like`, 'PUT'],
      [`/api/tracks/${sample._id}/like`, 'DELETE'],
      ['/socket.io/?EIO=4&transport=polling', 'GET'],
      ['/socket.io/?EIO=4&transport=polling', 'POST'],
    ];
    for (const [path, method] of preflights) {
      const preflight = await f.send(path, origin, {
        method: 'OPTIONS',
        headers: {
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      });
      assert.equal(preflight.status, 204);
      assertCors(preflight, origin);
      assert.ok(preflight.headers.get('access-control-allow-methods').split(',').includes(method));
      assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);
      assert.match(preflight.headers.get('access-control-allow-headers'), /content-type/i);
    }

    const unauthorized = await f.send('/api/auth/me', origin);
    assert.equal(unauthorized.status, 401);
    assertCors(unauthorized, origin);
    const invalidJson = await f.send('/api/auth/login', origin, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    assert.equal(invalidJson.status, 400);
    assertCors(invalidJson, origin);

    const polling = await f.send('/socket.io/?EIO=4&transport=polling', origin);
    assert.equal(polling.status, 200);
    assertCors(polling, origin);
    assert.match(polling.text, /^0\{/);
  });

  for (const transport of ['polling', 'websocket']) {
    test(`real Socket.IO ${transport} connection and public room join accept ${label}`, async t => {
      const f = await setup(t);
      const client = await f.socket(origin, transport);
      const ack = await client.timeout(2000).emitWithAck('track:join', { trackId: sample._id });
      assert.equal(ack.ok, true);
      assert.equal(ack.data.listenersCount, 1);
    });
  }
}

for (const [label, origin] of [
  ['unlisted origin', 'https://untrusted.example.invalid'],
  ['lookalike preview hostname', PREVIEW + '.attacker.invalid'],
  ['opaque browser origin', 'null'],
]) {
  test(`${label} receives no REST CORS permission and cannot open either socket transport`, async t => {
    const f = await setup(t);
    const list = await f.send('/api/tracks', origin);
    assert.equal(list.status, 200);
    assertCors(list, null);
    const preflight = await f.send('/api/tracks', origin, {
      method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assertCors(preflight, null);
    const polling = await f.send('/socket.io/?EIO=4&transport=polling', origin);
    assert.equal(polling.status, 403);
    assertCors(polling, null);
    for (const transport of ['polling', 'websocket']) {
      await assert.rejects(f.socket(origin, transport));
    }
    assert.equal(f.realtime.inspect().clients, 0);
  });
}

test('REST and both socket transports retain non-browser requests without Origin', async t => {
  const f = await setup(t);
  const response = await f.send('/api/health');
  assert.equal(response.status, 200);
  assertCors(response, null);
  for (const transport of ['polling', 'websocket']) {
    const client = await f.socket(undefined, transport);
    const ack = await client.timeout(2000).emitWithAck('track:join', { trackId: sample._id });
    assert.equal(ack.ok, true);
  }
});
