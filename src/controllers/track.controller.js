const Track = require('../models/Track');
const {
  validateCreateTrackInput,
  validateUpdateTrackInput,
} = require('../validators/track.validator');
const mongoose = require('mongoose');
const TrackLike = require('../models/TrackLike');
const trackResponseService = require('../services/track-response.service');
const trackWriteOptions = {
  readPreference: 'primary',
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
};

function parsePositiveInteger(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const number = Number(value);

  return Number.isSafeInteger(number) ? number : null;
}

async function listTracks(req, res, next) {
  const page = parsePositiveInteger(req.query.page, 1);
  const limit = parsePositiveInteger(req.query.limit, 12);

  if (page === null) {
    return res.status(400).json({
      message: 'page must be a positive integer.',
    });
  }

  if (limit === null || limit > 100) {
    return res.status(400).json({
      message: 'limit must be an integer between 1 and 100.',
    });
  }

  const skip = (page - 1) * limit;

  if (!Number.isSafeInteger(skip)) {
    return res.status(400).json({
      message: 'The requested page is too large.',
    });
  }

  try {
    const filter = { isPublic: true };

    const [tracks, total] = await Promise.all([
      Track.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      Track.countDocuments(filter).exec(),
    ]);

    const data = await trackResponseService.enrichTracks(tracks, req.user?._id);

    return res.status(200).json({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function getTrack(req, res, next) {
  const { trackId } = req.params;

  if (
    typeof trackId !== 'string' ||
    !/^[a-fA-F0-9]{24}$/.test(trackId)
  ) {
    return res.status(400).json({
      message: 'trackId must be a valid MongoDB ObjectId.',
    });
  }

  try {
    const accessFilter = req.user?._id
      ? {
          $or: [
            { isPublic: true },
            { artistId: req.user._id },
          ],
        }
      : { isPublic: true };

    const track = await Track.findOne({
      _id: trackId,
      ...accessFilter,
    }).exec();

    if (!track) {
      return res.status(404).json({
        message: 'Track not found',
      });
    }

    const [data] = await trackResponseService.enrichTracks([track], req.user?._id);

    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function createTrack(req, res, next) {
  if (!req.user?._id) {
    return res.status(401).json({
      message: 'Authentication required.',
    });
  }

  const validationMessage = validateCreateTrackInput(req.body);

  if (validationMessage) {
    return res.status(400).json({
      message: validationMessage,
    });
  }

  try {
    const data = await mongoose.connection.transaction(async (session) => {
      const [track] = await Track.create([{
        ...req.body,
        artistId: req.user._id,
        likesCount: 0,
      }], { session });
      const [response] = await trackResponseService.enrichTracks([track], req.user._id, session);
      return response;
    }, trackWriteOptions);

    return res.status(201).json({ data });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: 'Track data failed validation.',
      });
    }

    return next(error);
  }
}

async function updateTrack(req, res, next) {
  if (!req.user?._id) {
    return res.status(401).json({
      message: 'Authentication required.',
    });
  }

  const { trackId } = req.params;

  if (
    typeof trackId !== 'string' ||
    !/^[a-fA-F0-9]{24}$/.test(trackId)
  ) {
    return res.status(400).json({
      message: 'trackId must be a valid MongoDB ObjectId.',
    });
  }

  const validationMessage = validateUpdateTrackInput(req.body);

  if (validationMessage) {
    return res.status(400).json({
      message: validationMessage,
    });
  }

  try {
    const data = await mongoose.connection.transaction(async (session) => {
      const track = await Track.findOneAndUpdate(
        { _id: trackId, artistId: req.user._id },
        { $set: req.body },
        { session, returnDocument: 'after', runValidators: true, upsert: false }
      ).exec();
      if (!track) return null;
      const [response] = await trackResponseService.enrichTracks([track], req.user._id, session);
      return response;
    }, trackWriteOptions);

    if (!data) {
      return res.status(404).json({
        message: 'Track not found',
      });
    }

    return res.status(200).json({ data });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: 'Track data failed validation.',
      });
    }

    return next(error);
  }
}

async function deleteTrack(req, res, next) {
  if (!req.user?._id) {
    return res.status(401).json({
      message: 'Authentication required.',
    });
  }

  const { trackId } = req.params;

  if (
    typeof trackId !== 'string' ||
    !/^[a-fA-F0-9]{24}$/.test(trackId)
  ) {
    return res.status(400).json({
      message: 'trackId must be a valid MongoDB ObjectId.',
    });
  }

  try {
    const track = await mongoose.connection.transaction(
      async (session) => {
        const deletedTrack = await Track.findOneAndDelete({
          _id: trackId,
          artistId: req.user._id,
        })
          .session(session)
          .exec();

        if (!deletedTrack) {
          return null;
        }

        await TrackLike.deleteMany({
          trackId: deletedTrack._id,
        })
          .session(session)
          .exec();

        return deletedTrack;
      },
      {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      }
    );

    if (!track) {
      return res.status(404).json({
        message: 'Track not found',
      });
    }

    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listTracks,
  getTrack,
  createTrack,
  updateTrack,
  deleteTrack,
};
