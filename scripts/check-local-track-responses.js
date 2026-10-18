// Real MongoDB / local HTTP regression check. Never imported by the application.
// Default: read-only preflight. --run: create/check/clean fixtures.
// Recovery: --cleanup docs/verification/<this-run-manifest>.json
require('dotenv').config({ quiet: true });
const dns = require('node:dns');
const http = require('node:http');
const { once } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const {
  MAIN, EXPECTED_CHECKS, VerificationError, must,
  prepareRecoveryReport, finishReport, validateFixtureManifest, removeOrphanLikes,
} = require('./lib/local-track-response-recovery');

if (process.env.DNS_SERVERS) {
  dns.setServers(process.env.DNS_SERVERS.split(',').map(s => s.trim()).filter(Boolean));
}
// This runner owns its loopback listener; no reverse proxy is involved.
process.env.TRUST_PROXY_HOPS = '0';
process.env.PROXY_DEBUG = 'false';

const DIRECTORY = path.resolve(__dirname, '../docs/verification');
const mode = process.argv[2];
const cleanupOnly = mode === '--cleanup';
const oid = id => new mongoose.Types.ObjectId(id);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tokens = new Map();
let db;
let server;
let base;
let report;
let manifest;

function safeError(error) {
  return error instanceof VerificationError ? error.message : `${error.name || 'Error'} (details suppressed)`;
}
function save() {
  if (manifest) fs.writeFileSync(manifest, JSON.stringify(report, null, 2) + '\n');
}
async function check(name, operation) {
  must(EXPECTED_CHECKS.includes(name) && !report.checks.some(check => check.name === name), 'Unexpected or duplicate verification group');
  try {
    const details = await operation();
    report.checks.push({ name, status: 'passed', ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: safeError(error) });
    console.log(`FAIL ${name}: ${safeError(error)}`);
  }
  save();
}
function expectStatus(response, expected) {
  must(response.status === expected, `Expected HTTP ${expected}, received ${response.status}`);
  if (expected >= 400) must(typeof response.json?.message === 'string', 'Expected JSON error message');
}
async function request(method, route, user, body, authorization) {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokens.get(user.id)}`;
  if (authorization) headers.Authorization = authorization;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(route, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* Callers verify shape. */ }
  return { status: response.status, json, empty: text.length === 0, headers: response.headers };
}

async function snapshot(excluded = {}) {
  const result = {};
  for (const name of ['users', 'tracks', 'tracklikes']) {
    const digest = crypto.createHash('sha256');
    let count = 0;
    const ids = excluded[name] || [];
    const cursor = db.collection(name).find(ids.length ? { _id: { $nin: ids.map(oid) } } : {}).sort({ _id: 1 });
    try {
      for await (const doc of cursor) {
        digest.update(JSON.stringify(doc) + '\n');
        count++;
      }
    } finally { await cursor.close(); }
    result[name] = { count, digest: digest.digest('hex') };
  }
  const main = await db.collection('users').findOne({ _id: oid(MAIN) });
  must(main, 'Protected main account is missing');
  result.mainAccountDigest = hash(main);
  return result;
}
function fixtureSelector(track) {
  return { _id: oid(track.id), artistId: oid(track.ownerId), tags: report.marker, description: report.marker };
}
function input(track, isPublic = true) {
  return {
    title: track.title, genre: 'Verification', bpm: 120, key: 'Am',
    tags: [report.marker], description: report.marker, isPublic, isDownloadable: false,
    stems: [{ name: 'Drums', audioUrl: `https://example.invalid/${report.marker}/drums.mp3`, duration: 1.25, fileSize: 1000 }],
  };
}
function plannedTrack(ownerId, name) {
  const track = { ownerId, title: `${report.marker}-${name}` };
  report.tracks.push(track);
  save();
  return track;
}
function verifyArtist(data, owner) {
  must(data && typeof data === 'object', 'Missing Track response');
  must(data.artistId === owner.id, 'Track owner ID changed');
  if (owner.missing) must(data.artist === null, 'Missing User did not produce artist=null');
  else {
    must(data.artist && Object.keys(data.artist).sort().join(',') === '_id,avatarUrl,username', 'Artist fields expose unexpected User data');
    must(data.artist._id === owner.id && data.artist.username === owner.username && data.artist.avatarUrl === owner.avatarUrl, 'Public artist information differs from fixture');
  }
  must(typeof data.likedByMe === 'boolean', 'Missing boolean likedByMe');
}
async function createTrack(owner, name, isPublic) {
  const track = plannedTrack(owner.id, name);
  const response = await request('POST', '/api/tracks', owner, input(track, isPublic));
  if (mongoose.isObjectIdOrHexString(response.json?.data?._id)) track.id = response.json.data._id;
  save();
  expectStatus(response, 201);
  must(track.id, 'POST Track did not return an ID');
  verifyArtist(response.json.data, owner);
  must(response.json.data.likedByMe === false, 'New Track is already liked');
  must(await db.collection('tracks').countDocuments(fixtureSelector(track)) === 1, 'Created Track not found in configured DB');
  return track;
}
async function detail(track, user, expectedLike, expectedCount) {
  const response = await request('GET', `/api/tracks/${track.id}`, user);
  expectStatus(response, 200);
  const owner = report.users.find(u => u.id === track.ownerId) || { id: track.ownerId, missing: true };
  verifyArtist(response.json.data, owner);
  must(response.json.data._id === track.id, 'Detail Track ID changed');
  must(response.json.data.likedByMe === expectedLike, 'Detail membership differs from the current account');
  must(response.json.data.likesCount === expectedCount, 'Detail global Like counter is incorrect');
  must(response.headers.get('cache-control') === 'no-store', 'Missing no-store policy');
  return response.json.data;
}
async function listing(user) {
  const records = [];
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    must(page <= 1000, 'Too many pages for a bounded verification run');
    const response = await request('GET', `/api/tracks?page=${page}&limit=100`, user);
    expectStatus(response, 200);
    must(Array.isArray(response.json?.data), 'Missing list data array');
    pages = response.json.pagination.totalPages;
    must(Number.isSafeInteger(pages) && pages >= 0, 'Invalid pagination');
    for (const track of response.json.data) {
      must(track.isPublic === true, 'Private Track leaked into public listing');
      must(typeof track.likedByMe === 'boolean', 'List membership missing');
      must(track.artist === null || Object.keys(track.artist).sort().join(',') === '_id,avatarUrl,username', 'List artist exposes extra fields');
      if (!user) must(track.likedByMe === false, 'Guest list contains personalized Like');
    }
    records.push(...response.json.data);
  }
  return records;
}
async function verifyState(track, a, b, aLiked, bLiked, count) {
  for (const [user, liked] of [[undefined, false], [a, aLiked], [b, bLiked]]) {
    await detail(track, user, liked, count);
    const records = await listing(user);
    const found = records.find(item => item._id === track.id);
    must(found, 'Public fixture missing from list');
    verifyArtist(found, a);
    must(found.likedByMe === liked && found.likesCount === count, 'List Like state/counter mismatch');
  }
  const persisted = await db.collection('tracks').findOne(fixtureSelector(track));
  must(persisted?.likesCount === count, 'Persisted counter mismatch');
  must(await db.collection('tracklikes').countDocuments({ trackId: oid(track.id) }) === count, 'Persisted membership count mismatch');
}
async function like(method, track, user, expectedLike, expectedCount) {
  const response = await request(method, `/api/tracks/${track.id}/like`, user);
  expectStatus(response, 200);
  const state = response.json?.data;
  must(state && Object.keys(state).sort().join(',') === 'isLiked,likesCount,trackId', 'Dedicated Like response shape changed');
  must(state.trackId === track.id && state.isLiked === expectedLike && state.likesCount === expectedCount, 'Dedicated Like state mismatch');
}
async function captureListQueries(user) {
  const counts = { authors: 0, memberships: 0 };
  const client = mongoose.connection.getClient();
  const observe = event => {
    if (event.commandName !== 'find') return;
    if (event.command.find === 'users' && event.command.filter?._id?.$in) counts.authors++;
    if (event.command.find === 'tracklikes' && event.command.filter?.trackId?.$in) counts.memberships++;
  };
  client.on('commandStarted', observe);
  try { expectStatus(await request('GET', '/api/tracks?limit=100', user), 200); }
  finally { client.off('commandStarted', observe); }
  must(counts.authors === 1 && counts.memberships === (user ? 1 : 0), 'HTTP list enrichment was not batched as expected');
  return counts;
}

async function cleanup() {
  validateFixtureManifest(report);
  // Recover uncertain HTTP outcomes by exact predetermined account and Track names.
  for (const user of report.users) {
    if (user.id) {
      const existing = await db.collection('users').findOne({ _id: oid(user.id) });
      must(!existing || (existing.username === user.username && existing.email === user.email), 'Fixture ID belongs to a foreign User');
    }
    const found = await db.collection('users').findOne({ username: user.username, email: user.email });
    if (found) {
      must(String(found._id) !== MAIN && (!user.id || user.id === String(found._id)), 'Unsafe fixture account identity');
      user.id = String(found._id);
    }
  }
  validateFixtureManifest(report);
  must(await db.collection('users').countDocuments({ _id: oid(report.orphanOwnerId) }) === 0, 'Orphan owner now belongs to a User; refusing cleanup');
  const userIds = report.users.filter(user => user.id).map(user => user.id);
  for (const track of report.tracks) {
    if (!track.ownerId) continue;
    if (!track.id) {
      const found = await db.collection('tracks').findOne({ artistId: oid(track.ownerId), title: track.title, tags: report.marker, description: report.marker });
      if (!found) continue;
      track.id = String(found._id);
      save();
    }
    const found = await db.collection('tracks').findOne({ _id: oid(track.id) });
    if (!found) {
      await removeOrphanLikes({ db, connection: mongoose.connection, track, userIds });
      must(await db.collection('tracklikes').countDocuments({ trackId: oid(track.id) }) === 0, 'Orphan Like cleanup is incomplete');
      continue;
    }
    must(String(found.artistId) === track.ownerId && found.tags?.includes(report.marker) && found.description === report.marker, 'Refusing cleanup of an unmarked or foreign Track');
    must(track.ownerId !== MAIN, 'Refusing cleanup of main account data');
    const owner = report.users.find(user => user.id === track.ownerId);
    if (owner && tokens.has(owner.id)) {
      const response = await request('DELETE', `/api/tracks/${track.id}`, owner);
      expectStatus(response, 204);
      must(response.empty, 'DELETE Track returned a body');
    } else {
      await mongoose.connection.transaction(async session => {
        const deletion = await db.collection('tracks').deleteOne(fixtureSelector(track), { session });
        must(deletion.deletedCount === 1, 'Exact fixture deletion did not match');
        await db.collection('tracklikes').deleteMany({ trackId: oid(track.id) }, { session });
      });
    }
    must(await db.collection('tracklikes').countDocuments({ trackId: oid(track.id) }) === 0, 'Track cleanup left orphan Likes');
  }
  for (const user of report.users.filter(user => user.id)) {
    must(user.id !== MAIN, 'Refusing main account deletion');
    must(await db.collection('tracks').countDocuments({ artistId: oid(user.id) }) === 0, 'Fixture account still owns Tracks');
    must(await db.collection('tracklikes').countDocuments({ userId: oid(user.id) }) === 0, 'Fixture account still has Likes');
    await db.collection('users').deleteOne({ _id: oid(user.id), username: user.username, email: user.email });
  }
  const ids = report.tracks.filter(track => track.id).map(track => oid(track.id));
  const users = report.users.filter(user => user.id).map(user => oid(user.id));
  const remaining = {
    users: await db.collection('users').countDocuments({ $or: [{ _id: { $in: users } }, { email: { $in: report.users.map(user => user.email) } }] }),
    tracks: await db.collection('tracks').countDocuments({ $or: [{ _id: { $in: ids } }, { artistId: { $in: [...users, oid(report.orphanOwnerId)] }, tags: report.marker }] }),
    likes: await db.collection('tracklikes').countDocuments({ $or: [{ trackId: { $in: ids } }, { userId: { $in: users } }] }),
  };
  must(Object.values(remaining).every(count => count === 0), 'Temporary records remain after cleanup');
  report.cleanup = { status: 'passed', remaining };
  save();
  console.log('PASS cleanup: zero fixture users, Tracks, or Likes remain');
}
async function preflight() {
  for (const name of ['MONGO_URI', 'MONGO_USERNAME', 'MONGO_PASSWORD', 'JWT_SECRET']) {
    must(process.env[name], `Missing ${name}; configure it privately in the terminal`);
  }
  await mongoose.connect(process.env.MONGO_URI, {
    user: process.env.MONGO_USERNAME, pass: process.env.MONGO_PASSWORD,
    autoCreate: false, autoIndex: false, monitorCommands: true, serverSelectionTimeoutMS: 15000,
  });
  db = mongoose.connection.db;
  const indexes = await db.collection('tracklikes').indexes();
  must(indexes.some(index => index.unique && index.key.trackId === 1 && index.key.userId === 1), 'Unique Like index is absent');
  const baseline = await snapshot();
  console.log('PASS preflight: Atlas reachable, main account present, unique Like index present');
  return baseline;
}
async function run() {
  must(!mode || ['--run', '--cleanup'].includes(mode), 'Use no arguments, --run, or --cleanup <manifest>');
  const baseline = await preflight();
  if (!mode) return;
  if (cleanupOnly) {
    const recoveryManifest = path.resolve(process.argv[3] || '');
    must(path.dirname(recoveryManifest) === DIRECTORY, 'Recovery manifest must be in docs/verification');
    const candidate = JSON.parse(fs.readFileSync(recoveryManifest, 'utf8'));
    validateFixtureManifest(candidate);
    prepareRecoveryReport(candidate);
    report = candidate;
    manifest = recoveryManifest;
  } else {
    const marker = `sf-context-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
    report = {
      kind: 'local-track-response', marker, startedAt: new Date().toISOString(),
      baseline, users: [], tracks: [], checks: [], orphanOwnerId: new mongoose.Types.ObjectId().toString(), renderTested: false,
      status: 'incomplete', verification: { status: 'incomplete', expectedGroups: EXPECTED_CHECKS.length, completedGroups: 0 },
    };
    for (let index = 0; index < 2; index++) report.users.push({
      username: `${marker}-${index}`, email: `${marker}-${index}@example.invalid`,
      avatarUrl: index ? null : `https://example.invalid/${marker}/avatar.png`,
    });
    fs.mkdirSync(DIRECTORY, { recursive: true });
    manifest = path.join(DIRECTORY, `${marker}.json`);
    save();
  }
  console.log(`Manifest: ${path.relative(process.cwd(), manifest)}`);
  try {
    if (cleanupOnly) return;
    const app = require('../src/app');
    server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    report.httpOrigin = base;
    expectStatus(await request('GET', '/api/health'), 200);
    for (const user of report.users) {
      const password = crypto.randomBytes(24).toString('base64url');
      const registered = await request('POST', '/api/auth/register', undefined, { username: user.username, email: user.email, password });
      if (mongoose.isObjectIdOrHexString(registered.json?.data?.user?._id)) user.id = registered.json.data.user._id;
      save();
      expectStatus(registered, 201);
      must(user.id && user.id !== MAIN, 'Invalid disposable account ID');
      tokens.set(user.id, registered.json.data.accessToken);
      const me = await request('GET', '/api/auth/me', user);
      expectStatus(me, 200);
      must(me.json?.data?.user?._id === user.id, 'Token identity mismatch');
      const updated = await db.collection('users').updateOne({ _id: oid(user.id), email: user.email, username: user.username }, { $set: { avatarUrl: user.avatarUrl } });
      must(updated.matchedCount === 1, 'API and DB fixture identities differ');
    }
    const [a, b] = report.users;
    const publicA = await createTrack(a, 'public-a', true);
    const privateA = await createTrack(a, 'private-a', false);
    const publicB = await createTrack(b, 'public-b', true);
    await check('POST returns exact public artist fields and likedByMe=false for both authors', async () => {
      await detail(publicA, a, false, 0);
      await detail(publicB, b, false, 0);
      return { accounts: 2, avatarCases: ['HTTPS string', 'null'] };
    });
    await check('Guest list/detail expose only public author fields and likedByMe=false', async () => {
      const records = await listing();
      for (const [track, owner] of [[publicA, a], [publicB, b]]) {
        await detail(track, undefined, false, 0);
        const found = records.find(item => item._id === track.id);
        must(found, 'Guest public fixture is missing');
        verifyArtist(found, owner);
      }
    });
    await check('Like/Unlike responses and list/detail follow each account membership, not global count', async () => {
      await verifyState(publicA, a, b, false, false, 0);
      await like('PUT', publicA, b, true, 1);
      await verifyState(publicA, a, b, false, true, 1);
      await like('PUT', publicA, a, true, 2);
      await verifyState(publicA, a, b, true, true, 2);
      const patched = await request('PATCH', `/api/tracks/${publicA.id}`, a, { genre: 'Jazz', isDownloadable: true });
      expectStatus(patched, 200);
      verifyArtist(patched.json.data, a);
      must(patched.json.data.likedByMe === true && patched.json.data.genre === 'Jazz', 'PATCH lost liked membership or metadata');
      await like('DELETE', publicA, b, false, 1);
      await verifyState(publicA, a, b, true, false, 1);
      await like('DELETE', publicA, a, false, 0);
      await verifyState(publicA, a, b, false, false, 0);
    });
    await check('Public listing stays public-only; private detail is owner-only', async () => {
      for (const user of [undefined, a, b]) {
        must(!(await listing(user)).some(track => track._id === privateA.id), 'Private fixture appeared in public list');
      }
      expectStatus(await request('GET', `/api/tracks/${privateA.id}`), 404);
      expectStatus(await request('GET', `/api/tracks/${privateA.id}`, b), 404);
      await detail(privateA, a, false, 0);
      await like('PUT', privateA, a, true, 1);
      await detail(privateA, a, true, 1);
      expectStatus(await request('PATCH', `/api/tracks/${privateA.id}`, b, { title: 'Forbidden' }), 404);
    });
    await check('Invalid token and malformed authorization return 401 on public list', async () => {
      for (const authorization of ['Bearer invalid-token', 'Basic invalid']) {
        expectStatus(await request('GET', '/api/tracks', undefined, undefined, authorization), 401);
      }
    });
    await check('PATCH returns enriched artist and likedByMe=false after Unlike', async () => {
      const response = await request('PATCH', `/api/tracks/${publicA.id}`, a, { genre: 'Electronic' });
      expectStatus(response, 200);
      verifyArtist(response.json.data, a);
      must(response.json.data.likedByMe === false, 'PATCH retained Like after Unlike');
    });
    await check('POST/PATCH reject response-only fields and do not change existing fixture data', async () => {
      const before = hash(await db.collection('tracks').findOne(fixtureSelector(publicA)));
      for (const [field, value] of [['artist', { _id: b.id, username: 'Spoofed', avatarUrl: null }], ['likedByMe', true]]) {
        const rejected = plannedTrack(a.id, `rejected-${field}`);
        const response = await request('POST', '/api/tracks', a, { ...input(rejected), [field]: value });
        if (mongoose.isObjectIdOrHexString(response.json?.data?._id)) rejected.id = response.json.data._id;
        save();
        expectStatus(response, 400);
        expectStatus(await request('PATCH', `/api/tracks/${publicA.id}`, a, { [field]: value }), 400);
        must(await db.collection('tracks').countDocuments({ artistId: oid(a.id), title: rejected.title }) === 0, 'Rejected POST created a Track');
      }
      must(hash(await db.collection('tracks').findOne(fixtureSelector(publicA))) === before, 'Rejected PATCH changed stored Track');
    });
    await check('Missing author returns null on list/detail and preserves Track/artistId', async () => {
      must(await db.collection('users').countDocuments({ _id: oid(report.orphanOwnerId) }) === 0, 'Orphan owner unexpectedly exists');
      const track = plannedTrack(report.orphanOwnerId, 'orphan');
      track.id = new mongoose.Types.ObjectId().toString();
      save();
      const Track = require('../src/models/Track');
      await Track.create({ ...input(track), _id: oid(track.id), artistId: oid(track.ownerId) });
      await detail(track, undefined, false, 0);
      await like('PUT', track, b, true, 1);
      await detail(track, b, true, 1);
      const found = (await listing(b)).find(item => item._id === track.id);
      must(found, 'Missing-author Track disappeared from listing');
      verifyArtist(found, { id: track.ownerId, missing: true });
      must(found.likedByMe === true, 'Missing author suppressed valid membership');
    });
    await check('Real HTTP list performs batched author and membership queries', async () => ({
      guest: await captureListQueries(), authenticated: await captureListQueries(a),
    }));
    await check('Computed response fields are absent from every stored fixture Track', async () => {
      for (const track of report.tracks.filter(track => track.id)) {
        const doc = await db.collection('tracks').findOne(fixtureSelector(track));
        must(doc, 'Fixture Track missing from database');
        must(!Object.hasOwn(doc, 'artist') && !Object.hasOwn(doc, 'likedByMe'), 'Computed response fields were persisted');
      }
    });
  } catch (error) {
    report.fatal = safeError(error);
    console.log(`FAIL setup/run: ${report.fatal}`);
  } finally {
    try { await cleanup(); }
    catch (error) { report.cleanup = { status: 'failed', error: safeError(error) }; console.log(`FAIL cleanup: ${safeError(error)}`); }
    try {
      const after = await snapshot();
      must(JSON.stringify(after) === JSON.stringify(report.baseline), 'Preexisting data or protected main account changed');
      report.preservation = { status: 'passed', mainAccountPresent: true, allPreexistingCollectionsMatch: true };
      console.log('PASS main account and all preexisting users, Tracks, and Likes unchanged');
    } catch (error) { report.preservation = { status: 'failed', error: safeError(error) }; }
    const succeeded = finishReport(report, { cleanupOnly });
    save();
    if (cleanupOnly) console.log(`Recovery cleanup ${succeeded ? 'passed' : 'failed'}; verification remains ${report.verification.status}`);
    if (!succeeded) process.exitCode = 1;
  }
}
run().catch(error => { console.log(`BLOCKED ${safeError(error)}`); process.exitCode = 1; })
  .finally(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await mongoose.disconnect();
    if (report) { report.dbDisconnected = mongoose.connection.readyState === 0; save(); }
  });
