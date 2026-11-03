const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
let mongoose, server, config, source, releaseBarrier;
let faults = {};
const trace = { trackInserts: 0, receiptInserts: 0, commitsStarted: 0, commitsSucceeded: 0,
  failures: [], ackSuppressed: 0, sessionsStarted: 0, sessionsEnded: 0 };
function safeUri(c) {
  const url = new URL(c.uri);
  assert.equal(url.protocol, 'mongodb:'); assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, String(c.mongoPort)); assert.equal(url.pathname, '/' + c.dbName);
  assert.equal(url.searchParams.get('replicaSet'), c.setName);
  assert.equal(url.username, ''); assert.equal(url.password, '');
  assert.match(c.dbName, /^sf_idem_[a-z0-9_]+$/);
}
async function init(c) {
  safeUri(c); config = c;
  source = createRequire(c.worktree + '/package.json');
  source('dotenv').config = () => ({ parsed: {} });
  Object.assign(process.env, { MONGO_URI: c.uri, MONGO_USERNAME: c.user, MONGO_PASSWORD: c.password,
    JWT_SECRET: c.jwt, FRONTEND_URL: 'http://localhost:5173', ADDITIONAL_FRONTEND_ORIGINS: '',
    CLOUDINARY_CLOUD_NAME: 'local-probe', CLOUDINARY_API_KEY: 'local-probe',
    CLOUDINARY_API_SECRET: 'local-probe', TRUST_PROXY_HOPS: '0', PROXY_DEBUG: 'false', PORT: String(c.httpPort) });
  mongoose = source('mongoose'); mongoose.set('autoCreate', false); mongoose.set('autoIndex', false);
  const connect = mongoose.connect.bind(mongoose);
  mongoose.connect = async (uri, opts) => {
    assert.equal(uri, config.uri);
    const result = await connect(uri, { ...opts, appName: c.appName, monitorCommands: true, serverSelectionTimeoutMS: 4000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.equal(mongoose.connection.name, c.dbName); assert.equal(hello.setName, c.setName);
    assert.deepEqual(hello.hosts, ['127.0.0.1:' + c.mongoPort]);
    const client = mongoose.connection.getClient();
    client.on('commandStarted', event => {
      if (event.commandName === 'insert' && event.command.insert === 'tracks') trace.trackInserts++;
      if (event.commandName === 'insert' && event.command.insert === 'trackcreateidempotencies') trace.receiptInserts++;
      if (event.commandName === 'commitTransaction') trace.commitsStarted++;
    });
    client.on('commandSucceeded', event => { if (event.commandName === 'commitTransaction') trace.commitsSucceeded++; });
    client.on('commandFailed', event => {
      trace.failures.push({ command: event.commandName, code: event.failure?.code,
        labels: event.failure?.errorLabels || [] });
    });
    return result;
  };
  const startSession = mongoose.connection.startSession.bind(mongoose.connection);
  mongoose.connection.startSession = async (...args) => {
    const session = await startSession(...args);
    trace.sessionsStarted++;
    const endSession = session.endSession.bind(session); let ended = false;
    session.endSession = async (...endArgs) => {
      const result = await endSession(...endArgs);
      if (!ended) { ended = true; trace.sessionsEnded++; }
      return result;
    };
    const commit = session.commitTransaction.bind(session);
    session.commitTransaction = async (...a) => {
      const result = await commit(...a);
      if (faults.ackLoss) {
        faults.ackLoss = false; trace.ackSuppressed++;
        throw new mongoose.mongo.MongoServerError({ message: 'Test-only committed ACK suppression', code: 91,
          errorLabels: ['UnknownTransactionCommitResult'] });
      }
      return result;
    };
    return session;
  };
  const response = source(c.worktree + '/src/services/track-response.service');
  const enrich = response.enrichTracks;
  response.enrichTracks = async (...args) => {
    if (faults.beforeEnrich) { faults.beforeEnrich = false; throw new Error('Test-only before enrichment'); }
    const result = await enrich(...args);
    if (faults.afterEnrich) { faults.afterEnrich = false; throw new Error('Test-only after enrichment'); }
    return result;
  };
  const Track = source(c.worktree + '/src/models/Track');
  const create = Track.create;
  Track.create = async function (...args) {
    const result = await create.apply(this, args);
    if (faults.barrier) {
      faults.barrier = false;
      const waiting = new Promise(resolve => { releaseBarrier = resolve; });
      process.send({ event: 'barrier' }); await waiting;
    }
    return result;
  };
  const Receipt = source(c.worktree + '/src/models/TrackCreateIdempotency');
  const receiptCreate = Receipt.create;
  Receipt.create = async function (...args) {
    const result = await receiptCreate.apply(this, args);
    if (faults.afterReceipt) { faults.afterReceipt = false; throw new Error('Test-only after receipt insertion'); }
    return result;
  };
  const cloudinary = source(c.worktree + '/src/config/cloudinary');
  for (const method of ['upload_stream', 'destroy']) cloudinary.uploader[method] = () => { throw new Error('Cloudinary forbidden'); };
  require('node:https').request = () => { throw new Error('External HTTPS forbidden'); };
  const http = require('node:http'); const createServer = http.createServer;
  http.createServer = (app, ...args) => {
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/tracks') {
        const end = res.end;
        res.end = function (...a) {
          if (faults.dropResponse && res.statusCode === 201) {
            faults.dropResponse = false; process.send({ event: 'responseDropped' }); req.socket.destroy(); return this;
          }
          return end.apply(this, a);
        };
      }
      app(req, res);
    }, ...args);
    server.on('listening', () => process.send({ event: 'ready', port: server.address().port }));
    return server;
  };
  source(c.worktree + '/src/server.js');
}
process.on('message', async message => {
  try {
    if (message.command === 'init') { await init(message.config); return; }
    if (message.command === 'arm') { faults = { ...faults, ...message.fault }; }
    if (message.command === 'release') { releaseBarrier?.(); releaseBarrier = undefined; }
    if (message.command === 'trace') {
      process.send({ id: message.id, value: JSON.parse(JSON.stringify(trace)) }); return;
    }
    if (message.command === 'shutdown') {
      releaseBarrier?.(); process.emit('SIGTERM');
      const end = Date.now() + 15000;
      while ((mongoose.connection.readyState !== 0 || server?.listening) && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(mongoose.connection.readyState, 0); assert.ok(!server?.listening);
      assert.equal(trace.sessionsStarted, trace.sessionsEnded, 'Explicit sessions must end');
      process.send({ id: message.id, value: { closed: true,
        sessionsStarted: trace.sessionsStarted, sessionsEnded: trace.sessionsEnded } });
      process.disconnect(); return;
    }
    process.send({ id: message.id, value: true });
  } catch (error) {
    process.send({ id: message.id, event: 'workerError', error: { name: error.name, code: error.code || null } });
  }
});
