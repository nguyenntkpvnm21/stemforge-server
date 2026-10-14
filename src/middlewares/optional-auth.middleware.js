const authenticate = require('./auth.middleware');

function optionalAuthenticate(req, res, next) {
  const authorization = req.get('authorization');

  if (authorization === undefined) {
    return next();
  }

  return authenticate(req, res, next);
}

module.exports = optionalAuthenticate;