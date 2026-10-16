const path = require('node:path');
const multer = require('multer');

const MAX_AUDIO_FILE_SIZE = 20 * 1024 * 1024;

const allowedMimeTypes = {
  '.mp3': new Set([
    'audio/mpeg',
    'audio/mp3',
    'audio/x-mp3',
    'application/octet-stream',
  ]),
  '.wav': new Set([
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/vnd.wave',
    'application/octet-stream',
  ]),
  '.flac': new Set([
    'audio/flac',
    'audio/x-flac',
    'application/octet-stream',
  ]),
};

const receiveMultipart = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_AUDIO_FILE_SIZE,
    files: 1,
    fields: 0,
    parts: 1,
    fieldNameSize: 50,
  },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    const mimeTypes = allowedMimeTypes[extension];
    const mimeType = file.mimetype.toLowerCase();

    if (!mimeTypes || !mimeTypes.has(mimeType)) {
      const error = new Error('Unsupported audio file type.');
      error.code = 'UNSUPPORTED_AUDIO_TYPE';

      return callback(error);
    }

    return callback(null, true);
  },
}).single('audio');

function receiveAudio(req, res, next) {
  res.set('Cache-Control', 'no-store');

  if (!req.user?._id) {
    return res.status(401).json({
      message: 'Authentication required.',
    });
  }

  if (!req.is('multipart/form-data')) {
    return res.status(415).json({
      message: 'Content-Type must be multipart/form-data.',
    });
  }

  return receiveMultipart(req, res, (error) => {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        message: 'Audio file must not exceed 20 MiB.',
      });
    }

    if (error?.code === 'UNSUPPORTED_AUDIO_TYPE') {
      return res.status(415).json({
        message: 'Only MP3, WAV, and FLAC audio files are supported.',
      });
    }

    if (error instanceof multer.MulterError) {
      return res.status(400).json({
        message: 'Upload exactly one file using the audio field, without extra fields.',
      });
    }

    if (error) {
      return res.status(400).json({
        message: 'Request must contain valid multipart form data.',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        message: 'An audio file is required.',
      });
    }

    if (req.file.size === 0) {
      return res.status(400).json({
        message: 'Audio file must not be empty.',
      });
    }

    return next();
  });
}

module.exports = {
  receiveAudio,
  MAX_AUDIO_FILE_SIZE,
};