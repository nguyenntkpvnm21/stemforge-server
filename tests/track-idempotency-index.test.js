const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ensureIndexes, verifyReady, DECLARATIONS, COLLECTION } = require('../src/services/track-idempotency-index.service');
const { parseArgs } = require('../scripts/ensure-track-idempotency-indexes');

function fixture({ exists = true, indexes = [], options = {} } = {}) {
  const old = { name: '_id_', key: { _id: 1 }, v: 2 };
  const state = { exists, indexes: [old, ...structuredClone(indexes)], created: [], collections: 0 };
  const db = {
    listCollections(filter) {
      assert.deepEqual(filter, { name: COLLECTION });
      return { async toArray() { return state.exists ? [{ name: COLLECTION, type: 'collection', options }] : []; } };
    },
    async createCollection(name) {
      assert.equal(name, COLLECTION); state.exists = true; state.collections += 1;
    },
    collection(name) {
      assert.equal(name, COLLECTION);
      return {
        listIndexes: () => ({ async toArray() { return structuredClone(state.indexes); } }),
        async createIndex(key, settings) {
          state.created.push(settings.name); state.indexes.push({ key, ...settings });
        },
      };
    },
  };
  return { db, state };
}
const valid = () => DECLARATIONS.map(([key, settings]) => ({ key, ...settings }));

test('CLI modes default to dry-run and reject conflicting/unknown arguments', () => {
  assert.equal(parseArgs([]), false); assert.equal(parseArgs(['--dry-run']), false);
  assert.equal(parseArgs(['--apply']), true);
  for (const args of [['--drop'], ['--dry-run', '--apply']]) assert.throws(() => parseArgs(args));
});
test('dry-run reports missing collection/indexes with no DDL; readiness fails closed', async () => {
  const f = fixture({ exists: false });
  assert.equal((await ensureIndexes(f.db)).ready, false);
  await assert.rejects(verifyReady(f.db), /collection missing/);
  assert.equal(f.state.collections, 0); assert.deepEqual(f.state.created, []);
});
test('apply creates only the new collection/two indexes, verifies and safely reruns', async () => {
  const f = fixture({ exists: false });
  const before = structuredClone(f.state.indexes);
  assert.equal((await ensureIndexes(f.db, { apply: true, requireReady: true })).ready, true);
  assert.deepEqual(f.state.created, ['unique_owner_track_create_key', 'track_create_key_expiry']);
  assert.deepEqual(f.state.indexes[0], before[0]);
  assert.deepEqual((await ensureIndexes(f.db, { apply: true })).createdIndexes, []);
  await verifyReady(f.db); assert.equal(f.state.collections, 1);
});
test('existing collection missing an index is not ready and only missing declaration is provisioned', async () => {
  const f = fixture({ indexes: valid().slice(0, 1) });
  await assert.rejects(verifyReady(f.db), /indexes missing/);
  await ensureIndexes(f.db, { apply: true });
  assert.deepEqual(f.state.created, ['track_create_key_expiry']);
});
for (const change of [
  { unique: false }, { sparse: true }, { hidden: true },
  { partialFilterExpression: { ownerId: { $exists: true } } },
  { collation: { locale: 'en', strength: 2 } }, { key: { keyHash: 1, ownerId: 1 } },
]) test('unique index conflict is refused without DDL: ' + JSON.stringify(change), async () => {
  const indexes = valid(); indexes[0] = { ...indexes[0], ...change };
  const f = fixture({ indexes });
  await assert.rejects(ensureIndexes(f.db, { apply: true }));
  assert.deepEqual(f.state.created, []);
});
test('wrong TTL interval is refused without replacing or dropping anything', async () => {
  const indexes = valid(); indexes[1].expireAfterSeconds = 86400;
  const f = fixture({ indexes });
  await assert.rejects(ensureIndexes(f.db, { apply: true }), /TTL/);
  assert.deepEqual(f.state.created, []);
});
test('equivalent keys under a different name and non-simple collection collation are refused', async () => {
  const indexes = valid(); indexes[0].name = 'another_name';
  await assert.rejects(ensureIndexes(fixture({ indexes }).db, { apply: true }), /another name/);
  await assert.rejects(verifyReady(fixture({ indexes: valid(), options: { collation: { locale: 'en' } } }).db), /simple/);
});
test('post-provision verification detects unrelated index loss', async () => {
  const f = fixture();
  const collection = f.db.collection(COLLECTION);
  const original = collection.createIndex;
  collection.createIndex = async (...args) => { await original(...args); f.state.indexes = f.state.indexes.filter(i => i.name !== '_id_'); };
  f.db.collection = () => collection;
  await assert.rejects(ensureIndexes(f.db, { apply: true }), /existing index changed/);
});
