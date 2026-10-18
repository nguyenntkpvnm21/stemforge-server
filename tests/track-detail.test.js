const { test } = require('node:test');
const assert = require('node:assert/strict');

const Track = require('../src/models/Track');
const trackResponseService = require('../src/services/track-response.service');
const { getTrack } = require('../src/controllers/track.controller');
const sample = require('./fixtures/track-contract-draft.json');

const trackId = sample._id;
const ownerId = sample.artistId;
const otherUserId = '507f1f77bcf86cd799439099';

function makeResponse() {
  return {
    statusCode: null,
    body: undefined,

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(body) {
      this.body = body;
      return this;
    },
  };
}

function mockFindOne(t, result, error) {
  return t.mock.method(Track, 'findOne', () => ({
    async exec() {
      if (error) {
        throw error;
      }

      return result;
    },
  }));
}

const successCases = [
  {
    name: 'returns a public track to a guest',
    user: undefined,
    isPublic: true,
    expectedFilter: {
      _id: trackId,
      isPublic: true,
    },
  },
  {
    name: 'returns a public track to another authenticated user',
    user: { _id: otherUserId },
    isPublic: true,
    expectedFilter: {
      _id: trackId,
      $or: [
        { isPublic: true },
        { artistId: otherUserId },
      ],
    },
  },
  {
    name: 'returns a private track to its owner',
    user: { _id: ownerId },
    isPublic: false,
    expectedFilter: {
      _id: trackId,
      $or: [
        { isPublic: true },
        { artistId: ownerId },
      ],
    },
  },
];

for (const entry of successCases) {
  test(entry.name, async (t) => {
    const track = {
      ...structuredClone(sample),
      isPublic: entry.isPublic,
    };

    const findOne = mockFindOne(t, track);
    const data = { ...track, artist: null, likedByMe: false };
    const enrich = t.mock.method(trackResponseService, 'enrichTracks', async () => [data]);
    const res = makeResponse();
    const next = t.mock.fn();

    await getTrack(
      {
        params: { trackId },
        user: entry.user,
      },
      res,
      next
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { data });
    assert.deepEqual(enrich.mock.calls[0].arguments, [[track], entry.user?._id]);
    assert.equal(findOne.mock.calls.length, 1);
    assert.deepEqual(
      findOne.mock.calls[0].arguments[0],
      entry.expectedFilter
    );
    assert.equal(next.mock.calls.length, 0);
  });
}

const notFoundCases = [
  {
    name: 'returns 404 when a guest has no accessible matching track',
    user: undefined,
    expectedFilter: {
      _id: trackId,
      isPublic: true,
    },
  },
  {
    name: 'returns 404 when an authenticated user has no accessible matching track',
    user: { _id: otherUserId },
    expectedFilter: {
      _id: trackId,
      $or: [
        { isPublic: true },
        { artistId: otherUserId },
      ],
    },
  },
];

for (const entry of notFoundCases) {
  test(entry.name, async (t) => {
    const findOne = mockFindOne(t, null);
    const res = makeResponse();
    const next = t.mock.fn();

    await getTrack(
      {
        params: { trackId },
        user: entry.user,
      },
      res,
      next
    );

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: 'Track not found' });
    assert.equal(findOne.mock.calls.length, 1);
    assert.deepEqual(
      findOne.mock.calls[0].arguments[0],
      entry.expectedFilter
    );
    assert.equal(next.mock.calls.length, 0);
  });
}

const invalidIds = [
  ['rejects a short ID', 'invalid-id'],
  ['rejects a 24-character non-hex ID', 'z'.repeat(24)],
  ['rejects an array ID', [trackId]],
];

for (const [name, invalidId] of invalidIds) {
  test(name, async (t) => {
    const findOne = mockFindOne(t, null);
    const res = makeResponse();
    const next = t.mock.fn();

    await getTrack(
      { params: { trackId: invalidId } },
      res,
      next
    );

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      message: 'trackId must be a valid MongoDB ObjectId.',
    });
    assert.equal(findOne.mock.calls.length, 0);
    assert.equal(next.mock.calls.length, 0);
  });
}

test('forwards a database error to next', async (t) => {
  const error = new Error('Database unavailable');
  const findOne = mockFindOne(t, null, error);
  const res = makeResponse();
  const next = t.mock.fn();

  await getTrack(
    { params: { trackId } },
    res,
    next
  );

  assert.equal(findOne.mock.calls.length, 1);
  assert.equal(next.mock.calls.length, 1);
  assert.equal(next.mock.calls[0].arguments[0], error);
  assert.equal(res.statusCode, null);
  assert.equal(res.body, undefined);
});
