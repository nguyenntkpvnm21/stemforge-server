const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once, EventEmitter } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const { Writable } = require('node:stream');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

// Worker-local synthetic configuration only. Never load .env or server.js.
for (const key of ['JWT_SECRET', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  process.env[key] = randomBytes(32).toString('hex');
}
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.ADDITIONAL_FRONTEND_ORIGINS = '';
process.env.TRUST_PROXY_HOPS = '0';
process.env.PROXY_DEBUG = 'false';
mongoose.set('bufferCommands', false);

const app = require('../../src/app');
const cloudinary = require('../../src/config/cloudinary');
const User = require('../../src/models/User');
const Track = require('../../src/models/Track');
const TrackLike = require('../../src/models/TrackLike');
const authLimiter = require('../../src/middlewares/auth-rate-limit.middleware');

function makeWave(index) {
  const frames = 80;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame += 1) buffer.writeInt16LE((index + 1) * 100, 44 + frame * 2);
  return buffer;
}

function selection(count = 4) {
  return ['Drums', 'Bass', 'Chords', 'Lead'].slice(0, count).map((name, index) => ({
    clientId: `slot-${index}`, name, buffer: makeWave(index),
    // Intentionally identical filenames: neither name nor completion order is identity.
    filename: 'stem.wav',
  }));
}

async function startFixture(t, slots) {
  const records = [];
  const assets = new Map();
  const pending = new Map();
  const received = new EventEmitter();
  const calls = { uploads: [], creates: [], requests: [], commits: 0, drops: 0 };
  const password = randomBytes(24).toString('hex');
  const user = new User({
    _id: new mongoose.Types.ObjectId(), username: 'Publish fixture',
    email: `${randomBytes(8).toString('hex')}@example.invalid`,
    passwordHash: await bcrypt.hash(password, 12), role: 'user', avatarUrl: null,
  });
  let session = null;
  let dropNextResponse = null;
  authLimiter.resetKey('127.0.0.1');

  // Fail closed if an unmocked path attempts a DB or provider connection.
  t.mock.method(mongoose.connection, 'openUri', async () => { throw new Error('External DB forbidden'); });
  t.mock.method(https, 'request', () => { throw new Error('External HTTPS forbidden'); });
  t.mock.method(console, 'error', () => {});
  t.mock.method(User, 'findOne', filter => ({
    async select() { return filter.email === user.email ? user : null; },
  }));
  t.mock.method(User, 'findById', async id => String(id) === String(user._id) ? user : null);
  t.mock.method(User, 'find', filter => ({
    select() { return this; }, lean() { return this; },
    session(value) { assert.equal(value, session); return this; },
    async exec() { return filter._id.$in.includes(String(user._id)) ? [user.toObject()] : []; },
  }));
  t.mock.method(TrackLike, 'find', () => ({
    select() { return this; }, lean() { return this; },
    session(value) { assert.equal(value, session); return this; },
    async exec() { return []; },
  }));
  t.mock.method(mongoose.connection, 'transaction', async operation => {
    assert.equal(session, null);
    const staged = [];
    session = { staged };
    try {
      const result = await operation(session);
      records.push(...staged);
      calls.commits += 1;
      return result;
    } finally { session = null; }
  });
  t.mock.method(Track, 'create', async ([input], options) => {
    assert.ok(session);
    assert.equal(options.session, session);
    calls.creates.push(structuredClone(input));
    const doc = new Track({ ...input, createdAt: new Date() });
    await doc.validate();
    session.staged.push(doc);
    return [doc];
  });
  const matches = (doc, filter) =>
    (!filter._id || String(doc._id) === String(filter._id)) &&
    (filter.artistId === undefined || String(doc.artistId) === String(filter.artistId)) &&
    (filter.isPublic === undefined || doc.isPublic === filter.isPublic) &&
    (!filter.$or || filter.$or.some(part => matches(doc, part)));
  t.mock.method(Track, 'findOne', filter => ({ async exec() { return records.find(doc => matches(doc, filter)) ?? null; } }));
  t.mock.method(Track, 'find', filter => {
    let skip = 0; let limit = 12; let sort;
    return {
      sort(value) { sort = value; return this; },
      skip(value) { skip = value; return this; },
      limit(value) { limit = value; return this; },
      async exec() {
        return records.filter(doc => matches(doc, filter)).sort((a, b) => {
          for (const [key, direction] of Object.entries(sort)) {
            const left = key === '_id' ? String(a[key]) : a[key];
            const right = key === '_id' ? String(b[key]) : b[key];
            if (left < right) return -direction;
            if (left > right) return direction;
          }
          return 0;
        }).slice(skip, skip + limit);
      },
    };
  });
  t.mock.method(Track, 'countDocuments', filter => ({ async exec() { return records.filter(doc => matches(doc, filter)).length; } }));
  t.mock.method(cloudinary.uploader, 'upload_stream', (options, callback) => {
    const chunks = [];
    return new Writable({
      write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
      final(done) {
        const buffer = Buffer.concat(chunks);
        const slot = slots.find(item => item.buffer.equals(buffer));
        assert.ok(slot, 'Only explicitly registered in-memory fixture audio is allowed');
        assert.equal(options.resource_type, 'video');
        assert.equal(options.type, 'upload');
        assert.equal(options.overwrite, false);
        assert.ok(options.public_id.startsWith(`stemforge/audio/${user._id}/`));
        assert.equal(pending.has(slot.clientId), false);
        pending.set(slot.clientId, { slot, options, callback });
        calls.uploads.push(slot.clientId);
        done();
        received.emit('upload');
      },
    });
  });
  const destroy = t.mock.method(cloudinary.uploader, 'destroy', async () => {
    throw new Error('Unexpected deletion: successful uploads must be preserved');
  });

  const server = http.createServer((req, res) => {
    calls.requests.push({ method: req.method, path: new URL(req.url, 'http://localhost').pathname });
    if (dropNextResponse && req.method === 'POST' && req.url === '/api/tracks') {
      const timing = dropNextResponse;
      dropNextResponse = null;
      if (timing === 'before-handler') {
        calls.drops += 1;
        req.socket.destroy();
        return;
      }
      const end = res.end;
      // Test-only transport fault outside runtime code: lose the response after commit.
      res.end = function (...args) {
        if (res.statusCode !== 201) return end.apply(this, args);
        assert.equal(calls.commits, records.length);
        calls.drops += 1;
        req.socket.destroy();
        return this;
      };
    }
    app(req, res);
  });
  t.after(async () => {
    try {
      for (const { callback } of pending.values()) callback(new Error('Fixture teardown'));
      pending.clear();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.equal(mongoose.connection.readyState, 0);
      assert.equal(destroy.mock.callCount(), 0);
    } finally {
      records.length = 0; assets.clear(); received.removeAllListeners();
      authLimiter.resetKey('127.0.0.1');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function send(path, { token, method = 'GET', body } = {}) {
    const url = new URL(path, base);
    assert.equal(url.origin, base, 'HTTP must stay on this fixture server');
    const multipart = body instanceof FormData;
    const response = await fetch(url, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() };
  }
  return {
    records, assets, calls, ownerId: String(user._id),
    async login() {
      const response = await send('/api/auth/login', { method: 'POST', body: { email: user.email, password } });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.user._id, String(user._id));
      assert.equal(response.body.data.user.passwordHash, undefined);
      return response.body.data.accessToken;
    },
    send,
    upload(slot, token) {
      const form = new FormData();
      form.append('audio', new Blob([slot.buffer], { type: 'audio/wav' }), slot.filename);
      return send('/api/uploads/audio', { token, method: 'POST', body: form });
    },
    async waitForUpload(clientId) {
      while (!pending.has(clientId)) await once(received, 'upload', { signal: AbortSignal.timeout(5000) });
    },
    release(clientId, { reject = false } = {}) {
      const item = pending.get(clientId);
      assert.ok(item, 'Release only an upload already received by the provider fixture');
      pending.delete(clientId);
      if (reject) return item.callback({ http_code: 400, message: 'Invalid audio file' });
      const data = {
        public_id: item.options.public_id, resource_type: 'video', type: 'upload', format: 'wav',
        secure_url: `https://example.invalid/${item.options.public_id}.wav`,
        duration: 0.01, bytes: item.slot.buffer.length,
      };
      assets.set(data.public_id, data);
      item.callback(null, data);
    },
    loseNextCreateResponse(timing = 'after-commit') {
      assert.ok(['before-handler', 'after-commit'].includes(timing));
      dropNextResponse = timing;
    },
  };
}

// Reference client orchestration for this test only; not frontend/runtime code.
function startUploads(fixture, slots, token, previous = new Map()) {
  const results = new Map(previous);
  const queue = slots.filter(slot => results.get(slot.clientId)?.status !== 201);
  const completed = new EventEmitter();
  const completionOrder = [];
  let next = 0;
  const done = Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (next < queue.length) {
      const slot = queue[next++];
      results.set(slot.clientId, await fixture.upload(slot, token));
      completionOrder.push(slot.clientId);
      completed.emit('slot');
    }
  }));
  return {
    results, completionOrder, done,
    async waitForResult(clientId) {
      while (!results.has(clientId)) await once(completed, 'slot', { signal: AbortSignal.timeout(5000) });
    },
  };
}

function trackInput(slots, results, overrides = {}) {
  assert.ok(slots.every(slot => results.get(slot.clientId)?.status === 201), 'Every selected slot must upload successfully');
  return {
    title: 'Local multi-stem integration', genre: 'Electronic', bpm: 96, key: 'Am',
    tags: ['local-publish-integration'], coverImageUrl: null,
    description: 'Synthetic audio with mocked storage; never uploaded externally.',
    isPublic: true, isDownloadable: false,
    stems: slots.map(slot => {
      const { audioUrl, duration, fileSize } = results.get(slot.clientId).body.data;
      return { name: slot.name, audioUrl, duration, fileSize };
    }), ...overrides,
  };
}

async function publish(fixture, input, token) {
  try {
    const response = await fixture.send('/api/tracks', { token, method: 'POST', body: input });
    if (response.status === 201) return { state: 'published', track: response.body.data };
    if ([400, 401, 413].includes(response.status)) return { state: 'rejected', response };
    return { state: 'unknown', response };
  } catch {
    // A transport failure is not evidence that the Track was never committed.
    return { state: 'unknown' };
  }
}

module.exports = { selection, startFixture, startUploads, trackInput, publish };
