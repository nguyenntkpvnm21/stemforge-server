const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

// Dummy configuration used only inside this test process.
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key';
process.env.CLOUDINARY_API_SECRET = 'test-secret';

const cloudinary = require('../src/config/cloudinary');

const {
  uploadAudioBuffer,
  AudioUploadError,
} = require('../src/services/audio-upload.service');

const OWNER_ID = '507f1f77bcf86cd799439011';
const AUDIO_BUFFER = Buffer.from('service-test-audio-bytes');

function validResult(options, format = 'mp3') {
  return {
    public_id: options.public_id,
    resource_type: 'video',
    type: 'upload',
    format,
    secure_url:
      `https://res.cloudinary.com/test-cloud/video/upload/v1/` +
      `${options.public_id}.${format}`,
    duration: 30.125,
    bytes: AUDIO_BUFFER.length,
  };
}

function mockCloudinary(t, settings = {}) {
  const receivedBuffers = [];

  const upload = t.mock.method(
    cloudinary.uploader,
    'upload_stream',
    (options, callback) => {
      if (settings.syncError) {
        throw settings.syncError;
      }

      return new Writable({
        write(chunk, encoding, done) {
          receivedBuffers.push(Buffer.from(chunk));
          done(settings.streamError);
        },
        final(done) {
          done();

          queueMicrotask(() => {
            if (settings.uploadError) {
              callback(settings.uploadError);
              return;
            }

            const result = validResult(
              options,
              settings.format || 'mp3'
            );

            callback(
              null,
              settings.transform
                ? settings.transform(result)
                : result
            );
          });
        },
      });
    }
  );

  const destroy = t.mock.method(
    cloudinary.uploader,
    'destroy',
    async () => {
      if (settings.destroyError) {
        throw settings.destroyError;
      }

      return settings.destroyResult || { result: 'ok' };
    }
  );

  return { upload, destroy, receivedBuffers };
}

async function expectUploadError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AudioUploadError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(typeof error.message, 'string');

    // Upstream diagnostics must not become public messages.
    assert.doesNotMatch(error.message, /private-diagnostic/);

    return true;
  });
}

function assertCleanup(storage) {
  assert.equal(storage.destroy.mock.callCount(), 1);

  const generatedId =
    storage.upload.mock.calls[0].arguments[0].public_id;

  assert.deepEqual(
    storage.destroy.mock.calls[0].arguments,
    [
      generatedId,
      {
        resource_type: 'video',
        type: 'upload',
        invalidate: true,
        timeout: 15000,
      },
    ]
  );
}

for (const format of ['mp3', 'wav', 'flac']) {
  test(`uploads valid ${format} audio and returns metadata`, async (t) => {
    const storage = mockCloudinary(t, { format });

    const result = await uploadAudioBuffer(AUDIO_BUFFER, OWNER_ID);

    assert.equal(storage.upload.mock.callCount(), 1);
    assert.equal(storage.destroy.mock.callCount(), 0);

    const options = storage.upload.mock.calls[0].arguments[0];

    assert.equal(options.resource_type, 'video');
    assert.equal(options.type, 'upload');
    assert.equal(options.overwrite, false);
    assert.deepEqual(options.allowed_formats, ['mp3', 'wav', 'flac']);

    assert.match(
      options.public_id,
      new RegExp(`^stemforge/audio/${OWNER_ID}/[0-9a-f-]{36}$`)
    );

    assert.deepEqual(
      Buffer.concat(storage.receivedBuffers),
      AUDIO_BUFFER
    );

    assert.deepEqual(result, {
      audioUrl: validResult(options, format).secure_url,
      duration: 30.125,
      fileSize: AUDIO_BUFFER.length,
      publicId: options.public_id,
    });
  });
}

const invalidInputs = [
  {
    name: 'rejects a non-Buffer input before uploading',
    buffer: 'base64-audio',
    ownerId: OWNER_ID,
  },
  {
    name: 'rejects an empty buffer before uploading',
    buffer: Buffer.alloc(0),
    ownerId: OWNER_ID,
  },
  {
    name: 'rejects an invalid owner ID before uploading',
    buffer: AUDIO_BUFFER,
    ownerId: 'invalid-owner',
  },
  {
    name: 'rejects a missing owner ID before uploading',
    buffer: AUDIO_BUFFER,
    ownerId: undefined,
  },
];

for (const sample of invalidInputs) {
  test(sample.name, async (t) => {
    const storage = mockCloudinary(t);

    await assert.rejects(
      uploadAudioBuffer(sample.buffer, sample.ownerId),
      TypeError
    );

    assert.equal(storage.upload.mock.callCount(), 0);
    assert.equal(storage.destroy.mock.callCount(), 0);
  });
}

const upstreamErrors = [
  {
    name: 'maps a rejected media file to 415',
    error: {
      http_code: 400,
      message: 'Invalid video file: private-diagnostic',
    },
    code: 'UNSUPPORTED_AUDIO',
    status: 415,
  },
  {
    name: 'maps a network failure to 502',
    error: new Error('Connection failed: private-diagnostic'),
    code: 'AUDIO_UPLOAD_FAILED',
    status: 502,
  },
  {
    name: 'maps a Cloudinary authentication failure to 502',
    error: {
      http_code: 401,
      message: 'Invalid credentials: private-diagnostic',
    },
    code: 'AUDIO_UPLOAD_FAILED',
    status: 502,
  },
  {
    name: 'does not classify every upstream 400 as invalid audio',
    error: {
      http_code: 400,
      message: 'Invalid configuration: private-diagnostic',
    },
    code: 'AUDIO_UPLOAD_FAILED',
    status: 502,
  },
];

for (const sample of upstreamErrors) {
  test(sample.name, async (t) => {
    const storage = mockCloudinary(t, {
      uploadError: sample.error,
    });

    await expectUploadError(
      uploadAudioBuffer(AUDIO_BUFFER, OWNER_ID),
      sample.code,
      sample.status
    );

    assert.equal(storage.upload.mock.callCount(), 1);
    assert.equal(storage.destroy.mock.callCount(), 0);
  });
}

test('handles an upload stream error', async (t) => {
  const storage = mockCloudinary(t, {
    streamError: new Error('Stream failed: private-diagnostic'),
  });

  await expectUploadError(
    uploadAudioBuffer(AUDIO_BUFFER, OWNER_ID),
    'AUDIO_UPLOAD_FAILED',
    502
  );

  assert.equal(storage.destroy.mock.callCount(), 0);
});

test('handles a synchronous SDK error', async (t) => {
  const storage = mockCloudinary(t, {
    syncError: new Error('SDK failed: private-diagnostic'),
  });

  await expectUploadError(
    uploadAudioBuffer(AUDIO_BUFFER, OWNER_ID),
    'AUDIO_UPLOAD_FAILED',
    502
  );

  assert.equal(storage.destroy.mock.callCount(), 0);
});

const invalidResults = [
  {
    name: 'rejects an absent upload result',
    transform: () => null,
    code: 'INVALID_UPLOAD_RESULT',
    status: 502,
  },
  {
    name: 'rejects a different public ID and cleans only its generated ID',
    transform: (result) => ({
      ...result,
      public_id: 'another-owner/existing-asset',
    }),
    code: 'INVALID_UPLOAD_RESULT',
    status: 502,
  },
  {
    name: 'rejects the wrong resource type',
    transform: (result) => ({
      ...result,
      resource_type: 'raw',
    }),
    code: 'INVALID_UPLOAD_RESULT',
    status: 502,
  },
  {
    name: 'rejects an actual MP4 result despite the client filename',
    transform: (result) => ({
      ...result,
      format: 'mp4',
    }),
    code: 'UNSUPPORTED_AUDIO',
    status: 415,
  },
  {
    name: 'rejects zero duration',
    transform: (result) => ({ ...result, duration: 0 }),
    code: 'INVALID_AUDIO_METADATA',
    status: 502,
  },
  {
    name: 'rejects a non-finite duration',
    transform: (result) => ({ ...result, duration: NaN }),
    code: 'INVALID_AUDIO_METADATA',
    status: 502,
  },
  {
    name: 'rejects duration supplied as a string',
    transform: (result) => ({ ...result, duration: '30' }),
    code: 'INVALID_AUDIO_METADATA',
    status: 502,
  },
  {
    name: 'rejects zero file size',
    transform: (result) => ({ ...result, bytes: 0 }),
    code: 'INVALID_AUDIO_METADATA',
    status: 502,
  },
  {
    name: 'rejects a fractional file size',
    transform: (result) => ({ ...result, bytes: 12.5 }),
    code: 'INVALID_AUDIO_METADATA',
    status: 502,
  },
  {
    name: 'rejects an HTTP delivery URL',
    transform: (result) => ({
      ...result,
      secure_url: 'http://example.invalid/audio.mp3',
    }),
    code: 'INVALID_AUDIO_METADATA',
    status: 502,
  },
  {
    name: 'rejects a malformed delivery URL',
    transform: (result) => ({
      ...result,
      secure_url: 'not-a-url',
    }),
    code: 'INVALID_AUDIO_METADATA',
    status: 502,
  },
];

for (const sample of invalidResults) {
  test(sample.name, async (t) => {
    const storage = mockCloudinary(t, {
      transform: sample.transform,
    });

    await expectUploadError(
      uploadAudioBuffer(AUDIO_BUFFER, OWNER_ID),
      sample.code,
      sample.status
    );

    assertCleanup(storage);
  });
}

test('accepts not-found as a completed cleanup', async (t) => {
  const storage = mockCloudinary(t, {
    transform: (result) => ({ ...result, duration: 0 }),
    destroyResult: { result: 'not found' },
  });

  await expectUploadError(
    uploadAudioBuffer(AUDIO_BUFFER, OWNER_ID),
    'INVALID_AUDIO_METADATA',
    502
  );

  assertCleanup(storage);
});

test('reports a rejected cleanup request', async (t) => {
  const log = t.mock.method(console, 'error', () => {});

  const storage = mockCloudinary(t, {
    transform: (result) => ({ ...result, duration: 0 }),
    destroyError: new Error('Cleanup failed: private-diagnostic'),
  });

  await expectUploadError(
    uploadAudioBuffer(AUDIO_BUFFER, OWNER_ID),
    'AUDIO_CLEANUP_FAILED',
    502
  );

  assertCleanup(storage);
  assert.equal(log.mock.callCount(), 1);

  const generatedId =
    storage.upload.mock.calls[0].arguments[0].public_id;

  assert.equal(log.mock.calls[0].arguments[1], generatedId);
});

test('reports an unexpected cleanup response', async (t) => {
  t.mock.method(console, 'error', () => {});

  const storage = mockCloudinary(t, {
    transform: (result) => ({ ...result, duration: 0 }),
    destroyResult: { result: 'pending' },
  });

  await expectUploadError(
    uploadAudioBuffer(AUDIO_BUFFER, OWNER_ID),
    'AUDIO_CLEANUP_FAILED',
    502
  );

  assertCleanup(storage);
});

test('generates a distinct public ID for each upload', async (t) => {
  const storage = mockCloudinary(t);

  const first = await uploadAudioBuffer(AUDIO_BUFFER, OWNER_ID);
  const second = await uploadAudioBuffer(AUDIO_BUFFER, OWNER_ID);

  assert.notEqual(first.publicId, second.publicId);
  assert.equal(storage.upload.mock.callCount(), 2);
  assert.equal(storage.destroy.mock.callCount(), 0);
});