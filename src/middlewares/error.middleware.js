function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  res.set('Cache-Control', 'no-store');

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      message: 'Request body must contain valid JSON.',
    });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      message: 'Request body exceeds the allowed size.',
    });
  }

  const status = error.status ?? error.statusCode;

  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({
      message: 'Invalid request.',
    });
  }

  console.error(
    'Unhandled request error:',
    error.name || 'Error',
    error.code || ''
  );

  return res.status(500).json({
    message: 'Internal server error.',
  });
}

module.exports = errorHandler;