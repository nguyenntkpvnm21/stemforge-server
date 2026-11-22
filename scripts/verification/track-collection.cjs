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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stemforge-collection-proof-'));
const dataPath = fs.mkdtempSync(path.join(root, 'run-data-'));
const dbName = 'sf_collection_' + marker;
const setName = 'sf_collection_rs_' + marker;
const report = { marker, expectedGroups: 7, verification: 'incomplete',
  packageVersion: require('./track-idempotency/node_modules/mongodb-memory-server/package.json').version,
  requestedBinary: '8.0.34', host: '127.0.0.1', checks: [], cleanup: {} };
let repl, server, uri, port, a, b, publicTrack, privateTrack, changingTrack, unlikedTrack;
const tokens = [process.env.JWT_SECRET];
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
  return { status: response.status, data: response.status === 204 ? null : await response.json(), headers: response.headers };
}
async function group(name, operation) { await operation(); report.checks.push({ name, status: 'passed' }); console.log('PASS ' + name); }
async function list(account, query = '') { const r = await send('GET', '/api/tracks/liked' + query, account); assert.equal(r.status, 200); return r.data; }
async function like(track, account, method = 'PUT') { const r = await send(method, '/api/tracks/' + track._id + '/like', account); assert.equal(r.status, 200); return r.data.data; }
function payload(owner, title, isPublic) {
  return { artistId: owner._id, title, genre: 'Electronic', bpm: 96, key: 'Am', tags: [marker], isPublic, isDownloadable: false,
    stems: [{ name: 'Fixture stem', audioUrl: 'https://example.invalid/' + marker + '.wav', duration: 20, fileSize: 320044 }] };
}
(async () => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  repl = new MongoMemoryReplSet({ binary: { version: '8.0.34', downloadDir: path.join(os.tmpdir(), 'stemforge-mongodb-binary-cache'), checkMD5: true },
    replSet: { count: 1, name: setName, storageEngine: 'wiredTiger', ip: '127.0.0.1' },
    instanceOpts: [{ ip: '127.0.0.1', port, dbPath: dataPath }] });
  await repl.start(); await repl.waitUntilRunning();
  uri = repl.getUri(dbName);
  const parsed = new URL(uri); assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.port, String(port));
  assert.equal(parsed.pathname, '/' + dbName); assert.equal(parsed.searchParams.get('replicaSet'), setName);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false }); await owned();
  report.binaryVersion = (await mongoose.connection.db.admin().command({ buildInfo: 1 })).version;
  // DDL is restricted to the validated disposable replica set; no secondary indexes are provisioned.
  for (const model of [User, Track, TrackLike]) { await owned(); await model.createCollection(); }
  const password = randomBytes(24).toString('hex'); tokens.push(password);
  const hash = await bcrypt.hash(password, 12);
  a = await User.create({ username: 'collection-a-' + marker, email: 'a-' + marker + '@example.invalid', passwordHash: hash });
  b = await User.create({ username: 'collection-b-' + marker, email: 'b-' + marker + '@example.invalid', passwordHash: hash });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  for (const account of [a, b]) {
    const response = await send('POST', '/api/auth/login', null, { email: account.email, password });
    assert.equal(response.status, 200); account.token = response.data.data.accessToken; tokens.push(account.token);
  }
  publicTrack = await Track.create(payload(b, 'Public fixture', true));
  privateTrack = await Track.create(payload(a, 'Owner private fixture', false));
  changingTrack = await Track.create(payload(b, 'Private title must not leak', true));
  unlikedTrack = await Track.create(payload(b, 'Other account membership', true));

  await group('real authentication, empty collection and route/cache behavior', async () => {
    assert.equal((await send('GET', '/api/tracks/liked')).status, 401);
    const r = await send('GET', '/api/tracks/liked', a); assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(r.data, { data: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 0 } });
  });
  await group('real Like/Unlike service and account scoping', async () => {
    for (const track of [publicTrack, privateTrack, changingTrack]) await like(track, a);
    await like(publicTrack, a); await like(unlikedTrack, b); await like(changingTrack, b);
    const rows = await list(a); assert.equal(rows.pagination.total, 3);
    assert.ok(rows.data.every(t => t.likedByMe)); assert.equal(rows.data.some(t => t._id === String(unlikedTrack._id)), false);
    assert.equal((await list(b)).pagination.total, 2);
  });
  await group('actual PATCH privacy filtering before page/total, including all-hidden case', async () => {
    assert.equal((await send('PATCH', '/api/tracks/' + changingTrack._id, b, { isPublic: false })).status, 200);
    const result = await list(a, '?limit=1'); assert.equal(result.pagination.total, 2); assert.equal(result.data.length, 1);
    assert.equal(JSON.stringify(result).includes('Private title must not leak'), false);
    assert.equal((await list(b)).pagination.total, 2);
    assert.equal((await send('GET', '/api/tracks/' + changingTrack._id, a)).status, 404);
  });
  await group('real aggregation Like-time/tie ordering, complete pages and beyond-last totals', async () => {
    await owned(); await TrackLike.updateMany({ userId: a._id }, { $set: { createdAt: new Date('2026-01-01') } });
    const expected = await TrackLike.find({ userId: a._id, trackId: { $in: [publicTrack._id, privateTrack._id] } }).sort({ createdAt: -1, _id: -1 }).lean();
    const first = await list(a, '?limit=1'), second = await list(a, '?page=2&limit=1'), beyond = await list(a, '?page=9&limit=1');
    assert.deepEqual([...first.data, ...second.data].map(t => t._id), expected.map(l => String(l.trackId)));
    assert.deepEqual(beyond, { data: [], pagination: { page: 9, limit: 1, total: 2, totalPages: 2 } });
  });
  await group('real orphan join, missing author and response metadata allowlist', async () => {
    await owned(); await TrackLike.create({ userId: a._id, trackId: new mongoose.Types.ObjectId() });
    const ghost = await Track.create(payload({ _id: new mongoose.Types.ObjectId() }, 'Missing author', true));
    await like(ghost, a); const result = await list(a); assert.equal(result.pagination.total, 3);
    const missing = result.data.find(t => t._id === String(ghost._id)); assert.equal(missing.artist, null); assert.equal(missing.likedByMe, true);
    for (const t of result.data) { assert.equal('__v' in t, false); assert.equal('userId' in t, false); if (t.artist) assert.deepEqual(Object.keys(t.artist).sort(), ['_id', 'avatarUrl', 'username']); }
    assert.equal(JSON.stringify(result).includes('passwordHash'), false);
    await owned(); await Track.deleteOne({ _id: ghost._id });
    assert.equal((await list(a)).pagination.total, 2);
  });
  await group('real Unlike/re-Like and transactional DELETE update collection membership', async () => {
    await like(publicTrack, a, 'DELETE'); await like(publicTrack, a, 'DELETE');
    assert.equal((await list(a)).pagination.total, 1);
    await like(publicTrack, a); assert.equal((await list(a)).pagination.total, 2);
    assert.equal((await send('DELETE', '/api/tracks/' + publicTrack._id, b)).status, 204);
    assert.equal((await list(a)).pagination.total, 1);
    assert.equal(await TrackLike.countDocuments({ trackId: publicTrack._id }), 0);
    await owned(); await Track.deleteOne({ _id: privateTrack._id });
    assert.deepEqual(await list(a), { data: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 0 } });
  });
  await group('real invalid/repeated/operator/scope queries rejected', async () => {
    for (const q of ['page=0', 'limit=101', 'page=1&page=2', 'page[$gt]=1', 'userId=' + b._id, 'isPublic=false', 'sort=newest']) {
      assert.equal((await send('GET', '/api/tracks/liked?' + q, a)).status, 400);
    }
  });
  assert.equal(report.checks.length, report.expectedGroups); report.verification = 'passed';
})().catch(error => {
  let message = String(error.message).replace(/mongodb:\/\/\S+/g, '[local-uri]');
  for (const token of tokens) message = message.replaceAll(token, '[redacted]');
  report.error = { name: error.name, message }; process.exitCode = 1;
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
