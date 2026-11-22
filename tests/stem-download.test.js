const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

// Test-only credentials. Never load .env or connect to a database/provider.
delete process.env.CLOUDINARY_URL;
process.env.JWT_SECRET = 'stem-download-tests-only-signing-key-32-bytes';
process.env.CLOUDINARY_CLOUD_NAME = 'download-test-cloud';
process.env.CLOUDINARY_API_KEY = 'download-test-key';
process.env.CLOUDINARY_API_SECRET = 'download-test-secret';
const { createAccessToken } = require('../src/config/jwt');
const cloudinary = require('../src/config/cloudinary');
const service = require('../src/services/stem-download.service');
const routes = require('../src/routes/track.routes');
const errorHandler = require('../src/middlewares/error.middleware');
const Track = require('../src/models/Track');
const User = require('../src/models/User');

const OWNER = '507f1f77bcf86cd799439011';
const VIEWER = '507f1f77bcf86cd799439022';
const MISSING_USER = '507f1f77bcf86cd799439033';
const TRACK = '507f1f77bcf86cd799439044';
const STEM = '507f1f77bcf86cd799439055';
const OTHER_STEM = '507f1f77bcf86cd799439066';
const PUBLIC_ID = `stemforge/audio/${OWNER}/3bb2d1a7-9cf6-4dae-bc39-cad8ce01c4dc`;
const AUDIO = `https://res.cloudinary.com/download-test-cloud/video/upload/v123/${PUBLIC_ID}.wav`;
const PATH = `/${TRACK}/stems/${STEM}/download`;

async function fixture(t, options = {}) {
  const record = { _id: TRACK, artistId: OWNER, isPublic: true, isDownloadable: true,
    title: 'Private metadata must not appear', ...options.track,
    stems: options.stems ?? [{ stemId: STEM, name: 'Drums', audioUrl: options.audioUrl ?? AUDIO,
      duration: 20, fileSize: 3528044 }, { stemId: OTHER_STEM, name: 'Bass', audioUrl: AUDIO.replace('.wav', '.mp3') }] };
  const calls = { tracks: [], signing: 0, auth: 0 };
  t.mock.method(User, 'findById', async id => {
    calls.auth++;
    if (options.authError) throw new Error('Private authentication diagnostic');
    return [OWNER, VIEWER].includes(String(id)) ? { _id: id } : null;
  });
  t.mock.method(Track, 'findOne', filter => {
    calls.tracks.push(filter);
    assert.deepEqual(Object.keys(filter).sort(), ['$or', '_id']);
    assert.equal(filter.$or[0].isPublic, true);
    assert.deepEqual(Object.keys(filter.$or[1]), ['artistId']);
    return { select(fields) { assert.equal(fields, '_id isDownloadable stems'); return this; },
      lean() { return this; }, async exec() {
        if (options.dbError) throw Object.assign(new Error('Private database diagnostic'), { code: 123 });
        if (options.missing || filter._id.toLowerCase() !== TRACK) return null;
        return record.isPublic || String(filter.$or[1].artistId) === record.artistId ? record : null;
      } };
  });
  const realSign = cloudinary.utils.private_download_url;
  t.mock.method(cloudinary.utils, 'private_download_url', function (...args) {
    calls.signing++;
    if (options.signError) throw new Error('Private signing diagnostic');
    return realSign.apply(this, args);
  });
  // Issuing a descriptor must not call upload/delete/Admin APIs or proxy audio.
  for (const method of ['upload', 'upload_stream', 'destroy']) {
    t.mock.method(cloudinary.uploader, method, () => assert.fail('Unexpected storage mutation'));
  }
  t.mock.method(cloudinary.api, 'resource', () => assert.fail('Unexpected remote lookup'));
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const app = express();
  app.use(express.json());
  app.use('/api/tracks', routes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(server.listening, false);
  });
  await once(server, 'listening');
  return { record, calls, logs, async send(path = PATH, { user = VIEWER, authorization } = {}) {
    const headers = {};
    if (user) headers.Authorization = 'Bearer ' + createAccessToken(user);
    if (authorization !== undefined) headers.Authorization = authorization;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tracks${path}`, {
      headers, signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  } };
}

for (const [name, options] of [
  ['guest', { user: null }], ['invalid token', { authorization: 'Bearer invalid' }],
  ['wrong scheme', { authorization: 'Basic invalid' }], ['missing account', { user: MISSING_USER }],
  ['expired token', { authorization: 'Bearer ' + jwt.sign({}, process.env.JWT_SECRET, {
    subject: OWNER, issuer: 'stemforge-server', audience: 'stemforge-client', algorithm: 'HS256', expiresIn: -1,
  }) }],
]) test('download authenticates before Track/storage access: ' + name, async t => {
  const f = await fixture(t); const r = await f.send(PATH, options);
  assert.equal(r.status, 401); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(f.calls.tracks.length, 0); assert.equal(f.calls.signing, 0);
  assert.equal(JSON.stringify(r.body).includes(PUBLIC_ID), false);
});

for (const [name, path] of [
  ['bad Track ID', `/not-an-id/stems/${STEM}/download`],
  ['bad stem ID', `/${TRACK}/stems/not-an-id/download`],
  ['newline in Track ID', `/${TRACK}%0A/stems/${STEM}/download`],
  ['newline in stem ID', `/${TRACK}/stems/${STEM}%0A/download`],
  ['NUL in stem ID', `/${TRACK}/stems/${STEM}%00/download`],
  ['URL query', PATH + '?url=https://example.invalid/audio.wav'],
  ['owner query', PATH + '?artistId=' + OWNER], ['duplicate query', PATH + '?url=x&url=y'],
  ['operator query', PATH + '?url[$ne]=x'],
]) test('download rejects unsupported inputs before a Track query: ' + name, async t => {
  const f = await fixture(t); const r = await f.send(path);
  assert.equal(r.status, 400); assert.equal(f.calls.tracks.length, 0); assert.equal(f.calls.signing, 0);
});

function assertDescriptor(r, expectedStem = STEM, format = 'wav') {
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.deepEqual(Object.keys(r.body), ['data']);
  assert.deepEqual(Object.keys(r.body.data).sort(), ['downloadUrl', 'expiresAt', 'stemId', 'trackId']);
  assert.equal(r.body.data.trackId, TRACK); assert.equal(r.body.data.stemId, expectedStem);
  const url = new URL(r.body.data.downloadUrl);
  assert.equal(url.origin, 'https://api.cloudinary.com');
  assert.equal(url.pathname, '/v1_1/download-test-cloud/video/download');
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual(Object.keys(params).sort(), ['api_key', 'attachment', 'expires_at', 'format', 'public_id', 'signature', 'timestamp', 'type']);
  assert.equal(params.public_id, PUBLIC_ID); assert.equal(params.type, 'upload');
  assert.equal(params.format, format); assert.equal(params.attachment, 'true');
  assert.equal(Number(params.expires_at) - Number(params.timestamp), 300);
  assert.equal(r.body.data.expiresAt, new Date(Number(params.expires_at) * 1000).toISOString());
  assert.ok(Math.abs(Number(params.timestamp) * 1000 - Date.now()) < 10000);
  const { api_key, signature, ...signed } = params;
  assert.equal(api_key, 'download-test-key');
  assert.equal(signature, cloudinary.utils.api_sign_request(signed, 'download-test-secret'));
  assert.notEqual(signature, cloudinary.utils.api_sign_request({ ...signed, public_id: 'another-asset' }, 'download-test-secret'));
  assert.equal(JSON.stringify(r.body).includes('Bearer'), false);
  assert.equal(JSON.stringify(r.body).includes('download-test-secret'), false);
  assert.equal(JSON.stringify(r.body).includes('Private metadata'), false);
}

for (const [name, config, user] of [
  ['public Track, another account', {}, VIEWER], ['public Track, owner', {}, OWNER],
  ['private Track, owner', { track: { isPublic: false } }, OWNER],
]) test('download permits ' + name + ' when enabled', async t => {
  const f = await fixture(t, config); const before = JSON.stringify(f.record);
  const r = await f.send(PATH, { user }); assertDescriptor(r);
  assert.equal(f.calls.signing, 1); assert.equal(JSON.stringify(f.record), before);
  assert.equal(String(f.calls.tracks[0].$or[1].artistId), user);
});

test('download selects the requested stem, including uppercase ID, without changing playback URL', async t => {
  const f = await fixture(t); const before = f.record.stems.map(s => s.audioUrl);
  const r = await f.send(`/${TRACK.toUpperCase()}/stems/${OTHER_STEM.toUpperCase()}/download`);
  assertDescriptor(r, OTHER_STEM, 'mp3'); assert.deepEqual(f.record.stems.map(s => s.audioUrl), before);
});

for (const [name, options, user, status] of [
  ['missing Track', { missing: true }, VIEWER, 404],
  ['foreign private Track', { track: { isPublic: false } }, VIEWER, 404],
  ['foreign private disabled Track', { track: { isPublic: false, isDownloadable: false } }, VIEWER, 404],
  ['downloads disabled, viewer', { track: { isDownloadable: false } }, VIEWER, 403],
  ['downloads disabled, owner', { track: { isDownloadable: false } }, OWNER, 403],
  ['downloads disabled, own private', { track: { isDownloadable: false, isPublic: false } }, OWNER, 403],
  ['missing legacy flag', { track: { isDownloadable: undefined } }, OWNER, 403],
]) test('download denies ' + name, async t => {
  const f = await fixture(t, options); const r = await f.send(PATH, { user });
  assert.equal(r.status, status); assert.equal(f.calls.signing, 0);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(r.body), ['message']);
  assert.equal(JSON.stringify(r.body).includes(PUBLIC_ID), false);
});

test('stem ID from a different Track cannot be used as an arbitrary download selector', async t => {
  const f = await fixture(t); const r = await f.send(`/${TRACK}/stems/507f1f77bcf86cd799439099/download`);
  assert.deepEqual(r.body, { message: 'Stem not found' }); assert.equal(r.status, 404);
  assert.equal(f.calls.signing, 0);
});

test('permission checks precede unsupported URL validation', async t => {
  const f = await fixture(t, { track: { isPublic: false, isDownloadable: false }, audioUrl: 'https://private.invalid/audio.wav' });
  assert.equal((await f.send()).status, 404);
  assert.equal((await f.send(PATH, { user: OWNER })).status, 403);
  assert.equal(f.calls.signing, 0);
});

test('each authorization rechecks current visibility/download flag/deletion without caching tickets', async t => {
  const f = await fixture(t); assertDescriptor(await f.send());
  f.record.isDownloadable = false; assert.equal((await f.send()).status, 403);
  f.record.isDownloadable = true; f.record.isPublic = false;
  assert.equal((await f.send()).status, 404);
  assertDescriptor(await f.send(PATH, { user: OWNER }));
  assert.equal(f.calls.tracks.length, 4); assert.equal(f.calls.signing, 2);
});

for (const [name, options] of [
  ['database', { dbError: true }], ['signer', { signError: true }], ['authentication database', { authError: true }],
]) test('download sanitizes ' + name + ' failures', async t => {
  const f = await fixture(t, options); const r = await f.send();
  assert.equal(r.status, 500); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(r.body).includes('Private'), false);
  assert.equal(f.logs.join(' ').includes('Private'), false);
  assert.equal(f.logs.join(' ').includes('signature='), false);
});

for (const format of ['mp3', 'wav', 'flac']) test('original ' + format + ' uses a signed attachment without conversion', () => {
  const descriptor = service.createStemDownload(AUDIO.replace('.wav', '.' + format));
  assertDescriptor({ status: 200, headers: new Headers({ 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }),
    body: { data: { trackId: TRACK, stemId: STEM, ...descriptor } } }, STEM, format);
});

const invalidUrls = [
  ['external HTTPS', 'https://example.invalid/audio.wav'], ['loopback', 'http://127.0.0.1/audio.wav'],
  ['wrong cloud', AUDIO.replace('download-test-cloud', 'other-cloud')],
  ['host suffix', AUDIO.replace('res.cloudinary.com', 'res.cloudinary.com.evil.invalid')],
  ['URL userinfo', AUDIO.replace('res.cloudinary.com', 'evil.invalid@res.cloudinary.com')],
  ['explicit port', AUDIO.replace('res.cloudinary.com', 'res.cloudinary.com:443')],
  ['insecure HTTP', AUDIO.replace('https:', 'http:')],
  ['fetch delivery', AUDIO.replace('/video/upload/', '/video/fetch/')],
  ['private delivery', AUDIO.replace('/video/upload/', '/video/private/')],
  ['image resource', AUDIO.replace('/video/', '/image/')],
  ['existing transformation', AUDIO.replace('/upload/', '/upload/q_auto/')],
  ['URL query', AUDIO + '?format=mp3'], ['URL fragment', AUDIO + '#x'],
  ['unmanaged public ID', AUDIO.replace('stemforge/audio/', 'private-data/')],
  ['path traversal', AUDIO.replace('/stemforge/audio/', '/safe/../stemforge/audio/')],
  ['encoded path', AUDIO.replace('/stemforge/', '/%73temforge/')],
  ['unsupported format', AUDIO.replace('.wav', '.mp4')],
  ['trailing newline', AUDIO + '\n'], ['NUL', AUDIO + '\0'], ['nonstring', null],
];
for (const [name, audioUrl] of invalidUrls) test('download rejects stored URL: ' + name, async t => {
  const f = await fixture(t, { stems: [{ stemId: STEM, audioUrl }] }); const r = await f.send();
  assert.equal(r.status, 422); assert.equal(f.calls.signing, 0);
  assert.deepEqual(r.body, { message: 'Stem audio is not available from supported storage.' });
});

test('signed attachment always targets the official API even if SDK upload_prefix is configured', t => {
  const original = cloudinary.config().upload_prefix;
  t.after(() => cloudinary.config({ upload_prefix: original ?? null }));
  cloudinary.config({ upload_prefix: 'http://127.0.0.1:1' });
  assert.equal(new URL(service.createStemDownload(AUDIO).downloadUrl).origin, 'https://api.cloudinary.com');
});

test('Swagger describes the authenticated descriptor and every implemented error status', () => {
  const spec = require('../src/config/swagger');
  const operation = spec.paths['/api/tracks/{trackId}/stems/{stemId}/download'].get;
  assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
  assert.deepEqual(operation.parameters.map(p => p.name), ['trackId', 'stemId']);
  assert.deepEqual(Object.keys(operation.responses).sort(), ['200', '400', '401', '403', '404', '422', '500']);
  assert.deepEqual(operation.responses['200'].content['application/json'].schema.properties.data.required,
    ['trackId', 'stemId', 'downloadUrl', 'expiresAt']);
});
