const mongoose = require('mongoose');

const trackLikeSchema = new mongoose.Schema(
  {
    trackId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Track',
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: {
      createdAt: 'createdAt',
      updatedAt: false,
    },
    toJSON: {
      versionKey: false,
    },
  }
);

trackLikeSchema.index(
  { trackId: 1, userId: 1 },
  {
    unique: true,
    name: 'unique_track_user_like',
  }
);

module.exports = mongoose.model('TrackLike', trackLikeSchema);