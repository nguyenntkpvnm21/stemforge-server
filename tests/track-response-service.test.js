const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Track = require('../src/models/Track');
const User = require('../src/models/User');
const TrackLike = require('../src/models/TrackLike');
const { enrichTracks } = require('../src/services/track-response.service');
const sample = require('./fixtures/track-contract-draft.json');

const viewerId = '507f1f77bcf86cd799439099';
const author = {
  _id: new mongoose.Types.ObjectId(sample.artistId),
  username: 'Composer', avatarUrl: null,
  email: 'private@example.invalid', passwordHash: 'test-only-hash',
  role: 'admin', createdAt: new Date(), updatedAt: new Date(), __v: 7,
};
const publicArtist = { _id: sample.artistId, username: 'Composer', avatarUrl: null };

function mockQuery(t, model, result, error) {
  const calls = { selects: [], sessions: [], lean: 0, exec: 0 };
  const find = t.mock.method(model, 'find', () => ({
    select(value) { calls.selects.push(value); return this; },
    lean() { calls.lean++; return this; },
    session(value) { calls.sessions.push(value); return this; },
    async exec() {
      calls.exec++;
      if (error) throw error;
      return typeof result === 'function' ? result() : result;
    },
  }));
  return { find, calls };
}

test('transaction enrichment binds both lookups to one session and executes them sequentially', async (t) => {
  const session = {};
  const order = [];
  const artists = mockQuery(t, User, async () => {
    order.push('author-start');
    await Promise.resolve();
    order.push('author-end');
    return [author];
  });
  const likes = mockQuery(t, TrackLike, async () => {
    assert.deepEqual(order, ['author-start', 'author-end']);
    order.push('membership');
    return [{ trackId: sample._id }];
  });
  const [data] = await enrichTracks([sample], viewerId, session);
  assert.equal(data.likedByMe, true);
  assert.deepEqual(artists.calls.sessions, [session]);
  assert.deepEqual(likes.calls.sessions, [session]);
});

test('transaction author failure aborts enrichment before executing membership lookup', async (t) => {
  const error = new Error('Author lookup failed');
  mockQuery(t, User, [], error);
  const likes = mockQuery(t, TrackLike, []);
  await assert.rejects(enrichTracks([sample], viewerId, {}), value => value === error);
  assert.equal(likes.calls.exec, 0);
});

test('guest gets allowlisted artist and false without a membership lookup', async (t) => {
  const artists = mockQuery(t, User, [author]);
  const likes = mockQuery(t, TrackLike, []);
  const track = structuredClone(sample);
  const before = structuredClone(track);

  const [data] = await enrichTracks([track]);

  assert.deepEqual(data, { ...sample, artist: publicArtist, likedByMe: false });
  assert.deepEqual(track, before);
  assert.deepEqual(artists.calls.selects, ['_id username avatarUrl']);
  assert.equal(artists.calls.lean, 1);
  assert.equal(likes.find.mock.calls.length, 0);
  assert.deepEqual(Object.keys(data.artist).sort(), ['_id', 'avatarUrl', 'username']);
});

test('membership belongs to the viewer; nonzero global count does not imply likedByMe', async (t) => {
  mockQuery(t, User, [author]);
  const unliked = { ...sample, _id: '507f1f77bcf86cd799439022', likesCount: 9 };
  const liked = { ...sample, likesCount: 3 };
  const likes = mockQuery(t, TrackLike, [{ trackId: new mongoose.Types.ObjectId(liked._id) }]);

  const data = await enrichTracks([unliked, liked], viewerId);

  assert.deepEqual(data.map(track => track.likedByMe), [false, true]);
  assert.deepEqual(data.map(track => track.likesCount), [9, 3]);
  assert.deepEqual(likes.find.mock.calls[0].arguments[0], {
    userId: viewerId, trackId: { $in: [unliked._id, liked._id] },
  });
  assert.deepEqual(likes.calls.selects, ['trackId -_id']);
  assert.equal(likes.calls.lean, 1);
});

test('one author query and one membership query cover a full page with repeated authors', async (t) => {
  const otherId = '507f1f77bcf86cd799439077';
  const tracks = Array.from({ length: 100 }, (_, index) => ({
    ...sample,
    _id: new mongoose.Types.ObjectId(),
    artistId: index % 2 ? otherId : sample.artistId,
  }));
  const other = { _id: otherId, username: 'Second author', avatarUrl: 'https://example.invalid/avatar.png' };
  const artists = mockQuery(t, User, [other, author]);
  const likes = mockQuery(t, TrackLike, tracks.filter((_, i) => i % 3 === 0).map(track => ({ trackId: track._id })));

  const data = await enrichTracks(tracks, viewerId);

  assert.equal(artists.find.mock.calls.length, 1);
  assert.equal(likes.find.mock.calls.length, 1);
  assert.deepEqual(artists.find.mock.calls[0].arguments[0], {
    _id: { $in: [sample.artistId, otherId] },
  });
  assert.deepEqual(data.map(track => track._id), tracks.map(track => track._id));
  data.forEach((track, index) => {
    assert.equal(track.artist._id, index % 2 ? otherId : sample.artistId);
    assert.equal(track.likedByMe, index % 3 === 0);
  });
});

test('empty pages perform no author or membership queries', async (t) => {
  const artists = mockQuery(t, User, []);
  const likes = mockQuery(t, TrackLike, []);
  assert.deepEqual(await enrichTracks([], viewerId), []);
  assert.equal(artists.find.mock.calls.length, 0);
  assert.equal(likes.find.mock.calls.length, 0);
});

test('missing author produces null and preserves the Track ID, owner, and Like state', async (t) => {
  mockQuery(t, User, []);
  mockQuery(t, TrackLike, [{ trackId: sample._id }]);
  const [data] = await enrichTracks([sample], viewerId);
  assert.deepEqual(data, { ...sample, artist: null, likedByMe: true });
});

test('absent avatar is represented as null without exposing extra author fields', async (t) => {
  mockQuery(t, User, [{ _id: sample.artistId, username: 'Composer', email: author.email }]);
  const [data] = await enrichTracks([sample]);
  assert.deepEqual(data.artist, publicArtist);
});

test('Mongoose serialization preserves Track fields and omits internal version and computed persistence', async (t) => {
  mockQuery(t, User, [author]);
  mockQuery(t, TrackLike, []);
  const track = new Track({ ...structuredClone(sample), __v: 3 });
  const [data] = await enrichTracks([track], viewerId);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), { ...sample, artist: publicArtist, likedByMe: false });
  assert.equal(track.toObject().artist, undefined);
  assert.equal(track.toObject().likedByMe, undefined);
  assert.equal(Track.schema.path('artist'), undefined);
  assert.equal(Track.schema.path('likedByMe'), undefined);
});

for (const failingQuery of ['author', 'membership']) {
  test(`propagates ${failingQuery} lookup errors instead of returning a false fallback`, async (t) => {
    const error = new Error('Database unavailable');
    mockQuery(t, User, [author], failingQuery === 'author' ? error : undefined);
    mockQuery(t, TrackLike, [], failingQuery === 'membership' ? error : undefined);
    await assert.rejects(enrichTracks([sample], viewerId), value => value === error);
  });
}
