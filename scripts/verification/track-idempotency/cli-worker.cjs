const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
process.once('message', async c => {
  try {
    const url = new URL(c.uri);
    assert.equal(url.protocol, 'mongodb:'); assert.equal(url.username, ''); assert.equal(url.password, '');
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, String(c.mongoPort));
    assert.equal(url.pathname, '/' + c.dbName); assert.equal(url.searchParams.get('replicaSet'), c.setName);
    assert.match(c.dbName, /^sf_idem_[a-z0-9_]+$/);
    const source = createRequire(c.worktree + '/package.json');
    source('dotenv').config = () => ({ parsed: {} });
    Object.assign(process.env, { MONGO_URI: c.uri, MONGO_USERNAME: c.user, MONGO_PASSWORD: c.password });
    const cli = source(c.worktree + '/scripts/ensure-track-idempotency-indexes.js');
    await cli.main([c.mode]);
    process.send({ exitCode: process.exitCode || 0 });
  } catch (error) {
    console.error(JSON.stringify({ name: error.name, code: error.code || null }));
    process.exitCode = 1;
  } finally { if (process.connected) process.disconnect(); }
});
