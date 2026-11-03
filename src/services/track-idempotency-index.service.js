const assert = require('node:assert/strict');
const Receipt = require('../models/TrackCreateIdempotency');

const COLLECTION = 'trackcreateidempotencies';
const DECLARATIONS = Receipt.schema.indexes();
const sameKeys = (a, b) => JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

function verify(index, [key, options]) {
  assert.equal(index.name, options.name, 'Unexpected idempotency index name.');
  assert.ok(sameKeys(index.key, key), 'Idempotency index key/order mismatch.');
  assert.equal(index.unique === true, options.unique === true, 'Idempotency unique option mismatch.');
  assert.equal(index.expireAfterSeconds, options.expireAfterSeconds, 'Idempotency TTL option mismatch.');
  for (const [name, value] of Object.entries(index)) {
    if (['v', 'ns', 'key', 'name', 'unique', 'expireAfterSeconds', 'background'].includes(name)) continue;
    if (['hidden', 'sparse'].includes(name) && value === false) continue;
    if (name === 'collation' && JSON.stringify(value) === '{"locale":"simple"}') continue;
    assert.fail('Incompatible idempotency index option: ' + name);
  }
}

async function ensureIndexes(db, { apply = false, requireReady = false } = {}) {
  assert.equal(DECLARATIONS.length, 2);
  let info = await db.listCollections({ name: COLLECTION }).toArray();
  let createdCollection = false;
  if (info.length === 0 && apply) {
    try { await db.createCollection(COLLECTION); createdCollection = true; } catch (error) {
      if (error.code !== 48) throw error; // Another provisioner may have created it.
    }
    info = await db.listCollections({ name: COLLECTION }).toArray();
  }
  if (info.length === 0) {
    assert.ok(!requireReady, 'Idempotency collection missing; run the provisioning CLI.');
    return { ready: false, createdCollection: false, createdIndexes: [],
      missing: DECLARATIONS.map(([, options]) => options.name) };
  }
  assert.equal(info.length, 1);
  assert.ok(!info[0].type || info[0].type === 'collection', 'Idempotency target must be a collection.');
  const settings = info[0].options || {};
  assert.ok(!settings.collation || settings.collation.locale === 'simple', 'Idempotency collection must use simple collation.');
  assert.ok(!settings.timeseries && !settings.capped, 'Incompatible idempotency collection.');
  const collection = db.collection(COLLECTION);
  const before = await collection.listIndexes().toArray();
  // Validate the whole catalog before any DDL; never fix conflicts by dropping.
  for (const declaration of DECLARATIONS) {
    const [key, options] = declaration;
    const named = before.find(index => index.name === options.name);
    if (named) verify(named, declaration);
    assert.ok(!before.some(index => index.name !== options.name && sameKeys(index.key, key)),
      'Equivalent idempotency index keys exist under another name.');
  }
  const createdIndexes = [];
  if (apply) for (const [key, options] of DECLARATIONS) {
    if (!before.some(index => index.name === options.name)) {
      await collection.createIndex(key, options);
      createdIndexes.push(options.name);
    }
  }
  const after = await collection.listIndexes().toArray();
  for (const index of before) assert.deepEqual(after.find(item => item.name === index.name), index,
    'An existing index changed during provisioning.');
  assert.equal(after.length, before.length + createdIndexes.length, 'Unexpected idempotency index catalog change.');
  const missing = [];
  for (const declaration of DECLARATIONS) {
    const index = after.find(item => item.name === declaration[1].name);
    if (index) verify(index, declaration); else missing.push(declaration[1].name);
  }
  assert.ok(!requireReady || missing.length === 0, 'Idempotency indexes missing; run the provisioning CLI.');
  return { ready: missing.length === 0, createdCollection, createdIndexes, missing };
}

const verifyReady = db => ensureIndexes(db, { requireReady: true });
module.exports = { ensureIndexes, verifyReady, verify, COLLECTION, DECLARATIONS };
