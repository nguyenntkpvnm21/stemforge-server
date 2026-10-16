const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');

const {
  createAudioUploadRateLimiter,
} = require('../src/middlewares/audio-upload-rate-limit.middleware');

const OWNER_A = '507f1f77bcf86cd799439011';
const OWNER_B = '507f1f77bcf86cd799439012';

async function startServer(t, handlerStatus = 201) {
  const app = express();
  let handledRequests = 0;

  app.post(
    '/upload',
    (req, res, next) => {
      res.set('Cache-Control', 'no-store');

      // Test-only authentication stub.
      const ownerId = req.get('x-test-owner');

      if (!ownerId) {
        return res.status(401).json({
          message: 'Authentication required.',
        });
      }

      req.user = { _id: ownerId };
      return next();
    },
    createAudioUploadRateLimiter(),
    (req, res) => {
      handledRequests += 1;

      return res.status(handlerStatus).json({
        message: 'Test handler reached.',
      });
    }
  );

  const server = app.listen(0, '127.0.0.1');

  t.after(async () => {
    server.closeAllConnections();

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });

  await once(server, 'listening');

  const url = `http://127.0.0.1:${server.address().port}/upload`;

  return {
    handledRequests: () => handledRequests,

    async send(ownerId) {
      const response = await fetch(url, {
        method: 'POST',
        headers: ownerId ? { 'x-test-owner': ownerId } : {},
        signal: AbortSignal.timeout(5000),
      });

      return {
        status: response.status,
        headers: response.headers,
        body: await response.json(),
      };
    },
  };
}

test('allows 10 requests and blocks the eleventh before the handler', async (t) => {
  const server = await startServer(t);

  for (let index = 0; index < 10; index += 1) {
    const response = await server.send(OWNER_A);
    assert.equal(response.status, 201);
  }

  const blocked = await server.send(OWNER_A);

  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, {
    message: 'Too many audio upload requests. Please try again later.',
  });

  assert.equal(blocked.headers.get('cache-control'), 'no-store');
  assert.ok(blocked.headers.get('ratelimit'));
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal(server.handledRequests(), 10);
});

test('keeps separate quotas for accounts using the same IP', async (t) => {
  const server = await startServer(t);

  for (let index = 0; index < 10; index += 1) {
    assert.equal((await server.send(OWNER_A)).status, 201);
  }

  assert.equal((await server.send(OWNER_A)).status, 429);
  assert.equal((await server.send(OWNER_B)).status, 201);
  assert.equal(server.handledRequests(), 11);
});

test('rejects unauthenticated requests before counting uploads', async (t) => {
  const server = await startServer(t);

  for (let index = 0; index < 12; index += 1) {
    const response = await server.send();

    assert.equal(response.status, 401);
    assert.equal(response.headers.get('ratelimit'), null);
  }

  for (let index = 0; index < 10; index += 1) {
    assert.equal((await server.send(OWNER_A)).status, 201);
  }

  assert.equal((await server.send(OWNER_A)).status, 429);
  assert.equal(server.handledRequests(), 10);
});

test('counts failed requests after authentication', async (t) => {
  const server = await startServer(t, 415);

  for (let index = 0; index < 10; index += 1) {
    assert.equal((await server.send(OWNER_A)).status, 415);
  }

  assert.equal((await server.send(OWNER_A)).status, 429);
  assert.equal(server.handledRequests(), 10);
});