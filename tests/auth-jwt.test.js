const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'auth-jwt-tests-only-signing-key-at-least-32-bytes';
const { createAccessToken, verifyAccessToken } = require('../src/config/jwt');
const OWNER = '507f1f77bcf86cd799439011';

test('access tokens contain only identity/standard claims, use HS256 and expire after exactly one hour', () => {
  const before = Math.floor(Date.now() / 1000);
  const token = createAccessToken(OWNER);
  const verified = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'],
    issuer: 'stemforge-server', audience: 'stemforge-client' });
  const after = Math.floor(Date.now() / 1000);
  const header = jwt.decode(token, { complete: true }).header;
  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(Object.keys(verified).sort(), ['sub', 'iat', 'exp', 'iss', 'aud'].sort());
  assert.equal(verified.sub, OWNER);
  assert.equal(verified.iss, 'stemforge-server');
  assert.equal(verified.aud, 'stemforge-client');
  assert.ok(verified.iat >= before && verified.iat <= after);
  assert.equal(verified.exp - verified.iat, 3600);
  assert.deepEqual(verifyAccessToken(token), verified);
});

test('verification accepts the last valid second and rejects the exact expiry boundary without sleeping', t => {
  const token = createAccessToken(OWNER);
  const exp = jwt.decode(token).exp;
  let now = (exp - 1) * 1000;
  t.mock.method(Date, 'now', () => now);
  assert.equal(verifyAccessToken(token).sub, OWNER);
  now = exp * 1000;
  assert.throws(() => verifyAccessToken(token), error => error.name === 'TokenExpiredError');
});

// Configuration is evaluated at require time; child processes isolate both
// the module cache and dummy environment from the HTTP tests and each other.
for (const [name, secret, accepted] of [
  ['missing secret', undefined, false],
  ['31 ASCII bytes', 'x'.repeat(31), false],
  ['30 multibyte UTF-8 bytes', '\u00e9'.repeat(15), false],
  ['32 ASCII bytes', 'x'.repeat(32), true],
  ['32 multibyte UTF-8 bytes', '\u00e9'.repeat(16), true],
]) {
  test(`JWT configuration ${accepted ? 'accepts' : 'rejects'} ${name}`, () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp'].includes(key.toLowerCase())));
    if (secret !== undefined) env.JWT_SECRET = secret;
    const modulePath = path.resolve(__dirname, '../src/config/jwt');
    const result = spawnSync(process.execPath, ['-e', `
      try { require(${JSON.stringify(modulePath)}); process.stdout.write('accepted'); }
      catch (error) {
        if (error.message !== 'JWT_SECRET must contain at least 32 bytes.') process.exitCode = 1;
        else process.stdout.write('rejected');
      }
    `], { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, accepted ? 'accepted' : 'rejected');
  });
}
