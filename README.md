# StemForge Server

Backend API for the StemForge group project, built with Node.js,
Express, Mongoose, and MongoDB Atlas.

## Current functionality

- Health endpoint: `GET /api/health`
- MongoDB Atlas connection before API startup
- Environment configuration validation
- Configurable frontend origin for CORS
- Optional DNS resolver configuration

- JWT authentication, ownership-aware Track CRUD, and public pagination
- Authenticated audio uploads and transactional Like/Unlike with cascade deletion
- Track responses with public artist information and current-user likedByMe

Search/filtering, realtime features, and audio/stem replacement remain pending.

## Requirements

- Node.js 24
- npm
- A MongoDB Atlas database user and an allowed network address

## Local setup

```powershell
git clone https://github.com/nguyenntkpvnm21/stemforge-server.git
cd stemforge-server
npm.cmd ci
Copy-Item .env.example .env
```

Fill in `.env` before starting the server:

| Variable | Purpose |
|---|---|
| `PORT` | Local API port, normally `5000` |
| `FRONTEND_URL` | Allowed frontend origin |
| `MONGO_URI` | MongoDB URI with database name and no embedded credentials |
| `MONGO_USERNAME` | Database username |
| `MONGO_PASSWORD` | Database password |
| `DNS_SERVERS` | Optional comma-separated DNS server addresses |

Atlas must allow the development machine's public IP address.
The database user needs `readWrite` access to the `stemforge` database.

```powershell
npm.cmd run dev
```

Open `http://localhost:5000/api/health`.

Expected response:

```json
{"status":"ok","service":"stemforge-server"}
```

Keep `.env` private. Commit only `.env.example` with empty credential fields.

## Render deployment

| Setting | Value |
|---|---|
| Service type | Web Service |
| Branch | `main` |
| Region | Singapore |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Node version | `NODE_VERSION=24` |
| Runtime mode | `NODE_ENV=production` |

Set the MongoDB credentials and `FRONTEND_URL` in Render's environment
settings. Render provides `PORT` automatically.

Allow the service's outbound IP ranges in MongoDB Atlas.
Leave `DNS_SERVERS` unset unless the deployment environment needs it.

API URL: https://stemforge-server.onrender.com

Health endpoint: https://stemforge-server.onrender.com/api/health

## Git workflow

- `main`: stable versions used for deployment
- `dev`: integration branch
- `feature/*`: feature development
- `docs/*`: documentation changes

Create pull requests into `dev`. Promote verified versions from
`dev` to `main`.

## Cloudinary configuration and upload check

Set these variables in your local `.env`:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Keep real credentials out of `.env.example` and Git.

To verify audio upload, run from the repository root:

```powershell
node .\scripts\check-cloudinary-upload.js "C:\path\audio.mp3"
```

The script accepts a local MP3 or WAV file up to 5 MiB.
This limit applies only to the diagnostic script.

Each run uploads a new test asset and prints its public ID,
HTTPS URL, duration in seconds, and size in bytes.
Open the returned URL to check playback.

The initial audio delivery check confirmed HTTP Range support:
the CDN returned `206 Partial Content` for a partial file request.

## API documentation

Swagger UI is available at `/api-docs/`.

For local development:
1. Run `npm run dev`.
2. Open http://localhost:5000/api-docs/.
3. Expand `GET /api/health`, select **Try it out**, then **Execute**.

For the deployed service, append `/api-docs/` to the Render base URL.

The documentation covers health, authentication, Tracks, audio uploads, and Likes.
The health endpoint returns the API status and does not actively check
external services.

## Authentication

Set `JWT_SECRET` in the local `.env` file to a cryptographically random
secret. Keep its value blank in `.env.example` and configure the real
secret separately on Render.

| Method | Endpoint | Authentication |
| --- | --- | --- |
| POST | `/api/auth/register` | Public |
| POST | `/api/auth/login` | Public |
| GET | `/api/auth/me` | Bearer access token |

Registration and login return `{ data: { user, accessToken } }`.
The current-account endpoint returns `{ data: { user } }`.
Responses do not include `passwordHash`.

Access tokens expire after one hour. Log in again to obtain a new token.
For protected requests, send `Authorization: Bearer <accessToken>`.

Registration always creates a `user` account. Client-supplied role
values are ignored.

Registration and login share a limit of 20 requests per IP within
15 minutes, including successful and unsuccessful requests.
Exceeding the limit returns HTTP 429 with a `Retry-After` header.
Counters are stored in process memory and reset when the server restarts.

To test authentication in Swagger UI:
1. Execute `POST /api/auth/login` with an existing account.
2. Copy the returned access token.
3. Select **Authorize** and paste only the token.
4. Execute `GET /api/auth/me`.

### Proxy configuration

| Environment | TRUST_PROXY_HOPS | PROXY_DEBUG |
| --- | --- | --- |
| Local development without a reverse proxy | 0 | false |
| Current Render deployment | 3 | false |

The Render proxy configuration was verified on October 13, 2026.
The API client IP matched the IP reported by Cloudflare's trace endpoint
on the same service domain.

Re-verify the trusted hop count if the hosting environment or proxy
topology changes.

Set PROXY_DEBUG=true temporarily to log the effective proxy setting,
client IP, socket IP, and forwarded IP chain for authentication requests.
Disable it after troubleshooting. These diagnostics do not log request
bodies, passwords, or access tokens.

### Production verification

The following checks passed on Render:

- Swagger login and authenticated account retrieval returned 200.
- Authentication requests reached the shared limit of 20 requests per
  client IP within 15 minutes.
- Requests exceeding the limit returned 429 with a Retry-After header
  and the documented JSON error message.
- A client-supplied X-Forwarded-For value did not change the detected
  client IP or bypass the active rate limit.
- The health endpoint returned 200 after proxy diagnostics were disabled.

The rate limiter uses an in-memory store. Its counters reset when the
server process restarts.

## Error responses

The error middleware returns JSON responses with a `message` field.

| Error | HTTP status | Message |
| --- | --- | --- |
| Malformed JSON request body | 400 | Request body must contain valid JSON. |
| JSON request body exceeds the parser size limit | 413 | Request body exceeds the allowed size. |
| Unhandled server error | 500 | Internal server error. |

Other client errors reaching the middleware retain their HTTP status
and return the generic message `Invalid request.`

Unhandled server errors return a generic response without internal error
details or stack traces.

## Track and Stem models (draft)

The models implement the proposed Track/Stem contract while teammate
review is pending.

A Track embeds 1–4 Stem subdocuments and preserves their array order.
Each stem has a stable ObjectId stored as `stemId`. A new ID is generated
when one is not supplied, and duplicate stem IDs within a track are rejected.

Model rules:
- Title, genre, and musical key must be non-empty strings.
- BPM and stem duration must be positive finite numbers.
- Stem file size must be a positive integer in bytes.
- Audio URLs must use HTTPS.
- Cover image URL defaults to null; a supplied URL must use HTTPS.
- Tags default to an empty array and description defaults to an empty string.
- Visibility and download flags require explicit boolean values.
- Likes count defaults to zero and must be a non-negative integer.
- Track creation time is stored as `createdAt`.
- Public JSON omits the internal version field `__v`.

Model validation runs after Mongoose casting. The API layer will validate
request input types, assign the authenticated owner, and enforce ownership.

### Model tests

Run:

```sh
npm run test:models
```

The 20 tests cover the contract sample, JSON serialization, defaults,
stem-count boundaries, generated IDs, and invalid metadata.

Tests run in memory without connecting to MongoDB or uploading audio.
The fixture is a snapshot of the current draft contract and should be
updated alongside agreed contract changes.

## Public Track list API

GET /api/tracks

This endpoint lists public tracks without requiring authentication.
Optional Bearer authentication supplies current-user Like state. A supplied
invalid/expired token or malformed header returns 401, as on Track detail.
Results are ordered by `createdAt` descending, then `_id` descending
to keep ordering consistent when creation timestamps are equal.

Query parameters:
- `page`: positive integer, default 1.
- `limit`: integer from 1 to 100, default 12.

Example:

```text
GET /api/tracks?page=2&limit=5
```

Successful responses use this structure:

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 12,
    "total": 0,
    "totalPages": 0
  }
}
```

`total` counts public tracks only. When no public tracks exist,
`totalPages` is zero. A page beyond the available results returns
an empty `data` array.

Invalid pagination parameters return HTTP 400 with a readable
`message`. Database errors are forwarded to the error middleware.
Responses include `Cache-Control: no-store`.

Track listing, detail, creation, metadata updates, owner-only deletion,
audio uploads, and authenticated likes are implemented.

Audio/stem replacement is pending.

The [Track/Stem data contract](docs/data-contract.md) remains a draft awaiting
Phuc's final review of the artist/likedByMe additions and missing-author policy.

### Derived Track response fields

List, detail, POST, and PATCH responses retain artistId and all existing Track
fields, and add:

```json
{
  "artist": {
    "_id": "507f1f77bcf86cd799439012",
    "username": "demo_composer",
    "avatarUrl": null
  },
  "likedByMe": false
}
```

artist exposes only these three public User fields. If the author no longer
exists, artist is null and artistId remains unchanged; the accessible Track stays
in results. Frontend acceptance of this fallback is pending. Database errors
remain errors rather than silently appearing as missing authors or false Likes.
likedByMe reflects the authenticated user's membership, and is false for guests.
Both additions are response-only: never persisted in Track or accepted by
POST/PATCH. The model test fixture intentionally remains the stored Track shape;
the [contract JSON](docs/data-contract.json) illustrates the enriched API response.

For a nonempty list page, authors are fetched once for distinct owner IDs and
memberships at most once for the current account and page Track IDs. Guests skip
the membership lookup; empty pages skip both lookups. Public listing still excludes
private Tracks, including an authenticated owner's private Tracks. All Track
responses use Cache-Control: no-store. List/detail counters and membership are
separate reads. POST/PATCH run the write and enrichment in one transaction with
the same session; author/membership lookups execute sequentially there. Enrichment
errors abort the write rather than substituting artist=null or likedByMe=false;
success is sent only after commit. A genuinely missing author still yields null.
The dedicated Like endpoint keeps its snapshot and isLiked/likesCount unchanged.

### Track tests

```sh
npm run test:tracks
```

Run the Track Like model, service, and controller tests:

```powershell
npm run test:likes
```

Track tests include models, input validation, controller access rules, deletion,
response enrichment, real-router optional authentication, and Swagger consistency.
Audio upload tests: `npm run test:uploads`.

| Suite | Tests |
| --- | --- |
| Tracks | 170 |
| Audio uploads | 59 |
| Likes | 51 |
| Local recovery runner | 26 |
| Total | 306 |

Controller tests cover public-query filters, sorting, pagination,
invalid parameters, and forwarding database errors.
Database queries are mocked; route tests use an ephemeral local HTTP server.
These tests do not connect to MongoDB or upload audio.

### Real MongoDB and local HTTP verification

For response/authentication regression checks against the configured database:

```powershell
node scripts/check-local-track-responses.js
node scripts/check-local-track-responses.js --run
```

The default is a read-only DB preflight. `--run` starts the current Express app
on an ephemeral loopback port, creates uniquely marked disposable accounts and
Tracks, verifies artist/likedByMe over HTTP, then cleans up only those fixtures.
It uses private .env configuration, honors DNS_SERVERS, keeps tokens in memory,
and records only nonsecret IDs/counts/results under docs/verification. Audio URLs
are placeholders; this does not upload assets or test Render. The runner closes
its HTTP server and disconnects MongoDB in finally. It also compares preexisting
User/Track/Like fingerprints, including the protected main account, before/after.

Generated `sf-context-*.json` and `sf-write-rollback-*.json` reports in
docs/verification are ignored by Git and retained locally for recovery/audit.
Keep an interrupted run's manifest until cleanup is verified. The versioned
[project status](docs/PROJECT_STATUS.md#postpatch-enrichment-rollback-correction-october-18-2026)
summarizes the actual 306-test, Atlas/HTTP, rollback, and recovery results without
requiring those local reports. Render verification for this feature is pending.

If a run is interrupted, retain its manifest and recover with
`node scripts/check-local-track-responses.js --cleanup <manifest-path>`.
Recovery validates exact marker/account/owner identities; do not edit a manifest
to include unrelated records. This opt-in runner is separate from mock DB tests.

Verification and recovery are independent: verification can pass only after all
10 distinct expected groups pass. `--cleanup` never promotes incomplete/failed
verification, changes the original verification completion time, or reruns those
checks. It records cleanup/preservation and lastRecovery separately; exit 0 from
`--cleanup` means recovery succeeded, not that feature verification passed.
Legacy manifests are migrated conservatively; an unsupported old passed verdict
is downgraded if the required groups are missing.

If a recorded Track is already gone, recovery can remove orphan Likes restricted
to that fixture Track ID and the recorded fixture account IDs, in a transaction.
Foreign/main-account Likes cause refusal without deletion. Existing Tracks still
require matching owner and marker. Focused offline regression tests for these
rules: `npm run test:local-recovery` (26 tests; no .env or database access).

## Track detail API

GET /api/tracks/:trackId

Returns an accessible Track object wrapped in `data`.

Access rules:
- Guests can view public tracks.
- Authenticated users can view public tracks and their own private tracks.
- Private tracks belonging to another owner are not accessible.
- Missing and inaccessible tracks both return HTTP 404.

Authentication is optional when no Authorization header is supplied.
If a header is supplied, it must contain a valid Bearer access token.

Responses:
- 200: Track returned in `data`.
- 400: Track ID is not a 24-character hexadecimal ObjectId.
- 401: Authorization header or access token is invalid or expired.
- 404: Track not found or not accessible.

Responses include `Cache-Control: no-store`.
Database query errors are forwarded to the error middleware.

Validation:
- Nine detail-controller tests cover responses, access-query filters,
  invalid IDs, and forwarding database errors.
- Local API checks with temporary Atlas records verified public access,
  owner access to private tracks, and rejection of unauthorized access.
- The public list excluded both private check tracks.
- Temporary records and setup files were removed after verification.

## Track creation API

POST /api/tracks

Requires a valid Bearer access token and a JSON request body.

Required fields:
- `title`, `genre`, and `key`: non-empty strings.
- `bpm`: positive finite number.
- `isPublic` and `isDownloadable`: explicit booleans.
- `stems`: an array containing 1–4 stem objects.

Each stem requires:
- `name`: non-empty string.
- `audioUrl`: HTTPS URL.
- `duration`: positive finite number in seconds.
- `fileSize`: positive safe integer in bytes.

Optional fields:
- `tags`: array of non-empty strings; defaults to an empty array.
- `coverImageUrl`: HTTPS URL or null; defaults to null.
- `description`: string; defaults to an empty string.

Input types are checked before Mongoose casting. Numeric strings
and string booleans are rejected.

The backend assigns `artistId` from the authenticated account,
sets `likesCount` to zero, and generates Track and Stem IDs.

Client-supplied `_id`, `artistId`, `likesCount`, `createdAt`,
`stemId`, and other unsupported fields are rejected.

Example request:

```json
{
  "title": "Private demo",
  "genre": "Electronic",
  "bpm": 128,
  "key": "Am",
  "isPublic": false,
  "isDownloadable": false,
  "stems": [
    {
      "name": "Drums",
      "audioUrl": "https://example.invalid/audio/demo.mp3",
      "duration": 30.125,
      "fileSize": 480000
    }
  ]
}
```

The example audio URL is a placeholder and cannot play audio.

A successful request returns HTTP 201 with the saved Track object
wrapped in `data`. Invalid metadata returns HTTP 400.
Missing or invalid credentials return HTTP 401.
Oversized JSON bodies return HTTP 413.

The endpoint stores supplied audio metadata. Audio upload uses its separate
endpoint; Track creation does not verify the origin of supplied URLs.

Validation:
- Creation tests verify input types, server-managed fields,
  ownership assignment, responses, and error handling.
- Local checks against Atlas verified creation, generated IDs,
  defaults, private access, and rejection of invalid requests.
- The temporary Track and response file were removed after testing.

## Track metadata update API

PATCH /api/tracks/:trackId

Requires a valid Bearer access token. Only the owner can update
a Track, whether it is public or private.

Updates only the supplied fields:
- `title`, `genre`, and `key`: non-empty strings.
- `bpm`: positive finite number.
- `tags`: array of non-empty strings.
- `coverImageUrl`: HTTPS URL or null.
- `description`: string.
- `isPublic` and `isDownloadable`: booleans.

At least one supported field must be supplied. Input types are
validated before Mongoose casting.

Example request:

```json
{
  "title": "Updated title",
  "isDownloadable": false
}
```

Fields omitted from the request remain unchanged.
Use null to remove the cover URL, an empty string to clear the
description, and an empty array to clear tags.

Track ID, owner, stems, likes count, creation time, and internal
version fields cannot be changed through this endpoint.
Unsupported fields and database update operators are rejected.

Responses:
- 200: Updated Track object wrapped in `data`.
- 400: Invalid ID, empty update, invalid metadata, or unsupported fields.
- 401: Missing, invalid, or expired credentials.
- 404: Track does not exist or belongs to another owner.
- 413: JSON request body exceeds the allowed size.

The ownership condition is included in the database update query.
Updates run model validation and do not create missing Tracks.
Responses include `Cache-Control: no-store`.

Validation:
- Update tests cover partial input, forbidden fields, ownership
  filters, responses, and error handling.
- Local Atlas checks verified title-only updates and clearing
  optional metadata while preserving all other response fields.
- Rejected requests left the owned Track unchanged.
- Updating a foreign-owner Track returned 404 and left it unchanged.
- Both temporary Tracks and all local check files were removed.

### Delete a Track

DELETE /api/tracks/:trackId

Requires a valid Bearer access token. Only the Track owner can delete it,
whether the Track is public or private.

No request body is required.

Responses:
- 204: Track deleted successfully. The response has no body.
- 400: Invalid Track ID.
- 401: Missing, invalid, or expired authentication.
- 404: Track does not exist or does not belong to the authenticated user.
- 500: Internal server error.

Responses use Cache-Control: no-store.

After a successful deletion, the frontend must handle HTTP 204 without
attempting to parse a JSON response.

Deletion removes the Track document and its embedded stem metadata.
It does not remove files from Cloudinary.

### Upload audio

POST /api/uploads/audio

Requires a valid Bearer access token.

Send multipart/form-data containing exactly one file in the audio field.
No additional form fields are accepted.

Supported formats: MP3, WAV, FLAC.
Maximum file size: 20 MiB (20,971,520 bytes).

The server checks the filename and MIME type, then validates the format
and metadata returned by Cloudinary.

Rate limit: 10 authenticated requests per account per 15 minutes.
Failed requests after authentication also count toward this limit.
The current rate limiter stores counters in server memory.

Responses:
- 201: Audio uploaded successfully.
- 400: Missing, empty, or invalid multipart input.
- 401: Missing, invalid, or expired authentication.
- 413: File exceeds the size limit.
- 415: Unsupported Content-Type or invalid audio.
- 429: Upload request limit exceeded.
- 500: Unexpected internal error.
- 502: Audio storage or upload processing failed.

Successful responses contain data.audioUrl, data.duration,
data.fileSize, and data.publicId.

Duration and file size come from Cloudinary.
Responses use Cache-Control: no-store.

Uploading audio does not create a Track.
Use audioUrl, duration, and fileSize in a stem when creating a Track.
Do not include publicId in the Track creation request.

Cloudinary URLs currently use public delivery.
Track isPublic controls Track API visibility.

Deleting a Track does not automatically delete its Cloudinary files.

## Track Likes

All Track Like endpoints require a valid Bearer access token.

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/tracks/:trackId/like` | Get the current account's Like state and total likes count. |
| PUT | `/api/tracks/:trackId/like` | Like a Track. Repeated requests do not add more likes. |
| DELETE | `/api/tracks/:trackId/like` | Remove the current account's Like. Repeated requests do not decrease the count again. |

These endpoints accept a Track ID in the path and require no request body.
They are available for public Tracks and private Tracks owned by the
authenticated account. Another account's private Track returns HTTP 404.

All three endpoints return HTTP 200 on success:

```json
{
  "data": {
    "trackId": "507f1f77bcf86cd799439011",
    "isLiked": true,
    "likesCount": 3
  }
}
```

`isLiked` describes the authenticated account's Like state.
`likesCount` is the total across all accounts.

Invalid Track IDs return HTTP 400. Missing, invalid, or expired access
tokens return HTTP 401. Missing or inaccessible Tracks return HTTP 404.
Responses use `Cache-Control: no-store`.

### Consistency and Track deletion

A unique compound index on `trackId` and `userId` prevents duplicate Likes
from the same account. Server startup waits for TrackLike indexes to be ready.

Like and Unlike update the Like record and Track counter in one MongoDB
transaction. The database must support transactions, as MongoDB Atlas does.
The Like state and total count are read from one transaction snapshot.

Owner-only Track deletion removes the Track and all associated Like records
in one transaction. Successful Track deletion returns HTTP 204 with no body.

Track deletion does not remove Cloudinary audio assets. Automatic cleanup
of uploaded audio assets is pending.
