const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');

// Dummy configuration for this test process.
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key';
process.env.CLOUDINARY_API_SECRET = 'test-secret';

const service = require('../src/services/audio-upload.service');
const {
  uploadAudio,
} = require('../src/controllers/upload.controller');

const OWNER_ID = '507f1f77bcf86cd799439011';
const AUDIO_BUFFER = Buffer.from('controller-test-audio');

const UPLOAD_DATA = {
  audioUrl: 'https://example.invalid/audio/uploaded.mp3',
  duration: 30.125,
  fileSize: 480000,
  publicId: `stemforge/audio/${OWNER_ID}/test-upload`,
};

function makeRequest(overrides = {}) {
  return {
    user: {
      _id: new Types.ObjectId(OWNER_ID),
    },
    file: {
      buffer: AUDIO_BUFFER,
    },
    body: {},
    ...overrides,
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},

    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function invoke(req) {
  const res = makeResponse();
  const nextCalls = [];

  await uploadAudio(req, res, (error) => {
    nextCalls.push(error);
  });

  return { res, nextCalls };
}

test('returns 201 using the authenticated owner and service metadata', async (t) => {
  const upload = t.mock.method(
    service,
    'uploadAudioBuffer',
    async () => ({ ...UPLOAD_DATA })
  );

  const req = makeRequest({
    body: {
      artistId: '507f1f77bcf86cd799439099',
      audioUrl: 'https://example.invalid/forged.mp3',
      duration: 999,
      fileSize: 1,
    },
  });

  const { res, nextCalls } = await invoke(req);

  assert.equal(upload.mock.callCount(), 1);
  assert.deepEqual(
    upload.mock.calls[0].arguments,
    [AUDIO_BUFFER, OWNER_ID]
  );

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { data: UPLOAD_DATA });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(nextCalls, []);
});

const rejectedRequests = [
  {
    name: 'rejects an unauthenticated request without calling the service',
    overrides: { user: undefined },
    status: 401,
    message: 'Authentication required.',
  },
  {
    name: 'rejects a request without a file',
    overrides: { file: undefined },
    status: 400,
    message: 'An audio file is required.',
  },
  {
    name: 'rejects a file without a Buffer',
    overrides: {
      file: { buffer: 'not-a-buffer' },
    },
    status: 400,
    message: 'An audio file is required.',
  },
  {
    name: 'rejects an empty file buffer',
    overrides: {
      file: { buffer: Buffer.alloc(0) },
    },
    status: 400,
    message: 'An audio file is required.',
  },
];

for (const sample of rejectedRequests) {
  test(sample.name, async (t) => {
    const upload = t.mock.method(
      service,
      'uploadAudioBuffer',
      async () => ({ ...UPLOAD_DATA })
    );

    const { res, nextCalls } = await invoke(
      makeRequest(sample.overrides)
    );

    assert.equal(upload.mock.callCount(), 0);
    assert.equal(res.statusCode, sample.status);
    assert.deepEqual(res.body, { message: sample.message });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(nextCalls, []);
  });
}

const expectedErrors = [
  {
    name: 'returns 415 for unsupported audio',
    code: 'UNSUPPORTED_AUDIO',
    status: 415,
    message: 'Only valid MP3, WAV, and FLAC audio files are supported.',
  },
  {
    name: 'returns 502 when audio storage fails',
    code: 'AUDIO_UPLOAD_FAILED',
    status: 502,
    message: 'Unable to upload audio. Please try again later.',
  },
];

for (const sample of expectedErrors) {
  test(sample.name, async (t) => {
    const error = new service.AudioUploadError(
      sample.code,
      sample.status,
      sample.message
    );

    const upload = t.mock.method(
      service,
      'uploadAudioBuffer',
      async () => {
        throw error;
      }
    );

    const { res, nextCalls } = await invoke(makeRequest());

    assert.equal(upload.mock.callCount(), 1);
    assert.equal(res.statusCode, sample.status);
    assert.deepEqual(res.body, { message: sample.message });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(nextCalls, []);
  });
}

test('passes an unexpected error to the central error handler', async (t) => {
  const error = new Error('Unexpected internal failure');

  t.mock.method(service, 'uploadAudioBuffer', async () => {
    throw error;
  });

  const { res, nextCalls } = await invoke(makeRequest());

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, undefined);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(nextCalls, [error]);
});