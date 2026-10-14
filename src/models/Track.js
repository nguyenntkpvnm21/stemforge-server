const mongoose = require('mongoose');
const stemSchema = require('./stem.schema');

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function hasValidStems(stems) {
  if (!Array.isArray(stems) || stems.length < 1 || stems.length > 4) {
    return false;
  }

  const ids = stems.map((stem) => stem?.stemId?.toString());

  return ids.every(Boolean) && new Set(ids).size === ids.length;
}

const trackSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    artistId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    genre: {
      type: String,
      required: true,
      trim: true,
    },
    bpm: {
      type: Number,
      required: true,
      validate: {
        validator: (value) => Number.isFinite(value) && value > 0,
        message: 'Track bpm must be a positive number.',
      },
    },
    key: {
      type: String,
      required: true,
      trim: true,
    },
    tags: {
      type: [{ type: String, trim: true }],
      default: [],
      validate: {
        validator: (value) =>
          Array.isArray(value) &&
          value.every((tag) => typeof tag === 'string' && tag.length > 0),
        message: 'Track tags must contain non-empty strings.',
      },
    },
    coverImageUrl: {
      type: String,
      default: null,
      validate: {
        validator: (value) => value === null || isHttpsUrl(value),
        message: 'Track coverImageUrl must be null or a valid HTTPS URL.',
      },
    },
    description: {
      type: String,
      default: '',
      validate: {
        validator: (value) => typeof value === 'string',
        message: 'Track description must be a string.',
      },
    },
    isPublic: {
      type: Boolean,
      required: true,
    },
    isDownloadable: {
      type: Boolean,
      required: true,
    },
    stems: {
      type: [stemSchema],
      required: true,
      validate: {
        validator: hasValidStems,
        message: 'Track must contain 1 to 4 stems with unique stemId values.',
      },
    },
    likesCount: {
      type: Number,
      required: true,
      default: 0,
      validate: {
        validator: (value) => Number.isSafeInteger(value) && value >= 0,
        message: 'Track likesCount must be a non-negative integer.',
      },
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

trackSchema.index({ artistId: 1, createdAt: -1 });
trackSchema.index({ isPublic: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model('Track', trackSchema);