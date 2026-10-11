const jwt = require('jsonwebtoken');

const secret = process.env.JWT_SECRET;

if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
  throw new Error('JWT_SECRET must contain at least 32 bytes.');
}

const issuer = 'stemforge-server';
const audience = 'stemforge-client';

function createAccessToken(userId) {
  return jwt.sign({}, secret, {
    algorithm: 'HS256',
    subject: String(userId),
    expiresIn: 3600,
    issuer,
    audience,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer,
    audience,
  });
}

module.exports = {
  createAccessToken,
  verifyAccessToken,
};