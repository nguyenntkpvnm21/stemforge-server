const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

// Isolated worker: no .env, external service or real database is loaded.
process.env.JWT_SECRET = 'collection-tests-only-signing-key-32-bytes';
const { createAccessToken } = require('../src/config/jwt');
const routes = require('../src/routes/track.routes');
const errorHandler = require('../src/middlewares/error.middleware');
const Track = require('../src/models/Track');
const TrackLike = require('../src/models/TrackLike');
const User = require('../src/models/User');
const likeService = require('../src/services/track-like.service');
const sample = require('./fixtures/track-contract-draft.json');

const id = n => n.toString(16).padStart(24, '0');
const A = id(11), B = id(12), C = id(13), MISSING = id(14);
const PUBLIC = id(21), OWN_PRIVATE = id(22), FOREIGN_PRIVATE = id(23), OTHER = id(24), GHOST_AUTHOR = id(25), ORPHAN = id(26);
const oid = value => new mongoose.Types.ObjectId(value);

async function fixture(t, options = {}) {
  const users = [A, B, C].map((_id, i) => ({ _id, username: 'Account ' + i, avatarUrl: null,
    email: 'private@example.invalid', passwordHash: 'fixture-only-hash', role: 'admin' }));
  const tracks = new Map([
    [PUBLIC, new Track({ ...sample, _id: PUBLIC, artistId: B, title: 'Visible public', createdAt: '2020-01-01' })],
    [OWN_PRIVATE, new Track({ ...sample, _id: OWN_PRIVATE, artistId: A, title: 'Own private', isPublic: false })],
    [FOREIGN_PRIVATE, new Track({ ...sample, _id: FOREIGN_PRIVATE, artistId: B, title: 'Hidden title', isPublic: false })],
    [OTHER, new Track({ ...sample, _id: OTHER, artistId: B, title: 'Other account only' })],
    [GHOST_AUTHOR, new Track({ ...sample, _id: GHOST_AUTHOR, artistId: MISSING, title: 'Missing author' })],
  ]);
  let sequence = 200;
  const record = (userId, trackId, n, date) => ({ _id: oid(id(n)), userId: oid(userId), trackId: oid(trackId), createdAt: new Date(date) });
  const likes = [
    record(A, PUBLIC, 101, '2026-01-01'), record(A, OWN_PRIVATE, 102, '2026-01-01'),
    record(A, FOREIGN_PRIVATE, 103, '2026-01-03'), record(A, GHOST_AUTHOR, 104, '2026-01-02'),
    record(A, ORPHAN, 105, '2026-01-04'), record(B, PUBLIC, 106, '2026-01-01'),
    record(B, OTHER, 107, '2026-01-02'), record(B, FOREIGN_PRIVATE, 108, '2026-01-03'),
  ];
  const calls = { aggregates: [], authors: [], memberships: [], auth: [] };
  t.mock.method(User, 'findById', async userId => {
    calls.auth.push(String(userId));
    if (options.authError) throw new Error('Private authentication diagnostic');
    return users.find(u => u._id === String(userId)) ?? null;
  });
  t.mock.method(User, 'find', filter => {
    calls.authors.push(filter);
    return { select(value) { assert.equal(value, '_id username avatarUrl'); return this; }, lean() { return this; },
      async exec() {
        if (options.authorError) throw new Error('Private author lookup diagnostic');
        return users.filter(u => filter._id.$in.map(String).includes(u._id));
      } };
  });
  t.mock.method(TrackLike, 'find', filter => {
    calls.memberships.push(filter);
    return { select(value) { assert.equal(value, 'trackId -_id'); return this; }, lean() { return this; },
      async exec() {
        if (options.membershipError) throw new Error('Private membership diagnostic');
        return likes.filter(l => String(l.userId) === String(filter.userId) && filter.trackId.$in.map(String).includes(String(l.trackId)));
      } };
  });
  // Database boundary fixture. Pipeline structure is asserted before simulating its scoped result.
  t.mock.method(TrackLike, 'aggregate', pipeline => {
    calls.aggregates.push(pipeline);
    return { async exec() {
      if (options.aggregateError) throw new Error('Private aggregate diagnostic');
      assert.equal(pipeline.length, 5);
      const viewer = pipeline[0].$match.userId;
      assert.ok(viewer instanceof mongoose.Types.ObjectId);
      assert.deepEqual(pipeline[1].$lookup, { from: Track.collection.name, localField: 'trackId', foreignField: '_id', as: 'track' });
      assert.equal(pipeline[2].$unwind, '$track');
      assert.deepEqual(pipeline[3].$match, { $or: [{ 'track.isPublic': true }, { 'track.artistId': viewer }] });
      const { tracks: data, total } = pipeline[4].$facet;
      assert.deepEqual(total, [{ $count: 'count' }]);
      assert.deepEqual(data[0], { $sort: { createdAt: -1, _id: -1 } });
      assert.deepEqual(data[3], { $replaceRoot: { newRoot: '$track' } });
      const accessible = likes.filter(l => String(l.userId) === String(viewer)).filter(l => {
        const track = tracks.get(String(l.trackId));
        return track && (track.isPublic || String(track.artistId) === String(viewer));
      }).sort((left, right) => Number(right.createdAt) - Number(left.createdAt) || String(right._id).localeCompare(String(left._id)));
      return [{ tracks: accessible.slice(data[1].$skip, data[1].$skip + data[2].$limit)
        .map(l => ({ ...tracks.get(String(l.trackId)).toObject(), __v: 7 })), total: accessible.length ? [{ count: accessible.length }] : [] }];
    } };
  });
  // REST Like routes/controllers run unchanged. Existing Like suites cover their transaction service;
  // this adapter models committed membership changes for cross-request collection checks.
  t.mock.method(likeService, 'setTrackLikeState', async (trackId, userId, shouldLike) => {
    const track = tracks.get(trackId);
    if (!track || (!track.isPublic && String(track.artistId) !== userId)) throw new likeService.TrackLikeError(404, 'Track not found');
    const index = likes.findIndex(l => String(l.trackId) === trackId && String(l.userId) === userId);
    if (shouldLike && index === -1) likes.push(record(userId, trackId, ++sequence, '2026-02-01'));
    if (!shouldLike && index !== -1) likes.splice(index, 1);
    track.likesCount = likes.filter(l => String(l.trackId) === trackId).length;
    return { trackId, isLiked: shouldLike, likesCount: track.likesCount };
  });
  const app = express();
  app.use(express.json());
  app.use('/api/tracks', routes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  await once(server, 'listening');
  return { tracks, likes, calls, async send(path = '/liked', { user = A, authorization, method = 'GET' } = {}) {
    const headers = {};
    if (user) headers.Authorization = 'Bearer ' + createAccessToken(user);
    if (authorization !== undefined) headers.Authorization = authorization;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tracks${path}`, { method, headers, signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  } };
}

for (const [name, config] of [
  ['guest', { user: null }], ['invalid token', { authorization: 'Bearer invalid' }],
  ['malformed header', { authorization: 'Basic invalid' }], ['missing User', { user: MISSING }],
  ['expired token', { authorization: 'Bearer ' + jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256',
    subject: A, issuer: 'stemforge-server', audience: 'stemforge-client', expiresIn: -1 }) }],
]) test('collection requires authentication: ' + name, async t => {
  const f = await fixture(t); const r = await f.send('/liked', config);
  assert.equal(r.status, 401); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(f.calls.aggregates.length, 0); assert.equal(f.calls.authors.length, 0); assert.equal(f.calls.memberships.length, 0);
});

test('collection scopes membership and visibility before pagination and total', async t => {
  const f = await fixture(t); const r = await f.send();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map(x => x._id), [GHOST_AUTHOR, OWN_PRIVATE, PUBLIC]);
  assert.deepEqual(r.body.pagination, { page: 1, limit: 12, total: 3, totalPages: 1 });
  assert.equal(JSON.stringify(r.body).includes('Hidden title'), false);
  assert.equal(JSON.stringify(r.body).includes(FOREIGN_PRIVATE), false);
  assert.equal(JSON.stringify(r.body).includes(ORPHAN), false);
  assert.equal(f.calls.aggregates.length, 1);
  assert.equal(String(f.calls.aggregates[0][0].$match.userId), A);
});

test('another account gets its own collection including only its private Tracks', async t => {
  const f = await fixture(t); const r = await f.send('/liked', { user: B });
  assert.deepEqual(r.body.data.map(x => x._id), [FOREIGN_PRIVATE, OTHER, PUBLIC]);
  assert.equal(r.body.pagination.total, 3);
  assert.equal(r.body.data.some(x => x._id === OWN_PRIVATE), false);
});

test('collection paginates after visibility, sorts by Like timestamp/ID and retains total beyond last page', async t => {
  const f = await fixture(t);
  const first = await f.send('/liked?page=1&limit=2');
  assert.deepEqual(first.body.data.map(x => x._id), [GHOST_AUTHOR, OWN_PRIVATE]);
  assert.deepEqual(first.body.pagination, { page: 1, limit: 2, total: 3, totalPages: 2 });
  const second = await f.send('/liked?page=2&limit=2');
  assert.deepEqual(second.body.data.map(x => x._id), [PUBLIC]);
  const before = f.calls.authors.length;
  const beyond = await f.send('/liked?page=9&limit=2');
  assert.deepEqual(beyond.body, { data: [], pagination: { page: 9, limit: 2, total: 3, totalPages: 2 } });
  assert.equal(f.calls.authors.length, before);
});

test('account without Likes gets zero total/pages and no enrichment queries', async t => {
  const f = await fixture(t); const r = await f.send('/liked', { user: C });
  assert.deepEqual(r.body, { data: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 0 } });
  assert.equal(f.calls.authors.length, 0); assert.equal(f.calls.memberships.length, 0);
});

test('response reuses batched artist/membership context without User or Like metadata leaks', async t => {
  const f = await fixture(t); const r = await f.send('/liked?limit=2');
  assert.equal(f.calls.authors.length, 1); assert.equal(f.calls.memberships.length, 1);
  assert.deepEqual(f.calls.memberships[0].trackId.$in.map(String), [GHOST_AUTHOR, OWN_PRIVATE]);
  assert.equal(String(f.calls.memberships[0].userId), A);
  for (const track of r.body.data) {
    assert.equal(track.likedByMe, true); assert.equal('__v' in track, false);
    assert.equal('trackId' in track, false); assert.equal('userId' in track, false);
    assert.ok(track.stems[0].stemId);
  }
  assert.equal(r.body.data[0].artist, null); assert.equal(r.body.data[0].artistId, MISSING);
  assert.deepEqual(Object.keys(r.body.data[1].artist).sort(), ['_id', 'avatarUrl', 'username']);
  assert.equal(JSON.stringify(r.body).includes('private@example.invalid'), false);
  assert.equal(JSON.stringify(r.body).includes('passwordHash'), false);
});

test('Like/Unlike HTTP changes are reflected without duplicates or cross-account changes', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('/' + OTHER + '/like', { method: 'PUT' })).status, 200);
  await f.send('/' + OTHER + '/like', { method: 'PUT' });
  let r = await f.send();
  assert.equal(r.body.pagination.total, 4); assert.equal(r.body.data[0]._id, OTHER);
  assert.equal(r.body.data.filter(x => x._id === OTHER).length, 1);
  await f.send('/' + OTHER + '/like', { method: 'DELETE' });
  await f.send('/' + OTHER + '/like', { method: 'DELETE' });
  r = await f.send(); assert.equal(r.body.pagination.total, 3);
  assert.equal(r.body.data.some(x => x._id === OTHER), false);
  assert.equal((await f.send('/liked', { user: B })).body.pagination.total, 3);
});

test('privacy changes and deleted/orphan Tracks never leak into totals or partially empty pages', async t => {
  const f = await fixture(t);
  f.tracks.get(PUBLIC).isPublic = false;
  let r = await f.send('/liked?limit=1');
  assert.equal(r.body.pagination.total, 2); assert.equal(r.body.data.length, 1);
  f.tracks.get(PUBLIC).isPublic = true;
  assert.equal((await f.send()).body.pagination.total, 3);
  f.tracks.delete(PUBLIC); f.tracks.delete(GHOST_AUTHOR);
  r = await f.send();
  assert.deepEqual(r.body.data.map(x => x._id), [OWN_PRIVATE]); assert.equal(r.body.pagination.total, 1);
  // Only inaccessible and orphan Likes remain for A after removing its own private Track.
  f.tracks.delete(OWN_PRIVATE); r = await f.send();
  assert.deepEqual(r.body, { data: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 0 } });
});

const invalidQueries = [
  'page=0', 'page=-1', 'page=01', 'page=1.5', 'page=', 'page=9007199254740992',
  'limit=0', 'limit=101', 'limit=1.5', 'limit=', 'page=9007199254740991&limit=100',
  'page=1&page=2', 'limit=1&limit=2', 'page[$gt]=1', 'limit[$ne]=1',
  'userId=' + B, 'artistId=' + B, 'isPublic=false', 'q=test', 'sort=newest', 'tag=test',
];
for (const query of invalidQueries) test('invalid collection query rejected before collection DB reads: ' + query, async t => {
  const f = await fixture(t); const r = await f.send('/liked?' + query);
  assert.equal(r.status, 400); assert.equal(typeof r.body.message, 'string');
  assert.equal(f.calls.aggregates.length, 0); assert.equal(f.calls.authors.length, 0); assert.equal(f.calls.memberships.length, 0);
});

for (const option of ['aggregateError', 'authorError', 'membershipError', 'authError']) {
  test(option + ' returns sanitized500, never a false empty collection or artist fallback', async t => {
    const f = await fixture(t, { [option]: true }); const r = await f.send();
    assert.equal(r.status, 500); assert.equal('data' in r.body, false);
    assert.equal(JSON.stringify(r.body).includes('Private'), false);
  });
}
