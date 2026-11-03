const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  keyHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  requestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  hashVersion: { type: Number, required: true, enum: [1] },
  trackId: { type: mongoose.Schema.Types.ObjectId, required: true },
  responseBody: { type: mongoose.Schema.Types.Mixed, required: true },
  completedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, {
  collection: 'trackcreateidempotencies',
  autoCreate: false,
  autoIndex: false,
  bufferCommands: false,
  versionKey: false,
});

schema.index({ ownerId: 1, keyHash: 1 }, { unique: true, name: 'unique_owner_track_create_key' });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'track_create_key_expiry' });

module.exports = mongoose.model('TrackCreateIdempotency', schema);
