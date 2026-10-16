const audioUploadService = require('../services/audio-upload.service');

async function uploadAudio(req, res, next) {
  res.set('Cache-Control', 'no-store');

  if (!req.user?._id) {
    return res.status(401).json({
      message: 'Authentication required.',
    });
  }

  if (
    !req.file ||
    !Buffer.isBuffer(req.file.buffer) ||
    req.file.buffer.length === 0
  ) {
    return res.status(400).json({
      message: 'An audio file is required.',
    });
  }

  try {
    const data = await audioUploadService.uploadAudioBuffer(
      req.file.buffer,
      String(req.user._id)
    );

    return res.status(201).json({ data });
  } catch (error) {
    if (error instanceof audioUploadService.AudioUploadError) {
      return res.status(error.status).json({
        message: error.message,
      });
    }

    return next(error);
  }
}

module.exports = {
  uploadAudio,
};