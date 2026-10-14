const mongoose = require('mongoose');

const stemSchema = new mongoose.Schema(
  {
    stemId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      default: () => new mongoose.Types.ObjectId(),
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    audioUrl: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator(value) {
          try {
            return new URL(value).protocol === 'https:';
          } catch {
            return false;
          }
        },
        message: 'Stem audioUrl must be a valid HTTPS URL.',
      },
    },
    duration: {
      type: Number,
      required: true,
      validate: {
        validator: (value) => Number.isFinite(value) && value > 0,
        message: 'Stem duration must be a positive number of seconds.',
      },
    },
    fileSize: {
      type: Number,
      required: true,
      validate: {
        validator: (value) => Number.isSafeInteger(value) && value > 0,
        message: 'Stem fileSize must be a positive integer in bytes.',
      },
    },
  },
  {
    _id: false,
  }
);

module.exports = stemSchema;