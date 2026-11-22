const mongoose = require('mongoose');
const Track = require('../models/Track');
const TrackLike = require('../models/TrackLike');

async function listLikedTracks(userId, { skip, limit }) {
  // Mongoose does not cast aggregation stages. Scope always comes from authenticated identity.
  const viewerId = new mongoose.Types.ObjectId(userId);
  const [result] = await TrackLike.aggregate([
    { $match: { userId: viewerId } },
    { $lookup: { from: Track.collection.name, localField: 'trackId', foreignField: '_id', as: 'track' } },
    { $unwind: '$track' },
    { $match: { $or: [{ 'track.isPublic': true }, { 'track.artistId': viewerId }] } },
    { $facet: {
      tracks: [
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $replaceRoot: { newRoot: '$track' } },
      ],
      total: [{ $count: 'count' }],
    } },
  ]).exec();

  // Hydrate just this page for the same schema/toJSON behavior as normal Track reads.
  // No Like IDs/timestamps or internal Track version key become response metadata.
  return {
    tracks: (result?.tracks ?? []).map(track => Track.hydrate(track)),
    total: result?.total?.[0]?.count ?? 0,
  };
}

module.exports = { listLikedTracks };
