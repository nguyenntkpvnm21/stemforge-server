const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Track = require('../src/models/Track');
const { updateTrack } = require('../src/controllers/track.controller');
const sample = require('./fixtures/track-contract-draft.json');

const ownerId = new mongoose.Types.ObjectId(sample.artistId);

function makeRequest(body, trackId = sample._id) {
  return {
    params: { trackId },
    user: { _id: ownerId },
    body,
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

function mockUpdate(t, result, error) {
  return t.mock.method(Track, 'findOneAndUpdate', () => ({
    async exec() {
      if (error) {
        throw error;
      }

      return result;
    },
  }));
}

const successfulUpdates = [
  [
    'updates only the supplied title',
    { title: 'Updated title' },
  ],
  [
    'passes false flags and cleared optional metadata',
    {
      isPublic: false,
      isDownloadable: false,
      tags: [],
      coverImageUrl: null,
      description: '',
    },
  ],
];

for (const [name, body] of successfulUpdates) {
  test(name, async (t) => {
    const savedTrack = {
      ...structuredClone(sample),
      ...body,
    };

    const update = mockUpdate(t, savedTrack);
    const res = makeResponse();
    const next = t.mock.fn();

    await updateTrack(makeRequest(body), res, next);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { data: savedTrack });
    assert.equal(update.mock.calls.length, 1);

    const [filter, changes, options] =
      update.mock.calls[0].arguments;

    assert.deepEqual(filter, {
      _id: sample._id,
      artistId: ownerId,
    });

    assert.deepEqual(changes, { $set: body });

    assert.deepEqual(options, {
      returnDocument: 'after',
      runValidators: true,
      upsert: false,
    });

    assert.equal(next.mock.calls.length, 0);
  });
}

test('returns 404 when no owned Track matches', async (t) => {
  const update = mockUpdate(t, null);
  const res = makeResponse();
  const next = t.mock.fn();

  await updateTrack(
    makeRequest({ title: 'Updated title' }),
    res,
    next
  );

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: 'Track not found' });
  assert.equal(update.mock.calls.length, 1);

  assert.deepEqual(update.mock.calls[0].arguments[0], {
    _id: sample._id,
    artistId: ownerId,
  });

  assert.equal(update.mock.calls[0].arguments[2].upsert, false);
  assert.equal(next.mock.calls.length, 0);
});

async function expectRejection(t, req, status, message) {
  const update = mockUpdate(t, null);
  const res = makeResponse();
  const next = t.mock.fn();

  await updateTrack(req, res, next);

  assert.equal(res.statusCode, status);
  assert.deepEqual(res.body, { message });
  assert.equal(update.mock.calls.length, 0);
  assert.equal(next.mock.calls.length, 0);
}

test('rejects an unauthenticated request without writing', async (t) => {
  const req = makeRequest({ title: 'Updated title' });
  delete req.user;

  await expectRejection(
    t,
    req,
    401,
    'Authentication required.'
  );
});

for (const [name, trackId] of [
  ['a short ID', 'invalid-id'],
  ['a non-hex ID', 'z'.repeat(24)],
  ['an array ID', [sample._id]],
]) {
  test('rejects ' + name + ' without writing', async (t) => {
    await expectRejection(
      t,
      makeRequest({ title: 'Updated title' }, trackId),
      400,
      'trackId must be a valid MongoDB ObjectId.'
    );
  });
}

test('rejects an empty update without writing', async (t) => {
  await expectRejection(
    t,
    makeRequest({}),
    400,
    'At least one Track field must be provided.'
  );
});

test('rejects changing ownership without writing', async (t) => {
  await expectRejection(
    t,
    makeRequest({
      title: 'Updated title',
      artistId: '507f1f77bcf86cd799439099',
    }),
    400,
    'Request contains unsupported Track fields.'
  );
});

test('rejects replacing stems without writing', async (t) => {
  await expectRejection(
    t,
    makeRequest({ stems: [] }),
    400,
    'Request contains unsupported Track fields.'
  );
});

test('rejects a numeric string BPM without writing', async (t) => {
  await expectRejection(
    t,
    makeRequest({ bpm: '128' }),
    400,
    'bpm must be a positive number.'
  );
});

test('returns 400 for a model validation error', async (t) => {
  const error = new Error('Model validation failed');
  error.name = 'ValidationError';

  const update = mockUpdate(t, null, error);
  const res = makeResponse();
  const next = t.mock.fn();

  await updateTrack(
    makeRequest({ title: 'Updated title' }),
    res,
    next
  );

  assert.equal(update.mock.calls.length, 1);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    message: 'Track data failed validation.',
  });
  assert.equal(next.mock.calls.length, 0);
});

test('forwards a database error to next', async (t) => {
  const error = new Error('Database unavailable');
  const update = mockUpdate(t, null, error);
  const res = makeResponse();
  const next = t.mock.fn();

  await updateTrack(
    makeRequest({ title: 'Updated title' }),
    res,
    next
  );

  assert.equal(update.mock.calls.length, 1);
  assert.equal(next.mock.calls.length, 1);
  assert.equal(next.mock.calls[0].arguments[0], error);
  assert.equal(res.statusCode, null);
  assert.equal(res.body, undefined);
});