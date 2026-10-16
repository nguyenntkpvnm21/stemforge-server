const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');

const {
  receiveAudio,
} = require('../src/middlewares/audio-upload.middleware');

const FILE_SIZE_LIMIT = 20 * 1024 * 1024;

let server;
let baseUrl;

before(async () => {
  const app = express();

  // Test-only authentication stub.
  // Production routes will use the real authenticate middleware.
  app.use((req, res, next) => {
    if (req.get('x-test-auth') === 'yes') {
      req.user = {
        _id: '507f1f77bcf86cd799439011',
      };
    }

    next();
  });

  app.post('/upload', receiveAudio, (req, res) => {
    res.status(200).json({
      data: {
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        bufferLength: req.file.buffer.length,
        bufferIsBuffer: Buffer.isBuffer(req.file.buffer),
      },
    });
  });

  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server?.listening) {
    return;
  }

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

function makeForm({
  filename = 'clip.mp3',
  type = 'audio/mpeg',
  size = 8,
  field = 'audio',
} = {}) {
  const form = new FormData();

  // Dummy bytes test multipart parsing, not actual audio decoding.
  const file = new Blob([new Uint8Array(size)], { type });

  form.append(field, file, filename);

  return form;
}

async function send({
  body,
  headers = {},
  authenticated = true,
}) {
  return fetch(`${baseUrl}/upload`, {
    method: 'POST',
    headers: {
      ...(authenticated ? { 'x-test-auth': 'yes' } : {}),
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
}

async function assertRejected(options, expectedStatus) {
  const response = await send(options);
  const body = await response.json();

  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(
    response.headers.get('content-type'),
    /^application\/json/
  );
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
  assert.equal(body.data, undefined);
}

const acceptedFiles = [
  {
    name: 'accepts an MP3 file',
    filename: 'clip.mp3',
    type: 'audio/mpeg',
  },
  {
    name: 'accepts a WAV file with an uppercase extension',
    filename: 'clip.WAV',
    type: 'audio/wav',
  },
  {
    name: 'accepts a FLAC file',
    filename: 'clip.flac',
    type: 'audio/flac',
  },
  {
    name: 'accepts an MP3 file with a generic binary MIME type',
    filename: 'clip.mp3',
    type: 'application/octet-stream',
  },
];

for (const sample of acceptedFiles) {
  test(sample.name, async () => {
    const response = await send({
      body: makeForm(sample),
    });

    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    assert.deepEqual(body.data, {
      fieldname: 'audio',
      originalname: sample.filename,
      mimetype: sample.type,
      size: 8,
      bufferLength: 8,
      bufferIsBuffer: true,
    });
  });
}

const rejectedRequests = [
  {
    name: 'rejects an unauthenticated multipart request',
    status: 401,
    build: () => ({
      body: makeForm(),
      authenticated: false,
    }),
  },
  {
    name: 'checks authentication before checking Content-Type',
    status: 401,
    build: () => ({
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      authenticated: false,
    }),
  },
  {
    name: 'rejects JSON instead of multipart',
    status: 415,
    build: () => ({
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    }),
  },
  {
    name: 'rejects a multipart request without a file',
    status: 400,
    build: () => ({
      body: new FormData(),
    }),
  },
  {
    name: 'rejects an empty audio file',
    status: 400,
    build: () => ({
      body: makeForm({ size: 0 }),
    }),
  },
  {
    name: 'rejects a file under the wrong field name',
    status: 400,
    build: () => ({
      body: makeForm({ field: 'file' }),
    }),
  },
  {
    name: 'rejects two files',
    status: 400,
    build: () => {
      const form = makeForm();

      form.append(
        'audio',
        new Blob(['second'], { type: 'audio/mpeg' }),
        'second.mp3'
      );

      return { body: form };
    },
  },
  {
    name: 'rejects an extra text field before the file',
    status: 400,
    build: () => {
      const form = new FormData();

      form.append('title', 'Unexpected field');
      form.append(
        'audio',
        new Blob(['audio'], { type: 'audio/mpeg' }),
        'clip.mp3'
      );

      return { body: form };
    },
  },
  {
    name: 'rejects an extra text field after the file',
    status: 400,
    build: () => {
      const form = makeForm();

      form.append('title', 'Unexpected field');

      return { body: form };
    },
  },
  {
    name: 'rejects an unsupported file extension',
    status: 415,
    build: () => ({
      body: makeForm({
        filename: 'clip.txt',
        type: 'text/plain',
      }),
    }),
  },
  {
    name: 'rejects an incompatible MIME type',
    status: 415,
    build: () => ({
      body: makeForm({
        filename: 'clip.mp3',
        type: 'image/png',
      }),
    }),
  },
  {
    name: 'rejects multipart without a boundary',
    status: 400,
    build: () => ({
      body: 'invalid multipart body',
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    }),
  },
  {
    name: 'rejects a truncated multipart body',
    status: 400,
    build: () => ({
      body: [
        '--test-boundary',
        'Content-Disposition: form-data; name="audio"; filename="clip.mp3"',
        'Content-Type: audio/mpeg',
        '',
        'unfinished file',
      ].join('\r\n'),
      headers: {
        'Content-Type': 'multipart/form-data; boundary=test-boundary',
      },
    }),
  },
];

for (const sample of rejectedRequests) {
  test(sample.name, async () => {
    await assertRejected(sample.build(), sample.status);
  });
}

test('accepts a file exactly at the 20 MiB limit', async () => {
  const response = await send({
    body: makeForm({ size: FILE_SIZE_LIMIT }),
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.data.size, FILE_SIZE_LIMIT);
  assert.equal(body.data.bufferLength, FILE_SIZE_LIMIT);
  assert.equal(body.data.bufferIsBuffer, true);
});

test('rejects a file one byte above the 20 MiB limit', async () => {
  await assertRejected(
    {
      body: makeForm({ size: FILE_SIZE_LIMIT + 1 }),
    },
    413
  );
});