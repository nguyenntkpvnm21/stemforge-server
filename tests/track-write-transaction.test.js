const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Track = require('../src/models/Track');
const responseService = require('../src/services/track-response.service');
const { createTrack, updateTrack } = require('../src/controllers/track.controller');
const sample = require('./fixtures/track-contract-draft.json');

function setup(t, { enrichmentError, commitError } = {}) {
  const session = {};
  let stored = [structuredClone(sample)];
  let committed = false;
  const events = [];
  const res = {
    statusCode: null, body: undefined,
    status(code) { assert.ok(committed, 'Response must wait for transaction commit'); this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  t.mock.method(mongoose.connection, 'transaction', async (operation, options) => {
    assert.deepEqual(options, { readPreference: 'primary', readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    const before = structuredClone(stored);
    try {
      const result = await operation(session);
      assert.equal(res.statusCode, null);
      if (commitError) throw commitError;
      committed = true;
      events.push('commit');
      return result;
    } catch (error) {
      stored = before;
      events.push('abort');
      throw error;
    }
  });
  t.mock.method(Track, 'create', async ([payload], options) => {
    assert.equal(options.session, session);
    const doc = { ...payload, _id: '507f1f77bcf86cd799439088' };
    stored.push(doc);
    events.push('insert');
    return [doc];
  });
  t.mock.method(Track, 'findOneAndUpdate', (filter, changes, options) => ({
    async exec() {
      assert.equal(options.session, session);
      assert.deepEqual(filter, { _id: sample._id, artistId: sample.artistId });
      stored[0] = { ...stored[0], ...changes.$set };
      events.push('update');
      return stored[0];
    },
  }));
  t.mock.method(responseService, 'enrichTracks', async (tracks, userId, actualSession) => {
    assert.equal(actualSession, session);
    assert.equal(userId, sample.artistId);
    assert.equal(committed, false);
    events.push('enrich');
    if (enrichmentError) throw enrichmentError;
    return tracks.map(track => ({
      ...track, artist: { _id: sample.artistId, username: 'Composer', avatarUrl: null },
      likedByMe: track._id === sample._id,
    }));
  });
  const input = {
    title: sample.title, genre: sample.genre, bpm: sample.bpm, key: sample.key,
    isPublic: true, isDownloadable: false,
    stems: sample.stems.map(({ name, audioUrl, duration, fileSize }) => ({ name, audioUrl, duration, fileSize })),
  };
  return { res, stored: () => stored, events, request: {
    body: input, user: { _id: sample.artistId }, params: { trackId: sample._id },
  } };
}

for (const [method, controller, writeEvent] of [['POST', createTrack, 'insert'], ['PATCH', updateTrack, 'update']]) {
  for (const lookup of ['author', 'membership']) {
    test(`${method} rolls back its write on ${lookup} enrichment failure`, async (t) => {
      const error = new Error(`${lookup} lookup failed`);
      const context = setup(t, { enrichmentError: error });
      if (method === 'PATCH') context.request.body = { title: 'Changed metadata' };
      const next = t.mock.fn();
      await controller(context.request, context.res, next);
      assert.deepEqual(context.stored(), [sample]);
      assert.deepEqual(context.events, [writeEvent, 'enrich', 'abort']);
      assert.equal(context.res.statusCode, null);
      assert.equal(next.mock.calls[0].arguments[0], error);
    });
  }
  test(`${method} sends the enriched response only after commit`, async (t) => {
    const context = setup(t);
    if (method === 'PATCH') context.request.body = { title: 'Changed metadata' };
    const next = t.mock.fn();
    await controller(context.request, context.res, next);
    assert.deepEqual(context.events, [writeEvent, 'enrich', 'commit']);
    assert.equal(context.res.statusCode, method === 'POST' ? 201 : 200);
    assert.deepEqual(context.res.body.data.artist, { _id: sample.artistId, username: 'Composer', avatarUrl: null });
    assert.equal(context.res.body.data.likedByMe, method === 'PATCH');
    assert.equal(next.mock.calls.length, 0);
  });
  test(`${method} does not send success when commit fails`, async (t) => {
    const error = new Error('Commit failed');
    const context = setup(t, { commitError: error });
    if (method === 'PATCH') context.request.body = { title: 'Changed metadata' };
    const next = t.mock.fn();
    await controller(context.request, context.res, next);
    assert.deepEqual(context.stored(), [sample]);
    assert.equal(context.res.statusCode, null);
    assert.equal(next.mock.calls[0].arguments[0], error);
  });
}
