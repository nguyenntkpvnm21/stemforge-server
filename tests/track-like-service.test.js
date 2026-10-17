const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Track = require('../src/models/Track');
const TrackLike = require('../src/models/TrackLike');

const {
  getTrackLikeState,
  setTrackLikeState,
  TrackLikeError,
} = require('../src/services/track-like.service');

const TRACK_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f1f77bcf86cd799439012';
const TRACK_OBJECT_ID = new mongoose.Types.ObjectId(TRACK_ID);

const LIKE = {
  _id: new mongoose.Types.ObjectId('507f1f77bcf86cd799439013'),
};

const DB_ERROR = new Error('Database operation failed');

function makeTrack(likesCount) {
  return {
    _id: TRACK_OBJECT_ID,
    likesCount,
  };
}

function resolveValue(value) {
  return typeof value === 'function' ? value() : value;
}

function makeQuery(value, expectedSession) {
  let sessionAssigned = false;

  return {
    select() {
      return this;
    },

    session(actualSession) {
      assert.equal(actualSession, expectedSession);
      sessionAssigned = true;
      return this;
    },

    async exec() {
      if (expectedSession) {
        assert.ok(sessionAssigned, 'Read must use the transaction session.');
      }

      return resolveValue(value);
    },
  };
}

function mockDatabase(t, settings = {}) {
  const {
    track = makeTrack(0),
    like = null,
    updatedTrack = makeTrack(1),
  } = settings;

  let activeSession;
  const sessions = [];

  const transaction = t.mock.method(
    mongoose.connection,
    'transaction',
    async (operation, options) => {
      assert.equal(options.readPreference, 'primary');
      assert.deepEqual(options.readConcern, { level: 'snapshot' });
      assert.deepEqual(options.writeConcern, { w: 'majority' });

      activeSession = { attempt: sessions.length + 1 };
      sessions.push(activeSession);

      if (settings.transactionError) {
        throw settings.transactionError;
      }

      return operation(activeSession);
    }
  );

  const findTrack = t.mock.method(Track, 'findOne', () => {
    assert.ok(activeSession);

    return makeQuery(() => {
      if (settings.readError) {
        throw settings.readError;
      }

      return resolveValue(track);
    }, activeSession);
  });

  const findLike = t.mock.method(TrackLike, 'findOne', () => {
    assert.ok(activeSession);
    return makeQuery(like, activeSession);
  });

  const create = t.mock.method(
    TrackLike,
    'create',
    async (documents, options) => {
      assert.ok(activeSession);
      assert.equal(options.session, activeSession);

      if (settings.createError) {
        throw settings.createError;
      }

      return documents;
    }
  );

  const remove = t.mock.method(
    TrackLike,
    'deleteOne',
    (filter, options) => {
      assert.ok(activeSession);
      assert.equal(options.session, activeSession);

      return makeQuery(() => {
        if (settings.deleteError) {
          throw settings.deleteError;
        }

        return {
          deletedCount: settings.deletedCount ?? 1,
        };
      });
    }
  );

  const update = t.mock.method(
    Track,
    'findOneAndUpdate',
    (filter, change, options) => {
      assert.ok(activeSession);
      assert.equal(options.session, activeSession);
      assert.equal(options.returnDocument, 'after');
      assert.equal(options.upsert, false);

      return makeQuery(() => {
        if (settings.updateError) {
          throw settings.updateError;
        }

        return resolveValue(updatedTrack);
      });
    }
  );

  return {
    transaction,
    findTrack,
    findLike,
    create,
    remove,
    update,
    sessions,
  };
}

function assertWrites(db, [creates, removals, updates]) {
  assert.equal(db.create.mock.callCount(), creates);
  assert.equal(db.remove.mock.callCount(), removals);
  assert.equal(db.update.mock.callCount(), updates);
}

for (const isLiked of [false, true]) {
  test(`reads the ${isLiked ? 'liked' : 'unliked'} state without writing`, async (t) => {
    const count = isLiked ? 3 : 0;

    const db = mockDatabase(t, {
      track: makeTrack(count),
      like: isLiked ? LIKE : null,
    });

    const result = await getTrackLikeState(TRACK_ID, USER_ID);

    assert.deepEqual(result, {
      trackId: TRACK_ID,
      isLiked,
      likesCount: count,
    });

    assert.deepEqual(db.findTrack.mock.calls[0].arguments[0], {
      _id: TRACK_ID,
      $or: [
        { isPublic: true },
        { artistId: USER_ID },
      ],
    });

    assert.deepEqual(db.findLike.mock.calls[0].arguments[0], {
      trackId: TRACK_OBJECT_ID,
      userId: USER_ID,
    });

    assertWrites(db, [0, 0, 0]);
  });
}

const successfulChanges = [
  {
    name: 'creates a new like and increments the count once',
    settings: {},
    desired: true,
    count: 1,
    writes: [1, 0, 1],
  },
  {
    name: 'repeated like keeps the count unchanged',
    settings: {
      track: makeTrack(1),
      like: LIKE,
    },
    desired: true,
    count: 1,
    writes: [0, 0, 0],
  },
  {
    name: 'removes an existing like and decrements the count once',
    settings: {
      track: makeTrack(1),
      like: LIKE,
      updatedTrack: makeTrack(0),
    },
    desired: false,
    count: 0,
    writes: [0, 1, 1],
  },
  {
    name: 'repeated unlike preserves likes from other users',
    settings: {
      track: makeTrack(3),
      like: null,
    },
    desired: false,
    count: 3,
    writes: [0, 0, 0],
  },
];

for (const sample of successfulChanges) {
  test(sample.name, async (t) => {
    const db = mockDatabase(t, sample.settings);

    const result = await setTrackLikeState(
      TRACK_ID,
      USER_ID,
      sample.desired
    );

    assert.deepEqual(result, {
      trackId: TRACK_ID,
      isLiked: sample.desired,
      likesCount: sample.count,
    });

    assertWrites(db, sample.writes);

    if (sample.writes[0]) {
      assert.deepEqual(db.create.mock.calls[0].arguments[0], [{
        trackId: TRACK_OBJECT_ID,
        userId: USER_ID,
      }]);
    }

    if (sample.writes[1]) {
      assert.deepEqual(db.remove.mock.calls[0].arguments[0], {
        _id: LIKE._id,
        trackId: TRACK_OBJECT_ID,
        userId: USER_ID,
      });
    }

    if (sample.writes[2]) {
      const [filter, change] = db.update.mock.calls[0].arguments;

      assert.deepEqual(filter, {
        _id: TRACK_OBJECT_ID,
        $or: [
          { isPublic: true },
          { artistId: USER_ID },
        ],
      });

      assert.deepEqual(change, {
        $inc: { likesCount: sample.desired ? 1 : -1 },
      });
    }
  });
}

const errorCases = [
  {
    name: 'returns 404 for a missing or inaccessible Track',
    mode: 'get',
    settings: { track: null },
    type: TrackLikeError,
    status: 404,
  },
  {
    name: 'propagates a Track read failure',
    mode: 'get',
    settings: { readError: DB_ERROR },
    original: DB_ERROR,
  },
  {
    name: 'propagates a transaction startup failure',
    settings: { transactionError: DB_ERROR },
    original: DB_ERROR,
  },
  {
    name: 'rejects a non-boolean state before starting a transaction',
    desired: 'true',
    type: TypeError,
    transactions: 0,
  },
  {
    name: 'prevents the count exceeding the safe integer range',
    settings: {
      track: makeTrack(Number.MAX_SAFE_INTEGER),
    },
    pattern: /would become invalid/,
  },
  {
    name: 'prevents the count becoming negative',
    desired: false,
    settings: {
      track: makeTrack(0),
      like: LIKE,
    },
    pattern: /would become invalid/,
  },
  {
    name: 'does not update the count when creating the like fails',
    settings: { createError: DB_ERROR },
    original: DB_ERROR,
    writes: [1, 0, 0],
  },
  {
    name: 'does not update the count when removing the like fails',
    desired: false,
    settings: {
      track: makeTrack(1),
      like: LIKE,
      deleteError: DB_ERROR,
    },
    original: DB_ERROR,
    writes: [0, 1, 0],
  },
  {
    name: 'does not decrement when no like was actually deleted',
    desired: false,
    settings: {
      track: makeTrack(1),
      like: LIKE,
      deletedCount: 0,
    },
    pattern: /Unable to remove/,
    writes: [0, 1, 0],
  },
  {
    name: 'propagates a counter update failure',
    settings: { updateError: DB_ERROR },
    original: DB_ERROR,
    writes: [1, 0, 1],
  },
  {
    name: 'returns 404 when the Track update finds no accessible Track',
    settings: { updatedTrack: null },
    type: TrackLikeError,
    status: 404,
    writes: [1, 0, 1],
  },
  {
    name: 'rejects an inconsistent updated count',
    settings: { updatedTrack: makeTrack(2) },
    pattern: /inconsistent/,
    writes: [1, 0, 1],
  },
  {
    name: 'rejects an invalid stored count before reading membership',
    mode: 'get',
    settings: { track: makeTrack(-1) },
    pattern: /likes count is invalid/,
  },
];

for (const sample of errorCases) {
  test(sample.name, async (t) => {
    const db = mockDatabase(t, sample.settings);

    const operation = sample.mode === 'get'
      ? getTrackLikeState(TRACK_ID, USER_ID)
      : setTrackLikeState(
          TRACK_ID,
          USER_ID,
          sample.desired ?? true
        );

    await assert.rejects(operation, (error) => {
      assert.ok(error instanceof (sample.type || Error));

      if (sample.original) {
        assert.equal(error, sample.original);
      }

      if (sample.status) {
        assert.equal(error.status, sample.status);
      }

      if (sample.pattern) {
        assert.match(error.message, sample.pattern);
      }

      return true;
    });

    assertWrites(db, sample.writes || [0, 0, 0]);

    assert.equal(
      db.transaction.mock.callCount(),
      sample.transactions ?? 1
    );

    if (sample.mode === 'get') {
      assert.equal(db.findLike.mock.callCount(), 0);
    }
  });
}

function duplicateError(nested = false) {
  const error = new Error('Duplicate Track-user like');
  error.code = 11000;

  if (nested) {
    error.errorResponse = {
      keyPattern: { trackId: 1, userId: 1 },
    };
  } else {
    error.keyPattern = { trackId: 1, userId: 1 };
  }

  return error;
}

for (const nested of [false, true]) {
  test(`retries a duplicate like with ${nested ? 'nested' : 'direct'} key metadata`, async (t) => {
    let trackReads = 0;
    let likeReads = 0;

    const db = mockDatabase(t, {
      track: () => makeTrack(trackReads++ === 0 ? 0 : 1),
      like: () => likeReads++ === 0 ? null : LIKE,
      createError: duplicateError(nested),
    });

    const result = await setTrackLikeState(TRACK_ID, USER_ID, true);

    assert.deepEqual(result, {
      trackId: TRACK_ID,
      isLiked: true,
      likesCount: 1,
    });

    assert.equal(db.transaction.mock.callCount(), 2);
    assert.notEqual(db.sessions[0], db.sessions[1]);
    assertWrites(db, [1, 0, 0]);
  });
}

test('stops after three duplicate-like transaction attempts', async (t) => {
  const error = duplicateError();

  const db = mockDatabase(t, {
    createError: error,
  });

  await assert.rejects(
    setTrackLikeState(TRACK_ID, USER_ID, true),
    (actual) => actual === error
  );

  assert.equal(db.transaction.mock.callCount(), 3);
  assertWrites(db, [3, 0, 0]);
});

test('does not retry an unrelated duplicate-key error', async (t) => {
  const error = Object.assign(
    new Error('Duplicate document ID'),
    {
      code: 11000,
      keyPattern: { _id: 1 },
    }
  );

  const db = mockDatabase(t, {
    createError: error,
  });

  await assert.rejects(
    setTrackLikeState(TRACK_ID, USER_ID, true),
    (actual) => actual === error
  );

  assert.equal(db.transaction.mock.callCount(), 1);
  assertWrites(db, [1, 0, 0]);
});