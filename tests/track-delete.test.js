const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Track = require('../src/models/Track');
const { deleteTrack } = require('../src/controllers/track.controller');
const sample = require('./fixtures/track-contract-draft.json');

const ownerId = new mongoose.Types.ObjectId(sample.artistId);

function makeRequest(trackId = sample._id) {
  return {
    params: { trackId },
    user: { _id: ownerId },
  };
}

function makeResponse() {
  return {
    statusCode: null,
    body: undefined,
    endCalls: 0,
    endArguments: undefined,

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(body) {
      this.body = body;
      return this;
    },

    end(...args) {
      this.endCalls += 1;
      this.endArguments = args;
      return this;
    },
  };
}

function mockDelete(t, result, error) {
  return t.mock.method(Track, 'findOneAndDelete', () => ({
    async exec() {
      if (error) {
        throw error;
      }

      return result;
    },
  }));
}

for (const isPublic of [true, false]) {
  test(
    'deletes an owned ' + (isPublic ? 'public' : 'private') + ' Track',
    async (t) => {
      const remove = mockDelete(t, {
        ...structuredClone(sample),
        isPublic,
      });

      const res = makeResponse();
      const next = t.mock.fn();

      await deleteTrack(makeRequest(), res, next);

      assert.equal(remove.mock.calls.length, 1);
      assert.deepEqual(remove.mock.calls[0].arguments, [
        {
          _id: sample._id,
          artistId: ownerId,
        },
      ]);

      assert.equal(res.statusCode, 204);
      assert.equal(res.body, undefined);
      assert.equal(res.endCalls, 1);
      assert.deepEqual(res.endArguments, []);
      assert.equal(next.mock.calls.length, 0);
    }
  );
}

test('returns 404 when no owned Track matches', async (t) => {
  const remove = mockDelete(t, null);
  const res = makeResponse();
  const next = t.mock.fn();

  await deleteTrack(makeRequest(), res, next);

  assert.equal(remove.mock.calls.length, 1);
  assert.deepEqual(remove.mock.calls[0].arguments[0], {
    _id: sample._id,
    artistId: ownerId,
  });

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {
    message: 'Track not found',
  });
  assert.equal(res.endCalls, 0);
  assert.equal(next.mock.calls.length, 0);
});

async function expectRejection(t, req, status, message) {
  const remove = mockDelete(t, null);
  const res = makeResponse();
  const next = t.mock.fn();

  await deleteTrack(req, res, next);

  assert.equal(res.statusCode, status);
  assert.deepEqual(res.body, { message });
  assert.equal(remove.mock.calls.length, 0);
  assert.equal(res.endCalls, 0);
  assert.equal(next.mock.calls.length, 0);
}

test('rejects an unauthenticated request without deleting', async (t) => {
  const req = makeRequest();
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
  test('rejects ' + name + ' without deleting', async (t) => {
    await expectRejection(
      t,
      makeRequest(trackId),
      400,
      'trackId must be a valid MongoDB ObjectId.'
    );
  });
}

test('forwards a database error to next', async (t) => {
  const error = new Error('Database unavailable');
  const remove = mockDelete(t, null, error);
  const res = makeResponse();
  const next = t.mock.fn();

  await deleteTrack(makeRequest(), res, next);

  assert.equal(remove.mock.calls.length, 1);
  assert.equal(next.mock.calls.length, 1);
  assert.equal(next.mock.calls[0].arguments[0], error);
  assert.equal(res.statusCode, null);
  assert.equal(res.body, undefined);
  assert.equal(res.endCalls, 0);
});