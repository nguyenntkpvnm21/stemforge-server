const DOWNLOAD_TTL_SECONDS = 300;

class StemDownloadError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'StemDownloadError';
    this.status = status;
  }
}

function createStemDownload(audioUrl) {
  // Lazy loading preserves routes that do not use storage. Signing is local;
  // no request is sent to Cloudinary and no client-supplied URL is fetched.
  const cloudinary = require('../config/cloudinary');
  const cloudName = cloudinary.config().cloud_name;
  const match = typeof audioUrl === 'string' && audioUrl.match(
    /^https:\/\/res\.cloudinary\.com\/([a-z0-9_-]+)\/video\/upload\/v[1-9][0-9]*\/(stemforge\/audio\/[a-fA-F0-9]{24}\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\.(mp3|wav|flac)$/
  );
  // Full equality also rejects a trailing newline ($ may match before it).
  if (!match || match[0] !== audioUrl || match[1] !== cloudName) {
    throw new StemDownloadError(422, 'Stem audio is not available from supported storage.');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const expires = timestamp + DOWNLOAD_TTL_SECONDS;
  const downloadUrl = cloudinary.utils.private_download_url(match[2], match[3], {
    resource_type: 'video',
    type: 'upload',
    attachment: true,
    timestamp,
    expires_at: expires,
    upload_prefix: 'https://api.cloudinary.com',
  });

  return { downloadUrl, expiresAt: new Date(expires * 1000).toISOString() };
}

module.exports = { createStemDownload, StemDownloadError, DOWNLOAD_TTL_SECONDS };
