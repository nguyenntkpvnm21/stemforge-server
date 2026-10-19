const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Track = require('../src/models/Track');
const TrackLike = require('../src/models/TrackLike');
const events = require('../src/services/track-events.service');
const responseService = require('../src/services/track-response.service');
const { setTrackLikeState } = require('../src/services/track-like.service');
const { updateTrack, deleteTrack } = require('../src/controllers/track.controller');
const ID = '507f1f77bcf86cd799439021';
const USER = '507f1f77bcf86cd799439011';

function setup(t, { rollback = false, retry = false, publishError = false } = {}) {
  let stored = { _id: ID, artistId: USER, isPublic: true, likesCount: 0 };
  let membership = null;
  let committed = false;
  const publications = [];
  const order = [];
  const session = {};
  const unbind = events.bindPublisher((event, id, data) => {
    assert.equal(committed, true);
    publications.push({ event, id, data });
    order.push('publish');
    if (publishError) throw new Error('notification failure');
  });
  t.after(async () => { unbind(); await events.coordinator.idle(); assert.equal(events.coordinator.size, 0); });
  if (publishError) t.mock.method(console, 'error', () => {});
  const transaction = t.mock.method(mongoose.connection, 'transaction', async operation => {
    const before = structuredClone(stored);
    const beforeLike = structuredClone(membership);
    let result;
    for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
      result = await operation(session);
      assert.equal(publications.length, 0, 'No emit inside transaction callback or retry');
      if (attempt === 0 && retry) { stored = structuredClone(before); membership = structuredClone(beforeLike); }
    }
    if (rollback) { stored = before; membership = beforeLike; throw new Error('commit aborted'); }
    committed = true;
    order.push('commit');
    return result;
  });
  function query(value, requiresSession = true) {
    let assigned = false;
    return {
      select() { return this; },
      session(actual) { assert.equal(actual, session); assigned = true; return this; },
      async exec() { if (requiresSession) assert.ok(assigned); return value(); },
    };
  }
  t.mock.method(Track, 'findOne', () => query(() => stored && { ...stored }));
  t.mock.method(TrackLike, 'findOne', () => query(() => membership));
  t.mock.method(TrackLike, 'create', async (docs, options) => {
    assert.equal(options.session, session);
    membership = { _id: '507f1f77bcf86cd799439090' };
    return docs;
  });
  t.mock.method(TrackLike, 'deleteOne', (filter, options) => {
    assert.equal(options.session, session);
    return query(() => { membership = null; return { deletedCount: 1 }; }, false);
  });
  t.mock.method(Track, 'findOneAndUpdate', (filter, change, options) => {
    assert.equal(options.session, session);
    return query(() => {
      if (change.$inc) stored.likesCount += change.$inc.likesCount;
      else Object.assign(stored, change.$set);
      return { ...stored };
    }, false);
  });
  t.mock.method(Track, 'findOneAndDelete', () => query(() => { const old = stored; stored = null; return old; }));
  t.mock.method(TrackLike, 'deleteMany', () => query(() => { membership = null; return { deletedCount: 0 }; }));
  t.mock.method(responseService, 'enrichTracks', async (tracks, user, actual) => {
    assert.equal(actual, session);
    return tracks.map(track => ({ ...track, artist: { _id: USER, username: 'Composer', avatarUrl: null }, likedByMe: Boolean(membership) }));
  });
  const res = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  const req = { params: { trackId: ID }, user: { _id: USER }, body: { isPublic: false } };
  const next = t.mock.fn();
  return { res, req, next, publications, transaction, order, stored: () => stored, membership: () => membership };
}

for (const retry of [false, true]) test(`Like publishes once after commit (transaction retry=${retry})`, async t => {
  const f = setup(t, { retry });
  assert.deepEqual(await setTrackLikeState(ID, USER, true), { trackId: ID, isLiked: true, likesCount: 1 });
  assert.deepEqual(f.order, ['commit', 'publish']);
  assert.equal(f.publications[0].event, 'like');
  assert.equal(f.stored().likesCount, 1);
});

test('Like/Unlike no-op does not publish; actual membership changes publish once each', async t => {
  const f = setup(t);
  await setTrackLikeState(ID, USER, false);
  assert.equal(f.publications.length, 0);
  await setTrackLikeState(ID, USER, true);
  // The transaction mock's callback invariant applies per mutation.
  f.publications.length = 0;
  await setTrackLikeState(ID, USER, true);
  assert.equal(f.publications.length, 0);
  await setTrackLikeState(ID, USER, false);
  assert.equal(f.publications.length, 1);
  assert.equal(f.publications[0].data.likesCount, 0);
});

test('Like rollback preserves count/membership and emits nothing', async t => {
  const f = setup(t, { rollback: true });
  await assert.rejects(setTrackLikeState(ID, USER, true));
  assert.equal(f.publications.length, 0);
  assert.equal(f.stored().likesCount, 0);
  assert.equal(f.membership(), null);
});

for (const [name, controller, event] of [['PATCH', updateTrack, 'visibility'], ['DELETE', deleteTrack, 'deleted']]) {
  for (const rollback of [false, true]) test(`${name} ${rollback ? 'rollback does not revoke' : 'revokes once after retried commit'}`, async t => {
    const f = setup(t, { rollback, retry: !rollback });
    await controller(f.req, f.res, f.next);
    assert.equal(f.publications.length, rollback ? 0 : 1);
    if (rollback) {
      assert.equal(f.stored().isPublic, true);
      assert.equal(f.res.statusCode, null);
      assert.equal(f.next.mock.calls.length, 1);
    } else {
      assert.deepEqual(f.order, ['commit', 'publish']);
      assert.equal(f.publications[0].event, event);
      assert.equal(f.res.statusCode, name === 'PATCH' ? 200 : 204);
      if (name === 'PATCH') {
        assert.equal(f.res.body.data.likedByMe, false);
        assert.equal(f.res.body.data.artist.username, 'Composer');
      }
    }
  });
  test(`${name} postcommit publish failure keeps REST success without rerunning mutation`, async t => {
    const f = setup(t, { publishError: true });
    await controller(f.req, f.res, f.next);
    assert.equal(f.res.statusCode, name === 'PATCH' ? 200 : 204);
    assert.equal(f.next.mock.calls.length, 0);
    assert.equal(f.transaction.mock.calls.length, 1);
  });
}

test('Like postcommit publish failure preserves successful REST state and does not retry', async t => {
  const f = setup(t, { publishError: true });
  assert.deepEqual(await setTrackLikeState(ID, USER, true), { trackId: ID, isLiked: true, likesCount: 1 });
  assert.equal(f.transaction.mock.calls.length, 1);
  assert.equal(f.stored().likesCount, 1);
});
