const express = require('express');
const authenticate = require('../middlewares/auth.middleware');
const {
  createAudioUploadRateLimiter,
} = require('../middlewares/audio-upload-rate-limit.middleware');
const {
  receiveAudio,
} = require('../middlewares/audio-upload.middleware');
const {
  uploadAudio,
} = require('../controllers/upload.controller');

const router = express.Router();
const audioUploadRateLimit = createAudioUploadRateLimiter();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/**
 * @openapi
 * components:
 *   schemas:
 *     AudioUploadResponse:
 *       type: object
 *       required: [data]
 *       properties:
 *         data:
 *           type: object
 *           required: [audioUrl, duration, fileSize, publicId]
 *           properties:
 *             audioUrl:
 *               type: string
 *               format: uri
 *               description: HTTPS URL of the uploaded audio.
 *               example: https://res.cloudinary.com/demo/video/upload/v1/sample.wav
 *             duration:
 *               type: number
 *               format: double
 *               minimum: 0
 *               exclusiveMinimum: true
 *               description: Audio duration in seconds, reported by Cloudinary.
 *               example: 1
 *             fileSize:
 *               type: integer
 *               format: int64
 *               minimum: 1
 *               description: File size in bytes, reported by Cloudinary.
 *               example: 88244
 *             publicId:
 *               type: string
 *               description: Server-generated Cloudinary asset identifier.
 *               example: stemforge/audio/507f1f77bcf86cd799439011/123e4567-e89b-42d3-a456-426614174000
 * /api/uploads/audio:
 *   post:
 *     tags: [Uploads]
 *     summary: Upload an audio file
 *     description: |
 *       Upload exactly one MP3, WAV, or FLAC file using the audio field.
 *       Maximum file size is 20 MiB (20,971,520 bytes).
 *       Additional form fields are not accepted.
 *
 *       Authentication is checked before multipart parsing.
 *       The limit is 10 authenticated requests per account per 15 minutes.
 *       Failed authenticated requests also count toward the limit.
 *
 *       Uploading does not create a Track. Use the returned audioUrl,
 *       duration, and fileSize when creating a stem.
 *       Do not include publicId in the Track creation request.
 *
 *       Cloudinary delivery URLs are public. Track visibility is managed
 *       separately by the Track API.
 *
 *       All responses use Cache-Control: no-store.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [audio]
 *             properties:
 *               audio:
 *                 type: string
 *                 format: binary
 *                 description: One MP3, WAV, or FLAC file, up to 20 MiB.
 *     responses:
 *       '201':
 *         description: Audio uploaded successfully.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               example: no-store
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AudioUploadResponse'
 *       '400':
 *         description: Missing, empty, or invalid multipart input.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: An audio file is required.
 *       '401':
 *         description: Missing, invalid, or expired access token.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Authentication required.
 *       '413':
 *         description: Audio file exceeds 20 MiB.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Audio file must not exceed 20 MiB.
 *       '415':
 *         description: Unsupported Content-Type or invalid audio.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Only valid MP3, WAV, and FLAC audio files are supported.
 *       '429':
 *         description: Upload request limit exceeded.
 *         headers:
 *           Retry-After:
 *             description: Seconds to wait before retrying.
 *             schema:
 *               type: integer
 *               minimum: 1
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Too many audio upload requests. Please try again later.
 *       '500':
 *         description: Unexpected internal error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Internal server error.
 *       '502':
 *         description: Audio storage or upload processing failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Unable to upload audio. Please try again later.
 */
router.post(
  '/audio',
  authenticate,
  audioUploadRateLimit,
  receiveAudio,
  uploadAudio
);

module.exports = router;