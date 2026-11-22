const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const dns = require('node:dns');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');

// Reuse the repository's pinned, optional Mongo test tooling, not application dependencies.
assert.equal(process.argv.length, 2, 'This probe accepts no URI, credentials or arguments.');
for (const key of Object.keys(process.env)) {
  if (/^(MONGO|MONGODB|MONGOMS|CLOUDINARY|JWT)_/.test(key)) delete process.env[key];
}
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map(value => value.trim()).filter(Boolean));
process.env.MONGOMS_DOWNLOAD_MIRROR = 'https://fastdl.mongodb.org';
const { MongoMemoryReplSet } = require('./track-idempotency/node_modules/mongodb-memory-server');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: randomBytes(32).toString('hex'),
  CLOUDINARY_CLOUD_NAME: 'fixture-only', CLOUDINARY_API_KEY: 'fixture-only', CLOUDINARY_API_SECRET: 'fixture-only',
  FRONTEND_URL: 'http://localhost:5173', ADDITIONAL_FRONTEND_ORIGINS: '', TRUST_PROXY_HOPS: '0' });
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
const User = require('../../src/models/User');
const Track = require('../../src/models/Track');
const TrackLike = require('../../src/models/TrackLike');
const app = require('../../src/app');

const marker = randomBytes(8).toString('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stemforge-download-proof-'));
const dataPath = fs.mkdtempSync(path.join(root, 'run-data-'));
const dbName = 'sf_download_' + marker;
const setName = 'sf_download_rs_' + marker;
const report = { marker, expectedGroups: 6, verification: 'incomplete',
  packageVersion: require('./track-idempotency/node_modules/mongodb-memory-server/package.json').version,
  requestedBinary: '8.0.34', host: '127.0.0.1', checks: [], cleanup: {} };
let repl, server, uri, port;
let currentGroup = 'startup';
async function owned() {
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'mongodb:'); assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.port, String(port)); assert.equal(parsed.pathname, '/' + dbName);
  assert.equal(parsed.searchParams.get('replicaSet'), setName); assert.equal(parsed.username, ''); assert.equal(parsed.password, '');
  assert.equal(mongoose.connection.name, dbName);
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, setName); assert.deepEqual(hello.hosts, ['127.0.0.1:' + port]);
}
async function send(method, route, account, body) {
  const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
    method, headers: { ...(account ? { Authorization: 'Bearer ' + account.token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data, headers: response.headers };
}
async function group(name, operation) {
  currentGroup = name; await operation(); report.checks.push({ name, status: 'passed' }); console.log('PASS ' + name);
}
function payload(owner, isPublic, isDownloadable, external = false) {
  return { artistId: owner._id, title: 'Isolated download ' + marker, genre: 'Electronic', bpm: 96, key: 'Am',
    tags: [marker], isPublic, isDownloadable, stems: [{ name: 'Fixture stem',
      audioUrl: external ? 'https://example.invalid/' + marker + '.wav' :
        'https://res.cloudinary.com/fixture-only/video/upload/v1/stemforge/audio/' + owner._id + '/3bb2d1a7-9cf6-4dae-bc39-cad8ce01c4dc.wav',
      duration: 20, fileSize: 320044 }] };
}
function route(track, stemId = track.stems[0].stemId) { return '/api/tracks/' + track._id + '/stems/' + stemId + '/download'; }
function descriptor(result, track) {
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.data.data.trackId, String(track._id)); assert.equal(result.data.data.stemId, String(track.stems[0].stemId));
  const url = new URL(result.data.data.downloadUrl);
  assert.equal(url.origin, 'https://api.cloudinary.com'); assert.equal(url.pathname, '/v1_1/fixture-only/video/download');
  assert.equal(url.searchParams.get('type'), 'upload'); assert.equal(url.searchParams.get('attachment'), 'true');
  assert.equal(url.searchParams.get('format'), 'wav'); assert.equal(url.searchParams.get('transformation'), null);
  assert.equal(Number(url.searchParams.get('expires_at')) - Number(url.searchParams.get('timestamp')), 300);
}
(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  repl = new MongoMemoryReplSet({ binary: { version: '8.0.34', downloadDir: path.join(os.tmpdir(), 'stemforge-mongodb-binary-cache'), checkMD5: true },
    replSet: { count: 1, name: setName, storageEngine: 'wiredTiger', ip: '127.0.0.1' },
    instanceOpts: [{ ip: '127.0.0.1', port, dbPath: dataPath }] });
  await repl.start(); await repl.waitUntilRunning(); uri = repl.getUri(dbName);
  const parsed = new URL(uri); assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.port, String(port));
  assert.equal(parsed.pathname, '/' + dbName); assert.equal(parsed.searchParams.get('replicaSet'), setName);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false }); await owned();
  report.binaryVersion = (await mongoose.connection.db.admin().command({ buildInfo: 1 })).version;
  for (const model of [User, Track, TrackLike]) { await owned(); await model.createCollection(); }
  const password = randomBytes(24).toString('hex');
  const hash = await bcrypt.hash(password, 12);
  const a = await User.create({ username: 'download-a-' + marker, email: 'a-' + marker + '@example.invalid', passwordHash: hash });
  const b = await User.create({ username: 'download-b-' + marker, email: 'b-' + marker + '@example.invalid', passwordHash: hash });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  for (const account of [a, b]) {
    const result = await send('POST', '/api/auth/login', null, { email: account.email, password });
    assert.equal(result.status, 200); account.token = result.data.data.accessToken;
  }
  await owned();
  const publicTrack = await Track.create(payload(a, true, true));
  const privateTrack = await Track.create(payload(a, false, true));
  const disabledTrack = await Track.create(payload(a, true, false));
  const externalTrack = await Track.create(payload(a, true, true, true));
  const originalStems = JSON.stringify(publicTrack.stems);
  await group('real Auth and invalid ID/input rejection', async () => {
    assert.equal((await send('GET', route(publicTrack))).status, 401);
    assert.equal((await send('GET', route(publicTrack) + '?url=https://example.invalid', a)).status, 400);
    assert.equal((await send('GET', '/api/tracks/invalid/stems/' + publicTrack.stems[0].stemId + '/download', a)).status, 400);
  });
  await group('real public read and original Cloudinary descriptor without network delivery', async () => {
    descriptor(await send('GET', route(publicTrack), a), publicTrack);
    descriptor(await send('GET', route(publicTrack), b), publicTrack);
    const detail = await send('GET', '/api/tracks/' + publicTrack._id);
    assert.equal(detail.status, 200); assert.equal(detail.data.data.stems[0].audioUrl, publicTrack.stems[0].audioUrl);
  });
  await group('real private-owner filter and download flag including owner', async () => {
    descriptor(await send('GET', route(privateTrack), a), privateTrack);
    assert.equal((await send('GET', route(privateTrack), b)).status, 404);
    for (const account of [a, b]) assert.equal((await send('GET', route(disabledTrack), account)).status, 403);
  });
  await group('real stem membership and unsupported stored URL', async () => {
    assert.equal((await send('GET', route(publicTrack, privateTrack.stems[0].stemId), a)).status, 404);
    assert.equal((await send('GET', route(externalTrack), a)).status, 422);
    assert.equal(await Track.countDocuments({ tags: marker }), 4);
  });
  await group('committed PATCH revokes fresh descriptors without modifying playback/stems', async () => {
    assert.equal((await send('PATCH', '/api/tracks/' + publicTrack._id, a, { isDownloadable: false })).status, 200);
    assert.equal((await send('GET', route(publicTrack), a)).status, 403);
    assert.equal((await send('PATCH', '/api/tracks/' + publicTrack._id, a, { isDownloadable: true, isPublic: false })).status, 200);
    assert.equal((await send('GET', route(publicTrack), b)).status, 404);
    descriptor(await send('GET', route(publicTrack), a), publicTrack);
    const saved = await Track.findById(publicTrack._id); assert.equal(JSON.stringify(saved.stems), originalStems);
  });
  await group('committed DELETE prevents new descriptors and preserves other fixtures', async () => {
    assert.equal((await send('DELETE', '/api/tracks/' + publicTrack._id, a)).status, 204);
    assert.equal((await send('GET', route(publicTrack), a)).status, 404);
    assert.equal(await Track.countDocuments({ tags: marker }), 3);
    assert.equal(await User.countDocuments(), 2);
  });
  assert.equal(report.checks.length, report.expectedGroups); report.verification = 'passed';
})().catch(error => {
  // Assertions may contain a signed link; report the failing group, never values.
  report.error = { name: error.name, group: currentGroup }; process.exitCode = 1;
}).finally(async () => {
  const cleanupErrors = [];
  async function step(name, operation, done) {
    try { await operation(); report.cleanup[name] = done(); }
    catch (error) { report.cleanup[name] = false; cleanupErrors.push({ step: name, name: error.name }); }
  }
  await step('httpClosed', async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }, () => !server?.listening);
  await step('connectionClosed', () => mongoose.disconnect(), () => mongoose.connection.readyState === 0);
  await step('replStopped', async () => {
    if (repl) await repl.stop({ doCleanup: true, force: true });
  }, () => !repl || repl.state === 'stopped');
  await step('dataDirectoryRemoved', async () => {
    assert.ok(report.cleanup.replStopped, 'Do not remove files while a test mongod may still be running.');
    if (fs.existsSync(dataPath)) {
      const realRoot = fs.realpathSync(root), realData = fs.realpathSync(dataPath);
      assert.ok(realData.startsWith(realRoot + path.sep)); assert.equal(fs.lstatSync(dataPath).isSymbolicLink(), false);
      fs.rmSync(realData, { recursive: true, force: true });
    }
  }, () => !fs.existsSync(dataPath));
  report.cleanup.passed = Object.values(report.cleanup).every(value => value === true);
  if (cleanupErrors.length) report.cleanup.errors = cleanupErrors;
  fs.writeFileSync(path.join(root, 'result.local.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(root, 'result.local.json'), ...report }));
  if (!report.cleanup.passed) process.exitCode = 1;
});
