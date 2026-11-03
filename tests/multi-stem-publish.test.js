const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { selection, startFixture, startUploads, trackInput, publish } = require('./helpers/multi-stem-publish.fixture');

async function finishUploads(f, slots, token) {
  const uploads = startUploads(f, slots, token);
  for (const slot of slots) {
    await f.waitForUpload(slot.clientId);
    f.release(slot.clientId);
    await uploads.waitForResult(slot.clientId);
  }
  await uploads.done;
  return uploads.results;
}

async function verifyReadback(f, track, input, token) {
  assert.match(track._id, /^[a-f0-9]{24}$/);
  assert.equal(track.artistId, f.ownerId);
  assert.deepEqual(track.artist, { _id: f.ownerId, username: 'Publish fixture', avatarUrl: null });
  assert.equal(track.likedByMe, false);
  assert.equal(track.likesCount, 0);
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'stems') assert.deepEqual(track[key], value);
  }
  assert.equal(new Set(track.stems.map(stem => stem.stemId)).size, input.stems.length);
  track.stems.forEach((stem, index) => {
    assert.match(stem.stemId, /^[a-f0-9]{24}$/);
    assert.deepEqual(Object.keys(stem).sort(), ['audioUrl', 'duration', 'fileSize', 'name', 'stemId']);
    const { stemId, ...metadata } = stem;
    assert.deepEqual(metadata, input.stems[index]);
  });
  input.stems.forEach(stem => assert.deepEqual(Object.keys(stem).sort(), ['audioUrl', 'duration', 'fileSize', 'name']));
  const detail = await f.send(`/api/tracks/${track._id}`, { token });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.data, track);
  const mine = await f.send('/api/tracks/mine', { token });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.data, [track]);
  assert.deepEqual(mine.body.pagination, { page: 1, limit: 12, total: 1, totalPages: 1 });
  assert.equal(f.calls.commits, 1);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].toObject().artist, undefined);
  assert.equal(f.records[0].toObject().likedByMe, undefined);
  assert.equal(f.records[0].toObject().stems.some(stem => 'publicId' in stem), false);
}

test('HTTP login -> one audio upload -> private Track -> owner detail/My Tracks', async t => {
  const slots = selection(1);
  const f = await startFixture(t, slots);
  const token = await f.login();
  const results = await finishUploads(f, slots, token);
  const input = trackInput(slots, results, { isPublic: false });
  const outcome = await publish(f, input, token);
  assert.equal(outcome.state, 'published');
  assert.equal(f.assets.size, 1);
  await verifyReadback(f, outcome.track, input, token);
});

test('four HTTP uploads finish Bass/Chords/Lead/Drums but selected names/order/IDs survive POST and reads', async t => {
  const slots = selection();
  const f = await startFixture(t, slots);
  const token = await f.login();
  const uploads = startUploads(f, slots, token);
  const order = [slots[1], slots[2], slots[3], slots[0]];
  for (const slot of order) {
    await f.waitForUpload(slot.clientId);
    f.release(slot.clientId);
    await uploads.waitForResult(slot.clientId);
  }
  await uploads.done;
  assert.deepEqual(uploads.completionOrder, order.map(slot => slot.clientId));
  assert.equal(f.assets.size, 4);
  const input = trackInput(slots, uploads.results);
  assert.deepEqual(input.stems.map(stem => stem.name), ['Drums', 'Bass', 'Chords', 'Lead']);
  const outcome = await publish(f, input, token);
  assert.equal(outcome.state, 'published');
  await verifyReadback(f, outcome.track, input, token);
});

test('one rejected upload blocks Track creation; retry only that slot and retain other successful assets', async t => {
  const slots = selection();
  const f = await startFixture(t, slots);
  const token = await f.login();
  const uploads = startUploads(f, slots, token);
  for (const slot of [slots[1], slots[2], slots[3], slots[0]]) {
    await f.waitForUpload(slot.clientId);
    f.release(slot.clientId, { reject: slot === slots[2] });
    await uploads.waitForResult(slot.clientId);
  }
  await uploads.done;
  assert.equal(uploads.results.get(slots[2].clientId).status, 415);
  assert.throws(() => trackInput(slots, uploads.results), /Every selected slot/);
  assert.equal(f.calls.requests.filter(req => req.method === 'POST' && req.path === '/api/tracks').length, 0);
  assert.equal(f.records.length, 0);
  assert.equal((await f.send('/api/tracks/mine', { token })).body.pagination.total, 0);
  assert.equal(f.assets.size, 3);
  const successful = slots.filter(slot => slot !== slots[2]).map(slot => uploads.results.get(slot.clientId));
  const retry = startUploads(f, slots, token, uploads.results);
  await f.waitForUpload(slots[2].clientId);
  f.release(slots[2].clientId);
  await retry.done;
  assert.equal(f.calls.uploads.length, 5);
  assert.deepEqual(slots.filter(slot => slot !== slots[2]).map(slot => retry.results.get(slot.clientId)), successful);
  const input = trackInput(slots, retry.results);
  const outcome = await publish(f, input, token);
  assert.equal(outcome.state, 'published');
  await verifyReadback(f, outcome.track, input, token);
});

test('Track validation rejection is known not-created; fix metadata and reuse uploads without uploading again', async t => {
  const slots = selection(1);
  const f = await startFixture(t, slots);
  const token = await f.login();
  const results = await finishUploads(f, slots, token);
  const input = trackInput(slots, results);
  const invalid = await publish(f, { ...input, bpm: '96' }, token);
  assert.equal(invalid.state, 'rejected');
  assert.equal(invalid.response.status, 400);
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.calls.commits, 0);
  assert.equal((await f.send('/api/tracks/mine', { token })).body.pagination.total, 0);
  assert.equal(f.assets.size, 1);
  const outcome = await publish(f, input, token);
  assert.equal(outcome.state, 'published');
  assert.equal(f.calls.uploads.length, 1);
  await verifyReadback(f, outcome.track, input, token);
});

test('auth failure at upload/publish leaves no Track; re-login as same owner reuses the uploaded audio', async t => {
  const slots = selection(1);
  const f = await startFixture(t, slots);
  const token = await f.login();
  assert.equal((await f.upload(slots[0])).status, 401);
  assert.equal((await f.upload(slots[0], 'not-a-jwt')).status, 401);
  assert.equal(f.calls.uploads.length, 0);
  const results = await finishUploads(f, slots, token);
  const input = trackInput(slots, results);
  const unauthenticated = await publish(f, input);
  assert.equal(unauthenticated.state, 'rejected');
  assert.equal(unauthenticated.response.status, 401);
  const invalid = await publish(f, input, 'not-a-jwt');
  assert.equal(invalid.state, 'rejected');
  assert.equal(invalid.response.status, 401);
  assert.equal(f.calls.creates.length, 0);
  assert.equal((await f.send('/api/tracks/mine', { token })).body.pagination.total, 0);
  const outcome = await publish(f, input, await f.login());
  assert.equal(outcome.state, 'published');
  assert.equal(f.calls.uploads.length, 1);
  await verifyReadback(f, outcome.track, input, token);
});

test('lost POST response after commit is unknown, not not-created; reconcile through My Tracks/detail without retry', async t => {
  const slots = selection(1);
  const f = await startFixture(t, slots);
  const token = await f.login();
  const results = await finishUploads(f, slots, token);
  const input = trackInput(slots, results);
  f.loseNextCreateResponse();
  const outcome = await publish(f, input, token);
  assert.deepEqual(outcome, { state: 'unknown' });
  assert.equal(f.calls.drops, 1);
  assert.equal(f.calls.commits, 1);
  assert.equal(f.calls.creates.length, 1);
  const mine = await f.send('/api/tracks/mine', { token });
  assert.equal(mine.status, 200);
  const { stems: expectedStems, ...expectedMetadata } = input;
  const candidates = mine.body.data.filter(track => {
    const { _id, artistId, artist, likedByMe, likesCount, createdAt, stems, ...metadata } = track;
    return artistId === f.ownerId && isDeepStrictEqual(metadata, expectedMetadata) &&
      isDeepStrictEqual(stems.map(({ stemId, ...stem }) => stem), expectedStems);
  });
  assert.equal(candidates.length, 1);
  await verifyReadback(f, candidates[0], input, token);
  assert.equal(f.calls.requests.filter(req => req.method === 'POST' && req.path === '/api/tracks').length, 1);
  // This fixture has one known committed candidate. An empty or ambiguous lookup
  // in a real system is NOT proof of absence and must not trigger a blind retry.
});

test('lost connection before the POST handler also stays unknown; an empty My Tracks lookup does not trigger retry', async t => {
  const slots = selection(1);
  const f = await startFixture(t, slots);
  const token = await f.login();
  const results = await finishUploads(f, slots, token);
  f.loseNextCreateResponse('before-handler');
  const outcome = await publish(f, trackInput(slots, results), token);
  assert.deepEqual(outcome, { state: 'unknown' });
  assert.equal(f.calls.drops, 1);
  assert.equal(f.calls.creates.length, 0);
  assert.equal(f.calls.commits, 0);
  assert.equal((await f.send('/api/tracks/mine', { token })).body.pagination.total, 0);
  assert.equal(outcome.state, 'unknown');
  assert.equal(f.calls.requests.filter(req => req.method === 'POST' && req.path === '/api/tracks').length, 1);
  assert.equal(f.assets.size, 1);
});
