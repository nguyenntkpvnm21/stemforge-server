const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const TrackLike = require('../src/models/TrackLike');

const VALID_INPUT = {
  trackId: '507f1f77bcf86cd799439011',
  userId: '507f1f77bcf86cd799439012',
};

test('accepts valid IDs and casts them to ObjectIds', async () => {
  const like = new TrackLike(VALID_INPUT);

  await like.validate();

  assert.ok(like.trackId instanceof mongoose.Types.ObjectId);
  assert.ok(like.userId instanceof mongoose.Types.ObjectId);
  assert.equal(String(like.trackId), VALID_INPUT.trackId);
  assert.equal(String(like.userId), VALID_INPUT.userId);
});

const invalidInputs = [
  {
    name: 'rejects a missing Track ID',
    field: 'trackId',
    value: undefined,
    errorName: 'ValidatorError',
  },
  {
    name: 'rejects a missing user ID',
    field: 'userId',
    value: undefined,
    errorName: 'ValidatorError',
  },
  {
    name: 'rejects a null Track ID',
    field: 'trackId',
    value: null,
    errorName: 'ValidatorError',
  },
  {
    name: 'rejects a null user ID',
    field: 'userId',
    value: null,
    errorName: 'ValidatorError',
  },
  {
    name: 'rejects an invalid Track ID',
    field: 'trackId',
    value: 'invalid-track',
    errorName: 'CastError',
  },
  {
    name: 'rejects an invalid user ID',
    field: 'userId',
    value: 'invalid-user',
    errorName: 'CastError',
  },
];

for (const sample of invalidInputs) {
  test(sample.name, async () => {
    const like = new TrackLike({
      ...VALID_INPUT,
      [sample.field]: sample.value,
    });

    await assert.rejects(like.validate(), (error) => {
      assert.equal(error.name, 'ValidationError');

      const fieldError = error.errors[sample.field];

      assert.ok(fieldError);
      assert.equal(fieldError.name, sample.errorName);

      if (sample.errorName === 'ValidatorError') {
        assert.equal(fieldError.kind, 'required');
      }

      return true;
    });
  });
}