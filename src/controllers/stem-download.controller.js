const Track = require('../models/Track');
const downloadService = require('../services/stem-download.service');

async function getStemDownload(req, res, next) {
  const { trackId, stemId } = req.params;
  for (const [name, value] of Object.entries({ trackId, stemId })) {
    if (typeof value !== 'string' || value.length !== 24 || !/^[a-fA-F0-9]{24}$/.test(value)) {
      return res.status(400).json({ message: `${name} must be a valid MongoDB ObjectId.` });
    }
  }
  if (req.originalUrl.includes('?')) {
    return res.status(400).json({ message: 'Download does not accept query parameters.' });
  }

  try {
    // Scope the read before inspecting the flag, stems or storage metadata.
    const track = await Track.findOne({
      _id: trackId,
      $or: [{ isPublic: true }, { artistId: req.user._id }],
    }).select('_id isDownloadable stems').lean().exec();
    if (!track) return res.status(404).json({ message: 'Track not found' });
    if (track.isDownloadable !== true) {
      return res.status(403).json({ message: 'Downloads are disabled for this Track.' });
    }
    const stem = track.stems.find(item => String(item.stemId).toLowerCase() === stemId.toLowerCase());
    if (!stem) return res.status(404).json({ message: 'Stem not found' });

    const data = downloadService.createStemDownload(stem.audioUrl);
    return res.status(200).json({ data: { trackId: String(track._id), stemId: String(stem.stemId), ...data } });
  } catch (error) {
    if (error instanceof downloadService.StemDownloadError) {
      return res.status(error.status).json({ message: error.message });
    }
    return next(error);
  }
}

module.exports = { getStemDownload };
