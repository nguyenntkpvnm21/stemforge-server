const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { selection, startFixture, startUploads, trackInput, publish } = require('./helpers/multi-stem-publish.fixture');
const idempotency = require('../src/services/track-create-idempotency.service');

async function setup(t, count = 1) {
  const slots = selection(count);
  const f = await startFixture(t, slots);
  const token = await f.login();
  const uploads = startUploads(f, slots, token);
  for (const slot of slots) {
    await f.waitForUpload(slot.clientId); f.release(slot.clientId);
    await uploads.waitForResult(slot.clientId);
  }
  await uploads.done;
  const input = trackInput(slots, uploads.results);
  const key = randomUUID();
  const post = (body = input, value = key, auth = token) => f.send('/api/tracks', {
    token: auth, method: 'POST', body, headers: value === undefined ? {} : { 'Idempotency-Key': value },
  });
  return { f, token, input, key, post };
}

test('HTTP keyed four-stem creation and replay preserve exact JSON, headers and initial public artist allowlist', async t => {
  const { f, token, input, post } = await setup(t, 4);
  const first = await post();
  assert.equal(first.status, 201);
  assert.equal(first.headers.get('idempotency-replayed'), 'false');
  assert.equal(first.body.data.stems.length, 4);
  assert.deepEqual(first.body.data.stems.map(s => s.name), ['Drums', 'Bass', 'Chords', 'Lead']);
  assert.deepEqual(Object.keys(first.body.data.artist).sort(), ['_id', 'avatarUrl', 'username']);
  const replay = await post(Object.fromEntries(Object.entries(input).reverse()));
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.equal(replay.headers.get('idempotency-key-expires-at'), first.headers.get('idempotency-key-expires-at'));
  assert.deepEqual(replay.body, first.body);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.receipts.size, 1);
  const detail = await f.send('/api/tracks/' + first.body.data._id, { token });
  assert.deepEqual(detail.body, first.body);
});

test('HTTP payload mismatch is 409; invalid input/auth does not access or consume the key', async t => {
  const { f, post, input } = await setup(t);
  const invalid = await post({ ...input, bpm: '96' });
  assert.equal(invalid.status, 400);
  assert.equal((await post(input, undefined, 'bad-token')).status, 401);
  assert.equal(f.calls.receiptReads, 0);
  assert.equal(f.receipts.size, 0);
  const first = await post();
  assert.equal(first.status, 201);
  const conflict = await post({ ...input, title: 'Different operation' });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, { message: idempotency.MESSAGES.mismatch });
  assert.equal(conflict.headers.get('retry-after'), null);
  assert.equal(f.calls.creates.length, 1);
});

test('HTTP invalid ASCII/header values are rejected and a raw repeated header is 400', async t => {
  const { f, post, input, key, token } = await setup(t);
  for (const value of ['', 'short', 'a'.repeat(129), 'a'.repeat(16) + ',duplicate', 'a'.repeat(16) + ' ', 'a'.repeat(16) + ':é']) {
    // Node normalizes outer HTTP whitespace; test an embedded space instead.
    const response = await post(input, value.endsWith(' ') ? 'a'.repeat(8) + ' ' + 'b'.repeat(8) : value);
    assert.equal(response.status, 400);
  }
  // fixture send intentionally exposes only its own local origin, not arbitrary URLs.
  const app = require('../src/app');
  const server = http.createServer(app);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/tracks', method: 'POST',
      headers: ['Host', '127.0.0.1', 'Content-Length', String(Buffer.byteLength(JSON.stringify(input))),
        'Authorization', 'Bearer ' + token, 'Content-Type', 'application/json',
        'Idempotency-Key', key, 'idempotency-key', key] }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.setTimeout(5000, () => request.destroy(new Error('Loopback deadline')));
    request.on('error', reject); request.end(JSON.stringify(input));
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { message: idempotency.MESSAGES.invalid });
  assert.equal(f.calls.receiptReads, 0);
});

test('receipt replay remains original after actual HTTP PATCH and DELETE; Track is not recreated', async t => {
  const { f, post, token } = await setup(t);
  const first = await post();
  const path = '/api/tracks/' + first.body.data._id;
  assert.equal((await f.send(path, { method: 'PATCH', token, body: { title: 'Changed title', isPublic: false } })).status, 200);
  assert.deepEqual((await post()).body, first.body);
  assert.equal((await f.send(path, { method: 'DELETE', token })).status, 204);
  assert.equal((await f.send(path, { token })).status, 404);
  assert.deepEqual((await post()).body, first.body);
  assert.equal(f.records.length, 0);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.receipts.size, 1);
});

test('replay keeps original counters/membership after the current Like state changes', async t => {
  const { f, post, token } = await setup(t);
  const first = await post();
  f.records[0].likesCount = 1;
  const TrackLike = require('../src/models/TrackLike');
  t.mock.method(TrackLike, 'find', () => ({
    select() { return this; }, lean() { return this; },
    async exec() { return [{ trackId: first.body.data._id }]; },
  }));
  const current = await f.send('/api/tracks/' + first.body.data._id, { token });
  assert.equal(current.body.data.likedByMe, true);
  assert.equal(current.body.data.likesCount, 1);
  assert.deepEqual((await post()).body, first.body);
});

for (const timing of ['before-handler', 'after-commit']) {
  test('multi-stem HTTP loss ' + timing + ': retry the same key without reupload or duplicate Track', async t => {
    const { f, token, input, key, post } = await setup(t);
    f.loseNextCreateResponse(timing);
    assert.deepEqual(await publish(f, input, token, key), { state: 'unknown' });
    const committed = timing === 'after-commit' ? f.records[0].toJSON() : null;
    const retry = await post();
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get('idempotency-replayed'), String(timing === 'after-commit'));
    if (committed) assert.equal(retry.body.data._id, String(committed._id));
    assert.equal(f.calls.creates.length, 1);
    assert.equal(f.calls.uploads.length, 1);
    assert.equal(f.receipts.size, 1);
    assert.equal((await f.send('/api/tracks/mine', { token })).body.pagination.total, 1);
  });
}

test('HTTP no-key callers keep the legacy path and never query receipts', async t => {
  const { f, input, token } = await setup(t);
  for (let i = 0; i < 2; i += 1) assert.equal((await f.send('/api/tracks', { token, method: 'POST', body: input })).status, 201);
  assert.equal(f.calls.receiptReads, 0);
  assert.equal(f.receipts.size, 0);
  assert.equal(f.records.length, 2);
});

for (const [status, message] of [[409, idempotency.MESSAGES.busy], [503, idempotency.MESSAGES.unknown]]) {
  test('HTTP renders known ' + status + ' with Retry-After and exposed CORS headers', async t => {
    const { f, token, key, input } = await setup(t);
    t.mock.method(idempotency, 'createTrackWithKey', async () => {
      throw new idempotency.IdempotencyError(status, message, 1);
    });
    const response = await f.send('/api/tracks', { token, method: 'POST', body: input,
      headers: { 'Idempotency-Key': key, Origin: 'http://localhost:5173' } });
    assert.equal(response.status, status);
    assert.deepEqual(response.body, { message });
    assert.equal(response.headers.get('retry-after'), '1');
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.match(response.headers.get('access-control-expose-headers'), /Retry-After/);
  });
}

test('Swagger documents optional POST-only key and 201/409/503 headers without changing Track inputs', () => {
  const spec = require('../src/config/swagger');
  const operation = spec.paths['/api/tracks'].post;
  assert.ok(operation.parameters.some(p => p.name === 'Idempotency-Key' && p.required === false));
  assert.ok(operation.responses['201'].headers['Idempotency-Replayed']);
  assert.ok(operation.responses['201'].headers['Idempotency-Key-Expires-At']);
  assert.ok(operation.responses['409'].headers['Retry-After']);
  assert.ok(operation.responses['503'].headers['Retry-After']);
  assert.equal(spec.components.schemas.CreateTrackRequest.properties.idempotencyKey, undefined);
});
