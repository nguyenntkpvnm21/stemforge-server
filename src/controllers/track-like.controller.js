const trackLikeService = require('../services/track-like.service');

async function handleTrackLike(req, res, next, desiredState) {
  res.set('Cache-Control', 'no-store');

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
    const userId = String(req.user._id);

    const data = desiredState === undefined
      ? await trackLikeService.getTrackLikeState(trackId, userId)
      : await trackLikeService.setTrackLikeState(
          trackId,
          userId,
          desiredState
        );

    return res.status(200).json({ data });
  } catch (error) {
    if (error instanceof trackLikeService.TrackLikeError) {
      return res.status(error.status).json({
        message: error.message,
      });
    }

    return next(error);
  }
}

function getTrackLike(req, res, next) {
  return handleTrackLike(req, res, next);
}

function likeTrack(req, res, next) {
  return handleTrackLike(req, res, next, true);
}

function unlikeTrack(req, res, next) {
  return handleTrackLike(req, res, next, false);
}

module.exports = {
  getTrackLike,
  likeTrack,
  unlikeTrack,
};