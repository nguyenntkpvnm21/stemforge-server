const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const mongoose = require('mongoose');

// Isolated test worker; no .env or production credentials are loaded.
process.env.JWT_SECRET = 'track-response-tests-only-signing-key-32-bytes';
const { createAccessToken } = require('../src/config/jwt');
const trackRoutes = require('../src/routes/track.routes');
const errorHandler = require('../src/middlewares/error.middleware');
const Track = require('../src/models/Track');
const User = require('../src/models/User');
const TrackLike = require('../src/models/TrackLike');
const sample = require('./fixtures/track-contract-draft.json');

const ownerId = sample.artistId;
const viewerId = '507f1f77bcf86cd799439099';
const secondId = '507f1f77bcf86cd799439022';
const privateId = '507f1f77bcf86cd799439033';
const artist = { _id: ownerId, username: 'Composer', avatarUrl: null };

async function startServer(t, { likedIds = [], missingAuthor = false, expectedFilter = { isPublic: true } } = {}) {
  const records = [
    new Track(sample),
    new Track({ ...sample, _id: secondId }),
    new Track({ ...sample, _id: privateId, isPublic: false }),
  ];
  const calls = { authors: [], likes: [], create: [], update: [], sorts: [] };
  const session = {};
  t.mock.method(mongoose.connection, 'transaction', async operation => operation(session));
  t.mock.method(User, 'findById', async id => ({ _id: id }));
  t.mock.method(User, 'find', filter => {
    calls.authors.push(filter);
    return {
      select() { return this; }, lean() { return this; },
      session(value) { assert.equal(value, session); return this; },
      async exec() {
        return missingAuthor ? [] : [{ ...artist, email: 'hidden@example.invalid', role: 'admin', passwordHash: 'test-only-hash' }];
      },
    };
  });
  t.mock.method(TrackLike, 'find', filter => {
    calls.likes.push(filter);
    return {
      select() { return this; }, lean() { return this; },
      session(value) { assert.equal(value, session); return this; },
      async exec() { return likedIds.map(trackId => ({ trackId })); },
    };
  });
  t.mock.method(Track, 'find', filter => {
    assert.deepEqual(filter, expectedFilter);
    let skip = 0;
    let limit = 12;
    let order;
    return {
      sort(value) { order = value; calls.sorts.push(value); return this; },
      skip(value) { skip = value; return this; },
      limit(value) { limit = value; return this; },
      async exec() {
        return records.filter(track => track.isPublic).sort((a, b) => {
          for (const [field, direction] of Object.entries(order)) {
            const left = field === '_id' ? String(a[field]) : a[field];
            const right = field === '_id' ? String(b[field]) : b[field];
            if (left < right) return -direction;
            if (left > right) return direction;
          }
          return 0;
        }).slice(skip, skip + limit);
      },
    };
  });
  t.mock.method(Track, 'countDocuments', filter => {
    assert.deepEqual(filter, expectedFilter);
    return { async exec() { return records.filter(track => track.isPublic).length; } };
  });
  t.mock.method(Track, 'findOne', filter => ({
    async exec() {
      return records.find(track => String(track._id) === filter._id && (
        track.isPublic || filter.$or?.some(part => String(part.artistId) === String(track.artistId))
      )) ?? null;
    },
  }));
  t.mock.method(Track, 'create', async ([payload], options) => {
    assert.equal(options.session, session);
    calls.create.push(payload);
    return [new Track({ ...payload, createdAt: new Date(sample.createdAt) })];
  });
  t.mock.method(Track, 'findOneAndUpdate', (filter, change, options) => ({
    async exec() {
      assert.equal(options.session, session);
      calls.update.push({ filter, change });
      const track = records.find(item => String(item._id) === filter._id && String(item.artistId) === String(filter.artistId));
      return track ? new Track({ ...track.toObject(), ...change.$set }) : null;
    },
  }));

  const app = express();
  app.use(express.json());
  app.use('/api/tracks', trackRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await once(server, 'listening');
  return {
    calls,
    async send(route = '', { userId, authorization, method = 'GET', body } = {}) {
      const headers = {};
      if (userId) headers.Authorization = `Bearer ${createAccessToken(userId)}`;
      if (authorization) headers.Authorization = authorization;
      if (body) headers['Content-Type'] = 'application/json';
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tracks${route}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, json: await response.json(), headers: response.headers };
    },
  };
}

test('guest list and detail include public author fields and false Like state', async (t) => {
  const server = await startServer(t);
  const list = await server.send();
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 2);
  assert.deepEqual(list.json.pagination, { page: 1, limit: 12, total: 2, totalPages: 1 });
  list.json.data.forEach(track => {
    assert.deepEqual(track.artist, artist);
    assert.equal(track.artistId, ownerId);
    assert.equal(track.likedByMe, false);
    assert.equal(track.isPublic, true);
  });
  assert.equal(server.calls.authors.length, 1);
  assert.equal(server.calls.likes.length, 0);
  const detail = await server.send(`/${sample._id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.data.artist, artist);
  assert.equal(detail.json.data.likedByMe, false);
  assert.equal(detail.headers.get('cache-control'), 'no-store');
});

test('authenticated list batches membership for visible page and detail reflects current user', async (t) => {
  const server = await startServer(t, { likedIds: [sample._id] });
  const response = await server.send('', { userId: viewerId });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.data.map(track => track.likedByMe), [false, true]);
  assert.equal(server.calls.authors.length, 1);
  assert.equal(server.calls.likes.length, 1);
  assert.deepEqual(server.calls.authors[0], { _id: { $in: [ownerId] } });
  assert.equal(String(server.calls.likes[0].userId), viewerId);
  assert.deepEqual(server.calls.likes[0].trackId.$in.map(String), [secondId, sample._id]);
  const detail = await server.send(`/${sample._id}`, { userId: viewerId });
  assert.equal(detail.json.data.likedByMe, true);
});

test('authenticated owner still gets only public Tracks in public listing', async (t) => {
  const server = await startServer(t);
  const response = await server.send('', { userId: ownerId });
  assert.equal(response.status, 200);
  assert.equal(response.json.data.some(track => track._id === privateId), false);
  assert.equal(response.json.pagination.total, 2);
});

test('invalid authorization on list or detail returns 401 before context lookups', async (t) => {
  const server = await startServer(t);
  for (const route of ['', `/${sample._id}`]) {
    for (const authorization of ['Basic invalid', 'Bearer invalid-token']) {
      const response = await server.send(route, { authorization });
      assert.equal(response.status, 401);
    }
  }
  assert.equal(server.calls.authors.length, 0);
  assert.equal(server.calls.likes.length, 0);
});

test('private Track is hidden from guest/other user and enriched for its owner', async (t) => {
  const server = await startServer(t, { likedIds: [privateId] });
  assert.equal((await server.send(`/${privateId}`)).status, 404);
  assert.equal((await server.send(`/${privateId}`, { userId: viewerId })).status, 404);
  assert.equal(server.calls.authors.length, 0);
  assert.equal(server.calls.likes.length, 0);
  const owner = await server.send(`/${privateId}`, { userId: ownerId });
  assert.equal(owner.status, 200);
  assert.equal(owner.json.data.isPublic, false);
  assert.deepEqual(owner.json.data.artist, artist);
  assert.equal(owner.json.data.likedByMe, true);
});

test('missing author returns null without hiding an otherwise accessible Track', async (t) => {
  const server = await startServer(t, { missingAuthor: true });
  const detail = await server.send(`/${sample._id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.artist, null);
  assert.equal(detail.json.data.artistId, ownerId);
  const list = await server.send();
  assert.equal(list.json.data.length, 2);
  assert.equal(list.json.data.every(track => track.artist === null), true);
});

test('POST and PATCH return the same enriched Track shape without storing response fields', async (t) => {
  const server = await startServer(t, { likedIds: [sample._id] });
  const input = {
    title: sample.title, genre: sample.genre, bpm: sample.bpm, key: sample.key,
    isPublic: true, isDownloadable: false,
    stems: sample.stems.map(({ name, audioUrl, duration, fileSize }) => ({ name, audioUrl, duration, fileSize })),
  };
  const created = await server.send('', { userId: ownerId, method: 'POST', body: input });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.data.artist, artist);
  assert.equal(created.json.data.likedByMe, false);
  assert.equal(server.calls.create[0].artist, undefined);
  assert.equal(server.calls.create[0].likedByMe, undefined);
  const updated = await server.send(`/${sample._id}`, { userId: ownerId, method: 'PATCH', body: { title: 'Updated' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.title, 'Updated');
  assert.deepEqual(updated.json.data.artist, artist);
  assert.equal(updated.json.data.likedByMe, true);
  assert.deepEqual(server.calls.update[0].change, { $set: { title: 'Updated' } });
  const foreign = await server.send(`/${sample._id}`, { userId: viewerId, method: 'PATCH', body: { title: 'Forbidden' } });
  assert.equal(foreign.status, 404);
});

test('Swagger response and request schemas agree with the implemented contract', () => {
  const spec = require('../src/config/swagger');
  const schemas = spec.components.schemas;
  assert.match(spec.paths['/api/tracks/{trackId}'].delete.description, /Likes.*same transaction/);
  assert.equal(schemas.Track.properties.artist.nullable, true);
  assert.equal(schemas.Track.properties.artist.readOnly, true);
  assert.equal(schemas.Track.properties.artist.additionalProperties, false);
  assert.deepEqual(Object.keys(schemas.Track.properties.artist.properties).sort(), ['_id', 'avatarUrl', 'username']);
  assert.equal(schemas.Track.properties.likedByMe.readOnly, true);
  assert.equal(schemas.Track.properties.likedByMe.type, 'boolean');
  for (const field of ['artist', 'likedByMe']) {
    assert.ok(schemas.Track.required.includes(field));
    assert.equal(schemas.CreateTrackRequest.properties[field], undefined);
    assert.equal(schemas.UpdateTrackRequest.properties[field], undefined);
  }
  assert.deepEqual(spec.paths['/api/tracks'].get.security, [{}, { bearerAuth: [] }]);
  assert.ok(spec.paths['/api/tracks'].get.responses['401']);
  for (const [route, method, responseCode] of [
    ['/api/tracks', 'get', '200'], ['/api/tracks', 'post', '201'],
    ['/api/tracks/{trackId}', 'get', '200'], ['/api/tracks/{trackId}', 'patch', '200'],
  ]) {
    const response = spec.paths[route][method].responses[responseCode].content['application/json'].schema;
    assert.equal(response.$ref, `#/components/schemas/${method === 'get' && route === '/api/tracks' ? 'TrackListResponse' : 'TrackResponse'}`);
  }
});

test('filtered HTTP list preserves pagination, artist, viewer membership and optional authentication', async (t) => {
  const server = await startServer(t, { likedIds: [sample._id], expectedFilter: {
    isPublic: true, title: { $regex: 'demo', $options: 'i' }, genre: { $regex: '^electronic$', $options: 'i' },
    key: { $regex: '^am$', $options: 'i' }, bpm: { $gte: 128, $lte: 128 },
  } });
  const query = '?q=demo&genre=electronic&key=am&bpmMin=128&bpmMax=128&page=2&limit=1';
  const response = await server.send(query, { userId: viewerId });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.pagination, { page: 2, limit: 1, total: 2, totalPages: 2 });
  assert.equal(response.json.data.length, 1);
  assert.equal(response.json.data[0]._id, sample._id);
  assert.deepEqual(response.json.data[0].artist, artist);
  assert.equal(response.json.data[0].likedByMe, true);
  assert.deepEqual(server.calls.likes[0].trackId.$in.map(String), [sample._id]);
  assert.equal((await server.send(query)).json.data[0].likedByMe, false);
  assert.equal((await server.send(query, { authorization: 'Bearer invalid' })).status, 401);
});

test('HTTP query parser rejects repeated, nested/operator and unsupported filters', async (t) => {
  const server = await startServer(t);
  for (const query of [
    '?q=one&q=two', '?genre=Jazz&genre=Rock', '?key[]=Am', '?q[$regex]=.*', '?genre[$ne]=Jazz',
    '?bpmMin[$gte]=120', '?bpmMax=120&bpmMax=130', '?$where=true', '?isPublic=false',
    '?sort=likesCount', '?tags=rock', '?q=%20%20', '?bpmMin=130&bpmMax=120', '?bpmMax=Infinity',
    '?tag=a&tag=b', '?tag[$ne]=Jazz', '?tag[]=Jazz', '?tag=%20%20', '?sort=',
    '?sort=newest&sort=mostLiked', '?sort[$gt]=newest', '?sort=MostLiked',
  ]) {
    const response = await server.send(query);
    assert.equal(response.status, 400, query);
    assert.equal(typeof response.json.message, 'string');
  }
  assert.equal(server.calls.authors.length, 0);
  assert.equal(server.calls.likes.length, 0);
});

for (const [parameter, field] of Object.entries({ q: 'title', genre: 'genre', key: 'key', tag: 'tags' })) {
  test('HTTP ' + parameter + '=%00 returns 400 before any database lookup', async (t) => {
    const server = await startServer(t);
    for (const value of ['%00', '%00demo', 'de%00mo', 'demo%00', '%20demo%00%20']) {
      const response = await server.send('?' + parameter + '=' + value);
      assert.equal(response.status, 400);
      assert.deepEqual(response.json, { message: parameter + ' must not contain U+0000 (NUL).' });
    }
    for (const operation of [Track.find, Track.countDocuments, User.find, User.findById, TrackLike.find]) {
      assert.equal(operation.mock.calls.length, 0);
    }
  });

  test('HTTP ' + parameter + ' still accepts trimmed literal regex characters and textual NUL representations', async (t) => {
    const literal = 'Demo.*[Live]+\\u0000 %00';
    const escaped = 'Demo\\.\\*\\[Live\\]\\+\\\\u0000 %00';
    const server = await startServer(t, { expectedFilter: {
      isPublic: true, [field]: { $regex: parameter === 'q' ? escaped : '^' + escaped + '$', $options: 'i' },
    } });
    const response = await server.send('?' + parameter + '=' + encodeURIComponent('  ' + literal + '  '));
    assert.equal(response.status, 200);
    assert.equal(Track.find.mock.calls.length, 1);
    assert.equal(Track.countDocuments.mock.calls.length, 1);
    assert.equal(response.json.pagination.total, 2);
  });
}

test('Swagger documents supported list filters, length limits and inclusive BPM semantics', () => {
  const operation = require('../src/config/swagger').paths['/api/tracks'].get;
  const parameters = Object.fromEntries(operation.parameters.map(p => [p.name, p]));
  assert.deepEqual(Object.keys(parameters).sort(), ['bpmMax', 'bpmMin', 'genre', 'key', 'limit', 'page', 'q', 'sort', 'tag']);
  for (const name of ['q', 'genre', 'key', 'tag']) assert.equal(parameters[name].schema.maxLength, 100);
  assert.deepEqual(parameters.sort.schema.enum, ['newest', 'mostLiked']);
  assert.equal(parameters.sort.schema.default, 'newest');
  for (const name of ['bpmMin', 'bpmMax']) assert.match(parameters[name].description, /[Ii]nclusive/);
  assert.match(operation.description, /AND/);
  assert.match(operation.description, /literal/);
  assert.match(operation.description, /U\+0000 \(NUL\).*400/);
});

test('tag/mostLiked HTTP pagination uses deterministic ties and retains viewer context and total', async (t) => {
  const server = await startServer(t, { likedIds: [sample._id], expectedFilter: {
    isPublic: true, tags: { $regex: '^DEMO$', $options: 'i' },
  } });
  const response = await server.send('?tag=%20DEMO%20&sort=mostLiked&page=2&limit=1', { userId: viewerId });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.pagination, { page: 2, limit: 1, total: 2, totalPages: 2 });
  assert.equal(response.json.data[0]._id, sample._id);
  assert.equal(response.json.data[0].likedByMe, true);
  assert.deepEqual(response.json.data[0].artist, artist);
  assert.deepEqual(server.calls.sorts[0], { likesCount: -1, createdAt: -1, _id: -1 });
  const newest = await server.send('?tag=%20DEMO%20&sort=newest&page=2&limit=1');
  assert.deepEqual(newest.json.pagination, response.json.pagination);
  assert.equal(newest.json.data[0].likedByMe, false);
  assert.equal((await server.send('?tag=DEMO&sort=mostLiked', { authorization: 'Bearer invalid' })).status, 401);
});
