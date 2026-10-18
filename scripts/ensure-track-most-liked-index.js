const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_NAME = 'public_tracks_most_liked';
const INDEX_KEY = { isPublic: 1, likesCount: -1, createdAt: -1, _id: -1 };
const COLLECTIONS = ['users', 'tracks', 'tracklikes'];
const MAIN_ACCOUNT_ID = '6acb9cdb457771b5ea947486';

function sameKeys(left, right) {
  return JSON.stringify(Object.entries(left)) === JSON.stringify(Object.entries(right));
}

function verifyIndex(index) {
  assert.equal(index.name, INDEX_NAME, 'Unexpected index name.');
  assert.ok(sameKeys(index.key, INDEX_KEY), 'Index key/order conflict.');
  for (const [option, value] of Object.entries(index)) {
    if (['v', 'ns', 'name', 'key', 'background'].includes(option)) continue;
    if (['unique', 'sparse', 'hidden'].includes(option) && value === false) continue;
    if (option === 'collation' && JSON.stringify(value) === '{"locale":"simple"}') continue;
    assert.fail(`Incompatible index option: ${option}.`);
  }
}

async function ensureIndex(collection, declaration, apply = false) {
  const [key, options] = declaration;
  verifyIndex({ key, ...options });
  const before = await collection.listIndexes().toArray();
  const named = before.find((index) => index.name === INDEX_NAME);
  if (named) verifyIndex(named);
  assert.ok(!before.some((index) => index.name !== INDEX_NAME && sameKeys(index.key, key)),
    'Equivalent keys already exist under another name; manual assessment required.');
  const created = !named && apply;
  if (created) await collection.createIndex(key, options);
  const after = await collection.listIndexes().toArray();
  for (const existing of before) {
    assert.deepEqual(after.find((index) => index.name === existing.name), existing,
      'An existing index changed during the operation.');
  }
  assert.equal(after.length, before.length + Number(created), 'Unexpected index catalog change.');
  const actual = after.find((index) => index.name === INDEX_NAME);
  if (actual) verifyIndex(actual);
  if (apply) assert.ok(actual, 'Index missing after apply.');
  return { created, exists: Boolean(actual), beforeCount: before.length,
    afterCount: after.length, actual: actual || null };
}

async function main(args = process.argv.slice(2)) {
  // No app/startup imports: automatic collection/index creation stays disabled.
  require('dotenv').config({ quiet: true });
  const mongoose = require('mongoose');
  const dns = require('node:dns');
  const report = { kind: 'track-most-liked-index', startedAt: new Date().toISOString(),
    mode: args.includes('--apply') ? 'apply' : 'inspect', status: 'failed',
    intentionalIndexAddition: args.includes('--apply'), fixtureDataCreated: false,
    dbDisconnected: false };
  const marker = `sf-context-${report.startedAt.replace(/\D/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
  const reportPath = path.join(__dirname, '..', 'docs', 'verification', `${marker}.json`);
  try {
    assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--apply'),
      'Usage: node scripts/ensure-track-most-liked-index.js [--apply]');
    for (const variable of ['MONGO_URI', 'MONGO_USERNAME', 'MONGO_PASSWORD']) {
      assert.ok(process.env[variable], `Missing environment variable: ${variable}.`);
    }
    if (process.env.DNS_SERVERS) {
      dns.setServers(process.env.DNS_SERVERS.split(',').map((server) => server.trim()).filter(Boolean));
    }
    const uriDatabase = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(process.env.MONGO_URI)?.[1];
    assert.ok(uriDatabase, 'MONGO_URI must explicitly select the project database.');
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
    const Track = require('../src/models/Track');
    const declarations = Track.schema.indexes().filter(([, options]) => options.name === INDEX_NAME);
    assert.equal(declarations.length, 1, 'Expected exactly one mostLiked index declaration.');
    await mongoose.connect(process.env.MONGO_URI, {
      user: process.env.MONGO_USERNAME, pass: process.env.MONGO_PASSWORD,
      autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 30000,
    });
    const db = mongoose.connection.db;
    assert.ok(db.databaseName === decodeURIComponent(uriDatabase), 'Configured database mismatch.');
    assert.equal(Track.collection.name, 'tracks', 'Unexpected Track collection.');
    const collections = await db.listCollections({}, { nameOnly: false }).toArray();
    for (const name of COLLECTIONS) {
      assert.ok(collections.some((collection) => collection.name === name), 'Project collection missing.');
    }
    const trackOptions = collections.find((collection) => collection.name === 'tracks').options;
    assert.ok(!trackOptions.collation || trackOptions.collation.locale === 'simple',
      'Non-simple collection collation requires manual assessment.');
    assert.ok(await db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(MAIN_ACCOUNT_ID) },
      { projection: { _id: 1 } }), 'Protected project account not found; refusing DDL.');
    report.target = { configuredDatabaseMatched: true, projectCollectionsVerified: true,
      protectedAccountPresent: true, databaseFingerprint: digest(db.databaseName) };

    async function snapshot() {
      const result = {};
      for (const name of COLLECTIONS) {
        const hash = crypto.createHash('sha256');
        let count = 0;
        for await (const document of db.collection(name).find({}).sort({ _id: 1 })) {
          hash.update(mongoose.mongo.BSON.serialize(document));
          count += 1;
        }
        result[name] = { count, digest: hash.digest('hex'),
          indexes: await db.collection(name).listIndexes().toArray() };
      }
      return result;
    }

    const before = await snapshot();
    try {
      report.index = await ensureIndex(db.collection('tracks'), declarations[0], report.mode === 'apply');
      const explain = await db.collection('tracks').find({ isPublic: true })
        .sort({ likesCount: -1, createdAt: -1, _id: -1 }).limit(12).explain('queryPlanner');
      const plan = explain.queryPlanner.winningPlan;
      const stages = new Set();
      const indexes = new Set();
      function walk(value) {
        if (!value || typeof value !== 'object') return;
        if (value.stage) stages.add(value.stage);
        if (value.indexName) indexes.add(value.indexName);
        Object.values(value).forEach(walk);
      }
      walk(plan);
      report.explain = { filter: { isPublic: true },
        sort: { likesCount: -1, createdAt: -1, _id: -1 }, limit: 12, hintUsed: false,
        stages: [...stages], indexNames: [...indexes], winningPlan: plan };
    } finally {
      const after = await snapshot();
      report.preservation = {};
      for (const name of COLLECTIONS) {
        const dataUnchanged = before[name].count === after[name].count && before[name].digest === after[name].digest;
        const oldIndexesUnchanged = before[name].indexes.every((old) =>
          JSON.stringify(after[name].indexes.find((index) => index.name === old.name)) === JSON.stringify(old));
        const additions = after[name].indexes.filter((index) =>
          !before[name].indexes.some((old) => old.name === index.name));
        const allowedAddition = name === 'tracks' && report.mode === 'apply' &&
          additions.length === 1 && additions[0].name === INDEX_NAME;
        report.preservation[name] = { count: after[name].count, dataUnchanged, oldIndexesUnchanged,
          addedIndexes: additions.map((index) => index.name) };
        assert.ok(dataUnchanged && oldIndexesUnchanged && (additions.length === 0 || allowedAddition),
          'Data or unrelated index catalog changed during verification.');
      }
    }
    report.status = 'passed';
  } catch (error) {
    // Driver errors can contain connection details; never log their messages.
    report.error = error.code === 'ERR_ASSERTION' ? error.message : `${error.name || 'Error'} (details suppressed)`;
    process.exitCode = 1;
  } finally {
    try {
      await mongoose.disconnect();
      report.dbDisconnected = true;
    } catch {
      report.status = 'failed';
      report.error = 'Database disconnect failed (details suppressed).';
      process.exitCode = 1;
    }
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ...report, reportFile: path.basename(reportPath) }, null, 2));
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = { ensureIndex, verifyIndex };
if (require.main === module) void main();
