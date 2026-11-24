const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { fork } = require('node:child_process');
const path = require('node:path');
const zlib = require('node:zlib');

// Existing Auth tests cover plain valid/malformed/oversized JSON. This file adds
// compressed parsing and the crash-sensitive advisory cases without real services.
process.env.JWT_SECRET = 'json-parser-tests-only-signing-key-at-least-32-bytes';
process.env.CLOUDINARY_CLOUD_NAME = 'parser-test';
process.env.CLOUDINARY_API_KEY = 'parser-test';
process.env.CLOUDINARY_API_SECRET = 'parser-test';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.ADDITIONAL_FRONTEND_ORIGINS = '';
process.env.TRUST_PROXY_HOPS = '0';
const app = require('../src/app');
const User = require('../src/models/User');
const bcrypt = require('bcrypt');
const limiter = require('../src/middlewares/auth-rate-limit.middleware');
const EMAIL = 'parser@example.invalid';
const PASSWORD = 'parser-fixture-password';
const body = Buffer.from(JSON.stringify({ email: EMAIL, password: PASSWORD }));

async function fixture(t) {
  const queries = [];
  const user = new User({ _id: '507f1f77bcf86cd799439011', username: 'Parser fixture', email: EMAIL,
    passwordHash: 'fixture-only-hash', role: 'user' });
  t.mock.method(User, 'findOne', filter => ({ async select(fields) {
    assert.equal(fields, '+passwordHash'); queries.push(filter); return user;
  } }));
  t.mock.method(bcrypt, 'compare', async (value, hash) => {
    assert.equal(value, PASSWORD); assert.equal(hash, 'fixture-only-hash'); return true;
  });
  limiter.resetKey('127.0.0.1');
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    try { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
    finally { limiter.resetKey('127.0.0.1'); }
  });
  await once(server, 'listening');
  return { queries, async send(buffer, encoding, extra = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding, ...extra },
      body: buffer, signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  } };
}
for (const [encoding, compress] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]]) {
  test('JSON parser accepts ordinary ' + encoding + ' through actual app/Auth route', async t => {
    const f = await fixture(t), response = await f.send(compress(body), encoding);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.body.data.user.email, EMAIL); assert.ok(response.body.data.accessToken);
    assert.equal('passwordHash' in response.body.data.user, false);
    assert.deepEqual(f.queries, [{ email: EMAIL }]);
  });
}
for (const [name, buffer, encoding, status, message] of [
  ['corrupt gzip', Buffer.from('not a gzip stream'), 'gzip', 400, 'Invalid request.'],
  ['malformed inflated JSON', zlib.gzipSync(Buffer.from('{"email":')), 'gzip', 400, 'Request body must contain valid JSON.'],
  ['inflated body above 100KiB', zlib.gzipSync(Buffer.from(JSON.stringify({ padding: 'x'.repeat(110 * 1024) }))), 'gzip', 413, 'Request body exceeds the allowed size.'],
  ['unsupported content encoding', body, 'unknown-encoding', 415, 'Invalid request.'],
]) test('JSON parser sanitizes ' + name + ' before Auth/database work', async t => {
  const f = await fixture(t), response = await f.send(buffer, encoding);
  assert.equal(response.status, status); assert.deepEqual(response.body, { message });
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(f.queries.length, 0);
});

for (const mode of ['trailing-gzip', 'unsupported-charset']) test('GHSA-27r3-jxmh-p828 survives ' + mode + ' in isolated child', { timeout: 12000 }, async t => {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const child = fork(path.join(__dirname, 'fixtures/json-parser-worker.cjs'), [mode], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Drain diagnostics without printing crash payloads, tokens or environment values.
  child.stdout.resume(); child.stderr.resume();
  const messages = []; child.on('message', m => messages.push(m));
  let timer;
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  t.after(async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  const result = await Promise.race([exited, new Promise((_, reject) => {
    timer = setTimeout(() => { child.kill(); reject(new Error('Parser child deadline')); }, 9000);
  })]);
  clearTimeout(timer); assert.equal(result.code, 0, 'Crash-sensitive child must exit normally; last phase: ' + messages.filter(m => m.event === 'phase').at(-1)?.name); assert.equal(result.signal, null);
  const verified = messages.find(m => m.event === 'verified'); assert.ok(verified, 'Child must finish request and health assertion');
  assert.equal(verified.status, mode === 'unsupported-charset' ? 415 : 200); assert.equal(verified.followupHealth, 200);
  assert.equal(messages.find(m => m.event === 'closed')?.serverClosed, true);
});
