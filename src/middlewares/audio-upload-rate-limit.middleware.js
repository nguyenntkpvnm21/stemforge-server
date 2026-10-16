const { rateLimit } = require('express-rate-limit');

function createAudioUploadRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: 'audio-upload',
    keyGenerator(req) {
      return String(req.user._id);
    },
    handler(req, res) {
      res.set('Cache-Control', 'no-store');

      return res.status(429).json({
        message: 'Too many audio upload requests. Please try again later.',
      });
    },
  });
}

module.exports = {
  createAudioUploadRateLimiter,
};