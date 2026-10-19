const mongoose = require('mongoose');
const Track = require('../models/Track');
const TrackLike = require('../models/TrackLike');
const trackEvents = require('./track-events.service');

const MAX_TRANSACTION_ATTEMPTS = 3;

class TrackLikeError extends Error {
  constructor(status, message) {
    super(message);

    this.name = 'TrackLikeError';
    this.status = status;
  }
}

function accessFilter(trackId, userId) {
  return {
    _id: trackId,
    $or: [
      { isPublic: true },
      { artistId: userId },
    ],
  };
}

function isDuplicateLike(error) {
  const keyPattern =
    error?.keyPattern ?? error?.errorResponse?.keyPattern;

  return (
    error?.code === 11000 &&
    keyPattern?.trackId === 1 &&
    keyPattern?.userId === 1
  );
}

async function runLikeTransaction(operation) {
  for (
    let attempt = 1;
    attempt <= MAX_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await mongoose.connection.transaction(operation, {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
    } catch (error) {
      if (
        !isDuplicateLike(error) ||
        attempt === MAX_TRANSACTION_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
}

async function readSnapshot(trackId, userId, session) {
  const track = await Track.findOne(
    accessFilter(trackId, userId)
  )
    .select('_id likesCount')
    .session(session)
    .exec();

  if (!track) {
    throw new TrackLikeError(404, 'Track not found');
  }

  if (
    !Number.isSafeInteger(track.likesCount) ||
    track.likesCount < 0
  ) {
    throw new Error('Track likes count is invalid.');
  }

  const like = await TrackLike.findOne({
    trackId: track._id,
    userId,
  })
    .select('_id')
    .session(session)
    .exec();

  return { track, like };
}

function toState(track, isLiked) {
  return {
    trackId: String(track._id),
    isLiked,
    likesCount: track.likesCount,
  };
}

async function getTrackLikeState(trackId, userId) {
  return runLikeTransaction(async (session) => {
    const { track, like } = await readSnapshot(
      trackId,
      userId,
      session
    );

    return toState(track, Boolean(like));
  });
}

async function setTrackLikeState(trackId, userId, shouldLike) {
  if (typeof shouldLike !== 'boolean') {
    throw new TypeError('The requested like state must be a boolean.');
  }

  return trackEvents.coordinator.run(trackId, async () => {
    const outcome = await runLikeTransaction(async (session) => {
      const { track, like } = await readSnapshot(
        trackId,
        userId,
        session
      );

      if (Boolean(like) === shouldLike) {
        return { state: toState(track, shouldLike), changed: false };
      }

      const delta = shouldLike ? 1 : -1;
      const nextCount = track.likesCount + delta;

      if (!Number.isSafeInteger(nextCount) || nextCount < 0) {
        throw new Error('Track likes count would become invalid.');
      }

      if (shouldLike) {
        await TrackLike.create(
          [{
            trackId: track._id,
            userId,
          }],
          { session }
        );
      } else {
        const deletion = await TrackLike.deleteOne(
          {
            _id: like._id,
            trackId: track._id,
            userId,
          },
          { session }
        ).exec();

        if (deletion.deletedCount !== 1) {
          throw new Error('Unable to remove the Track like.');
        }
      }

      const updatedTrack = await Track.findOneAndUpdate(
        accessFilter(track._id, userId),
        {
          $inc: { likesCount: delta },
        },
        {
          session,
          returnDocument: 'after',
          runValidators: true,
          upsert: false,
        }
      )
        .select('_id likesCount')
        .exec();

      if (!updatedTrack) {
        throw new TrackLikeError(404, 'Track not found');
      }

      if (updatedTrack.likesCount !== nextCount) {
        throw new Error('Track likes count update is inconsistent.');
      }

      return { state: toState(updatedTrack, shouldLike), changed: true };
    });
    if (outcome.changed) await trackEvents.afterCommit('like', trackId, outcome.state);
    return outcome.state;
  });
}

module.exports = {
  getTrackLikeState,
  setTrackLikeState,
  TrackLikeError,
};
