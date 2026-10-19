const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { setImmediate: tick } = require('node:timers/promises');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function bootstrap(t) {
  const database = deferred();
  const index = deferred();
  const calls = [];
  const process = new EventEmitter();
  process.env = {};
  process.exit = code => calls.push(`exit:${code}`);
  const dependencies = {
    dotenv: { config() {} },
    'node:dns': {},
    'node:http': { createServer: () => ({
      listen() { calls.push('listen'); this.listening = true; },
      close(callback) { calls.push('http.close'); callback(); },
    }) },
    './app': {},
    './config/database': () => database.promise,
    './models/TrackLike': { init: () => { calls.push('index'); return index.promise; } },
    mongoose: { disconnect: async () => { calls.push('db.disconnect'); } },
    './realtime/track-realtime': { attachTrackRealtime: () => {
      calls.push('attach');
      return { close: async () => { calls.push('realtime.close'); } };
    } },
  };
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/server'), 'utf8'), {
    require(name) { assert.ok(name in dependencies, name); return dependencies[name]; },
    process, console: { log() {}, error() {} },
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout,
  });
  return { calls, database, index, process };
}

test('bootstrap attaches Socket.IO only after DB/index readiness; shutdown drains before DB disconnect once', async t => {
  const f = bootstrap(t);
  assert.deepEqual(f.calls, []);
  f.database.resolve(); await tick();
  assert.deepEqual(f.calls, ['index']);
  f.index.resolve(); await tick();
  assert.deepEqual(f.calls, ['index', 'attach', 'listen']);
  f.process.emit('SIGTERM'); f.process.emit('SIGINT'); await tick();
  assert.deepEqual(f.calls, ['index', 'attach', 'listen', 'realtime.close', 'db.disconnect']);
});

for (const stage of ['database', 'index']) test(`shutdown during ${stage} startup cannot start a late HTTP listener`, async t => {
  const f = bootstrap(t);
  if (stage === 'index') { f.database.resolve(); await tick(); }
  f.process.emit('SIGTERM'); await tick();
  f.database.resolve(); f.index.resolve(); await tick();
  assert.equal(f.calls.includes('listen'), false);
  assert.equal(f.calls.includes('attach'), false);
  assert.equal(f.calls.filter(call => call === 'db.disconnect').length, 1);
});
