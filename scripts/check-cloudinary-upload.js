require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const cloudinary = require('../src/config/cloudinary');

async function checkUpload() {
  const inputPath = process.argv[2];

  if (!inputPath) {
    throw new Error('Provide the local audio file path.');
  }

  const filePath = path.resolve(inputPath);
  const extension = path.extname(filePath).toLowerCase();

  if (!['.mp3', '.wav'].includes(extension)) {
    throw new Error('Use an MP3 or WAV file.');
  }

  const fileInfo = fs.statSync(filePath);

  if (!fileInfo.isFile()) {
    throw new Error('The path must point to a file.');
  }

  if (fileInfo.size > 5 * 1024 * 1024) {
    throw new Error('Use a file smaller than 5 MiB for this check.');
  }

  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: 'video',
    public_id: `stemforge/tests/${randomUUID()}`,
    overwrite: false,
  });

  console.log(JSON.stringify({
    public_id: result.public_id,
    resource_type: result.resource_type,
    secure_url: result.secure_url,
    duration: result.duration,
    bytes: result.bytes,
  }, null, 2));
}

checkUpload().catch((error) => {
  console.error(
    'Audio upload check failed:',
    error.message || error.error?.message || 'Unknown error'
  );
  process.exitCode = 1;
});