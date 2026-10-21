const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// This test worker never loads .env or opens a database connection.
process.env.JWT_SECRET = 'auth-http-tests-only-signing-key-at-least-32-bytes';
process.env.PROXY_DEBUG = 'false';
mongoose.set('bufferCommands', false);
const { createAccessToken, verifyAccessToken } = require('../src/config/jwt');
const User = require('../src/models/User');
const authRoutes = require('../src/routes/auth.routes');
const authRateLimiter = require('../src/middlewares/auth-rate-limit.middleware');
const errorHandler = require('../src/middlewares/error.middleware');

const OWNER = '507f1f77bcf86cd799439011';
const OTHER = '507f1f77bcf86cd799439012';
const PASSWORD = '  auth-test-password  ';
const EMAIL = 'listener@example.invalid';
const date = new Date('2026-01-01T00:00:00.000Z');
const registration = () => ({ username: 'Listener', email: EMAIL, password: PASSWORD });
let passwordHash;

before(async () => { passwordHash = await bcrypt.hash(PASSWORD, 12); });

function userDocument(values = {}) {
  return new User({ _id: OWNER, username: 'Listener', email: EMAIL,
    passwordHash, role: 'user', createdAt: date, updatedAt: date, __v: 3, ...values });
}

// Top-level tests are sequential. The real singleton limiter is reset before
// and after each server; model mocks are restored by node:test after teardown.
async function startServer(t, options = {}) {
  const keys = ['127.0.0.1', '198.51.100.21', '198.51.100.22'];
  for (const key of keys) authRateLimiter.resetKey(key);
  const users = options.users || [];
  const calls = { init: 0, create: [], findOne: [], select: [], findById: [] };
  t.mock.method(console, 'error', () => {});
  const warnings = t.mock.method(console, 'warn', () => {});
  t.mock.method(User, 'init', async () => {
    calls.init += 1;
    if (options.initError) throw options.initError;
  });
  t.mock.method(User, 'create', async input => {
    calls.create.push(input);
    if (options.createError) throw options.createError;
    if (users.some(user => user.email === input.email)) {
      throw Object.assign(new Error('Private duplicate-key diagnostic'), { code: 11000 });
    }
    const user = userDocument({ ...input, _id: new mongoose.Types.ObjectId() });
    await user.validate();
    users.push(user);
    return user;
  });
  t.mock.method(User, 'findOne', filter => {
    calls.findOne.push(filter);
    return {
      async select(projection) {
        calls.select.push(projection);
        if (options.loginError) throw options.loginError;
        return users.find(user => user.email === filter.email) || null;
      },
    };
  });
  t.mock.method(User, 'findById', async id => {
    calls.findById.push(id);
    if (options.meError) throw options.meError;
    // Keep passwordHash on the in-memory document deliberately: serialization
    // must still use the real User transform even with a selected hash.
    return users.find(user => String(user._id) === id) || null;
  });

  const app = express();
  app.set('trust proxy', options.trustProxy || false);
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      for (const key of keys) authRateLimiter.resetKey(key);
    }
  });
  await once(server, 'listening');
  return {
    users, calls, warnings,
    async send(route, { body, raw, headers = {} } = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/${route}`, {
        method: route === 'me' ? 'GET' : 'POST',
        headers: { ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-type'), /application\/json/);
      return { status: response.status, body: await response.json(), headers: response.headers };
    },
  };
}

function expectError(response, status, message) {
  assert.equal(response.status, status);
  assert.deepEqual(response.body, { message });
}

function expectUser(user, expected) {
  assert.deepEqual(Object.keys(user).sort(), ['_id', 'username', 'email', 'role', 'avatarUrl', 'createdAt', 'updatedAt'].sort());
  assert.equal(user._id, String(expected._id));
  assert.equal(user.username, expected.username);
  assert.equal(user.email, expected.email);
  assert.equal(user.role, expected.role);
  assert.equal(user.avatarUrl, expected.avatarUrl);
  assert.equal(user.createdAt, date.toISOString());
  assert.equal(user.updatedAt, date.toISOString());
}

function expectAuth(response, status, user) {
  assert.equal(response.status, status);
  assert.deepEqual(Object.keys(response.body), ['data']);
  assert.deepEqual(Object.keys(response.body.data).sort(), ['accessToken', 'user']);
  expectUser(response.body.data.user, user);
  assert.equal(typeof response.body.data.accessToken, 'string');
  assert.equal(verifyAccessToken(response.body.data.accessToken).sub, String(user._id));
}

test('register normalizes identity, hashes the untrimmed password at cost 12 and returns a safe User/token', async t => {
  const f = await startServer(t);
  const response = await f.send('register', { body: { ...registration(), username: '  Listener  ',
    email: '  LISTENER@EXAMPLE.INVALID  ', role: 'admin', passwordHash: 'client-supplied', _id: OTHER } });
  expectAuth(response, 201, f.users[0]);
  assert.equal(f.calls.init, 1);
  assert.equal(f.users.length, 1);
  const saved = f.calls.create[0];
  assert.deepEqual(Object.keys(saved).sort(), ['username', 'email', 'passwordHash', 'role'].sort());
  assert.equal(saved.username, 'Listener');
  assert.equal(saved.email, EMAIL);
  assert.equal(saved.role, 'user');
  assert.equal(bcrypt.getRounds(saved.passwordHash), 12);
  assert.ok(await bcrypt.compare(PASSWORD, saved.passwordHash));
  assert.equal(await bcrypt.compare(PASSWORD.trim(), saved.passwordHash), false);
});

for (const [name, change] of [
  ['minimum username and password', { username: 'ab', password: '12345678' }],
  ['maximum username and ASCII password', { username: 'a'.repeat(50), password: 'a'.repeat(72) }],
  ['72 UTF-8 bytes', { password: '\u00e9'.repeat(36) }],
  ['254-character email', { email: 'a'.repeat(242) + '@example.com' }],
]) {
  test(`register/login accept ${name}`, async t => {
    const f = await startServer(t);
    const body = { ...registration(), ...change };
    const response = await f.send('register', { body });
    expectAuth(response, 201, f.users[0]);
    assert.ok(await bcrypt.compare(body.password, f.calls.create[0].passwordHash));
    expectAuth(await f.send('login', { body: { email: body.email, password: body.password } }), 200, f.users[0]);
  });
}

for (const [name, change, message] of [
  ['missing username', { username: undefined }, 'username, email, and password must be strings.'],
  ['object username', { username: { $ne: null } }, 'username, email, and password must be strings.'],
  ['blank username', { username: '   ' }, 'Username must contain between 2 and 50 characters.'],
  ['one-character username', { username: 'a' }, 'Username must contain between 2 and 50 characters.'],
  ['long username', { username: 'a'.repeat(51) }, 'Username must contain between 2 and 50 characters.'],
]) {
  test(`register rejects ${name} before database access`, async t => {
    const f = await startServer(t);
    expectError(await f.send('register', { body: { ...registration(), ...change } }), 400, message);
    assert.equal(f.calls.init, 0);
    assert.equal(f.calls.create.length, 0);
  });
}

// Shared register/login input rules are exercised once as a parameterized matrix.
for (const route of ['register', 'login']) {
  const typeMessage = route === 'register' ? 'username, email, and password must be strings.' : 'email and password must be strings.';
  for (const [name, change, message] of [
    ['missing email', { email: undefined }, typeMessage],
    ['operator email', { email: { $ne: null } }, typeMessage],
    ['array email', { email: [EMAIL] }, typeMessage],
    ['blank email', { email: '   ' }, 'Provide a valid email address.'],
    ['malformed email', { email: 'not-an-email' }, 'Provide a valid email address.'],
    ['long email', { email: 'a'.repeat(243) + '@example.com' }, 'Provide a valid email address.'],
    ['missing password', { password: undefined }, typeMessage],
    ['numeric password', { password: 12345678 }, typeMessage],
    ['operator password', { password: { $gt: '' } }, typeMessage],
    ['short password', { password: '1234567' }, 'Password must contain at least 8 characters and at most 72 UTF-8 bytes.'],
    ['73-byte password', { password: 'a'.repeat(73) }, 'Password must contain at least 8 characters and at most 72 UTF-8 bytes.'],
    ['multibyte password above 72 bytes', { password: '\u00e9'.repeat(37) }, 'Password must contain at least 8 characters and at most 72 UTF-8 bytes.'],
  ]) {
    test(`${route} rejects ${name} before database access`, async t => {
      const f = await startServer(t);
      expectError(await f.send(route, { body: { ...registration(), ...change } }), 400, message);
      assert.equal(f.calls.init, 0);
      assert.equal(f.calls.create.length, 0);
      assert.equal(f.calls.findOne.length, 0);
    });
  }
  test(`${route} rejects a missing body`, async t => {
    const f = await startServer(t);
    expectError(await f.send(route), 400, typeMessage);
    assert.equal(f.calls.init, 0);
    assert.equal(f.calls.findOne.length, 0);
  });
  for (const [name, raw, status, message] of [
    ['malformed JSON', '{"email":', 400, 'Request body must contain valid JSON.'],
    ['oversized JSON', JSON.stringify({ padding: 'x'.repeat(110 * 1024) }), 413, 'Request body exceeds the allowed size.'],
  ]) {
    test(`${route} handles ${name} through the real parser/error middleware`, async t => {
      const f = await startServer(t);
      expectError(await f.send(route, { raw }), status, message);
      assert.equal(f.calls.init, 0);
      assert.equal(f.calls.findOne.length, 0);
    });
  }
}

test('register maps a normalized duplicate email to 409 without changing the existing account', async t => {
  const f = await startServer(t);
  assert.equal((await f.send('register', { body: registration() })).status, 201);
  const original = f.users[0].toObject();
  expectError(await f.send('register', { body: { ...registration(), email: '  LISTENER@EXAMPLE.INVALID  ' } }),
    409, 'Email is already registered.');
  assert.equal(f.users.length, 1);
  assert.deepEqual(f.users[0].toObject(), original);
});

for (const [name, options, status, message] of [
  ['index initialization failure', { initError: new Error('Private database diagnostic') }, 500, 'Unable to register. Please try again later.'],
  ['insert failure', { createError: Object.assign(new Error('Private database diagnostic'), { code: 9191 }) }, 500, 'Unable to register. Please try again later.'],
  ['Mongoose validation failure', { createError: new mongoose.Error.ValidationError() }, 400, 'Invalid registration data.'],
]) {
  test(`register sanitizes ${name}`, async t => {
    const f = await startServer(t, options);
    expectError(await f.send('register', { body: registration() }), status, message);
    assert.equal(f.users.length, 0);
    assert.equal(f.calls.create.length, options.initError ? 0 : 1);
  });
}

test('login normalizes email, selects the hash and verifies the original password with real bcrypt', async t => {
  const user = userDocument();
  const f = await startServer(t, { users: [user] });
  const response = await f.send('login', { body: { email: ' LISTENER@EXAMPLE.INVALID ', password: PASSWORD } });
  expectAuth(response, 200, user);
  assert.deepEqual(f.calls.findOne, [{ email: EMAIL }]);
  assert.deepEqual(f.calls.select, ['+passwordHash']);
  assert.equal(f.calls.init, 0);
  assert.equal(f.calls.create.length, 0);
});

test('login gives the same generic 401 for unknown email and wrong or trimmed passwords', async t => {
  const f = await startServer(t, { users: [userDocument()] });
  for (const body of [
    { email: 'unknown@example.invalid', password: PASSWORD },
    { email: EMAIL, password: 'wrong-password' },
    { email: EMAIL, password: PASSWORD.trim() },
  ]) {
    expectError(await f.send('login', { body }), 401, 'Invalid email or password.');
  }
  assert.equal(f.calls.create.length, 0);
});

test('login sanitizes a database query failure', async t => {
  const f = await startServer(t, { loginError: new Error('Private database diagnostic') });
  expectError(await f.send('login', { body: { email: EMAIL, password: PASSWORD } }),
    500, 'Unable to log in. Please try again later.');
  assert.deepEqual(f.calls.select, ['+passwordHash']);
});

test('me uses the signed subject and returns a safe User with case-insensitive Bearer syntax', async t => {
  const user = userDocument();
  const f = await startServer(t, { users: [user] });
  const response = await f.send('me', { headers: { Authorization: `bEaReR   ${createAccessToken(user._id)}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body), ['data']);
  assert.deepEqual(Object.keys(response.body.data), ['user']);
  expectUser(response.body.data.user, user);
  assert.deepEqual(f.calls.findById, [OWNER]);
});

for (const [name, authorization] of [
  ['missing header', undefined], ['wrong scheme', 'Basic invalid'],
  ['missing Bearer value', 'Bearer'], ['extra Bearer parts', 'Bearer one two'],
]) {
  test(`me rejects ${name} without database access`, async t => {
    const f = await startServer(t);
    expectError(await f.send('me', { headers: authorization ? { Authorization: authorization } : {} }), 401, 'Authentication required.');
    assert.equal(f.calls.findById.length, 0);
  });
}

function sign(claims = {}, options = {}, key = process.env.JWT_SECRET) {
  return jwt.sign({ sub: OWNER, ...claims }, key, { algorithm: 'HS256', issuer: 'stemforge-server',
    audience: 'stemforge-client', expiresIn: 3600, ...options });
}

for (const [name, token] of [
  ['malformed token', () => 'not-a-token'],
  ['another signing key', () => sign({}, {}, 'different-test-only-signing-key-32-bytes')],
  ['tampered subject', () => {
    const [header, payload, signature] = createAccessToken(OWNER).split('.');
    const altered = { ...JSON.parse(Buffer.from(payload, 'base64url')), sub: OTHER };
    return [header, Buffer.from(JSON.stringify(altered)).toString('base64url'), signature].join('.');
  }],
  ['expired token', () => sign({}, { expiresIn: -1 })],
  ['not-yet-valid token', () => sign({}, { notBefore: 60 })],
  ['wrong issuer', () => sign({}, { issuer: 'another-server' })],
  ['wrong audience', () => sign({}, { audience: 'another-client' })],
  ['HS384 token', () => sign({}, { algorithm: 'HS384' })],
  ['unsigned token', () => sign({}, { algorithm: 'none' }, '')],
  ['missing subject', () => sign({ sub: undefined })],
  ['numeric subject', () => sign({ sub: 42 })],
  ['invalid ObjectId subject', () => sign({ sub: 'not-an-object-id' })],
  ['12-character subject', () => sign({ sub: 'abcdefghijkl' })],
]) {
  test(`me rejects ${name} before database access`, async t => {
    const f = await startServer(t);
    expectError(await f.send('me', { headers: { Authorization: `Bearer ${token()}` } }), 401, 'Invalid or expired access token.');
    assert.equal(f.calls.findById.length, 0);
  });
}

test('me rejects a valid token when its User no longer exists', async t => {
  const f = await startServer(t);
  expectError(await f.send('me', { headers: { Authorization: `Bearer ${createAccessToken(OWNER)}` } }),
    401, 'Invalid or expired access token.');
  assert.deepEqual(f.calls.findById, [OWNER]);
});

test('me sanitizes a database failure and distinguishes it from invalid credentials', async t => {
  const f = await startServer(t, { meError: new Error('Private database diagnostic') });
  expectError(await f.send('me', { headers: { Authorization: `Bearer ${createAccessToken(OWNER)}` } }),
    500, 'Unable to authenticate. Please try again later.');
  assert.deepEqual(f.calls.findById, [OWNER]);
});

test('Auth shares a 20-request quota across register/login, counts successes/failures and leaves me accessible', async t => {
  const f = await startServer(t);
  const registered = await f.send('register', { body: registration() });
  assert.equal(registered.status, 201);
  assert.equal((await f.send('login', { body: { email: EMAIL, password: PASSWORD } })).status, 200);
  for (let i = 2; i < 20; i += 1) {
    assert.equal((await f.send(i % 2 ? 'login' : 'register', { body: {} })).status, 400);
  }
  const before = structuredClone(f.calls);
  for (const route of ['register', 'login']) {
    const blocked = await f.send(route, { body: registration() });
    expectError(blocked, 429, 'Too many authentication requests. Please try again later.');
    const retry = Number(blocked.headers.get('retry-after'));
    assert.ok(Number.isInteger(retry) && retry > 0 && retry <= 900);
    assert.match(blocked.headers.get('ratelimit'), /r=0/);
    assert.match(blocked.headers.get('ratelimit-policy'), /q=20;\s*w=900/);
    assert.equal(blocked.headers.get('x-ratelimit-limit'), null);
  }
  assert.deepEqual(f.calls, before, 'Blocked requests must not reach database operations');
  assert.equal(f.warnings.mock.callCount(), 2);
  const me = await f.send('me', { headers: { Authorization: `Bearer ${registered.body.data.accessToken}` } });
  assert.equal(me.status, 200);
  assert.equal(me.headers.get('ratelimit'), null);
});

test('Auth quota is keyed per client IP behind an explicitly trusted test proxy', async t => {
  const f = await startServer(t, { trustProxy: 1 });
  const a = { 'X-Forwarded-For': '198.51.100.21' };
  const b = { 'X-Forwarded-For': '198.51.100.22' };
  for (let i = 0; i < 20; i += 1) assert.equal((await f.send('login', { body: {}, headers: a })).status, 400);
  assert.equal((await f.send('register', { body: {}, headers: a })).status, 429);
  const other = await f.send('login', { body: {}, headers: b });
  assert.equal(other.status, 400);
  assert.match(other.headers.get('ratelimit'), /r=19/);
  assert.equal(f.calls.findOne.length, 0);
});

test('a new test server starts with a clean quota after the preceding exhaustion cases', async t => {
  const f = await startServer(t);
  const response = await f.send('login', { body: {} });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('ratelimit'), /r=19/);
});
