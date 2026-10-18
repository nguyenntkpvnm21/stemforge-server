const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Track = require('../src/models/Track');

const sample = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'track-contract-draft.json'),
    'utf8'
  )
);

function makeStems(count) {
  const baseStem = structuredClone(sample.stems[0]);
  delete baseStem.stemId;

  return Array.from({ length: count }, (_, index) => ({
    ...baseStem,
    name: 'Stem ' + (index + 1),
  }));
}

test('declares the additive most-liked public index and retains existing indexes', () => {
  const indexes = Track.schema.indexes();
  assert.ok(indexes.some(([keys]) => JSON.stringify(keys) === JSON.stringify({ artistId: 1, createdAt: -1 })));
  assert.ok(indexes.some(([keys]) => JSON.stringify(keys) === JSON.stringify({ isPublic: 1, createdAt: -1, _id: -1 })));
  const mostLiked = indexes.find(([, options]) => options.name === 'public_tracks_most_liked');
  assert.deepEqual(mostLiked[0], { isPublic: 1, likesCount: -1, createdAt: -1, _id: -1 });
  assert.notEqual(mostLiked[1].unique, true);
});

test('accepts the contract sample and preserves its public JSON shape', async () => {
  const track = new Track({
    ...structuredClone(sample),
    __v: 3,
  });

  await track.validate();

  const output = JSON.parse(JSON.stringify(track));
  assert.deepEqual(output, sample);
});

test('accepts one and four stems with automatically generated unique IDs', async () => {
  for (const count of [1, 4]) {
    const track = new Track({
      ...structuredClone(sample),
      stems: makeStems(count),
    });

    await track.validate();

    const ids = track.stems.map((stem) => String(stem.stemId));

    assert.equal(new Set(ids).size, count);

    for (const id of ids) {
      assert.match(id, /^[a-f0-9]{24}$/i);
    }
  }
});

test('accepts decimal duration and false visibility and download flags', async () => {
  const input = structuredClone(sample);
  input.stems[0].duration = 30.125;
  input.isPublic = false;
  input.isDownloadable = false;

  const track = new Track(input);
  await track.validate();

  assert.equal(track.stems[0].duration, 30.125);
  assert.equal(track.isPublic, false);
  assert.equal(track.isDownloadable, false);
});

test('applies defaults for omitted optional metadata and likes count', async () => {
  const input = structuredClone(sample);

  for (const field of ['tags', 'coverImageUrl', 'description', 'likesCount']) {
    delete input[field];
  }

  const track = new Track(input);
  await track.validate();

  assert.deepEqual(Array.from(track.tags), []);
  assert.equal(track.coverImageUrl, null);
  assert.equal(track.description, '');
  assert.equal(track.likesCount, 0);
});

const invalidCases = [
  ['rejects zero stems', 'stems', (input) => {
    input.stems = [];
  }],
  ['rejects five stems', 'stems', (input) => {
    input.stems = makeStems(5);
  }],
  ['rejects duplicate stem IDs', 'stems', (input) => {
    input.stems[1].stemId = input.stems[0].stemId;
  }],
  ['rejects a blank title', 'title', (input) => {
    input.title = '   ';
  }],
  ['rejects an invalid owner ID', 'artistId', (input) => {
    input.artistId = 'invalid-id';
  }],
  ['rejects zero BPM', 'bpm', (input) => {
    input.bpm = 0;
  }],
  ['rejects an HTTP cover URL', 'coverImageUrl', (input) => {
    input.coverImageUrl = 'http://example.invalid/cover.jpg';
  }],
  ['rejects a null description', 'description', (input) => {
    input.description = null;
  }],
  ['rejects a blank tag', 'tags', (input) => {
    input.tags = ['   '];
  }],
  ['rejects an HTTP audio URL', 'stems.0.audioUrl', (input) => {
    input.stems[0].audioUrl = 'http://example.invalid/audio.mp3';
  }],
  ['rejects zero duration', 'stems.0.duration', (input) => {
    input.stems[0].duration = 0;
  }],
  ['rejects zero file size', 'stems.0.fileSize', (input) => {
    input.stems[0].fileSize = 0;
  }],
  ['rejects fractional file size', 'stems.0.fileSize', (input) => {
    input.stems[0].fileSize = 1.5;
  }],
  ['rejects negative likes count', 'likesCount', (input) => {
    input.likesCount = -1;
  }],
  ['rejects fractional likes count', 'likesCount', (input) => {
    input.likesCount = 0.5;
  }],
  ['requires an explicit visibility flag', 'isPublic', (input) => {
    delete input.isPublic;
  }],
];

for (const [name, errorPath, mutate] of invalidCases) {
  test(name, async () => {
    const input = structuredClone(sample);
    mutate(input);

    await assert.rejects(new Track(input).validate(), (error) => {
      assert.equal(error.name, 'ValidationError');
      assert.ok(error.errors[errorPath], 'Expected error at ' + errorPath);
      return true;
    });
  });
}
