const mongoose = require('mongoose');
const User = require('../models/User');
const { verifyAccessToken } = require('../config/jwt');

async function authenticate(req, res, next) {
  const authorization = req.get('authorization');
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);

  if (!match) {
    return res.status(401).json({
      message: 'Authentication required.',
    });
  }

  try {
    const payload = verifyAccessToken(match[1]);

    if (
      typeof payload.sub !== 'string' ||
      !mongoose.isObjectIdOrHexString(payload.sub)
    ) {
      return res.status(401).json({
        message: 'Invalid or expired access token.',
      });
    }

    const user = await User.findById(payload.sub);

    if (!user) {
      return res.status(401).json({
        message: 'Invalid or expired access token.',
      });
    }

    req.user = user;

    return next();
  } catch (error) {
    if (
      ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError']
        .includes(error.name)
    ) {
      return res.status(401).json({
        message: 'Invalid or expired access token.',
      });
    }

    console.error('Authentication failed:', error.name, error.code || '');

    return res.status(500).json({
      message: 'Unable to authenticate. Please try again later.',
    });
  }
}

module.exports = authenticate;