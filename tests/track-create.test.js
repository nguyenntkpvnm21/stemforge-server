const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Track = require('../src/models/Track');
const trackResponseService = require('../src/services/track-response.service');
const { createTrack } = require('../src/controllers/track.controller');
const sample = require('./fixtures/track-contract-draft.json');

const ownerId = new mongoose.Types.ObjectId(sample.artistId);
const session = {};
beforeEach(t => {
  t.mock.method(mongoose.connection, 'transaction', async (operation, options) => {
    assert.deepEqual(options, { readPreference: 'primary', readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return operation(session);
  });
});

function makeInput() {
  return {
    title: sample.title,
    genre: sample.genre,
    bpm: sample.bpm,
    key: sample.key,
    tags: [...sample.tags],
    coverImageUrl: sample.coverImageUrl,
    description: sample.description,
    isPublic: sample.isPublic,
    isDownloadable: sample.isDownloadable,
    stems: sample.stems.map((stem) => ({
      name: stem.name,
      audioUrl: stem.audioUrl,
      duration: stem.duration,
      fileSize: stem.fileSize,
    })),
  };
}

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

for (const isPublic of [true, false]) {
  test(
    'creates a ' + (isPublic ? 'public' : 'private') + ' track',
    async (t) => {
      const input = makeInput();
      input.isPublic = isPublic;

      const savedTrack = {
        ...structuredClone(sample),
        isPublic,
      };
      const data = { ...savedTrack, artist: null, likedByMe: false };
      const enrich = t.mock.method(trackResponseService, 'enrichTracks', async () => [data]);

      const create = t.mock.method(
        Track,
        'create',
        async () => [savedTrack]
      );

      const res = makeResponse();
      const next = t.mock.fn();

      await createTrack(
        { body: input, user: { _id: ownerId } },
        res,
        next
      );

      assert.equal(res.statusCode, 201);
      assert.deepEqual(res.body, { data });
      assert.deepEqual(enrich.mock.calls[0].arguments, [[savedTrack], ownerId, session]);
      assert.equal(create.mock.calls.length, 1);

      const payload = create.mock.calls[0].arguments[0];

      assert.deepEqual(payload, [{
        ...input,
        artistId: ownerId,
        likesCount: 0,
      }]);
      assert.deepEqual(create.mock.calls[0].arguments[1], { session });

      assert.equal(next.mock.calls.length, 0);
    }
  );
}

async function expectRejection(t, body, user, status, message) {
  const create = t.mock.method(Track, 'create', async () => null);
  const res = makeResponse();
  const next = t.mock.fn();

  await createTrack({ body, user }, res, next);

  assert.equal(res.statusCode, status);
  assert.deepEqual(res.body, { message });
  assert.equal(create.mock.calls.length, 0);
  assert.equal(next.mock.calls.length, 0);
}

test('rejects an unauthenticated request without writing', async (t) => {
  await expectRejection(
    t,
    makeInput(),
    undefined,
    401,
    'Authentication required.'
  );
});

test('rejects invalid metadata without writing', async (t) => {
  const input = makeInput();
  input.title = 123;

  await expectRejection(
    t,
    input,
    { _id: ownerId },
    400,
    'title must be a non-empty string.'
  );
});

for (const [field, value] of [
  ['artistId', '507f1f77bcf86cd799439099'],
  ['likesCount', 999],
  ['_id', sample._id],
  ['createdAt', sample.createdAt],
  ['artist', { _id: sample.artistId, username: 'Spoofed', avatarUrl: null }],
  ['likedByMe', true],
]) {
  test('rejects client-supplied ' + field + ' without writing', async (t) => {
    const input = makeInput();
    input[field] = value;

    await expectRejection(
      t,
      input,
      { _id: ownerId },
      400,
      'Request contains unsupported Track fields.'
    );
  });
}

test('rejects a client-supplied stem ID without writing', async (t) => {
  const input = makeInput();
  input.stems[0].stemId = sample.stems[0].stemId;

  await expectRejection(
    t,
    input,
    { _id: ownerId },
    400,
    'stems[0] contains unsupported fields.'
  );
});

test('returns 400 for a model validation error', async (t) => {
  const error = new Error('Model validation failed');
  error.name = 'ValidationError';

  const create = t.mock.method(Track, 'create', async () => {
    throw error;
  });

  const res = makeResponse();
  const next = t.mock.fn();

  await createTrack(
    { body: makeInput(), user: { _id: ownerId } },
    res,
    next
  );

  assert.equal(create.mock.calls.length, 1);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    message: 'Track data failed validation.',
  });
  assert.equal(next.mock.calls.length, 0);
});

test('forwards a database error to next', async (t) => {
  const error = new Error('Database unavailable');

  const create = t.mock.method(Track, 'create', async () => {
    throw error;
  });

  const res = makeResponse();
  const next = t.mock.fn();

  await createTrack(
    { body: makeInput(), user: { _id: ownerId } },
    res,
    next
  );

  assert.equal(create.mock.calls.length, 1);
  assert.equal(next.mock.calls.length, 1);
  assert.equal(next.mock.calls[0].arguments[0], error);
  assert.equal(res.statusCode, null);
  assert.equal(res.body, undefined);
});
