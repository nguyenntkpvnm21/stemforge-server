const User = require('../models/User');
const TrackLike = require('../models/TrackLike');

async function enrichTracks(tracks, userId, session) {
  if (tracks.length === 0) {
    return [];
  }

  const data = tracks.map((track) => (
    typeof track.toJSON === 'function' ? track.toJSON() : { ...track }
  ));
  const artistIds = [...new Set(data.map((track) => String(track.artistId)))];
  const trackIds = data.map((track) => track._id);

  const authorQuery = User.find({ _id: { $in: artistIds } })
    .select('_id username avatarUrl').lean();
  const membershipQuery = userId
    ? TrackLike.find({ userId, trackId: { $in: trackIds } }).select('trackId -_id').lean()
    : null;
  const read = query => {
    if (session) query.session(session);
    return query.exec();
  };
  let artists;
  let likes;
  if (session) {
    // MongoDB does not support parallel operations within a transaction.
    artists = await read(authorQuery);
    likes = membershipQuery ? await read(membershipQuery) : [];
  } else {
    [artists, likes] = await Promise.all([
      read(authorQuery), membershipQuery ? read(membershipQuery) : [],
    ]);
  }

  // Explicitly allowlist public fields even when a query result has extra data.
  const artistById = new Map(artists.map((artist) => [
    String(artist._id),
    {
      _id: String(artist._id),
      username: artist.username,
      avatarUrl: artist.avatarUrl ?? null,
    },
  ]));
  const likedTrackIds = new Set(likes.map((like) => String(like.trackId)));

  return data.map((track) => ({
    ...track,
    artist: artistById.get(String(track.artistId)) ?? null,
    likedByMe: likedTrackIds.has(String(track._id)),
  }));
}

module.exports = { enrichTracks };
