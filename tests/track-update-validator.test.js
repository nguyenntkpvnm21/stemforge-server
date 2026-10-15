const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateUpdateTrackInput,
} = require('../src/validators/track.validator');

const singleFieldUpdates = [
  ['title', 'Renamed track'],
  ['genre', 'Jazz'],
  ['bpm', 96.5],
  ['key', 'Dm'],
  ['tags', []],
  ['coverImageUrl', null],
  ['description', ''],
  ['isPublic', false],
  ['isDownloadable', false],
];

for (const [field, value] of singleFieldUpdates) {
  test('accepts updating only ' + field, () => {
    assert.equal(
      validateUpdateTrackInput({ [field]: value }),
      null
    );
  });
}

test('accepts multiple metadata changes together', () => {
  assert.equal(
    validateUpdateTrackInput({
      title: 'Renamed track',
      bpm: 120,
      isPublic: false,
      tags: ['demo'],
    }),
    null
  );
});

const invalidBodies = [
  [
    'null',
    null,
    'Request body must be a Track update object.',
  ],
  [
    'an array',
    [],
    'Request body must be a Track update object.',
  ],
  [
    'an empty object',
    {},
    'At least one Track field must be provided.',
  ],
];

for (const [name, body, message] of invalidBodies) {
  test('rejects ' + name, () => {
    assert.equal(validateUpdateTrackInput(body), message);
  });
}

const forbiddenFields = [
  ['_id', '507f1f77bcf86cd799439011'],
  ['artistId', '507f1f77bcf86cd799439012'],
  ['likesCount', 100],
  ['createdAt', '2026-10-15T00:00:00.000Z'],
  ['stems', []],
  ['__v', 1],
];

for (const [field, value] of forbiddenFields) {
  test('rejects changing ' + field, () => {
    assert.equal(
      validateUpdateTrackInput({
        title: 'Valid title',
        [field]: value,
      }),
      'Request contains unsupported Track fields.'
    );
  });
}

const invalidUpdates = [
  [
    'rejects a numeric string BPM',
    { bpm: '128' },
    'bpm must be a positive number.',
  ],
  [
    'rejects a string boolean',
    { isPublic: 'false' },
    'isPublic must be a boolean.',
  ],
  [
    'rejects null tags',
    { tags: null },
    'tags must be an array of non-empty strings.',
  ],
  [
    'rejects a null description',
    { description: null },
    'description must be a string.',
  ],
  [
    'rejects an HTTP cover URL',
    { coverImageUrl: 'http://example.invalid/cover.jpg' },
    'coverImageUrl must be null or a valid HTTPS URL.',
  ],
  [
    'rejects a blank title',
    { title: '   ' },
    'title must be a non-empty string.',
  ],
  [
    'rejects a database update operator',
    { $set: { title: 'Changed title' } },
    'Request contains unsupported Track fields.',
  ],
];

for (const [name, body, message] of invalidUpdates) {
  test(name, () => {
    assert.equal(validateUpdateTrackInput(body), message);
  });
}