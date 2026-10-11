const { rateLimit } = require('express-rate-limit');

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    message: 'Too many authentication requests. Please try again later.',
  },
  handler(req, res, next, options) {
    console.warn('Auth rate limit exceeded. Client IP:', req.ip);

    return res.status(options.statusCode).json(options.message);
  },
});

module.exports = authRateLimiter;