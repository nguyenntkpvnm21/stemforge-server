const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCreateTrackInput,
} = require('../src/validators/track.validator');

const sample = require('./fixtures/track-contract-draft.json');

function makeInput() {
  return {
    title: sample.title,
    genre: sample.genre,
    bpm: sample.bpm,
    key: sample.key,
    tags: [...sample.tags],
    coverImageUrl: sample.coverImageUrl,
    description: sample.description,
    isPublic: sample.isPublic,
    isDownloadable: sample.isDownloadable,
    stems: sample.stems.map((stem) => ({
      name: stem.name,
      audioUrl: stem.audioUrl,
      duration: stem.duration,
      fileSize: stem.fileSize,
    })),
  };
}

test('accepts valid creation metadata', () => {
  assert.equal(validateCreateTrackInput(makeInput()), null);
});

test('accepts omitted optional metadata', () => {
  const input = makeInput();

  for (const field of ['tags', 'coverImageUrl', 'description']) {
    delete input[field];
  }

  assert.equal(validateCreateTrackInput(input), null);
});

test('accepts one and four stems', () => {
  for (const count of [1, 4]) {
    const input = makeInput();
    const stem = input.stems[0];

    input.stems = Array.from({ length: count }, (_, index) => ({
      ...stem,
      name: 'Stem ' + (index + 1),
    }));

    assert.equal(validateCreateTrackInput(input), null);
  }
});

test('accepts false flags, decimal duration, and an HTTPS cover', () => {
  const input = makeInput();

  input.isPublic = false;
  input.isDownloadable = false;
  input.stems[0].duration = 30.125;
  input.coverImageUrl = 'https://example.invalid/cover.jpg';

  assert.equal(validateCreateTrackInput(input), null);
});

for (const [name, value] of [
  ['null', null],
  ['an array', []],
  ['a primitive', 42],
]) {
  test('rejects ' + name + ' as the request body', () => {
    assert.equal(
      validateCreateTrackInput(value),
      'Request body must be a Track object.'
    );
  });
}

const serverFields = [
  ['_id', sample._id],
  ['artistId', sample.artistId],
  ['likesCount', 100],
  ['createdAt', sample.createdAt],
  ['__v', 1],
  ['artist', { _id: sample.artistId, username: 'Spoofed', avatarUrl: null }],
  ['likedByMe', true],
];

for (const [field, value] of serverFields) {
  test('rejects client-supplied ' + field, () => {
    const input = makeInput();
    input[field] = value;

    assert.equal(
      validateCreateTrackInput(input),
      'Request contains unsupported Track fields.'
    );
  });
}

const invalidCases = [
  [
    'rejects a numeric title',
    (input) => { input.title = 123; },
    'title must be a non-empty string.',
  ],
  [
    'rejects a blank title',
    (input) => { input.title = '   '; },
    'title must be a non-empty string.',
  ],
  [
    'rejects a numeric string BPM',
    (input) => { input.bpm = '128'; },
    'bpm must be a positive number.',
  ],
  [
    'rejects zero BPM',
    (input) => { input.bpm = 0; },
    'bpm must be a positive number.',
  ],
  [
    'rejects a string visibility flag',
    (input) => { input.isPublic = 'true'; },
    'isPublic must be a boolean.',
  ],
  [
    'requires an explicit download flag',
    (input) => { delete input.isDownloadable; },
    'isDownloadable must be a boolean.',
  ],
  [
    'rejects tags supplied as a string',
    (input) => { input.tags = 'demo'; },
    'tags must be an array of non-empty strings.',
  ],
  [
    'rejects a blank tag',
    (input) => { input.tags = ['   ']; },
    'tags must be an array of non-empty strings.',
  ],
  [
    'rejects a null description',
    (input) => { input.description = null; },
    'description must be a string.',
  ],
  [
    'rejects an HTTP cover URL',
    (input) => {
      input.coverImageUrl = 'http://example.invalid/cover.jpg';
    },
    'coverImageUrl must be null or a valid HTTPS URL.',
  ],
  [
    'rejects zero stems',
    (input) => { input.stems = []; },
    'stems must contain 1 to 4 objects.',
  ],
  [
    'rejects five stems',
    (input) => {
      input.stems = Array.from(
        { length: 5 },
        () => ({ ...input.stems[0] })
      );
    },
    'stems must contain 1 to 4 objects.',
  ],
  [
    'rejects a null stem',
    (input) => { input.stems[0] = null; },
    'stems[0] must be an object.',
  ],
  [
    'rejects a client-supplied stem ID',
    (input) => { input.stems[0].stemId = sample.stems[0].stemId; },
    'stems[0] contains unsupported fields.',
  ],
  [
    'rejects a numeric stem name',
    (input) => { input.stems[0].name = 123; },
    'stems[0].name must be a non-empty string.',
  ],
  [
    'rejects an HTTP audio URL',
    (input) => {
      input.stems[0].audioUrl = 'http://example.invalid/audio.mp3';
    },
    'stems[0].audioUrl must be a valid HTTPS URL.',
  ],
  [
    'rejects a numeric string duration',
    (input) => { input.stems[0].duration = '30'; },
    'stems[0].duration must be a positive number.',
  ],
  [
    'rejects zero duration',
    (input) => { input.stems[0].duration = 0; },
    'stems[0].duration must be a positive number.',
  ],
  [
    'rejects a fractional file size',
    (input) => { input.stems[0].fileSize = 1.5; },
    'stems[0].fileSize must be a positive safe integer.',
  ],
  [
    'rejects an unsafe file size',
    (input) => {
      input.stems[0].fileSize = Number.MAX_SAFE_INTEGER + 1;
    },
    'stems[0].fileSize must be a positive safe integer.',
  ],
  [
    'rejects a numeric string file size',
    (input) => { input.stems[0].fileSize = '480000'; },
    'stems[0].fileSize must be a positive safe integer.',
  ],
  [
    'rejects zero file size',
    (input) => { input.stems[0].fileSize = 0; },
    'stems[0].fileSize must be a positive safe integer.',
  ],
];

for (const [name, mutate, expectedMessage] of invalidCases) {
  test(name, () => {
    const input = makeInput();
    mutate(input);

    assert.equal(
      validateCreateTrackInput(input),
      expectedMessage
    );
  });
}
