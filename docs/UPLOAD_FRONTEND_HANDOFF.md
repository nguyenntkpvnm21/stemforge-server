# Frontend upload handoff

Updated November 12, 2026 (Asia/Saigon). **MVP choice agreed by Phuc according to
his reply supplied by Nguyen: 1-4 stems through separate single-file requests,
at most two uploads in flight, then one Track. PR #6 implementation/preview
acceptance remains pending. Backend behavior was compared with source.** This
limited agreement does not approve every reported retry rule, or the overall
Track/Stem and realtime contracts.
The overall Track/Stem and realtime contracts remain **Draft**.

Source reviewed: backend `dev` at
`50315205ef143a5d70b486931f6bba4cadc5ff59` (PR #53). The fetched `main` release is
`f9692e93cc359ea37410d451bf3758df584adb16` (PR #54), with the same tracked tree.
These Git references were checked after fetch; they do not prove the current
Render deployment. Previously supplied acceptance evidence and older results
cited below are separate from this source/documentation review. No new live
check was made for it. See [project status](PROJECT_STATUS.md#release-and-integration-checkpoint-november-12-2026).

API base: `https://stemforge-server.onrender.com`.
Swagger UI: `https://stemforge-server.onrender.com/api-docs/`.
Swagger definitions are generated from the checked-in routes; no separate
`/swagger.json` endpoint is promised.

## 1. Existing API: authentication and reads

| Request | Existing behavior |
| --- | --- |
| `POST /api/auth/register` | `201 {data: {user, accessToken}}`; the client can establish the session immediately. |
| `POST /api/auth/login` | `200 {data: {user, accessToken}}`. |
| `GET /api/auth/me` | Bearer token required; `200 {data: {user}}`. |
| `GET /api/tracks/mine?page=1&limit=12` | Bearer token required; only the current owner's public/private Tracks. Supports only `page` and `limit`, limit 1-100. Returns `{data: [...], pagination: {page, limit, total, totalPages}}`. |
| `GET /api/tracks/:trackId` | `{data: Track}`; public Tracks are readable by guests, private Tracks by their owner. Unavailable/unauthorized private Tracks return 404. |

Use `Authorization: Bearer <accessToken>` for protected API calls. The current
JWT lifetime is one hour. Sign out is client session removal, not a new logout
endpoint. The supplied handoff refers to Auth race protections in frontend PR #4;
that frontend source was not inspected in this backend review. An old request's
401 must not clear a newer account's token. Do not send the API Bearer
token to Cloudinary/audio URLs.

## 2. Existing API: upload one file

`POST /api/uploads/audio`, Bearer token required.

- Send `FormData` with exactly one file named **`audio`**, including its filename.
  The browser must set the multipart `Content-Type` and boundary; do not set it
  to JSON or a boundary-less multipart string in the shared API helper.
- No other multipart fields are accepted, including a stem name, index or owner.
  Keep those in the local draft and associate the response with a stable slot ID.
- MP3/WAV/FLAC, up to **20 MiB = 20,971,520 bytes per file**. The server checks
  filename/MIME and the provider's resulting format and metadata. A client-side
  extension check alone does not establish that a file is valid audio.
- **10 authenticated upload attempts/account/15 minutes**, including failed
  authenticated requests. Four initial uploads plus retries share this budget.
  The limiter is process-local/in-memory, not an account storage quota.
- Success: `201 {data: {audioUrl, duration, fileSize, publicId}}`.
  `duration` is seconds; `fileSize` is bytes. Both come from the provider response.
  Use these returned values, rather than estimated browser metadata.
- Upload does not create a Track. This endpoint has no idempotency/replay or
  operation-status API. Aborting the browser request does not prove that the
  provider did not save an asset.

| Upload result | Client interpretation / proposed handling |
| --- | --- |
| 201 | Save that slot's result under the current owner/draft. Preserve it when a different slot fails. |
| 400 | Correct missing/empty/extra/malformed multipart input. |
| 401 | Pause; reauthenticate the same owner before resuming that draft. |
| 413 / 415 | Select a smaller/supported valid file; retry only the affected slot. |
| 429 | Pause the queue and honor `Retry-After` seconds. A countdown may resume the queue after the delay, still with at most two uploads in flight. Repeated 429s must pause again; never start duplicate workers or retry before the delay. |
| 500 / 502 / connection loss | Report failure or an unknown upload outcome. An explicit retry may create another asset; it is not protected by the Track creation key. |

All API error bodies use `{message: string}`. Provider failures are mapped to
sanitized messages. The provider upload timeout is not a guarantee that an HTTP
client timeout means no asset was created.

## 3. Existing API: create one Track

`POST /api/tracks`, Bearer token and `Content-Type: application/json`.

| Field | Existing validation |
| --- | --- |
| `title`, `genre`, `key` | Required non-empty strings; genre/key have no fixed server enum. |
| `bpm` | Required positive finite JSON number, not a numeric string. |
| `isPublic`, `isDownloadable` | Required JSON booleans, not strings. |
| `stems` | Required array of 1-4 objects, stored in the submitted order. |
| Each stem | Exactly `name` (non-empty string), `audioUrl` (HTTPS URL), `duration` (positive finite seconds), `fileSize` (positive safe integer bytes). |
| `tags` | Optional array of non-empty strings, default `[]`. |
| `coverImageUrl` | Optional HTTPS URL or null, default null. No cover-upload API is provided. |
| `description` | Optional string, default `""`. |

Do **not** send upload `publicId`, local slot IDs, `stemId`, `_id`, `artistId`,
`likesCount`, `artist`, `likedByMe`, or `createdAt`. Unsupported fields are 400.
Do not spread the whole upload response into StemInput.

The server assigns ownership and Track/stem IDs. Names such as Drums/Bass/Chords/
Lead are examples, not mandatory roles or a four-file requirement. The API does
not enforce equal stem durations or a shared BPM/key across uploaded files.

Illustrative four-stem payload (URLs and metadata below are placeholders, not
playable assets). Replace every slot's audioUrl/duration/fileSize with its own
successful upload response before sending:

```json
{
  "title": "Four-stem draft",
  "genre": "Electronic",
  "bpm": 96,
  "key": "Am",
  "tags": ["upload-example"],
  "coverImageUrl": null,
  "description": "Example only; replace upload metadata before publishing.",
  "isPublic": false,
  "isDownloadable": false,
  "stems": [
    { "name": "Drums", "audioUrl": "https://example.invalid/drums.wav", "duration": 20, "fileSize": 3528044 },
    { "name": "Bass", "audioUrl": "https://example.invalid/bass.wav", "duration": 20, "fileSize": 3528044 },
    { "name": "Chords", "audioUrl": "https://example.invalid/chords.wav", "duration": 20, "fileSize": 3528044 },
    { "name": "Lead", "audioUrl": "https://example.invalid/lead.wav", "duration": 20, "fileSize": 3528044 }
  ]
}
```

Success: `201 {data: Track}` with server-generated `_id`, ordered `stems[].stemId`,
`artistId`, initial `likesCount: 0`, `artist` (public fields or null), and
`likedByMe`. Use the returned Track ID for navigation and stemId for mixer identity.
Read detail again for current state when recovering a replayed creation receipt.

## 4. Existing API: Track creation recovery

The optional **`Idempotency-Key` applies only to POST /api/tracks**. It does not
make uploads idempotent. The agreed frontend MVP should send one UUID per
publish intent, scoped locally to the owner, and freeze the key and exact parsed
JSON payload for retries. The server accepts a single case-sensitive ASCII value
of 16-128 characters from `A-Za-z0-9._:-`.

| Create result | Existing semantics / proposed handling |
| --- | --- |
| 201, `Idempotency-Replayed: false` | Committed new Track. Save its ID and finish the publish intent. |
| 201, replayed `true` | Same original serialized receipt, Track ID and stemIds. Do not create another Track. |
| 400 / 401 / 413 | This request's invalid input/auth does not consume a key. Correct a confirmed validation failure or sign in as the same owner; do not reupload successful slots or discard an earlier unresolved publish intent. |
| 409 with `Retry-After` | Same-key contention is unresolved; wait and retry the same key/payload with bounded retries. |
| 409 without `Retry-After`, payload-mismatch message | Stop and reconcile the draft/key. Generating a new key automatically would bypass duplicate protection. |
| 503, connection loss, timeout, or other uncertain failure | Keep outcome unknown and keep the same key/payload. Retry/reconcile that operation; neither an empty My Tracks list nor a client timeout proves rollback. |

`Idempotency-Key-Expires-At` gives the receipt expiry. Retention is 24 hours from
recorded completion and is not extended by replay. After expiry the same key
**can create a new Track**; an unresolved older intent needs reconciliation, not
an automatic fresh key or post-expiry retry. Do not infer a receipt expiry from
the time at which the browser timed out.

Object property order/JSON formatting do not change the server payload hash;
array order, string whitespace/case, and explicit versus omitted defaults do.
While an intent is unknown, do not edit/reorder the frozen payload and silently
retry it. Replay remains the original creation receipt even after PATCH/Like/
DELETE; it does not recreate a deleted Track. Full semantics and expiry limits:
[Track creation idempotency](TRACK_CREATE_IDEMPOTENCY.md).

## 5. Existing CORS and asset boundaries

REST and Socket.IO share an exact origin allowlist. Preserve `FRONTEND_URL` as
one origin; `ADDITIONAL_FRONTEND_ORIGINS` is comma-separated exact origins. No
wildcards, including Vercel branch patterns. Keep existing entries when adding a
new Upload branch preview; the same API base does not imply that every frontend
preview origin is allowed.

For JSON publish, preflight must permit `Authorization`, `Content-Type`, and
`Idempotency-Key`. The REST middleware reflects requested header names and exposes
`Idempotency-Replayed`, `Idempotency-Key-Expires-At`, and `Retry-After`. It does not
enable cookie credentials. Timeout without an HTTP response is not CORS proof.

Track private access protects the Track API, **not an already known public CDN
audio URL**. `isDownloadable` is metadata, not enforced byte-access protection.
There is no general upload ownership/reference ledger, safe asset-release API,
or orphan cleanup job. POST stores supplied HTTPS URLs/metadata without proving
that they belong to an upload by that owner. Track rollback/DELETE does not delete
previous successful Cloudinary uploads. Do not promise automatic orphan cleanup,
protected CDN delivery, or later stem replacement in the Upload form.

The backend does attempt cleanup of its own generated asset ID when a completed
provider result fails validation. That per-attempt rejected-result cleanup does
not provide a general release API for successful uploads or resolve an unknown
provider outcome after connection loss.

## 6. Agreed MVP choice and remaining review

Nguyen supplied Phuc's agreement to option A and the bounded two-request queue,
plus his report of frontend PR #6 (base dev, short SHA `8bd80b3`). The backend
endpoints above are implemented; the following describe the agreed direction
and recovery requirements. Implementation correctness and preview acceptance are
still to be checked. This is not a new batch endpoint, full contract approval,
or a reassignment of frontend code to Nguyen:

1. One form selects 1-4 files; each slot has a stable local identity, editable
   name and display order. Names/order are never inferred from completion order.
2. At most **two** single-file upload requests in flight. Block publish until all
   selected slots have valid successful results; keep successes and retry only
   failed slots. Replacing a slot clears that slot's old result, not other slots.
3. Freeze a publish intent/key/body and block duplicate submit. Once the outcome
   is unknown, expose recovery for that intent instead of allowing a blind new POST.
4. Invalidate/cancel local work on owner change or sign out and ignore stale
   callbacks. Do not apply owner A's draft/results to B. Browser cancellation is
   not an asset deletion or server rollback guarantee. Confirm how same-owner
   re-login and page reload recover a draft; no durable client recovery is claimed.
5. Phuc owns Upload UI/integration; Nguyen owns API correctness/documentation and
   backend verification under the existing division of work. Agree any reassignment
   separately. The two-request concurrency choice is agreed; confirm draft reload
   recovery and visibility/download wording. Track/Stem and realtime approval
   remain outstanding.

### PR #6 report and focused acceptance still needed

Phuc reports slot add/name/reorder/remove, Track metadata, per-slot states/retry,
retention of successful uploads, a 429 countdown/resume, and navigation to
`#/tracks/<id>` after success. Detail navigation is consistent with the publishing
flow. He reports four uploads returning 201 and a created Track playing four stems
from a localhost frontend with real APIs under `phucphuc`. The exact API target,
full SHA, preview bundle and results were not independently checked here; this
is not Vercel acceptance or evidence that failure/recovery races passed.

His summary says a changed form or 4xx response causes a new key, with exceptions
listed for 408/429. Review the code rather than treating that broad rule as
approved: **409 contention must retain key/body**, payload mismatch must stop for
reconciliation, and edits after an unknown result must not silently start a new
publish intent. A new key belongs to a genuinely new intent after resolving the
old one, not a generic response-status branch. Also check 24-hour expiry and
owner-change/stale-response handling. Use mock fault scenarios for these races;
do not inject them into the shared live service.

Phuc requested cleanup of his Track named `Test upload 1`. This remains pending:
resolve the exact Track ID/owner and compare with the protected seed/demo records
before cleanup. The title alone is not a unique identifier. Track deletion does
not delete Cloudinary audio; provider-asset cleanup is a separate decision. No
Track or asset was deleted by this documentation update.

### Independent PR #6 source/browser review (November 12)

The later independent review confirmed PR #6 open at full head
`8bd80b3cc8ddf4fa398c64d92d8f379d669a770e`, base `dev`
`9b122ea438d17f68422437a0a8670f1ae735f4fa` (PR #5 merged).
Its six-file diff is Upload-specific and retains the earlier Auth fixes.
The Upload preview is
`https://stemforge-client-git-feature-upload-ui-ngoc-phuc.vercel.app`;
its production JavaScript matches the reviewed local build byte-for-byte.

Clean-checkout lint/build passed with ten existing warnings outside the changed
Upload files. A fourteen-scenario matrix plus one focused truncated-201 probe
ran on localhost and again on the matching Vercel bundle, with mocked upload,
create and recovery responses, not real provider writes. Seven matrix scenarios
met the expected behavior; seven matrix scenarios and the extra probe reproduced
five distinct issues:

- `UploadPage.jsx:103`: both 409 contention and mismatch discard the key. The
  next click creates a new intent instead of waiting/reconciling; the contention
  mock reproduced two Tracks when the previous operation had committed.
  The same classification also drops the key after a committed 201 with an
  unreadable JSON receipt, duplicating the Track on retry in the focused probe.
- `UploadPage.jsx:60,91`: editing after a committed-but-lost response unlocks a
  new key/body and duplicates the Track in the mock. Freeze/reconcile the older
  unknown intent first.
- `UploadPage.jsx:49,91` and `uploadApi.js:50`: no retention-window guard or
  receipt-header handling. A same-key retry after 25 simulated hours creates a
  second Track under the backend's documented expiry behavior.
- `UploadPage.jsx:98`: a delayed successful create can still navigate after
  Sign out/account change, discarding the new account's draft. Aborting on
  unmount alone is insufficient when a callback has already escaped cancellation.
- `uploadApi.js:11`: the form advertises/accepts 50 MiB and OGG/M4A, while the
  confirmed API supports only MP3/WAV/FLAC, at most 20 MiB.

The passing local scenarios covered one/four stems, multipart field/allowlist,
provider metadata, max-two scheduling, out-of-order completion with chosen
names/order, separate slot retry, repeated 429 countdown/resume, unchanged
same-key replay within the window, stale upload callbacks, and responsive
320/360/390/1440 layouts. These are external review probes, not additional
repository automated tests or proof of server deduplication.

Real preview GET returned HTTP 200 and Auth/upload/create preflights returned
204, but none allowed the exact Upload preview Origin. Browser JavaScript could
not read the real API response. The response already exposes Retry-After and
the two idempotency headers; adding this explicit origin to the existing
ADDITIONAL_FRONTEND_ORIGINS is a configuration follow-up for Nguyen, preserving
all old entries. No configuration was changed by the review. A separate health
request timed out; the later real API/preflight responses above were received.
Phuc's earlier localhost happy path remains attributed evidence, separate from
this independent preview review. No new upload/create/DELETE was sent live.

Read-only cleanup identification found exactly one `Test upload 1` owned by
`phucphuc` (`6aee5b0d33ea9c4d1a428b9b`): Track
`6af59201666407c763e58d68`, created `2026-11-12T10:16:33.673Z`, public, four stems,
zero Likes. It is absent from the seed manifest and differs from the protected
demo. The owner's 13 seed IDs are still present. Cleanup remains a manual,
authenticated-owner DELETE after rechecking this identity; provider assets are
out of scope. A real Render detail GET returned 200 with the same identity.
Before/after fingerprints of 2 Users, 16 Tracks and 0 Likes are unchanged;
the read-only DB connections were closed. PR #6 is not accepted for merge while the reproduced recovery
defects and live preview integration remain unresolved.

## 7. Acceptance to perform after the frontend exists

- Source/mock checks: 1 and 4 stems; completion out of order; per-slot retry;
  validation/401/413/415/429/provider errors; same-key recovery and mismatch;
  stale response/account change; responsive loading/error/progress states.
- Authorized live fixture: upload real agreed audio, create one Track, replay
  with the same key/IDs, open detail/My Tracks and hear/play/seek the actual stems.
  Check the exact preview origin and browser-readable response headers.
- Keep real-provider evidence separate from mocked orchestration. Existing
  [multi-stem HTTP tests](MULTI_STEM_UPLOAD_VERIFICATION.md) and the 659-test
  checkpoint do not certify an implemented Upload frontend or actual new uploads.
- Agree which test assets may be created and the cleanup method before a live
  upload run. Do not delete reused demo/seed audio; Track DELETE alone does not
  clean provider assets. No shared DB/CDN operation is part of this handoff update.

## Source references

- [Upload routes / Swagger](../src/routes/upload.routes.js),
  [multipart validation](../src/middlewares/audio-upload.middleware.js),
  [rate limit](../src/middlewares/audio-upload-rate-limit.middleware.js),
  [provider upload and rejected-result cleanup](../src/services/audio-upload.service.js).
- [Track routes / Swagger](../src/routes/track.routes.js),
  [Track validator](../src/validators/track.validator.js),
  [Track controller](../src/controllers/track.controller.js),
  [response enrichment](../src/services/track-response.service.js),
  [idempotency service](../src/services/track-create-idempotency.service.js).
- [Auth routes](../src/routes/auth.routes.js), [JWT configuration](../src/config/jwt.js),
  [REST CORS](../src/app.js), [origin policy](../src/config/frontend-origins.js).
