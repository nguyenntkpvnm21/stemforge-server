const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ensureIndex } = require('../scripts/ensure-track-most-liked-index');

const key = { isPublic: 1, likesCount: -1, createdAt: -1, _id: -1 };
const options = { name: 'public_tracks_most_liked' };
const declaration = [key, options];
const oldIndexes = [
  { v: 2, key: { _id: 1 }, name: '_id_' },
  { v: 2, key: { artistId: 1, createdAt: -1 }, name: 'artistId_1_createdAt_-1' },
  { v: 2, key: { isPublic: 1, createdAt: -1, _id: -1 }, name: 'isPublic_1_createdAt_-1__id_-1' },
];

function collectionWith(indexes = oldIndexes) {
  const state = { indexes: structuredClone(indexes), calls: [] };
  const collection = {
    listIndexes: () => ({ toArray: async () => structuredClone(state.indexes) }),
    async createIndex(keys, settings) {
      state.calls.push({ key: structuredClone(keys), options: structuredClone(settings) });
      state.indexes.push({ v: 2, key: keys, ...settings });
    },
  };
  return { collection, state };
}

test('inspection reports missing index without issuing DDL', async () => {
  const { collection, state } = collectionWith();
  const result = await ensureIndex(collection, declaration);
  assert.equal(result.exists, false);
  assert.equal(result.created, false);
  assert.deepEqual(state.indexes, oldIndexes);
  assert.equal(state.calls.length, 0);
});

test('apply creates only the declared index and rerun is a no-op preserving old indexes', async () => {
  const { collection, state } = collectionWith();
  const first = await ensureIndex(collection, declaration, true);
  const second = await ensureIndex(collection, declaration, true);
  assert.equal(first.created, true);
  assert.equal(first.afterCount, 4);
  assert.equal(second.created, false);
  assert.equal(second.beforeCount, second.afterCount);
  assert.deepEqual(state.calls, [{ key, options }]);
  assert.deepEqual(state.indexes.slice(0, 3), oldIndexes);
});

test('same name with reordered or incorrect keys is rejected without DDL', async () => {
  for (const invalid of [
    { likesCount: -1, isPublic: 1, createdAt: -1, _id: -1 },
    { ...key, likesCount: 1 },
  ]) {
    const { collection, state } = collectionWith([...oldIndexes, { key: invalid, ...options }]);
    await assert.rejects(ensureIndex(collection, declaration, true), /key\/order conflict/);
    assert.equal(state.calls.length, 0);
  }
});

test('incompatible semantic options are rejected without replacing an index', async () => {
  for (const option of [
    { unique: true }, { sparse: true }, { hidden: true }, { expireAfterSeconds: 60 },
    { partialFilterExpression: { isPublic: true } }, { collation: { locale: 'en', strength: 2 } },
  ]) {
    const initial = [...oldIndexes, { v: 2, key, ...options, ...option }];
    const { collection, state } = collectionWith(initial);
    await assert.rejects(ensureIndex(collection, declaration, true), /Incompatible index option/);
    assert.equal(state.calls.length, 0);
    assert.deepEqual(state.indexes, initial);
  }
});

test('equivalent keys with a different name are refused rather than duplicated', async () => {
  const { collection, state } = collectionWith([...oldIndexes, { key, name: 'another_ranking_index' }]);
  await assert.rejects(ensureIndex(collection, declaration, true), /another name/);
  assert.equal(state.calls.length, 0);
});

test('a mismatched schema declaration fails before reading or writing the database', async () => {
  await assert.rejects(ensureIndex({}, [{ ...key, likesCount: 1 }, options], true), /key\/order conflict/);
  await assert.rejects(ensureIndex({}, [key, { ...options, unique: true }], true), /Incompatible/);
});

test('server-managed version and explicit default options do not trigger duplicate creation', async () => {
  const { collection, state } = collectionWith([...oldIndexes, {
    v: 2, key, ...options, unique: false, sparse: false, hidden: false,
  }]);
  const result = await ensureIndex(collection, declaration, true);
  assert.equal(result.created, false);
  assert.equal(result.exists, true);
  assert.equal(state.calls.length, 0);
});

test('DDL rejection is propagated without retrying or dropping existing indexes', async () => {
  const { collection, state } = collectionWith();
  collection.createIndex = async () => { throw new Error('DDL denied'); };
  await assert.rejects(ensureIndex(collection, declaration, true), /DDL denied/);
  assert.deepEqual(state.indexes, oldIndexes);
});

test('unexpected changes to an existing index fail post-operation verification', async () => {
  const { collection } = collectionWith();
  const create = collection.createIndex;
  collection.createIndex = async (...args) => {
    await create(...args);
    collection.listIndexes = () => ({ toArray: async () => [{ v: 2, key, ...options }] });
  };
  await assert.rejects(ensureIndex(collection, declaration, true), /existing index changed/);
});
