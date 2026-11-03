function parseArgs(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) return false;
  if (args.length === 1 && args[0] === '--apply') return true;
  throw new Error('Usage: node scripts/ensure-track-idempotency-indexes.js [--dry-run|--apply]');
}

async function main(args = process.argv.slice(2)) {
  // No server/app import, no automatic index creation and no credential output.
  let mongoose;
  try {
    const apply = parseArgs(args);
    require('dotenv').config({ quiet: true });
    mongoose = require('mongoose');
    mongoose.set('autoCreate', false);
    mongoose.set('autoIndex', false);
    if (process.env.DNS_SERVERS) require('node:dns').setServers(
      process.env.DNS_SERVERS.split(',').map(value => value.trim()).filter(Boolean));
    for (const name of ['MONGO_URI', 'MONGO_USERNAME', 'MONGO_PASSWORD']) {
      if (!process.env[name]) throw new Error('Missing database configuration.');
    }
    const database = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(process.env.MONGO_URI)?.[1];
    if (!database) throw new Error('Database must be explicit in configuration.');
    await mongoose.connect(process.env.MONGO_URI, {
      user: process.env.MONGO_USERNAME, pass: process.env.MONGO_PASSWORD,
      autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000,
    });
    const db = mongoose.connection.db;
    if (db.databaseName !== decodeURIComponent(database)) throw new Error('Configured database mismatch.');
    // Check project shape before any new collection/index is created.
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name);
    if (!['users', 'tracks', 'tracklikes'].every(name => names.includes(name))) {
      throw new Error('Project collections not found.');
    }
    const { ensureIndexes } = require('../src/services/track-idempotency-index.service');
    const result = await ensureIndexes(db, { apply, requireReady: apply });
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', configuredDatabaseMatched: true, ...result }));
    if (!result.ready) process.exitCode = 2;
  } catch {
    console.error('Idempotency index operation failed. Check configuration, permissions and index compatibility; details suppressed.');
    process.exitCode = 1;
  } finally {
    if (mongoose) {
      try { await mongoose.disconnect(); } catch { process.exitCode = 1; }
    }
  }
}
module.exports = { parseArgs, main };
if (require.main === module) void main();
