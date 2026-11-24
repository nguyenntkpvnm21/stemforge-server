// Crash-sensitive parser regression: local process/loopback only, no .env/DB/provider.
const assert = require('node:assert/strict');
const http = require('node:http');
const { gzipSync } = require('node:zlib');
const { once } = require('node:events');
const mode = process.argv[2];
assert.ok(['trailing-gzip', 'unsupported-charset'].includes(mode));
for (const key of Object.keys(process.env)) if (/^(MONGO|CLOUDINARY|JWT)_/.test(key)) delete process.env[key];
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'parser-child-only-signing-key-at-least-32-bytes',
  CLOUDINARY_CLOUD_NAME: 'parser-test', CLOUDINARY_API_KEY: 'parser-test', CLOUDINARY_API_SECRET: 'parser-test',
  FRONTEND_URL: 'http://localhost:5173', ADDITIONAL_FRONTEND_ORIGINS: '', TRUST_PROXY_HOPS: '0' });
process.send?.({ event: 'phase', name: 'loading-app' });
const app = require('../../src/app');
process.send?.({ event: 'phase', name: 'app-loaded' });
let server, timer;
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
async function request(port, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', agent,
      ...(body ? { headers: { 'Content-Type': contentType, 'Content-Encoding': 'gzip', 'Content-Length': body.length } } : {}) }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('Loopback deadline')));
    req.on('error', reject);
    req.end(body);
  });
}
(async () => {
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  process.send?.({ event: 'phase', name: 'listening' });
  // Upstream security-regression shape; bounded to ~100 KiB and this child only.
  const payload = Buffer.concat([gzipSync(Buffer.from('{"a":1}')), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
  const result = await request(port, payload, mode === 'unsupported-charset' ? 'application/json; charset=utf-999' : 'application/json');
  process.send?.({ event: 'phase', name: 'initial-response', status: result.status });
  assert.equal(result.status, mode === 'unsupported-charset' ? 415 : 200);
  await new Promise(resolve => { timer = setTimeout(resolve, 250); });
  const health = await request(port);
  assert.equal(health.status, 200); assert.equal(JSON.parse(health.body).status, 'ok');
  process.send?.({ event: 'verified', mode, status: result.status, followupHealth: health.status });
})().catch(error => { process.send?.({ event: 'failed', name: error.name }); process.exitCode = 1; }).finally(async () => {
  clearTimeout(timer); agent.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  process.send?.({ event: 'closed', serverClosed: !server?.listening });
  process.disconnect?.();
});
