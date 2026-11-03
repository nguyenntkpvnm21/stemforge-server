const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const { fork } = require('node:child_process');
const { createRequire } = require('node:module');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
// This opt-in probe never accepts a DB URI and never loads project dotenv files.
const worktree = path.resolve(__dirname, '../../..');
assert.equal(process.argv.length, 2, 'Usage: node scripts/verification/track-idempotency/run.cjs');
assert.ok(fs.existsSync(path.join(worktree, 'src/app.js')), 'Application checkout required');
const source = createRequire(path.resolve(worktree, 'package.json'));
const mongoose = source('mongoose');
const bcrypt = source('bcrypt');
mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
const User = source(path.resolve(worktree, 'src/models/User'));
const Track = source(path.resolve(worktree, 'src/models/Track'));
const TrackLike = source(path.resolve(worktree, 'src/models/TrackLike'));
const Receipt = source(path.resolve(worktree, 'src/models/TrackCreateIdempotency'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stemforge-idempotency-proof-'));
const binaryCache = path.join(os.tmpdir(), 'stemforge-mongodb-binary-cache');
assert.ok(!path.resolve(root).startsWith(worktree + path.sep), 'Evidence must stay outside checkout');
const marker = randomBytes(8).toString('hex');
const dbName = 'sf_idem_' + marker;
const setName = 'sf_idem_rs_' + marker;
const user = 'probe_' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex');
const jwt = randomBytes(32).toString('hex');
const accountPassword = randomBytes(24).toString('hex');
const dataPath = fs.mkdtempSync(path.join(root, 'run-data-'));
const reportPath = path.join(root, 'result-' + marker + '.local.json');
const report = { marker, expectedGroups: 15, verification: 'incomplete',
  packageVersion: require('mongodb-memory-server/package.json').version,
  requestedBinary: '8.0.34', host: '127.0.0.1', checks: [], cleanup: {} };
const children = [];
let repl, uri, config, appA, appB, counter = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; });
async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
const safeError = error => ({ name: error.name, code: error.code || null,
  message: String(error.message).replaceAll(password, '[redacted]').replaceAll(accountPassword, '[redacted]')
    .replaceAll(user, '[redacted]').replaceAll(jwt, '[redacted]').replace(/mongodb:\/\/\S+/g, '[local-uri]') });
const safeEnv = () => Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
  .filter(name => process.env[name]).map(name => [name, process.env[name]]));
function validateUri() {
  assert.equal(uri, config.uri); const u = new URL(uri);
  assert.equal(u.protocol, 'mongodb:');
  assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.port, String(config.mongoPort));
  assert.equal(u.pathname, '/' + dbName); assert.equal(u.searchParams.get('replicaSet'), setName);
  assert.equal(u.username, ''); assert.equal(u.password, '');
}
async function owned() {
  validateUri(); assert.equal(mongoose.connection.name, dbName);
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, setName); assert.equal(hello.hosts.length, 1);
  assert.equal(hello.hosts[0], '127.0.0.1:' + config.mongoPort);
}
async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
function worker(file) {
  const child = fork(path.join(__dirname, file), [], { cwd: worktree, env: safeEnv(), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const state = { child, file, running: true, messages: [], logs: '', errors: '', next: 0, waiters: new Map(), exitCode: null };
  children.push(state);
  // close also fires after a spawn error and waits for captured stdio to drain.
  state.exited = new Promise(resolve => child.once('close', (code, signal) => {
    state.running = false; state.exitCode = code; state.signal = signal;
    for (const waiter of state.waiters.values()) waiter.reject(new Error('Worker exited before reply'));
    state.waiters.clear(); resolve({ code, signal });
  }));
  child.on('error', () => {
    for (const waiter of state.waiters.values()) waiter.reject(new Error('Worker process error'));
    state.waiters.clear();
  });
  child.stdout.on('data', chunk => { state.logs += chunk.toString(); });
  child.stderr.on('data', chunk => { state.errors += chunk.toString(); });
  child.on('message', message => {
    state.messages.push(message);
    const waiter = state.waiters.get(message.id);
    if (waiter) { state.waiters.delete(message.id); waiter.resolve(message); }
  });
  state.command = async (command, data = {}) => {
    assert.ok(state.running && child.connected, 'Worker is not connected');
    const id = ++state.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { state.waiters.delete(id); reject(new Error('Worker command deadline: ' + command)); }, 20000);
      state.waiters.set(id, {
        resolve(message) { clearTimeout(timer); message.error ? reject(new Error('Worker command failed')) : resolve(message.value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      child.send({ id, command, ...data }, error => {
        if (error) { clearTimeout(timer); state.waiters.delete(id); reject(new Error('Worker send failed')); }
      });
    });
  };
  return state;
}
async function waitUntil(predicate, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (interrupted) throw new Error('Probe interrupted');
    if (Date.now() > end) throw new Error(message);
    await delay(50);
  }
}
async function app(name, expectReady = true) {
  validateUri(); const state = worker('app-worker.cjs'); state.port = await freePort();
  state.appName = 'sf-idem-' + name + '-' + marker;
  state.child.send({ command: 'init', config: { ...config, httpPort: state.port, appName: state.appName } });
  await waitUntil(() => state.messages.some(m => ['ready', 'workerError'].includes(m.event)) || !state.running,
    'App startup deadline', 15000);
  assert.ok(!state.messages.some(m => m.event === 'workerError'), 'App worker initialization failed');
  if (expectReady) assert.ok(state.messages.some(m => m.event === 'ready'), 'App did not become ready: ' + state.errors);
  else { const result = await bounded(state.exited, 15000, 'Failed app exit deadline');
    assert.equal(result.code, 1); assert.ok(!state.messages.some(m => m.event === 'ready')); }
  return state;
}
async function cli(mode, expected) {
  validateUri(); const state = worker('cli-worker.cjs'); state.child.send({ ...config, mode });
  const result = await bounded(state.exited, 15000, 'CLI deadline');
  assert.equal(result.code, expected, 'Unexpected CLI status: ' + state.errors);
  const json = state.logs.trim().split('\n').filter(s => s.startsWith('{')).map(s => JSON.parse(s));
  return json.at(-1);
}
async function http(app, route, { method = 'GET', token, body, key } = {}) {
  try {
    const response = await fetch('http://127.0.0.1:' + app.port + route, {
      method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(18000),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json(),
      replayed: response.headers.get('idempotency-replayed'), retryAfter: response.headers.get('retry-after') };
  } catch (error) { return { status: 'network-error', error: error.name }; }
}
const keyHash = key => createHash('sha256').update(key).digest('hex');
function payload(label) {
  return { title: marker + '-' + (++counter) + '-' + label, genre: 'Electronic', bpm: 96, key: 'Am',
    tags: [marker], coverImageUrl: null, description: 'Isolated replica-set verification',
    isPublic: true, isDownloadable: false,
    stems: ['Drums', 'Bass', 'Chords', 'Lead'].map(name => ({ name,
      audioUrl: 'https://example.invalid/' + marker + '/' + name + '.wav', duration: 20, fileSize: 1000 })) };
}
async function counts(owner, key, body) {
  await owned();
  return { tracks: await Track.countDocuments({ artistId: owner, title: body.title, tags: marker }),
    receipts: await Receipt.countDocuments({ ownerId: owner, keyHash: keyHash(key) }) };
}
async function post(app, token, body, key) { return http(app, '/api/tracks', { method: 'POST', token, body, key }); }
async function resolved(app, token, body, key) {
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    result = await post(app, token, body, key);
    if (![409, 503].includes(result.status) || !result.retryAfter) return result;
    await delay(1000);
  }
  return result;
}
async function check(name, operation) {
  try {
    if (interrupted) throw new Error('Probe interrupted');
    const details = await operation(); report.checks.push({ name, status: 'passed', details });
    console.log(JSON.stringify({ name, status: 'passed', details }));
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: safeError(error) }); throw error;
  }
}
async function failpoint(appName, mode, data = {}) {
  await owned();
  return mongoose.connection.db.admin().command({ configureFailPoint: 'failCommand', mode,
    data: { failCommands: ['commitTransaction'], appName, ...data } });
}
async function main() {
  // Discard inherited tool overrides; pin the binary and its official source.
  for (const name of Object.keys(process.env)) if (name.startsWith('MONGOMS_')) delete process.env[name];
  process.env.MONGOMS_DOWNLOAD_MIRROR = 'https://fastdl.mongodb.org';
  repl = new MongoMemoryReplSet({ binary: { version: '8.0.34', downloadDir: binaryCache, checkMD5: true },
    instanceOpts: [{ dbPath: dataPath }], replSet: { name: setName, count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger',
      auth: { enable: true, customRootName: user, customRootPwd: password },
      args: ['--setParameter', 'enableTestCommands=1', '--setParameter', 'ttlMonitorSleepSecs=1'] } });
  await repl.start(); uri = repl.getUri(dbName);
  const u = new URL(uri); u.searchParams.set('authSource', 'admin'); uri = u.toString();
  config = { uri, dbName, setName, mongoPort: Number(u.port), user, password, jwt, worktree };
  validateUri();
  await mongoose.connect(uri, { user, pass: password, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000 });
  await owned();
  const db = mongoose.connection.db;
  const build = await db.admin().command({ buildInfo: 1 }); const status = await db.admin().command({ serverStatus: 1 });
  report.binaryVersion = build.version; report.storageEngine = status.storageEngine.name;
  report.topology = { nodes: 1, setNameVerified: true, bindLoopback: true, mongodbDriver: source('mongodb/package.json').version };
  for (const model of [User, Track, TrackLike]) { await owned(); await model.createCollection(); await model.createIndexes(); }

  await check('CLI dry-run missing -> startup missing-index failure -> apply -> dry-run -> repeat apply', async () => {
    const first = await cli('--dry-run', 2); assert.equal(first.ready, false);
    await app('missing', false);
    const applied = await cli('--apply', 0); assert.equal(applied.ready, true);
    const catalog = await Receipt.collection.listIndexes().toArray();
    assert.equal((await cli('--dry-run', 0)).ready, true);
    assert.deepEqual((await cli('--apply', 0)).createdIndexes, []);
    assert.deepEqual(await Receipt.collection.listIndexes().toArray(), catalog);
    return { dryRunExit: 2, missingStartupExit: 1, applyExit: 0, indexes: catalog.map(i => i.name), rerunAdded: 0 };
  });
  await check('real wrong unique/TTL indexes are refused by CLI and startup, then restored only in test DB', async () => {
    await owned(); await Receipt.collection.dropIndex('unique_owner_track_create_key');
    await Receipt.collection.createIndex({ ownerId: 1, keyHash: 1 }, { name: 'unique_owner_track_create_key' });
    await cli('--dry-run', 1); await app('wrong-unique', false);
    await owned(); await Receipt.collection.dropIndex('unique_owner_track_create_key'); await cli('--apply', 0);
    await Receipt.collection.dropIndex('track_create_key_expiry');
    await Receipt.collection.createIndex({ expiresAt: 1 }, { name: 'track_create_key_expiry', expireAfterSeconds: 86400 });
    await cli('--apply', 1); await app('wrong-ttl', false);
    await owned(); await Receipt.collection.dropIndex('track_create_key_expiry'); await cli('--apply', 0);
    return { wrongUniqueRefused: true, wrongTtlRefused: true, unrelatedIndexesPreserved: true };
  });
  const owners = [];
  for (let n = 0; n < 2; n++) owners.push(await User.create({ username: 'Replica ' + marker + '-' + n,
    email: marker + '-' + n + '@example.invalid', passwordHash: await bcrypt.hash(accountPassword, 12), avatarUrl: null }));
  appA = await app('a'); appB = await app('b');
  const login = await http(appA, '/api/auth/login', { method: 'POST', body: { email: owners[0].email, password: accountPassword } });
  assert.equal(login.status, 200); const token = login.body.data.accessToken;
  const loginB = await http(appB, '/api/auth/login', { method: 'POST', body: { email: owners[1].email, password: accountPassword } });
  assert.equal(loginB.status, 200); const tokenB = loginB.body.data.accessToken;
  await check('12 concurrent HTTP requests across two independent app processes, same owner/key/payload', async () => {
    const body = payload('same'); const key = randomUUID();
    const first = await Promise.all(Array.from({ length: 12 }, (_, n) => post(n % 2 ? appA : appB, token, body, key)));
    const results = await Promise.all(first.map((r, n) => r.status === 201 ? r : resolved(n % 2 ? appA : appB, token, body, key)));
    results.forEach(r => { assert.equal(r.status, 201); assert.deepEqual(r.body, results[0].body); });
    assert.equal(new Set(results[0].body.data.stems.map(s => s.stemId)).size, 4);
    assert.deepEqual(await counts(owners[0]._id, key, body), { tracks: 1, receipts: 1 });
    return { appProcesses: 2, initialStatuses: first.map(r => r.status), trackCount: 1, receiptCount: 1, sameIdsAndJson: true };
  });
  await check('concurrent different payloads conflict; subsequent mismatch stays 409', async () => {
    const one = payload('different-a'); const two = { ...one, title: one.title + '-b' }; const key = randomUUID();
    const results = await Promise.all([resolved(appA, token, one, key), resolved(appB, token, two, key)]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    const loser = results[0].status === 409 ? one : two;
    assert.equal((await post(appA, token, loser, key)).status, 409);
    assert.equal(await Track.countDocuments({ artistId: owners[0]._id, title: { $in: [one.title, two.title] } }), 1);
    assert.equal(await Receipt.countDocuments({ ownerId: owners[0]._id, keyHash: keyHash(key) }), 1);
    return { statuses: results.map(r => r.status), trackCount: 1, receiptCount: 1 };
  });
  await check('same key in two authenticated accounts creates two independent operations', async () => {
    const body = payload('accounts'); const key = randomUUID();
    const results = await Promise.all([post(appA, token, body, key), post(appB, tokenB, body, key)]);
    results.forEach(r => assert.equal(r.status, 201)); assert.notEqual(results[0].body.data._id, results[1].body.data._id);
    assert.equal(await Receipt.countDocuments({ keyHash: keyHash(key) }), 2);
    return { distinctTracks: 2, receipts: 2 };
  });
  for (const fault of ['beforeEnrich', 'afterEnrich', 'afterReceipt']) await check('real transaction rollback: ' + fault, async () => {
    const body = payload(fault); const key = randomUUID(); await appA.command('arm', { fault: { [fault]: true } });
    assert.equal((await post(appA, token, body, key)).status, 500);
    assert.deepEqual(await counts(owners[0]._id, key, body), { tracks: 0, receipts: 0 });
    assert.equal((await post(appB, token, body, key)).status, 201);
    assert.deepEqual(await counts(owners[0]._id, key, body), { tracks: 1, receipts: 1 });
    return { afterRollback: [0, 0], afterSameKeyRetry: [1, 1] };
  });
  await check('lose HTTP response after real commit; retry on the other process replays without duplicate', async () => {
    const body = payload('lost-http'); const key = randomUUID(); await appA.command('arm', { fault: { dropResponse: true } });
    assert.equal((await post(appA, token, body, key)).status, 'network-error');
    const row = await Receipt.findOne({ ownerId: owners[0]._id, keyHash: keyHash(key) }).lean();
    assert.ok(row);
    const retry = await post(appB, token, body, key); assert.equal(retry.status, 201); assert.equal(retry.replayed, 'true');
    assert.deepEqual(retry.body, row.responseBody);
    assert.deepEqual(await counts(owners[0]._id, key, body), { tracks: 1, receipts: 1 });
    return { retryReplayed: true, trackCount: 1, receiptCount: 1 };
  });
  await check('mongod failCommand UnknownTransactionCommitResult causes real commit retry, not callback duplication', async () => {
    const body = payload('server-unknown'); const key = randomUUID(); const before = await appA.command('trace');
    await failpoint(appA.appName, { times: 1 }, { errorCode: 1, errorLabels: ['UnknownTransactionCommitResult'] });
    try {
      const response = await post(appA, token, body, key); report.commitDiagnostic = { status: response.status, trace: await appA.command('trace') }; assert.equal(response.status, 201);
      const after = await appA.command('trace');
      assert.ok(after.commitsStarted - before.commitsStarted >= 2);
      assert.equal(after.trackInserts - before.trackInserts, 1);
      assert.ok(after.failures.slice(before.failures.length).some(f => f.command === 'commitTransaction' && f.labels.includes('UnknownTransactionCommitResult')));
      assert.deepEqual(await counts(owners[0]._id, key, body), { tracks: 1, receipts: 1 });
      return { commits: after.commitsStarted - before.commitsStarted, trackInserts: 1, serverErrorCode: 1, source: 'mongod failCommand', failover: false };
    } finally { await failpoint(appA.appName, 'off'); }
  });
  await check('suppress ACK after actual commit in test worker; driver retries commit with one Track insertion', async () => {
    const body = payload('ack-loss'); const key = randomUUID(); const before = await appA.command('trace');
    await appA.command('arm', { fault: { ackLoss: true } });
    assert.equal((await post(appA, token, body, key)).status, 201);
    const after = await appA.command('trace');
    assert.equal(after.ackSuppressed - before.ackSuppressed, 1);
    assert.ok(after.commitsSucceeded - before.commitsSucceeded >= 2);
    assert.equal(after.trackInserts - before.trackInserts, 1);
    assert.deepEqual(await counts(owners[0]._id, key, body), { tracks: 1, receipts: 1 });
    return { realSuccessfulCommits: after.commitsSucceeded - before.commitsSucceeded, trackInserts: 1, source: 'test-only post-commit wrapper', failover: false };
  });
  await check('unresolved server commit faults exhaust budget with 503; same-key retry after fault clears creates once', async () => {
    const body = payload('deadline'); const key = randomUUID();
    await failpoint(appA.appName, 'alwaysOn', { errorCode: 1, errorLabels: ['UnknownTransactionCommitResult'], blockConnection: true, blockTimeMS: 1200 });
    let response;
    try { response = await post(appA, token, body, key); } finally { await failpoint(appA.appName, 'off'); }
    assert.equal(response.status, 503); assert.equal(response.retryAfter, '1');
    assert.deepEqual(await counts(owners[0]._id, key, body), { tracks: 0, receipts: 0 });
    // Clearing a failpoint does not resolve a still-open server transaction.
    // A bounded application retry may be busy until the real mongod reaper aborts it.
    const statuses = []; const started = Date.now(); let retry;
    await waitUntil(async () => {
      retry = await post(appB, token, body, key); statuses.push(retry.status);
      if (retry.status === 201) return true;
      assert.ok([409, 503].includes(retry.status)); assert.equal(retry.retryAfter, '1');
      await delay(1000); return false;
    }, 'Same-key retry remained unresolved after server transaction expiration', 100000);
    assert.deepEqual(await counts(owners[0]._id, key, body), { tracks: 1, receipts: 1 });
    return { status: 503, retryStatuses: statuses, retryElapsedMs: Date.now() - started,
      sameKeyRetry: 201, trackCount: 1, receiptCount: 1,
      note: 'No inference of rollback from 503 or absent receipt; wait for server resolution' };
  });
  await check('expired retained receipt: two processes compete for one new generation without duplicate Track', async () => {
    await owned(); await db.admin().command({ setParameter: 1, ttlMonitorEnabled: false });
    const body = payload('expiry'); const key = randomUUID();
    const first = await post(appA, token, body, key); assert.equal(first.status, 201);
    await Receipt.collection.updateOne({ ownerId: owners[0]._id, keyHash: keyHash(key) },
      { $set: { completedAt: new Date(Date.now() - 26 * 3600000), expiresAt: new Date(Date.now() - 3600000) } });
    const results = await Promise.all([resolved(appA, token, body, key), resolved(appB, token, body, key)]);
    results.forEach(r => assert.equal(r.status, 201)); assert.deepEqual(results[0].body, results[1].body);
    assert.notEqual(results[0].body.data._id, first.body.data._id);
    assert.deepEqual(await counts(owners[0]._id, key, body), { tracks: 2, receipts: 1 });
    return { generations: 2, retainedReceipts: 1, newGenerationTracks: 1 };
  });
  await check('actual TTL monitor deletes expired receipt while a transaction is paused; driver retries safely', async () => {
    const body = payload('ttl-race'); const key = randomUUID();
    assert.equal((await post(appA, token, body, key)).status, 201);
    await Receipt.collection.updateOne({ ownerId: owners[0]._id, keyHash: keyHash(key) },
      { $set: { completedAt: new Date(Date.now() - 26 * 3600000), expiresAt: new Date(Date.now() - 3600000) } });
    const before = await appA.command('trace');
    const barriersBefore = appA.messages.filter(m => m.event === 'barrier').length;
    await appA.command('arm', { fault: { barrier: true } });
    const request = post(appA, token, body, key);
    await waitUntil(() => appA.messages.filter(m => m.event === 'barrier').length > barriersBefore, 'TTL barrier deadline');
    try {
      await owned(); await db.admin().command({ setParameter: 1, ttlMonitorEnabled: true });
      await waitUntil(async () => await Receipt.countDocuments({ ownerId: owners[0]._id, keyHash: keyHash(key) }) === 0, 'TTL did not delete receipt', 6000);
    } finally { await appA.command('release'); }
    const response = await request; assert.equal(response.status, 201);
    assert.deepEqual(await counts(owners[0]._id, key, body), { tracks: 2, receipts: 1 });
    const after = await appA.command('trace');
    assert.ok(after.trackInserts - before.trackInserts >= 2);
    return { actualTtlDeletionObserved: true, insertAttempts: after.trackInserts - before.trackInserts,
      failures: after.failures.slice(before.failures.length), newGenerationTracks: 1 };
  });
  await check('actual PATCH/DELETE followed by original 201 replay; no recreation', async () => {
    const body = payload('mutations'); const key = randomUUID(); const first = await post(appA, token, body, key);
    const route = '/api/tracks/' + first.body.data._id;
    assert.equal((await http(appB, route, { method: 'PATCH', token, body: { title: 'Changed ' + marker, isPublic: false } })).status, 200);
    assert.deepEqual((await post(appA, token, body, key)).body, first.body);
    assert.equal((await http(appB, route, { method: 'DELETE', token })).status, 204);
    assert.equal((await http(appA, route, { token })).status, 404);
    assert.deepEqual((await post(appB, token, body, key)).body, first.body);
    assert.equal(await Track.countDocuments({ _id: first.body.data._id }), 0);
    assert.equal(await Receipt.countDocuments({ ownerId: owners[0]._id, keyHash: keyHash(key) }), 1);
    return { originalReceiptPreserved: true, deletedTrackCount: 0 };
  });
}

async function cleanup() {
  const attempt = async (name, operation) => {
    try { await operation(); } catch (error) {
      (report.cleanup.errors ??= []).push({ name, error: safeError(error) }); process.exitCode = 1;
    }
  };
  // Cleanup stages are independent: a failed DB operation cannot skip child stop.
  await attempt('restore test server parameters', async () => {
    if (mongoose.connection.readyState !== 1 || !config) return;
    await owned();
    await mongoose.connection.db.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    await mongoose.connection.db.admin().command({ setParameter: 1, ttlMonitorEnabled: true });
  });
  for (const child of children) await attempt('stop child', async () => {
    if (!child.running) return;
    if (child.file === 'app-worker.cjs' && child.messages.some(m => m.event === 'ready')) {
      try {
        await child.command('release');
        const closed = await child.command('shutdown');
        assert.equal(closed.closed, true); assert.equal(closed.sessionsStarted, closed.sessionsEnded);
        (report.cleanup.appSessions ??= []).push(closed);
      } catch (error) {
        (report.cleanup.errors ??= []).push({ name: 'graceful app shutdown', error: safeError(error) });
        process.exitCode = 1;
      }
    }
    if (child.running) {
      try { await bounded(child.exited, 3000, 'Child exit deadline'); } catch {
        child.child.kill(); await bounded(child.exited, 5000, 'Child kill deadline');
      }
    }
  });
  report.cleanup.childrenExited = children.every(c => !c.running);
  await attempt('drop owned temporary database', async () => {
    if (mongoose.connection.readyState !== 1 || !config) return;
    await owned(); await mongoose.connection.db.dropDatabase(); report.cleanup.databaseDropped = true;
  });
  await attempt('disconnect parent', async () => {
    await mongoose.disconnect(); report.cleanup.connectionClosed = mongoose.connection.readyState === 0;
  });
  await attempt('stop replica set', async () => {
    if (repl) await repl.stop({ doCleanup: true, force: true });
    report.cleanup.replStopped = !repl || repl.state === 'stopped';
  });
  // Never remove a live mongod data directory if stopping the set failed.
  await attempt('remove owned data directory', async () => {
    assert.equal(report.cleanup.replStopped, true);
    assert.ok(path.resolve(dataPath).startsWith(path.resolve(root) + path.sep));
    if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { recursive: true, force: true });
    report.cleanup.dataDirectoryRemoved = !fs.existsSync(dataPath);
  });
  report.cleanup.status = !report.cleanup.errors && report.cleanup.childrenExited &&
    report.cleanup.connectionClosed && report.cleanup.replStopped && report.cleanup.dataDirectoryRemoved ? 'passed' : 'failed';
  report.verification = !report.error && !interrupted && report.checks.length === report.expectedGroups &&
    report.checks.every(c => c.status === 'passed') ? 'passed' : 'incomplete-or-failed';
  if (report.verification !== 'passed' || report.cleanup.status !== 'passed') process.exitCode = 1;
  report.multiNodeFailover = 'not exercised: single-node replica set';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: reportPath, verification: report.verification,
    checks: report.checks.length, cleanup: report.cleanup }));
}

main().catch(error => {
  report.error = safeError(error); process.exitCode = 1;
  console.error(JSON.stringify({ fatal: report.error }));
}).finally(cleanup);
