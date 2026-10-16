const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Track = require('../src/models/Track');
const TrackLike = require('../src/models/TrackLike');
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

function makeQuery(session, operation) {
  let sessionAssigned = false;

  return {
    session(actualSession) {
      assert.equal(actualSession, session);
      sessionAssigned = true;
      return this;
    },

    async exec() {
      assert.ok(
        sessionAssigned,
        'Deletion queries must use the transaction session.'
      );

      return operation();
    },
  };
}

function mockDatabase(t, settings = {}) {
  const session = {};

  const transaction = t.mock.method(
    mongoose.connection,
    'transaction',
    async (operation) => {
      const result = await operation(session);

      if (settings.commitError) {
        throw settings.commitError;
      }

      return result;
    }
  );

  const remove = t.mock.method(
    Track,
    'findOneAndDelete',
    () => makeQuery(session, () => {
      if (settings.findError) {
        throw settings.findError;
      }

      return settings.track ?? null;
    })
  );

  const cleanup = t.mock.method(
    TrackLike,
    'deleteMany',
    () => makeQuery(session, () => {
      if (settings.cleanupError) {
        throw settings.cleanupError;
      }

      return {
        acknowledged: true,
        deletedCount: settings.deletedLikes ?? 2,
      };
    })
  );

  return { transaction, remove, cleanup };
}

for (const isPublic of [true, false]) {
  test(
    'deletes an owned ' + (isPublic ? 'public' : 'private') +
      ' Track and its likes',
    async (t) => {
      const db = mockDatabase(t, {
        track: {
          ...structuredClone(sample),
          isPublic,
        },
        deletedLikes: isPublic ? 2 : 0,
      });

      const res = makeResponse();
      const next = t.mock.fn();

      await deleteTrack(makeRequest(), res, next);

      assert.equal(db.transaction.mock.callCount(), 1);
      assert.equal(db.remove.mock.callCount(), 1);
      assert.deepEqual(db.remove.mock.calls[0].arguments, [{
        _id: sample._id,
        artistId: ownerId,
      }]);

      assert.equal(db.cleanup.mock.callCount(), 1);

      // Cleanup includes every user's likes for this Track only.
      assert.deepEqual(db.cleanup.mock.calls[0].arguments, [{
        trackId: sample._id,
      }]);

      assert.equal(res.statusCode, 204);
      assert.equal(res.body, undefined);
      assert.equal(res.endCalls, 1);
      assert.deepEqual(res.endArguments, []);
      assert.equal(next.mock.callCount(), 0);
    }
  );
}

test('returns 404 without deleting likes when no owned Track matches', async (t) => {
  const db = mockDatabase(t);
  const res = makeResponse();
  const next = t.mock.fn();

  await deleteTrack(makeRequest(), res, next);

  assert.equal(db.transaction.mock.callCount(), 1);
  assert.equal(db.remove.mock.callCount(), 1);
  assert.deepEqual(db.remove.mock.calls[0].arguments[0], {
    _id: sample._id,
    artistId: ownerId,
  });

  assert.equal(db.cleanup.mock.callCount(), 0);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: 'Track not found' });
  assert.equal(res.endCalls, 0);
  assert.equal(next.mock.callCount(), 0);
});

async function expectRejection(t, req, status, message) {
  const db = mockDatabase(t);
  const res = makeResponse();
  const next = t.mock.fn();

  await deleteTrack(req, res, next);

  assert.equal(res.statusCode, status);
  assert.deepEqual(res.body, { message });
  assert.equal(res.endCalls, 0);
  assert.equal(next.mock.callCount(), 0);

  assert.equal(db.transaction.mock.callCount(), 0);
  assert.equal(db.remove.mock.callCount(), 0);
  assert.equal(db.cleanup.mock.callCount(), 0);
}

test('rejects an unauthenticated request before starting a transaction', async (t) => {
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
  test('rejects ' + name + ' before starting a transaction', async (t) => {
    await expectRejection(
      t,
      makeRequest(trackId),
      400,
      'trackId must be a valid MongoDB ObjectId.'
    );
  });
}

test('forwards a Track deletion error without cleaning up likes', async (t) => {
  const error = new Error('Database unavailable');
  const db = mockDatabase(t, { findError: error });
  const res = makeResponse();
  const next = t.mock.fn();

  await deleteTrack(makeRequest(), res, next);

  assert.equal(db.remove.mock.callCount(), 1);
  assert.equal(db.cleanup.mock.callCount(), 0);
  assert.equal(next.mock.callCount(), 1);
  assert.equal(next.mock.calls[0].arguments[0], error);

  assert.equal(res.statusCode, null);
  assert.equal(res.body, undefined);
  assert.equal(res.endCalls, 0);
});

for (const stage of ['cleanup', 'commit']) {
  test(`does not return 204 when ${stage} fails`, async (t) => {
    const error = new Error(`${stage} failed`);

    const db = mockDatabase(t, {
      track: structuredClone(sample),
      ...(stage === 'cleanup'
        ? { cleanupError: error }
        : { commitError: error }),
    });

    const res = makeResponse();
    const next = t.mock.fn();

    await deleteTrack(makeRequest(), res, next);

    assert.equal(db.transaction.mock.callCount(), 1);
    assert.equal(db.remove.mock.callCount(), 1);
    assert.equal(db.cleanup.mock.callCount(), 1);
    assert.equal(next.mock.callCount(), 1);
    assert.equal(next.mock.calls[0].arguments[0], error);

    assert.equal(res.statusCode, null);
    assert.equal(res.body, undefined);
    assert.equal(res.endCalls, 0);
  });
}