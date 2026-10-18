const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTrackListFilters } = require('../src/validators/track-list-query.validator');
const newest = { createdAt: -1, _id: -1 };

test('default filter is public-only and does not incorporate pagination', () => {
  assert.deepEqual(parseTrackListFilters({ page: '2', limit: '5' }), { filter: { isPublic: true }, sort: newest });
});

test('combines trimmed title, exact genre/key and inclusive decimal bounds with AND', () => {
  const result = parseTrackListFilters({ q: '  demo  ', genre: ' Electronic ', key: ' Am ', bpmMin: '120.5', bpmMax: '128' });
  assert.deepEqual(result, { filter: {
    isPublic: true, title: { $regex: 'demo', $options: 'i' },
    genre: { $regex: '^Electronic$', $options: 'i' }, key: { $regex: '^Am$', $options: 'i' },
    bpm: { $gte: 120.5, $lte: 128 },
  }, sort: newest });
});

test('title regex metacharacters and MongoDB-looking text are literal', () => {
  for (const value of ['.*+?^${}()|[]\\', '(a+)+$', '{"$ne":null}']) {
    const { filter } = parseTrackListFilters({ q: value });
    const pattern = new RegExp(filter.title.$regex, filter.title.$options);
    assert.ok(pattern.test('Prefix ' + value + ' Suffix'));
    assert.equal(pattern.test('unrelated title'), false);
  }
});

test('genre and key use case-insensitive full-value literal matches', () => {
  const { filter } = parseTrackListFilters({ genre: 'R&B (Live)', key: 'A+' });
  const genre = new RegExp(filter.genre.$regex, filter.genre.$options);
  const key = new RegExp(filter.key.$regex, filter.key.$options);
  assert.ok(genre.test('r&b (live)'));
  assert.equal(genre.test('R&B Live'), false);
  assert.equal(genre.test('Other R&B (Live)'), false);
  assert.ok(key.test('a+'));
  assert.equal(key.test('AAAA'), false);
});

for (const [query, bpm] of [
  [{ bpmMin: '0.5' }, { $gte: 0.5 }],
  [{ bpmMax: '140.25' }, { $lte: 140.25 }],
  [{ bpmMin: '120', bpmMax: '120.00' }, { $gte: 120, $lte: 120 }],
]) {
  test('accepts one-sided or equal BPM bounds: ' + JSON.stringify(query), () => {
    assert.deepEqual(parseTrackListFilters(query), { filter: { isPublic: true, bpm }, sort: newest });
  });
}

for (const field of ['q', 'genre', 'key', 'tag']) {
  test(field + ' rejects actual NUL without removing it or returning a database filter', () => {
    for (const value of ['\u0000', '\u0000demo', 'de\u0000mo', 'demo\u0000', '  demo\u0000  ']) {
      const result = parseTrackListFilters({ [field]: value });
      assert.deepEqual(result, { error: field + ' must not contain U+0000 (NUL).' });
    }
  });
  test(field + ' retains literal regex characters and textual NUL representations', () => {
    const literal = 'Demo.*[Live]+\\u0000 %00';
    const { filter } = parseTrackListFilters({ [field]: '  ' + literal + '  ' });
    const expression = filter[{ q: 'title', genre: 'genre', key: 'key', tag: 'tags' }[field]];
    const pattern = new RegExp(expression.$regex, expression.$options);
    assert.equal(pattern.test(literal.toLowerCase()), true);
    assert.equal(pattern.test('Demo expanded Live'), false);
    assert.equal(pattern.test('prefix ' + literal + ' suffix'), field === 'q');
  });
  test(field + ' accepts exactly 100 characters', () => {
    assert.ok(parseTrackListFilters({ [field]: 'x'.repeat(100) }).filter);
  });
  for (const [label, value] of [
    ['empty', ''], ['whitespace-only', ' \t '], ['overlong', 'x'.repeat(101)],
    ['repeated', ['a', 'b']], ['operator object', { $ne: null }],
  ]) {
    test(field + ' rejects ' + label, () => {
      assert.ok(parseTrackListFilters({ [field]: value }).error);
    });
  }
}

for (const field of ['bpmMin', 'bpmMax']) {
  for (const value of ['', '0', '-1', 'NaN', 'Infinity', '0x78', '1e2', '120 ', '1.2.3', '9'.repeat(33), ['120', '130'], { $gte: 120 }]) {
    test(field + ' rejects invalid positive decimal input: ' + JSON.stringify(value), () => {
      assert.ok(parseTrackListFilters({ [field]: value }).error);
    });
  }
}

test('rejects inverted BPM ranges', () => {
  assert.equal(parseTrackListFilters({ bpmMin: '130', bpmMax: '120' }).error, 'bpmMin must be less than or equal to bpmMax.');
});

for (const field of ['$where', '$or', 'q[$regex]', 'genre[$ne]', 'tag[$ne]', 'isPublic', 'artistId', 'tags']) {
  test('rejects unsupported parameter ' + field, () => {
    assert.ok(parseTrackListFilters({ [field]: 'anything' }).error);
  });
}

test('tag matches one full array element literally, with trimming and case-insensitivity', () => {
  const { filter } = parseTrackListFilters({ tag: '  R&B [Live]+  ' });
  const expression = new RegExp(filter.tags.$regex, filter.tags.$options);
  const matches = tags => tags.some(tag => expression.test(tag));
  assert.equal(matches(['other', 'r&b [live]+']), true);
  assert.equal(matches(['R&B Live']), false);
  assert.equal(matches(['R&B [Live]+ Remix']), false);
  assert.equal(matches(['R&B ', '[Live]+']), false);
});

test('tag and existing metadata filters combine without putting sort into the filter', () => {
  assert.deepEqual(parseTrackListFilters({ tag: 'Jazz', q: 'Demo', genre: 'Fusion', key: 'Am', bpmMin: '100', bpmMax: '120', sort: 'mostLiked' }), {
    filter: { isPublic: true, title: { $regex: 'Demo', $options: 'i' },
      genre: { $regex: '^Fusion$', $options: 'i' }, key: { $regex: '^Am$', $options: 'i' },
      tags: { $regex: '^Jazz$', $options: 'i' }, bpm: { $gte: 100, $lte: 120 } },
    sort: { likesCount: -1, createdAt: -1, _id: -1 },
  });
});

for (const sort of ['newest', 'mostLiked']) {
  test('sort=' + sort + ' selects only the predefined order and leaves filter unchanged', () => {
    const omitted = parseTrackListFilters({ tag: 'Jazz' });
    const explicit = parseTrackListFilters({ tag: 'Jazz', sort });
    assert.deepEqual(explicit.filter, omitted.filter);
    assert.deepEqual(explicit.sort, sort === 'newest' ? newest : { likesCount: -1, ...newest });
  });
}

for (const sort of ['', ' newest ', 'MostLiked', 'likesCount', '__proto__', 'constructor', ['newest', 'mostLiked'], { $gt: '' }]) {
  test('rejects invalid or non-scalar sort: ' + JSON.stringify(sort), () => {
    assert.equal(parseTrackListFilters({ sort }).error, 'sort must be newest or mostLiked.');
  });
}
