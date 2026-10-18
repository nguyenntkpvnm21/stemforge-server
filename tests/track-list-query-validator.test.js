const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTrackListFilters } = require('../src/validators/track-list-query.validator');

test('default filter is public-only and does not incorporate pagination', () => {
  assert.deepEqual(parseTrackListFilters({ page: '2', limit: '5' }), { filter: { isPublic: true } });
});

test('combines trimmed title, exact genre/key and inclusive decimal bounds with AND', () => {
  const result = parseTrackListFilters({ q: '  demo  ', genre: ' Electronic ', key: ' Am ', bpmMin: '120.5', bpmMax: '128' });
  assert.deepEqual(result, { filter: {
    isPublic: true, title: { $regex: 'demo', $options: 'i' },
    genre: { $regex: '^Electronic$', $options: 'i' }, key: { $regex: '^Am$', $options: 'i' },
    bpm: { $gte: 120.5, $lte: 128 },
  } });
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
    assert.deepEqual(parseTrackListFilters(query), { filter: { isPublic: true, bpm } });
  });
}

for (const field of ['q', 'genre', 'key']) {
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

for (const field of ['$where', '$or', 'q[$regex]', 'genre[$ne]', 'isPublic', 'artistId', 'tags', 'sort']) {
  test('rejects unsupported parameter ' + field, () => {
    assert.ok(parseTrackListFilters({ [field]: 'anything' }).error);
  });
}
