const { test } = require('node:test');
const assert = require('node:assert/strict');

const Track = require('../src/models/Track');
const trackResponseService = require('../src/services/track-response.service');
const { listTracks, listMyTracks } = require('../src/controllers/track.controller');
const sample = require('./fixtures/track-contract-draft.json');

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

function mockDatabase(t, options = {}) {
  const {
    tracks = [],
    total = 0,
    findError,
    countError,
  } = options;

  const calls = {};
  const enrich = t.mock.method(trackResponseService, 'enrichTracks', async (items) => (
    items.map((track) => ({ ...track, artist: null, likedByMe: false }))
  ));

  const query = {
    sort(value) {
      calls.sort = value;
      return this;
    },

    skip(value) {
      calls.skip = value;
      return this;
    },

    limit(value) {
      calls.limit = value;
      return this;
    },

    async exec() {
      if (findError) {
        throw findError;
      }

      return tracks;
    },
  };

  const find = t.mock.method(Track, 'find', (filter) => {
    calls.findFilter = filter;
    return query;
  });

  const count = t.mock.method(Track, 'countDocuments', (filter) => {
    calls.countFilter = filter;

    return {
      async exec() {
        if (countError) {
          throw countError;
        }

        return total;
      },
    };
  });

  return { calls, find, count, enrich };
}

test('returns an empty list with default pagination', async (t) => {
  const { calls, find, count } = mockDatabase(t);
  const res = makeResponse();
  const next = t.mock.fn();

  await listTracks({ query: {} }, res, next);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    data: [],
    pagination: {
      page: 1,
      limit: 12,
      total: 0,
      totalPages: 0,
    },
  });

  assert.deepEqual(calls.findFilter, { isPublic: true });
  assert.deepEqual(calls.countFilter, { isPublic: true });
  assert.deepEqual(calls.sort, { createdAt: -1, _id: -1 });
  assert.equal(calls.skip, 0);
  assert.equal(calls.limit, 12);
  assert.equal(find.mock.calls.length, 1);
  assert.equal(count.mock.calls.length, 1);
  assert.equal(next.mock.calls.length, 0);
});

test('returns tracks with the requested page and limit', async (t) => {
  const tracks = [structuredClone(sample)];
  const { calls, enrich } = mockDatabase(t, { tracks, total: 6 });
  const res = makeResponse();
  const next = t.mock.fn();

  await listTracks(
    { query: { page: '2', limit: '5' } },
    res,
    next
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    data: tracks.map((track) => ({ ...track, artist: null, likedByMe: false })),
    pagination: {
      page: 2,
      limit: 5,
      total: 6,
      totalPages: 2,
    },
  });

  assert.deepEqual(calls.findFilter, { isPublic: true });
  assert.deepEqual(calls.countFilter, { isPublic: true });
  assert.deepEqual(calls.sort, { createdAt: -1, _id: -1 });
  assert.equal(calls.skip, 5);
  assert.equal(calls.limit, 5);
  assert.deepEqual(enrich.mock.calls[0].arguments, [tracks, undefined]);
  assert.equal(next.mock.calls.length, 0);
});

test('uses one AND filter for data and total while retaining sort, pagination and viewer context', async (t) => {
  const tracks = [structuredClone(sample)];
  const { calls, enrich } = mockDatabase(t, { tracks, total: 5 });
  const res = makeResponse();
  const next = t.mock.fn();
  const viewerId = '507f1f77bcf86cd799439099';
  await listTracks({ query: {
    q: ' Demo.* ', genre: ' Electronic ', key: 'Am', bpmMin: '120.5', bpmMax: '130', page: '2', limit: '2',
  }, user: { _id: viewerId } }, res, next);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.findFilter, {
    isPublic: true, title: { $regex: 'Demo\\.\\*', $options: 'i' },
    genre: { $regex: '^Electronic$', $options: 'i' }, key: { $regex: '^Am$', $options: 'i' },
    bpm: { $gte: 120.5, $lte: 130 },
  });
  assert.equal(calls.findFilter, calls.countFilter);
  assert.deepEqual(calls.sort, { createdAt: -1, _id: -1 });
  assert.equal(calls.skip, 2);
  assert.equal(calls.limit, 2);
  assert.deepEqual(res.body.pagination, { page: 2, limit: 2, total: 5, totalPages: 3 });
  assert.deepEqual(enrich.mock.calls[0].arguments, [tracks, viewerId]);
  assert.equal(next.mock.calls.length, 0);
});

for (const field of ['q', 'genre', 'key', 'tag']) {
  test(field + ' containing NUL returns 400 without data/count/context queries', async (t) => {
    const { find, count, enrich } = mockDatabase(t);
    const res = makeResponse();
    const next = t.mock.fn();
    await listTracks({ query: { [field]: 'valid\u0000text' } }, res, next);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { message: field + ' must not contain U+0000 (NUL).' });
    for (const operation of [find, count, enrich, next]) assert.equal(operation.mock.calls.length, 0);
  });
}

for (const query of [{ q: '' }, { genre: { $ne: '' } }, { bpmMin: '140', bpmMax: '120' }, { isPublic: 'false' },
  { tag: ['Jazz', 'Rock'] }, { tag: { $ne: '' } }, { sort: ['newest', 'mostLiked'] }, { sort: 'likesCount' }]) {
  test('invalid filters return 400 before any database reads: ' + JSON.stringify(query), async (t) => {
    const { find, count, enrich } = mockDatabase(t);
    const res = makeResponse();
    const next = t.mock.fn();
    await listTracks({ query }, res, next);
    assert.equal(res.statusCode, 400);
    assert.equal(typeof res.body.message, 'string');
    assert.equal(find.mock.calls.length, 0);
    assert.equal(count.mock.calls.length, 0);
    assert.equal(enrich.mock.calls.length, 0);
    assert.equal(next.mock.calls.length, 0);
  });
}

for (const sort of [undefined, 'newest', 'mostLiked']) {
  test('tag filter and sort=' + sort + ' retain total, pagination and viewer enrichment', async (t) => {
    const tracks = [structuredClone(sample)];
    const { calls, enrich } = mockDatabase(t, { tracks, total: 5 });
    const res = makeResponse();
    const next = t.mock.fn();
    const user = { _id: sample.artistId };
    await listTracks({ query: { tag: ' Demo.* ', sort, page: '2', limit: '2' }, user }, res, next);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.findFilter, { isPublic: true, tags: { $regex: '^Demo\\.\\*$', $options: 'i' } });
    assert.equal(calls.findFilter, calls.countFilter);
    assert.equal(Object.hasOwn(calls.findFilter, 'sort'), false);
    assert.deepEqual(calls.sort, sort === 'mostLiked' ? { likesCount: -1, createdAt: -1, _id: -1 } : { createdAt: -1, _id: -1 });
    assert.deepEqual(res.body.pagination, { page: 2, limit: 2, total: 5, totalPages: 3 });
    assert.equal(calls.skip, 2);
    assert.deepEqual(enrich.mock.calls[0].arguments, [tracks, user._id]);
    assert.equal(next.mock.calls.length, 0);
  });
}

const invalidCases = [
  [
    'rejects page zero',
    { page: '0' },
    'page must be a positive integer.',
  ],
  [
    'rejects a decimal page',
    { page: '1.5' },
    'page must be a positive integer.',
  ],
  [
    'rejects multiple page values',
    { page: ['1', '2'] },
    'page must be a positive integer.',
  ],
  [
    'rejects an unsafe page integer',
    { page: '9007199254740992' },
    'page must be a positive integer.',
  ],
  [
    'rejects limit zero',
    { limit: '0' },
    'limit must be an integer between 1 and 100.',
  ],
  [
    'rejects a limit above 100',
    { limit: '101' },
    'limit must be an integer between 1 and 100.',
  ],
  [
    'rejects a decimal limit',
    { limit: '1.5' },
    'limit must be an integer between 1 and 100.',
  ],
  [
    'rejects an unsafe pagination offset',
    { page: '9007199254740991', limit: '2' },
    'The requested page is too large.',
  ],
];

for (const [name, query, message] of invalidCases) {
  test(name, async (t) => {
    const { find, count } = mockDatabase(t);
    const res = makeResponse();
    const next = t.mock.fn();

    await listTracks({ query }, res, next);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { message });
    assert.equal(find.mock.calls.length, 0);
    assert.equal(count.mock.calls.length, 0);
    assert.equal(next.mock.calls.length, 0);
  });
}

for (const operation of ['find', 'count']) {
  test('forwards a database ' + operation + ' error to next', async (t) => {
    const error = new Error('Database unavailable');

    mockDatabase(t, {
      findError: operation === 'find' ? error : undefined,
      countError: operation === 'count' ? error : undefined,
    });

    const res = makeResponse();
    const next = t.mock.fn();

    await listTracks({ query: {} }, res, next);

    assert.equal(next.mock.calls.length, 1);
    assert.equal(next.mock.calls[0].arguments[0], error);
    assert.equal(res.statusCode, null);
    assert.equal(res.body, undefined);
  });
}

test('mine defensively requires an authenticated account before database queries', async (t) => {
  const { find, count, enrich } = mockDatabase(t);
  const res = makeResponse();
  await listMyTracks({ query: {} }, res, t.mock.fn());
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Authentication required.' });
  for (const operation of [find, count, enrich]) assert.equal(operation.mock.calls.length, 0);
});

test('mine uses the same owner-only condition for data/total, with no visibility predicate', async (t) => {
  const user = { _id: sample.artistId };
  const tracks = [structuredClone(sample), { ...structuredClone(sample), isPublic: false }];
  const { calls, enrich } = mockDatabase(t, { tracks, total: 4 });
  const res = makeResponse();
  const next = t.mock.fn();
  await listMyTracks({ user, query: { page: '2', limit: '2' } }, res, next);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.findFilter, { artistId: user._id });
  assert.equal(calls.findFilter, calls.countFilter);
  assert.deepEqual(calls.sort, { createdAt: -1, _id: -1 });
  assert.equal(calls.skip, 2);
  assert.equal(calls.limit, 2);
  assert.deepEqual(enrich.mock.calls[0].arguments, [tracks, user._id]);
  assert.deepEqual(res.body.pagination, { page: 2, limit: 2, total: 4, totalPages: 2 });
  assert.equal(res.body.data[1].isPublic, false);
  assert.equal(next.mock.calls.length, 0);
});

test('mine returns default pagination for an account without Tracks', async (t) => {
  const { calls } = mockDatabase(t);
  const res = makeResponse();
  await listMyTracks({ user: { _id: sample.artistId }, query: {} }, res, t.mock.fn());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { data: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 0 } });
  assert.equal(calls.skip, 0);
  assert.equal(calls.limit, 12);
});

for (const field of ['artistId', 'isPublic', 'q', 'genre', 'key', 'bpmMin', 'bpmMax', 'tag', 'sort', '$or', 'page[$gt]']) {
  test('mine rejects unsupported scope/filter parameter ' + field + ' before Track reads', async (t) => {
    const { find, count, enrich } = mockDatabase(t);
    const res = makeResponse();
    await listMyTracks({ user: { _id: sample.artistId }, query: { [field]: 'anything' } }, res, t.mock.fn());
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { message: 'Query contains unsupported My Tracks parameters.' });
    for (const operation of [find, count, enrich]) assert.equal(operation.mock.calls.length, 0);
  });
}

for (const [name, query, message] of invalidCases) {
  test('mine ' + name, async (t) => {
    const { find, count, enrich } = mockDatabase(t);
    const res = makeResponse();
    await listMyTracks({ user: { _id: sample.artistId }, query }, res, t.mock.fn());
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { message });
    for (const operation of [find, count, enrich]) assert.equal(operation.mock.calls.length, 0);
  });
}

for (const operation of ['find', 'count', 'enrichment']) {
  test('mine forwards ' + operation + ' failure without returning success', async (t) => {
    const error = new Error('Database unavailable');
    const mocks = mockDatabase(t, {
      findError: operation === 'find' ? error : undefined,
      countError: operation === 'count' ? error : undefined,
    });
    if (operation === 'enrichment') mocks.enrich.mock.mockImplementation(async () => { throw error; });
    const res = makeResponse();
    const next = t.mock.fn();
    await listMyTracks({ user: { _id: sample.artistId }, query: {} }, res, next);
    assert.equal(next.mock.calls.length, 1);
    assert.equal(next.mock.calls[0].arguments[0], error);
    assert.equal(res.statusCode, null);
    assert.equal(res.body, undefined);
  });
}
