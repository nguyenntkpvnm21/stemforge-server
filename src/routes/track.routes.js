const express = require('express');

const {
  listTracks,
  getTrack,
  createTrack,
  updateTrack,
  deleteTrack,
} = require('../controllers/track.controller');

const authenticate = require('../middlewares/auth.middleware');

const optionalAuthenticate = require('../middlewares/optional-auth.middleware');

const {
  getTrackLike,
  likeTrack,
  unlikeTrack,
} = require('../controllers/track-like.controller');

const router = express.Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/**
 * @openapi
 * components:
 *   schemas:
 *     Stem:
 *       type: object
 *       required: [stemId, name, audioUrl, duration, fileSize]
 *       properties:
 *         stemId:
 *           type: string
 *           pattern: '^[a-fA-F0-9]{24}$'
 *           description: Stable mixer channel identifier.
 *           example: '507f1f77bcf86cd799439013'
 *         name:
 *           type: string
 *           minLength: 1
 *           example: Drums
 *         audioUrl:
 *           type: string
 *           format: uri
 *           description: HTTPS URL for audio playback.
 *         duration:
 *           type: number
 *           minimum: 0
 *           exclusiveMinimum: true
 *           description: Duration in seconds; decimals are allowed.
 *           example: 30.125
 *         fileSize:
 *           type: integer
 *           minimum: 1
 *           maximum: 9007199254740991
 *           description: File size in bytes.
 *           example: 480000
 *     Track:
 *       type: object
 *       required:
 *         - _id
 *         - title
 *         - artistId
 *         - artist
 *         - likedByMe
 *         - genre
 *         - bpm
 *         - key
 *         - tags
 *         - coverImageUrl
 *         - description
 *         - isPublic
 *         - isDownloadable
 *         - stems
 *         - likesCount
 *         - createdAt
 *       properties:
 *         _id:
 *           type: string
 *           pattern: '^[a-fA-F0-9]{24}$'
 *           example: '507f1f77bcf86cd799439011'
 *         title:
 *           type: string
 *           minLength: 1
 *           example: StemForge Demo
 *         artistId:
 *           type: string
 *           pattern: '^[a-fA-F0-9]{24}$'
 *           description: Owner ID, not a populated user object.
 *           example: '507f1f77bcf86cd799439012'
 *         artist:
 *           type: object
 *           nullable: true
 *           readOnly: true
 *           additionalProperties: false
 *           required: [_id, username, avatarUrl]
 *           description: Public author fields only; null if the owner User no longer exists. artistId is preserved.
 *           properties:
 *             _id:
 *               type: string
 *               pattern: '^[a-fA-F0-9]{24}$'
 *             username:
 *               type: string
 *             avatarUrl:
 *               type: string
 *               nullable: true
 *         likedByMe:
 *           type: boolean
 *           readOnly: true
 *           description: Whether the current account likes this Track. Always false for guests; not stored in Track.
 *           example: false
 *         genre:
 *           type: string
 *           minLength: 1
 *           example: Electronic
 *         bpm:
 *           type: number
 *           minimum: 0
 *           exclusiveMinimum: true
 *           example: 128
 *         key:
 *           type: string
 *           minLength: 1
 *           example: Am
 *         tags:
 *           type: array
 *           items:
 *             type: string
 *             minLength: 1
 *           example: [electronic, demo]
 *         coverImageUrl:
 *           type: string
 *           format: uri
 *           nullable: true
 *           description: HTTPS cover image URL, or null when absent.
 *           example: null
 *         description:
 *           type: string
 *           example: Sample track metadata.
 *         isPublic:
 *           type: boolean
 *           example: true
 *         isDownloadable:
 *           type: boolean
 *           description: Whether the application offers a download action.
 *           example: true
 *         stems:
 *           type: array
 *           minItems: 1
 *           maxItems: 4
 *           description: Ordered stems with unique stemId values.
 *           items:
 *             $ref: '#/components/schemas/Stem'
 *         likesCount:
 *           type: integer
 *           minimum: 0
 *           maximum: 9007199254740991
 *           example: 0
 *         createdAt:
 *           type: string
 *           format: date-time
 *           example: '2026-10-08T11:00:00.000Z'
 *     TrackListResponse:
 *       type: object
 *       required: [data, pagination]
 *       properties:
 *         data:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Track'
 *         pagination:
 *           type: object
 *           required: [page, limit, total, totalPages]
 *           properties:
 *             page:
 *               type: integer
 *               minimum: 1
 *               example: 1
 *             limit:
 *               type: integer
 *               minimum: 1
 *               maximum: 100
 *               example: 12
 *             total:
 *               type: integer
 *               minimum: 0
 *               description: Total number of public tracks.
 *               example: 0
 *             totalPages:
 *               type: integer
 *               minimum: 0
 *               description: Zero when no public tracks exist.
 *               example: 0
 */

/**
 * @openapi
 * /api/tracks:
 *   get:
 *     tags: [Tracks]
 *     summary: List public tracks
 *     description: >-
 *       No authentication is required. Returns public tracks ordered by
 *       createdAt descending, then _id descending. A page beyond the
 *       available results returns an empty data array. Authentication is
 *       optional; a supplied header must be a valid Bearer token. Each Track
 *       includes public artist information and personalized likedByMe (false
 *       for guests). The list remains public-only for authenticated users.
 *       The Track/Stem contract is currently a draft.
 *     security:
 *       - {}
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         required: false
 *         description: Positive integer page number.
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 9007199254740991
 *           default: 1
 *       - in: query
 *         name: limit
 *         required: false
 *         description: Number of tracks per page.
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 12
 *     responses:
 *       '200':
 *         description: Public track list and pagination.
 *         headers:
 *           Cache-Control:
 *             description: Prevents caching of the response.
 *             schema:
 *               type: string
 *               enum: [no-store]
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TrackListResponse'
 *             example:
 *               data: []
 *               pagination:
 *                 page: 1
 *                 limit: 12
 *                 total: 0
 *                 totalPages: 0
 *       '400':
 *         description: Invalid pagination parameters or an unsafe offset.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               invalidPage:
 *                 value:
 *                   message: page must be a positive integer.
 *               invalidLimit:
 *                 value:
 *                   message: limit must be an integer between 1 and 100.
 *               unsafeOffset:
 *                 value:
 *                   message: The requested page is too large.
 *       '401':
 *         description: A supplied Authorization header or token is invalid.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '500':
 *         description: Database, response enrichment, or authentication service error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/', optionalAuthenticate, listTracks);

/**
 * @openapi
 * components:
 *   schemas:
 *     CreateStemInput:
 *       type: object
 *       additionalProperties: false
 *       required: [name, audioUrl, duration, fileSize]
 *       properties:
 *         name:
 *           type: string
 *           minLength: 1
 *           pattern: '\S'
 *           example: Drums
 *         audioUrl:
 *           type: string
 *           format: uri
 *           description: HTTPS URL for an existing audio file.
 *           example: 'https://example.invalid/audio/demo.mp3'
 *         duration:
 *           type: number
 *           minimum: 0
 *           exclusiveMinimum: true
 *           description: Positive finite duration in seconds.
 *           example: 30.125
 *         fileSize:
 *           type: integer
 *           minimum: 1
 *           maximum: 9007199254740991
 *           description: File size in bytes.
 *           example: 480000
 *     CreateTrackRequest:
 *       type: object
 *       additionalProperties: false
 *       required:
 *         - title
 *         - genre
 *         - bpm
 *         - key
 *         - isPublic
 *         - isDownloadable
 *         - stems
 *       properties:
 *         title:
 *           type: string
 *           minLength: 1
 *           pattern: '\S'
 *           example: Private demo
 *         genre:
 *           type: string
 *           minLength: 1
 *           pattern: '\S'
 *           example: Electronic
 *         bpm:
 *           type: number
 *           minimum: 0
 *           exclusiveMinimum: true
 *           description: Positive finite tempo in beats per minute.
 *           example: 128
 *         key:
 *           type: string
 *           minLength: 1
 *           pattern: '\S'
 *           example: Am
 *         tags:
 *           type: array
 *           default: []
 *           items:
 *             type: string
 *             minLength: 1
 *             pattern: '\S'
 *         coverImageUrl:
 *           type: string
 *           format: uri
 *           nullable: true
 *           default: null
 *           description: HTTPS cover URL, or null.
 *         description:
 *           type: string
 *           default: ''
 *         isPublic:
 *           type: boolean
 *           example: false
 *         isDownloadable:
 *           type: boolean
 *           example: false
 *         stems:
 *           type: array
 *           minItems: 1
 *           maxItems: 4
 *           items:
 *             $ref: '#/components/schemas/CreateStemInput'
 * /api/tracks:
 *   post:
 *     tags: [Tracks]
 *     summary: Create a track
 *     description: >-
 *       Requires authentication. The backend assigns the owner from the
 *       authenticated account, sets likesCount to zero, and generates IDs.
 *       Unsupported fields are rejected, including client-supplied owner,
 *       IDs, creation time, likes count, artist, and likedByMe.
 *       The response includes artist and likedByMe without storing them.
 *       Creation and response enrichment share one transaction. Enrichment
 *       failure rolls back the new Track; success is sent only after commit.
 *       Numbers and booleans must use
 *       their actual JSON types. This endpoint stores supplied metadata;
 *       audio upload is a separate endpoint, and supplied URLs are not verified.
 *       The example audio URL is a placeholder and cannot play audio.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateTrackRequest'
 *           example:
 *             title: Private demo
 *             genre: Electronic
 *             bpm: 128
 *             key: Am
 *             isPublic: false
 *             isDownloadable: false
 *             stems:
 *               - name: Drums
 *                 audioUrl: 'https://example.invalid/audio/demo.mp3'
 *                 duration: 30.125
 *                 fileSize: 480000
 *     responses:
 *       '201':
 *         description: Track created successfully.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TrackResponse'
 *       '400':
 *         description: Invalid JSON, metadata, or unsupported fields.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               invalidBpm:
 *                 value:
 *                   message: bpm must be a positive number.
 *               unsupportedFields:
 *                 value:
 *                   message: Request contains unsupported Track fields.
 *               invalidJson:
 *                 value:
 *                   message: Request body must contain valid JSON.
 *               modelValidation:
 *                 value:
 *                   message: Track data failed validation.
 *       '401':
 *         description: Missing, invalid, or expired credentials.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               missingCredentials:
 *                 value:
 *                   message: Authentication required.
 *               invalidToken:
 *                 value:
 *                   message: Invalid or expired access token.
 *       '413':
 *         description: JSON request body exceeds the allowed size.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Request body exceeds the allowed size.
 *       '500':
 *         description: Server or authentication service error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               internalError:
 *                 value:
 *                   message: Internal server error.
 *               authenticationError:
 *                 value:
 *                   message: Unable to authenticate. Please try again later.
 */
router.post('/', authenticate, createTrack);

/**
 * @openapi
 * components:
 *   schemas:
 *     TrackResponse:
 *       type: object
 *       required: [data]
 *       properties:
 *         data:
 *           $ref: '#/components/schemas/Track'
 * /api/tracks/{trackId}:
 *   get:
 *     tags: [Tracks]
 *     summary: Get an accessible track
 *     description: >-
 *       Guests can view public tracks. Authenticated users can also view
 *       their own private tracks. Missing and inaccessible tracks both
 *       return 404. If an Authorization header is supplied, it must
 *       contain a valid Bearer access token.
 *       The response includes public artist information (null for a missing
 *       author) and likedByMe for the current account, or false for guests.
 *       The Track/Stem contract is currently a draft.
 *     security:
 *       - {}
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         description: Track ID represented as a MongoDB ObjectId string.
 *         schema:
 *           type: string
 *           pattern: '^[a-fA-F0-9]{24}$'
 *           example: '507f1f77bcf86cd799439011'
 *     responses:
 *       '200':
 *         description: Accessible Track object.
 *         headers:
 *           Cache-Control:
 *             description: Prevents caching of the response.
 *             schema:
 *               type: string
 *               enum: [no-store]
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TrackResponse'
 *       '400':
 *         description: Invalid Track ID format.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: trackId must be a valid MongoDB ObjectId.
 *       '401':
 *         description: A supplied Authorization header or token is invalid.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               invalidHeader:
 *                 value:
 *                   message: Authentication required.
 *               invalidToken:
 *                 value:
 *                   message: Invalid or expired access token.
 *       '404':
 *         description: Track does not exist or is not accessible.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Track not found
 *       '500':
 *         description: Database, response enrichment, or authentication service error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:trackId', optionalAuthenticate, getTrack);

/**
 * @openapi
 * components:
 *   schemas:
 *     UpdateTrackRequest:
 *       type: object
 *       minProperties: 1
 *       additionalProperties: false
 *       properties:
 *         title:
 *           type: string
 *           minLength: 1
 *           pattern: '\S'
 *         genre:
 *           type: string
 *           minLength: 1
 *           pattern: '\S'
 *         bpm:
 *           type: number
 *           minimum: 0
 *           exclusiveMinimum: true
 *           description: Positive finite tempo in beats per minute.
 *         key:
 *           type: string
 *           minLength: 1
 *           pattern: '\S'
 *         tags:
 *           type: array
 *           description: Use an empty array to clear tags.
 *           items:
 *             type: string
 *             minLength: 1
 *             pattern: '\S'
 *         coverImageUrl:
 *           type: string
 *           format: uri
 *           nullable: true
 *           description: HTTPS cover URL, or null to remove it.
 *         description:
 *           type: string
 *           description: Use an empty string to clear the description.
 *         isPublic:
 *           type: boolean
 *         isDownloadable:
 *           type: boolean
 * /api/tracks/{trackId}:
 *   patch:
 *     tags: [Tracks]
 *     summary: Update owned Track metadata
 *     description: >-
 *       Requires authentication and ownership. Only supplied metadata
 *       fields are updated. Omitted fields remain unchanged.
 *       Track ID, owner, stems, likes count, creation time, and internal
 *       version fields cannot be changed through this endpoint.
 *       Response-only artist and likedByMe are also rejected as inputs.
 *       The response includes both derived fields without storing them.
 *       Metadata changes and response enrichment share one transaction;
 *       enrichment failure rolls back the update. Success follows commit.
 *       Missing Tracks and Tracks belonging to another owner both
 *       return 404. This operation does not create missing Tracks.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         description: Track ID represented as a MongoDB ObjectId string.
 *         schema:
 *           type: string
 *           pattern: '^[a-fA-F0-9]{24}$'
 *           example: '507f1f77bcf86cd799439011'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateTrackRequest'
 *           examples:
 *             renameOnly:
 *               summary: Update only the title
 *               value:
 *                 title: Updated title
 *             clearOptionalMetadata:
 *               summary: Clear optional metadata and disable downloads
 *               value:
 *                 coverImageUrl: null
 *                 description: ''
 *                 tags: []
 *                 isDownloadable: false
 *     responses:
 *       '200':
 *         description: Track after applying the supplied changes.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               enum: [no-store]
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TrackResponse'
 *       '400':
 *         description: Invalid ID, JSON, update metadata, or unsupported fields.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               invalidId:
 *                 value:
 *                   message: trackId must be a valid MongoDB ObjectId.
 *               emptyUpdate:
 *                 value:
 *                   message: At least one Track field must be provided.
 *               invalidBpm:
 *                 value:
 *                   message: bpm must be a positive number.
 *               unsupportedFields:
 *                 value:
 *                   message: Request contains unsupported Track fields.
 *       '401':
 *         description: Missing, invalid, or expired credentials.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               missingCredentials:
 *                 value:
 *                   message: Authentication required.
 *               invalidToken:
 *                 value:
 *                   message: Invalid or expired access token.
 *       '404':
 *         description: Track does not exist or belongs to another owner.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Track not found
 *       '413':
 *         description: JSON request body exceeds the allowed size.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Request body exceeds the allowed size.
 *       '500':
 *         description: Database or authentication service error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               internalError:
 *                 value:
 *                   message: Internal server error.
 *               authenticationError:
 *                 value:
 *                   message: Unable to authenticate. Please try again later.
 */
router.patch('/:trackId', authenticate, updateTrack);

/**
 * @openapi
 * /api/tracks/{trackId}:
 *   delete:
 *     tags: [Tracks]
 *     summary: Delete an owned Track
 *     description: |
 *       Requires authentication. Only the Track owner can delete it,
 *       whether the Track is public or private.
 *
 *       Deletes the Track document and its embedded stem metadata.
 *       Cascades all related Likes from every account in the same transaction.
 *       Track and Like deletion commit together; failure rolls back both.
 *       Files stored in Cloudinary are not removed.
 *
 *       A successful response has no body.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         description: MongoDB ObjectId of the Track.
 *         schema:
 *           type: string
 *           pattern: '^[a-fA-F0-9]{24}$'
 *           example: '507f1f77bcf86cd799439011'
 *     responses:
 *       '204':
 *         description: Track deleted successfully. No response body.
 *         headers:
 *           Cache-Control:
 *             schema:
 *               type: string
 *               example: no-store
 *       '400':
 *         description: Invalid Track ID.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: trackId must be a valid MongoDB ObjectId.
 *       '401':
 *         description: Missing, invalid, or expired access token.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               missingToken:
 *                 value:
 *                   message: Authentication required.
 *               invalidToken:
 *                 value:
 *                   message: Invalid or expired access token.
 *       '404':
 *         description: Track does not exist or belongs to another user.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Track not found
 *       '500':
 *         description: Internal server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               message: Internal server error.
 */
router.delete('/:trackId', authenticate, deleteTrack);

/**
 * @openapi
 * components:
 *   schemas:
 *     TrackLikeResponse:
 *       type: object
 *       required:
 *         - data
 *       properties:
 *         data:
 *           type: object
 *           required:
 *             - trackId
 *             - isLiked
 *             - likesCount
 *           properties:
 *             trackId:
 *               type: string
 *               pattern: '^[a-fA-F0-9]{24}$'
 *               example: '507f1f77bcf86cd799439011'
 *             isLiked:
 *               type: boolean
 *               description: Whether the authenticated account likes this Track.
 *             likesCount:
 *               type: integer
 *               minimum: 0
 *               description: Total number of likes across all accounts.
 *   parameters:
 *     TrackLikeTrackId:
 *       name: trackId
 *       in: path
 *       required: true
 *       description: MongoDB ObjectId of the Track.
 *       schema:
 *         type: string
 *         pattern: '^[a-fA-F0-9]{24}$'
 *   responses:
 *     TrackLikeBadRequest:
 *       description: The Track ID is invalid.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ErrorResponse'
 *           example:
 *             message: trackId must be a valid MongoDB ObjectId.
 *     TrackLikeUnauthorized:
 *       description: Authentication is missing, invalid, or expired.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ErrorResponse'
 *           example:
 *             message: Authentication required.
 *     TrackLikeNotFound:
 *       description: The Track does not exist or is private and owned by another account.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ErrorResponse'
 *           example:
 *             message: Track not found
 *     TrackLikeServerError:
 *       description: An internal error prevented the operation.
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ErrorResponse'
 *           example:
 *             message: Internal server error.
 *
 * /api/tracks/{trackId}/like:
 *   parameters:
 *     - $ref: '#/components/parameters/TrackLikeTrackId'
 *   get:
 *     tags:
 *       - Tracks
 *     summary: Get the current account's Like state
 *     description: |
 *       Requires authentication. Available for public Tracks and private
 *       Tracks owned by the authenticated account.
 *       Returns the account's Like state and the total likes count
 *       from one transaction snapshot.
 *       Responses use Cache-Control no-store.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: The current Like state.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TrackLikeResponse'
 *             example:
 *               data:
 *                 trackId: '507f1f77bcf86cd799439011'
 *                 isLiked: false
 *                 likesCount: 2
 *       '400':
 *         $ref: '#/components/responses/TrackLikeBadRequest'
 *       '401':
 *         $ref: '#/components/responses/TrackLikeUnauthorized'
 *       '404':
 *         $ref: '#/components/responses/TrackLikeNotFound'
 *       '500':
 *         $ref: '#/components/responses/TrackLikeServerError'
 *   put:
 *     tags:
 *       - Tracks
 *     summary: Like a Track
 *     description: |
 *       Requires authentication. Available for public Tracks and private
 *       Tracks owned by the authenticated account.
 *       No request body is required.
 *       Repeated requests from the same account do not add more likes.
 *       The Like record and total count are updated in one transaction.
 *       Responses use Cache-Control no-store.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: The account likes the Track, including when it already did.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TrackLikeResponse'
 *             example:
 *               data:
 *                 trackId: '507f1f77bcf86cd799439011'
 *                 isLiked: true
 *                 likesCount: 3
 *       '400':
 *         $ref: '#/components/responses/TrackLikeBadRequest'
 *       '401':
 *         $ref: '#/components/responses/TrackLikeUnauthorized'
 *       '404':
 *         $ref: '#/components/responses/TrackLikeNotFound'
 *       '500':
 *         $ref: '#/components/responses/TrackLikeServerError'
 *   delete:
 *     tags:
 *       - Tracks
 *     summary: Unlike a Track
 *     description: |
 *       Requires authentication. Available for public Tracks and private
 *       Tracks owned by the authenticated account.
 *       No request body is required.
 *       Removes only the authenticated account's Like.
 *       Repeated requests do not decrease the count again.
 *       The Like record and total count are updated in one transaction.
 *       Returns HTTP 200 with the resulting Like state.
 *       Responses use Cache-Control no-store.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: The account does not like the Track, including when it already did not.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TrackLikeResponse'
 *             example:
 *               data:
 *                 trackId: '507f1f77bcf86cd799439011'
 *                 isLiked: false
 *                 likesCount: 2
 *       '400':
 *         $ref: '#/components/responses/TrackLikeBadRequest'
 *       '401':
 *         $ref: '#/components/responses/TrackLikeUnauthorized'
 *       '404':
 *         $ref: '#/components/responses/TrackLikeNotFound'
 *       '500':
 *         $ref: '#/components/responses/TrackLikeServerError'
 */
router.get('/:trackId/like', authenticate, getTrackLike);
router.put('/:trackId/like', authenticate, likeTrack);
router.delete('/:trackId/like', authenticate, unlikeTrack);

module.exports = router;
