const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Track = require('../src/models/Track');
const Receipt = require('../src/models/TrackCreateIdempotency');
const service = require('../src/services/track-create-idempotency.service');
const { MongoClient, MongoServerError } = mongoose.mongo;
const OWNER = '507f1f77bcf86cd799439011';
const OTHER = '507f1f77bcf86cd799439012';
const KEY = 'CaseSensitive-Key-1234';
const payload = () => ({ title: 'Demo', genre: 'Electronic', bpm: 96, key: 'Am',
  isPublic: false, isDownloadable: false,
  stems: [{ name: 'Drums', audioUrl: 'https://example.invalid/drums.wav', duration: 20, fileSize: 1000 }] });
const mongoError = (labels = [], code = 112) => new MongoServerError({ message: 'Private fixture detail', code, errorLabels: labels });
const duplicate = () => Object.assign(new Error('Private duplicate'), { code: 11000, keyPattern: { ownerId: 1, keyHash: 1 } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Models/atomic commit are simulated here; actual driver retry is tested below.
function fixture(options = {}) {
  const receipts = new Map(); const tracks = [];
  const calls = { transactions: 0, creates: 0, enrich: 0, reads: 0, updates: 0, inserts: 0 };
  let time = new Date('2026-11-03T00:00:00Z');
  const keyOf = row => String(row.ownerId) + ':' + row.keyHash;
  const model = {
    findOne(filter) {
      let session; let primary = false; let majority = false;
      return {
        read(value) { assert.equal(value, 'primary'); primary = true; return this; },
        readConcern(value) { assert.equal(value, 'majority'); majority = true; return this; },
        setOptions(value) { assert.deepEqual(value, { timeoutMS: 2000 }); return this; },
        lean() { return this; }, session(value) { session = value; return this; },
        async exec() {
          calls.reads += 1;
          assert.ok(session || (primary && majority));
          if (options.readError) throw options.readError;
          return receipts.get(keyOf(filter)) ?? null;
        },
      };
    },
    async create([row], { session }) {
      calls.inserts += 1;
      if (options.receiptError) throw options.receiptError;
      session.receipt = { ...row, ownerId: String(row.ownerId), trackId: String(row.trackId),
        _id: new mongoose.Types.ObjectId().toString() };
    },
    updateOne(filter, update, { session }) {
      return { async exec() {
        calls.updates += 1;
        if (options.ttlDelete) { receipts.delete(keyOf(filter)); options.ttlDelete = false; return { matchedCount: 0 }; }
        const row = receipts.get(keyOf(filter));
        if (!row || String(row._id) !== String(filter._id) ||
            row.expiresAt.getTime() !== new Date(filter.expiresAt).getTime()) return { matchedCount: 0 };
        session.previous = row;
        session.receipt = { ...row, ...update.$set, trackId: String(update.$set.trackId) };
        return { matchedCount: 1 };
      } };
    },
  };
  const connection = {
    async transaction(callback, settings) {
      assert.deepEqual(settings, { readPreference: 'primary', readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' }, timeoutMS: 10000 });
      calls.transactions += 1;
      const session = { staged: [] };
      const result = await callback(session);
      if (options.beforeCommit) await options.beforeCommit(session);
      if (options.commitError && !options.commitThenThrow) throw options.commitError;
      if (session.receipt) {
        const key = keyOf(session.receipt);
        const existing = receipts.get(key);
        if (!session.previous && existing) throw duplicate();
        if (session.previous && existing !== session.previous) throw mongoError(['TransientTransactionError']);
        receipts.set(key, session.receipt);
      }
      tracks.push(...session.staged);
      if (options.commitThenThrow) throw options.commitError;
      return result;
    },
  };
  const trackModel = { async create([input], { session }) {
    calls.creates += 1;
    const track = new Track({ ...input, createdAt: time });
    await track.validate(); session.staged.push(track);
    return [track];
  } };
  const responseService = { async enrichTracks(list, ownerId, session) {
    calls.enrich += 1; assert.ok(session.staged.includes(list[0]));
    if (options.enrichError) throw options.enrichError;
    if (options.enrichBarrier) await options.enrichBarrier();
    return list.map(track => ({ ...track.toJSON(), artist: { _id: String(ownerId), username: 'Composer', avatarUrl: null }, likedByMe: false }));
  } };
  const create = service.createService({ receiptModel: model, trackModel, connection, responseService, clock: () => new Date(time) });
  return { create: (body = payload(), key = KEY, ownerId = OWNER) => create({ ownerId, key, payload: body }),
    receipts, tracks, calls, options, connection, advance: ms => { time = new Date(time.getTime() + ms); } };
}

test('receipt schema is internal, required and has only the declared unique/TTL indexes', async () => {
  assert.equal(Receipt.collection.name, 'trackcreateidempotencies');
  assert.equal(Receipt.schema.options.autoCreate, false);
  assert.equal(Receipt.schema.options.autoIndex, false);
  assert.equal(Receipt.schema.options.bufferCommands, false);
  assert.deepEqual(Receipt.schema.indexes().map(([key, value]) => [key, { ...value }]), [
    [{ ownerId: 1, keyHash: 1 }, { unique: true, name: 'unique_owner_track_create_key' }],
    [{ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'track_create_key_expiry' }],
  ]);
  await assert.rejects(new Receipt({}).validate(), { name: 'ValidationError' });
  assert.equal(Track.schema.path('keyHash'), undefined);
});

test('header parser supports UUID/ASCII boundaries, case sensitivity and rejects repetition/invalid values', () => {
  assert.equal(service.parseKey({}), undefined);
  for (const value of ['a'.repeat(16), 'Z'.repeat(128), '85d767b9-b831-40b4-b125-0f1cc7b77680', 'Valid._:-Key12345']) {
    assert.equal(service.parseKey({ headers: { 'idempotency-key': value } }), value);
  }
  for (const value of ['', 'a'.repeat(15), 'a'.repeat(129), 'x'.repeat(16) + ',x', 'ä'.repeat(16), 'x'.repeat(8) + '\u0000' + 'y'.repeat(8), ['a'.repeat(16)]]) {
    assert.throws(() => service.parseKey({ headers: { 'idempotency-key': value } }), error => error.status === 400);
  }
  assert.throws(() => service.parseKey({ rawHeaders: ['Idempotency-Key', KEY, 'IDEMPOTENCY-KEY', KEY], get: () => KEY }), error => error.status === 400);
  // A JS `$` anchor permits a final line terminator; validate every character.
  // Node rejects these on the wire too, but the parser must enforce its own rule.
  for (const suffix of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(() => service.parseKey({ headers: { 'idempotency-key': KEY + suffix } }), error => error.status === 400);
  }
});

test('versioned canonical hashing ignores object key order but keeps array order, string whitespace and defaults', () => {
  const input = payload();
  assert.equal(service.payloadHash(input), service.payloadHash(Object.fromEntries(Object.entries(input).reverse())));
  for (const change of [{ title: ' Demo' }, { tags: [] }, { description: '' }, { bpm: 97 }, { coverImageUrl: null }]) {
    assert.notEqual(service.payloadHash(input), service.payloadHash({ ...input, ...change }));
  }
  assert.notEqual(service.payloadHash({ ...input, tags: ['a', 'b'] }), service.payloadHash({ ...input, tags: ['b', 'a'] }));
  const stems = [input.stems[0], { ...input.stems[0], name: 'Bass' }];
  assert.notEqual(service.payloadHash({ ...input, stems }), service.payloadHash({ ...input, stems: stems.slice().reverse() }));
});

test('same key replays serialized receipt without another write/enrichment and without extending expiry', async () => {
  const f = fixture();
  const first = await f.create();
  f.advance(1000);
  const second = await f.create();
  assert.equal(first.replayed, false); assert.equal(second.replayed, true);
  assert.deepEqual(second.body, first.body); assert.deepEqual(second.expiresAt, first.expiresAt);
  assert.equal(typeof first.body.data._id, 'string');
  assert.equal(typeof first.body.data.createdAt, 'string');
  assert.equal(f.calls.creates, 1); assert.equal(f.calls.enrich, 1);
  assert.equal(f.receipts.size, 1); assert.equal(f.tracks.length, 1);
});

test('different valid payload conflicts; same key in another account or with different case is independent', async () => {
  const f = fixture(); await f.create();
  await assert.rejects(f.create({ ...payload(), title: 'Different' }), error => error.status === 409 && !error.retryAfter);
  await f.create(payload(), KEY, OTHER);
  await f.create(payload(), KEY.toLowerCase());
  assert.equal(f.tracks.length, 3);
});

for (const failure of ['enrichError', 'receiptError', 'commitError']) {
  test(failure + ' rollback leaves no Track/receipt and the same key can succeed later', async () => {
    const f = fixture({ [failure]: new Error('Synthetic known abort') });
    await assert.rejects(f.create());
    assert.equal(f.tracks.length, 0); assert.equal(f.receipts.size, 0);
    delete f.options[failure];
    assert.equal((await f.create()).replayed, false);
    assert.equal(f.tracks.length, 1);
  });
}

for (const different of [false, true]) {
  test('concurrent independent mock sessions commit one Track; loser ' + (different ? 'conflicts' : 'replays'), async () => {
    const barrier = deferred(); let entered = 0;
    const f = fixture({ enrichBarrier: async () => { if (++entered === 2) barrier.resolve(); await barrier.promise; } });
    const results = await Promise.allSettled([f.create(), f.create(different ? { ...payload(), title: 'Different' } : payload())]);
    assert.equal(f.tracks.length, 1); assert.equal(f.receipts.size, 1);
    if (different) {
      assert.equal(results.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 1);
    } else {
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
      assert.deepEqual(results[0].value.body, results[1].value.body);
    }
  });
}

test('unknown commit that actually committed recovers receipt; no mutation is retried by the service', async () => {
  const f = fixture({ commitThenThrow: true, commitError: mongoError(['UnknownTransactionCommitResult']) });
  assert.equal((await f.create()).replayed, true);
  assert.equal(f.calls.transactions, 1); assert.equal(f.tracks.length, 1);
});

for (const [labels, status] of [[['UnknownTransactionCommitResult'], 503], [['TransientTransactionError'], 409]]) {
  test('unresolved ' + labels[0] + ' is ' + status + ', never proof of rollback', async () => {
    const f = fixture({ commitError: mongoError(labels) });
    await assert.rejects(f.create(), e => e.status === status && e.retryAfter === 1);
    assert.equal(f.calls.transactions, 1);
  });
}

test('timeout wrapping UnknownTransactionCommitResult remains 503; unrelated duplicate keys propagate', async () => {
  const timeout = Object.assign(new Error('Deadline'), { name: 'MongoOperationTimeoutError', cause: mongoError(['UnknownTransactionCommitResult']) });
  await assert.rejects(fixture({ commitError: timeout }).create(), e => e.status === 503);
  const other = Object.assign(new Error('Other duplicate'), { code: 11000, keyPattern: { _id: 1 } });
  await assert.rejects(fixture({ receiptError: other }).create(), e => e === other);
  const wrapped = Object.assign(new Error('Wrapped duplicate'), { name: 'MongoOperationTimeoutError', cause: other });
  await assert.rejects(fixture({ receiptError: wrapped }).create(), e => e === wrapped);
  assert.equal(service.ledgerDuplicate({ code: 11000, message: 'index: unique_owner_track_create_key dup key: hidden' }), true);
  assert.equal(service.ledgerDuplicate({ code: 11000, message: 'index: other dup key: hidden' }), false);
});

test('lookup outage fails closed; corrupt receipts do not authorize creation', async () => {
  const unavailable = fixture({ readError: mongoError([], 91) });
  await assert.rejects(unavailable.create(), e => e.status === 503);
  assert.equal(unavailable.calls.transactions, 0);
  const f = fixture(); await f.create();
  [...f.receipts.values()][0].responseBody = null;
  await assert.rejects(f.create(), e => e.status === 503);
  assert.equal(f.calls.creates, 1);
});

for (const physicallyRemoved of [false, true]) {
  test('24-hour boundary allows new creation when TTL ' + (physicallyRemoved ? 'removed' : 'retained') + ' the expired receipt', async () => {
    const f = fixture(); const first = await f.create();
    f.advance(service.RETENTION_MS - 1);
    assert.equal((await f.create()).replayed, true);
    f.advance(1);
    if (physicallyRemoved) f.receipts.clear();
    const next = await f.create();
    assert.notEqual(next.body.data._id, first.body.data._id);
    assert.equal(f.receipts.size, 1); assert.equal(f.tracks.length, 2);
    assert.equal(f.calls.updates, physicallyRemoved ? 0 : 1);
  });
}

test('TTL deletion racing expired replacement aborts staged Track; retry can create exactly once', async () => {
  const f = fixture(); await f.create(); f.advance(service.RETENTION_MS);
  f.options.ttlDelete = true;
  await assert.rejects(f.create(), e => e.status === 409);
  assert.equal(f.tracks.length, 1);
  await f.create(); assert.equal(f.tracks.length, 2);
});

test('concurrent expired replacements cannot commit two new Tracks in the mock transaction adapter', async () => {
  const f = fixture(); await f.create(); f.advance(service.RETENTION_MS);
  const barrier = deferred(); let count = 0;
  f.options.enrichBarrier = async () => { if (++count === 2) barrier.resolve(); await barrier.promise; };
  const results = await Promise.all([f.create(), f.create()]);
  assert.equal(f.tracks.length, 2);
  assert.deepEqual(results[0].body, results[1].body);
});

for (const mode of ['transient', 'unknown-commit']) {
  test('installed mongodb driver withTransaction ' + mode + ' retries the correct stage without connecting', async t => {
    const client = new MongoClient('mongodb://127.0.0.1:1/unused');
    const session = client.startSession();
    let callbacks = 0; let commits = 0;
    t.mock.method(client, 'connect', async () => { throw new Error('DB forbidden'); });
    t.mock.method(session, 'commitTransaction', async () => {
      commits += 1;
      if (mode === 'unknown-commit' && commits === 1) throw mongoError(['UnknownTransactionCommitResult']);
    });
    try {
      const value = await session.withTransaction(async () => {
        callbacks += 1;
        if (mode === 'transient' && callbacks === 1) throw mongoError(['TransientTransactionError']);
        return 'receipt';
      }, { timeoutMS: 1000 });
      assert.equal(value, 'receipt');
      assert.equal(callbacks, mode === 'transient' ? 2 : 1);
      assert.equal(commits, mode === 'unknown-commit' ? 2 : 1);
    } finally { await session.endSession(); await client.close(); }
  });
}
