const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const service = require('../src/services/track-like.service');

const {
  getTrackLike,
  likeTrack,
  unlikeTrack,
} = require('../src/controllers/track-like.controller');

const TRACK_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f1f77bcf86cd799439012';

const operations = [
  {
    name: 'GET',
    handler: getTrackLike,
    serviceMethod: 'getTrackLikeState',
    isLiked: true,
    likesCount: 3,
  },
  {
    name: 'PUT',
    handler: likeTrack,
    serviceMethod: 'setTrackLikeState',
    desiredState: true,
    isLiked: true,
    likesCount: 3,
  },
  {
    name: 'DELETE',
    handler: unlikeTrack,
    serviceMethod: 'setTrackLikeState',
    desiredState: false,
    isLiked: false,
    likesCount: 2,
  },
];

function makeRequest(trackId = TRACK_ID) {
  return {
    params: { trackId },
    user: {
      _id: new mongoose.Types.ObjectId(USER_ID),
    },
    body: {
      trackId: '507f1f77bcf86cd799439099',
      userId: '507f1f77bcf86cd799439098',
      likesCount: 999,
    },
  };
}

function makeResponse() {
  return {
    statusCode: null,
    body: undefined,
    headers: {},

    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },

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

function mockService(t, result, error) {
  const implementation = async () => {
    if (error) {
      throw error;
    }

    return result;
  };

  return {
    getTrackLikeState: t.mock.method(
      service,
      'getTrackLikeState',
      implementation
    ),
    setTrackLikeState: t.mock.method(
      service,
      'setTrackLikeState',
      implementation
    ),
  };
}

function assertNoServiceCalls(mocks) {
  assert.equal(mocks.getTrackLikeState.mock.callCount(), 0);
  assert.equal(mocks.setTrackLikeState.mock.callCount(), 0);
}

function assertServiceCall(mocks, operation) {
  const selected = mocks[operation.serviceMethod];

  const other = operation.serviceMethod === 'getTrackLikeState'
    ? mocks.setTrackLikeState
    : mocks.getTrackLikeState;

  assert.equal(selected.mock.callCount(), 1);
  assert.equal(other.mock.callCount(), 0);

  const expectedArguments = [TRACK_ID, USER_ID];

  if (operation.desiredState !== undefined) {
    expectedArguments.push(operation.desiredState);
  }

  assert.deepEqual(
    selected.mock.calls[0].arguments,
    expectedArguments
  );
}

async function invoke(operation, req) {
  const res = makeResponse();
  const nextCalls = [];

  await operation.handler(req, res, (error) => {
    nextCalls.push(error);
  });

  return { res, nextCalls };
}

for (const operation of operations) {
  test(`${operation.name} returns service state using the authenticated user`, async (t) => {
    const state = {
      trackId: TRACK_ID,
      isLiked: operation.isLiked,
      likesCount: operation.likesCount,
    };

    const mocks = mockService(t, state);
    const req = makeRequest();

    // Client input must not override the route's intended state.
    req.body.isLiked = !operation.isLiked;

    const { res, nextCalls } = await invoke(operation, req);

    assertServiceCall(mocks, operation);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { data: state });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(nextCalls, []);
  });

  test(`${operation.name} rejects an unauthenticated request`, async (t) => {
    const mocks = mockService(t);
    const req = makeRequest();

    delete req.user;

    const { res, nextCalls } = await invoke(operation, req);

    assertNoServiceCalls(mocks);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      message: 'Authentication required.',
    });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(nextCalls, []);
  });

  for (const [name, trackId] of [
    ['a short ID', 'invalid-id'],
    ['a non-hex ID', 'z'.repeat(24)],
    ['an array ID', [TRACK_ID]],
  ]) {
    test(`${operation.name} rejects ${name}`, async (t) => {
      const mocks = mockService(t);

      const { res, nextCalls } = await invoke(
        operation,
        makeRequest(trackId)
      );

      assertNoServiceCalls(mocks);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, {
        message: 'trackId must be a valid MongoDB ObjectId.',
      });
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual(nextCalls, []);
    });
  }

  test(`${operation.name} returns 404 for an inaccessible Track`, async (t) => {
    const error = new service.TrackLikeError(
      404,
      'Track not found'
    );

    const mocks = mockService(t, undefined, error);

    const { res, nextCalls } = await invoke(
      operation,
      makeRequest()
    );

    assertServiceCall(mocks, operation);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, {
      message: 'Track not found',
    });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(nextCalls, []);
  });

  test(`${operation.name} forwards an unexpected error`, async (t) => {
    const error = new Error('Database unavailable');
    const mocks = mockService(t, undefined, error);

    const { res, nextCalls } = await invoke(
      operation,
      makeRequest()
    );

    assertServiceCall(mocks, operation);
    assert.equal(res.statusCode, null);
    assert.equal(res.body, undefined);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(nextCalls, [error]);
  });
}