# Data contract proposal for discussion with Phuc

**Status: Draft - not approved.** Updated October 19, 2026. Released backend:
`559222a`; artist/likedByMe previously passed real Render HTTP verification
(12/12 groups), search/filtering subsequently passed 10/10 Render groups, and
tag/sort/NUL validation passed 12/12 actual Render groups on October 19.
Fixture cleanup and main-account preservation were verified. Deployment/testing
does not constitute Phuc's approval of the updated contract.
Read `docs/data-contract.md` and `.json` from branch `docs/data-contract` at
`9e041cd` with `git show`; no checkout or replacement of uncommitted files.
Retain existing field names and response wrappers. The old draft's statement
that Track APIs are unimplemented is obsolete. See the updated
[contract and response sample](data-contract.md).

## Phuc's feedback on the original contract PR

Nguyen supplied Phuc's review of the original two contract files (not answers to
the later five questions). Phuc confirmed stemId as channel key, stem ordering,
zero-start/max-duration timeline, maximum four stems, seconds/bytes units,
nullable coverImageUrl, one account with Creator/Listener as activities, and
the data, data/pagination, and message wrappers. Nguyen agreed to the requested
artist and likedByMe response additions. Final approval of the updated contract
and the client JSON copy remain pending. Collection, stem management, download
policy, and multi-upload request/cleanup choices were not settled by this reply.

## 1. Current API and existing verification evidence

The rules below come from current models/validators/controllers. The earlier
245-test run and Render checks cover the released baseline. October 18 local
feature verification passed 270 tests, including router HTTP tests with real
JWT middleware and mocked database queries. A subsequent local HTTP run against
real Atlas passed all 10 groups, including membership, private access, persistence,
orphan author behavior, query batching, and cleanup; see PROJECT_STATUS.md.
POST/PATCH now include enrichment in their write transaction, with sequential
session-bound reads and response sent after commit. Subsequent real-Atlas checks
verified rollback on both author/membership lookup failures and successful
responses, plus recovery of orphan fixture Likes without upgrading incomplete
verification. The latest automated total is 306 (Tracks 170, Likes 51, uploads 59,
recovery 26). Subsequent actual Render requests passed all 12 groups, covering
response/privacy/input rules, per-account Like state, public/private access,
missing authors, cascade, and deployed Swagger. Fixture cleanup and preservation
of existing data were verified; main/dev were synchronized to d5501f1. Failure
rollback and query batching retain their local verification scope; no production
fault injection was used. Client integration is not yet certified. See the
[Render results](PROJECT_STATUS.md#actual-render-verification-and-cleanup-october-18-2026).

### Track/Stem responses and inputs

GET detail and PATCH return HTTP 200 `{data: Track}`; POST returns 201 in the same
wrapper. JSON object shape (notation, not an executable TypeScript module):

```typescript
type StemInput = { name: string; audioUrl: string; duration: number; fileSize: number };
type Stem = StemInput & { stemId: string };
type Track = {
  _id: string; artistId: string;
  artist: { _id: string; username: string; avatarUrl: string | null } | null;
  likedByMe: boolean;
  title: string; genre: string; bpm: number; key: string;
  tags: string[]; coverImageUrl: string | null; description: string;
  isPublic: boolean; isDownloadable: boolean;
  stems: Stem[]; likesCount: number; createdAt: string;
};
```

| Fields | Current rules |
| --- | --- |
| `_id`, `artistId`, `stemId` | ObjectId strings: 24 hex characters. artistId is an owner ID, not a populated user. Stem has stemId, no separate _id. |
| `artist`, `likedByMe` | Computed response fields on list/detail/POST/PATCH, not stored or accepted in inputs. Artist exposes exactly _id/username/avatarUrl; missing User gives null, pending frontend acceptance. likedByMe is current-user membership, false for guests. |
| `title`, `genre`, `key`, stem `name` | Nonempty strings; trimmed when stored. No fixed Genre/Key/name enum or field-specific maximum length is currently imposed. |
| `bpm`, stem `duration` | Positive finite JSON numbers; numeric strings rejected. Duration is seconds, decimals allowed. |
| stem `fileSize` | Positive safe integer in bytes (at most Number.MAX_SAFE_INTEGER). |
| `audioUrl`, `coverImageUrl` | HTTPS URLs; cover may be null. Track input does not verify file ownership, fetch audio, or prove that a URL came from Cloudinary. |
| `tags`, `description` | Tags array of nonempty strings, default []; tags trimmed, no deduplication guarantee. Description string, default empty string. |
| `isPublic`, `isDownloadable` | Explicit JSON booleans required on create; string booleans rejected. |
| `stems` | 1-4 entries, ordered; server creates unique stemId values. Names need not be unique. |
| `likesCount`, `createdAt` | Nonnegative safe integer, initially 0; creation timestamp serialized as ISO 8601 UTC string. No Track updatedAt or __v in the response. |

POST `/api/tracks`: required fields are title, genre, bpm, key, isPublic,
isDownloadable, and stems with all four StemInput fields. Optional fields are
tags, coverImageUrl, and description. Minimal valid example (placeholder URL):

```json
{
  "title": "Demo", "genre": "Electronic", "bpm": 128, "key": "Am",
  "isPublic": true, "isDownloadable": false,
  "stems": [{
    "name": "Drums", "audioUrl": "https://example.invalid/drums.mp3",
    "duration": 30.125, "fileSize": 480000
  }]
}
```

PATCH `/api/tracks/:trackId`: at least one of title/genre/bpm/key/tags/
coverImageUrl/description/isPublic/isDownloadable; omitted fields are unchanged.
Clear tags with [], description with an empty string, and cover with null:

```json
{ "title": "Renamed demo", "tags": [], "description": "", "coverImageUrl": null }
```

Server controls `_id`, `artistId`, `stemId`, `likesCount`, `createdAt` and internal
version fields. Do not send them, artist/likedByMe, or unknown fields. PATCH
rejects stems; POST
StemInput rejects publicId and stemId. JSON parser currently limits bodies to
102400 bytes; this is distinct from the audio-upload limit.

### Access and deletion

- Public list is public Tracks only. Detail allows guests to see public Tracks
  and authenticated owners to see their private Tracks. Invalid supplied Bearer
  authentication on detail returns 401, even for a public Track.
- Create/upload/Like require authentication. Only the owner can PATCH/DELETE a
  Track. Foreign private access and foreign-owner edits/deletes return 404.
- Normal user can upload and listen. Schema roles are user/admin; registration
  creates user. Creator/Listener as activities is now confirmed by Phuc; no
  separate permission gates are required by that feedback.
- isDownloadable is an owner-controlled flag, not file protection. Audio URLs
  are public CDN URLs; isPublic protects API metadata, not an already known URL.
- DELETE Track returns 204 with **no body**, cascading its Likes. Cloudinary
  assets are not automatically deleted.

### Upload, Like, pagination, errors

POST `/api/uploads/audio`: Bearer auth; multipart/form-data with exactly one file
named audio and no other form fields. MP3/WAV/FLAC, nonempty, at most 20 MiB
(20971520 bytes); 10 authenticated attempts per account per 15 minutes, including
failures after authentication. HTTP 201 response:

```json
{ "data": { "audioUrl": "https://example.invalid/drums.mp3", "duration": 30.125, "fileSize": 480000, "publicId": "illustrative-storage-id" } }
```

Duration/fileSize are storage-reported metadata. Upload does not create a Track.
The 20 MiB upload limit is not separately enforced on manually supplied Track
fileSize metadata. publicId is an upload result, not an accepted Track/Stem field.

GET/PUT/DELETE `/api/tracks/:trackId/like`: Bearer auth, no request body, HTTP 200:

```json
{ "data": { "trackId": "507f1f77bcf86cd799439011", "isLiked": true, "likesCount": 2 } }
```

isLiked is specific to the current user; likesCount is shared across users.
PUT/DELETE are idempotent. Public Tracks and owner's private Tracks are eligible.
Track responses contain likesCount and personalized likedByMe. The separate Like
endpoint still uses isLiked; that field name and its transaction semantics are unchanged.

GET `/api/tracks?page=1&limit=12`: page is a positive safe integer; limit 1-100,
default 12; page defaults to 1. Unsafe skip values are rejected. Order is
createdAt descending, then _id descending. Out-of-range pages have an empty data
array; zero total means totalPages=0. Optional Bearer auth personalizes likedByMe;
an invalid supplied header/token now returns 401, matching detail behavior. Response:

```json
{ "data": [], "pagination": { "page": 1, "limit": 12, "total": 0, "totalPages": 0 } }
```

Errors use `{message: string}`. Common statuses: 400 invalid input/ID, 401 auth,
404 missing/inaccessible Track, 413 size, 415 upload media/content type, 429 upload
quota, 500 internal, 502 upload storage failure. Handle status and message; do not
depend on exact message text or expect structured error codes. Track/Like/upload
responses use Cache-Control: no-store. Handle 204 without parsing JSON.

## 2. New proposals, not implemented or jointly approved

- Preserve the above contract. A compatible client can upload 1-4 files through
  separate existing requests, keep each result paired with its selected stem
  name/order, wait for all successful results, then POST one Track with
  `stems = results.map(r => ({name, audioUrl, duration, fileSize}))`. Pick these
  fields explicitly; never spread publicId into stems. Parallelize only with
  bounded concurrency if chosen. This orchestration is a proposal, not a verified
  client flow or automatic acceptance of the document's multi-upload requirement.
  Do not create a partial Track after failure; retries and cleanup of successfully
  uploaded but unreferenced files need an agreed policy (not available today).
- The main mixer conventions and activity-based account model are confirmed in
  Phuc's feedback above. The shorter-stem-silence rule, file-alignment details,
  FLAC frontend compatibility, and actual frontend integration were not separately
  verified. MP3/WAV are specified; FLAC already works in the backend.
- My Collection: Like-derived listing is one possible design. An independent
  saved collection is another; neither listing exists and neither is approved.

## 3. Earlier five-question proposal (historical, not the source of the feedback)

Questions 1-2 are substantially addressed by Phuc's original-PR feedback above.
Questions 3-5 remain open; Phuc still needs to review the two new response fields
and missing-author null behavior. Preserve the original questions for context:

1. Can we confirm these field names/types/wrappers, 1-4 ordered stems, stemId as
   mixer key, and the proposed zero-start/max-duration mixer rules; is anything
   incompatible with the current frontend?
2. Is a user uploading and listening (Creator/Listener as activities) the agreed
   model, or are distinct enforced account permissions actually required?
3. For multi-stem upload, should one UI submission issue separate existing audio
   requests then POST Track or use a new multipart multi-file request, and how
   should completed files be handled if another upload or Track save fails?
4. Does My Collection mean liked Tracks (Unlike removes an entry), or a separate
   saved collection unaffected by Like/Unlike?
5. Which MVP choices do we want: (a) metadata-only edits, replace all stems, or
   individual stem add/remove/replace/reorder; (b) download-button gating with
   public CDN URLs, or authorized/expiring delivery? For replacement, agree which
   stem IDs persist. Controlled delivery still cannot prevent saving audio that
   the browser legitimately plays. These options are not selected by this draft.

Requirement basis: **WEB APPLICATION PROJECT.docx**, section 3 Module 3 says
"Cho phép upload đồng thời nhiều file audio"; section 6 Nguyen assignment says
"API upload nhiều file stems cùng lúc". This requires multi-stem capability but
does **not explicitly specify one HTTP request**. Whether several single-file
requests satisfy it needs agreement. Section 3 Module 1 describes Creator/Listener,
while section 4 explicitly says user/admin and every user can upload/listen.
Module 4 mentions Like and My Collection together but does not equate them or
define an independent collection. Pagination and API details above are current
code behavior, not invented requirements from the specification.

## Low-dependency backend task: released search/filters

Nguyen subsequently authorized this task. Implemented on
`feature/track-search-filters`: q is a case-insensitive literal title
substring; genre/key are case-insensitive full-value literal matches. Text is
trimmed, nonempty, at most 100 characters before trimming, and accent-sensitive.
bpmMin/bpmMax are inclusive positive finite plain decimal bounds (32 characters
maximum); either may be omitted, equal bounds are exact, and inverted ranges
return 400. These query-string rules do not change JSON write payload types.
Repeated, nested/operator, or unsupported parameters return 400. All filters
combine with AND and public-only visibility, with the same filter for data/total.
Existing pagination, ordering, artist/likedByMe and authentication remain.

372 automated tests and 10 real local HTTP/Atlas groups passed; fixture cleanup,
preservation of existing data/main account, and DB disconnection were verified.
Subsequent real Render verification passed 10/10 groups with cleanup and
preexisting-data/main-account preservation verified; main/dev now share 8691027.
Nguyen confirmed that Live commit in Render Dashboard. See the
[Render search/filter results](PROJECT_STATUS.md#actual-render-searchfilter-verification-and-cleanup-october-18-2026).
Tag/most-liked follow-up is now implemented locally as described below. This
task does not depend on unresolved roles,
collection storage, stem-edit, or download decisions and does not approve the
overall Draft contract.

## Local tag and sort follow-up (October 19)

Nguyen authorized extending the existing query allowlist with singular tag and
sort. tag is trimmed/nonempty/max 100 characters before trimming and matches a
whole tags element literally, case-insensitively. It combines with all metadata
predicates using AND. sort accepts exactly newest (default) or mostLiked, changes
only order, and is not part of data/total filters. newest keeps createdAt/_id DESC;
mostLiked uses likesCount/createdAt/_id DESC. Query validation, authentication,
public-only access, pagination and artist/likedByMe response semantics remain.

Before the NUL fix, 399 automated tests and a corrected 11-group local HTTP/Atlas run passed,
with safe cleanup and preservation of existing data/main account/indexes. The
HTTP fixture test did not build the new ranking index. Subsequent authorized
additive provisioning verified its exact keys/options on the configured shared
Atlas database: 3 -> 4 Track indexes, repeat apply 4 -> 4, and unhinted explain
using the new index without SORT. Existing data/indexes were preserved and 9
focused utility tests passed. After the NUL fix, 283 Track tests passed, including
the 132-test validator/controller/routes subset. Loopback HTTP with DB mocks
rejected 20 guest %00 requests before database lookups; four literal/textual-NUL
controls passed. These runs are separate, with no combined post-fix total claimed.
Subsequent actual Render verification on release 559222a passed 12/12 groups,
including 20 NUL 400 responses and four literal controls, with fixture cleanup,
all preexisting data/main-account/index preservation and DB disconnect verified.
main/dev and origin refs were synchronized by fast-forward to that release.
The existing index was verified without DDL; unhinted explain used IXSCAN without
SORT. This is not a load benchmark. See
[released status](PROJECT_STATUS.md#released-tag-and-sort-feature-october-19-2026).
This feature and its query documentation do not approve the overall Draft
contract or resolve the open collection/stem/download decisions.

## Local owned-Track listing (October 19)

Nguyen authorized GET /api/tracks/mine for the authenticated account's own Tracks.
It includes public/private Tracks and accepts only page/limit, with defaults 1/12,
limit 1-100 and the same safe-pagination validation as public listing. artistId
and all other filter/sort parameters are rejected; owner scope comes exclusively
from req.user._id. Ordering is createdAt DESC then _id DESC. It returns the same
data/pagination wrapper and artist/likedByMe context with Cache-Control: no-store.
The public list remains public-only and uses its existing discovery filters.

317 Track tests, 51 Like tests and 59 upload tests passed. Ten real local
HTTP/Atlas groups passed, with safe cleanup, preexisting-data/main-account/index
preservation and DB disconnect verified. This endpoint is not deployed/tested on
Render yet. It supplies owned-Track dashboard data; it does not implement or decide
My Collection, stem editing, download delivery or Socket.IO. The contract remains
Draft. See [current status](PROJECT_STATUS.md#local-my-tracks-feature-october-19-2026).
