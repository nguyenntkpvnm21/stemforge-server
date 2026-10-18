# Track and Stem Data Contract

**Status: Draft - awaiting Phuc's review of the updated response fields.**
Updated October 18, 2026. This is not a fully approved contract.
The sample [data-contract.json](data-contract.json) is a Track **response** object,
not a create/PATCH payload. URLs are illustrative and cannot play audio.

## Review record

Based on Phuc's original-contract PR feedback supplied by Nguyen, Phuc confirmed:

- stemId as the mixer channel key and preservation of stem array order.
- Stems start at zero; timeline equals the longest stem; maximum four stems.
- Duration in seconds, fileSize in bytes, and nullable coverImageUrl.
- One normal account type; Creator and Listener are activities.
- The data, data/pagination, and message response wrappers.

Nguyen authorized implementing Phuc's requested artist and likedByMe additions.
Phuc's final approval and copying the updated JSON into stemforge-client remain
pending. This feedback concerns the original PR, not the later five-question
proposal. It does not resolve collection, stem-management, download enforcement,
multi-upload request design, or partial-upload cleanup decisions.

## Track and Stem fields

| Field | JSON type | Contract |
| --- | --- | --- |
| _id, artistId | string | Track and owner ObjectId strings; artistId remains an ID, not a populated object. |
| artist | object or null | Response only: exactly _id (ObjectId string), username (string), avatarUrl (string or null). No email, role, passwordHash, timestamps, or other User fields. |
| likedByMe | boolean | Response only: current account's Like membership, always false for guests. Not inferred from global likesCount. |
| title, genre, key | string | Nonempty; trimmed when stored. No fixed genre/key enum. |
| bpm | number | Positive finite number, not a numeric string. |
| tags | string array | Nonempty trimmed entries; defaults to []. |
| coverImageUrl | string or null | HTTPS URL or null; defaults to null. |
| description | string | Defaults to empty string. |
| isPublic, isDownloadable | boolean | Explicit booleans on create; see access/download limits below. |
| stems | Stem array | 1-4 entries; preserve order. |
| likesCount | integer | Nonnegative safe integer, maintained by backend. |
| createdAt | string | ISO 8601 UTC timestamp, assigned by backend. |

Each Stem has stemId (server-generated ObjectId string), name (nonempty string),
audioUrl (HTTPS string), duration (positive finite seconds), and fileSize (positive
safe integer bytes). The current API imposes no field-specific maximum lengths.
No Track updatedAt or internal __v is returned.

**Missing author policy for group confirmation:** if artistId no longer identifies
a User, an otherwise accessible Track still returns 200 with artist=null, original
artistId preserved, and likedByMe computed normally. Lists retain that Track and
their pagination totals. Frontend must handle null, for example a generic missing-
author label/avatar. A database lookup error is an error response, not artist=null.

## Responses and input allowlists

- GET `/api/tracks`: 200 `{data: Track[], pagination:{page,limit,total,totalPages}}`.
  Public Tracks only for guests and signed-in users. Default page=1/limit=12,
  limit 1-100; newest-first then _id descending. Zero total means totalPages=0.
- GET `/api/tracks/:trackId`: 200 `{data: Track}`. Guests can see public Tracks;
  signed-in owners can also see their own private Tracks.
- POST `/api/tracks`: authenticated, 201 `{data: Track}`. Required input: title,
  genre, bpm, key, isPublic, isDownloadable, stems. Each input stem has only name,
  audioUrl, duration, fileSize. Optional input: tags, coverImageUrl, description.
- PATCH `/api/tracks/:trackId`: owner only, 200 `{data: Track}`. At least one of
  title/genre/bpm/key/tags/coverImageUrl/description/isPublic/isDownloadable. No stem
  updates. Omitted fields remain unchanged; clear tags with [], description with
  an empty string, and cover with null.
- POST/PATCH perform the Track write and response enrichment in one transaction.
  All transaction queries share one session and run sequentially. A lookup error
  rolls back the new Track or metadata update; success is sent only after commit.
  Query failure is not converted to an empty Like state or missing author.
- Both artist and likedByMe appear on **all four** Track response operations.
  They are computed response data, never Track schema fields or accepted input.
  Backend also assigns _id/artistId/stemId/likesCount/createdAt. Unknown fields
  and response-only fields in POST/PATCH return 400.
- GET/PUT/DELETE `/api/tracks/:trackId/like` remain authenticated, no body, 200
  `{data:{trackId,isLiked,likesCount}}`. isLiked is unchanged; do not rename it
  to likedByMe. PUT/DELETE are idempotent. Only public or own private Tracks
  are accessible. DELETE Track remains owner-only, empty 204, with Like cascade.
- Errors retain `{message:string}` and HTTP status handling. Foreign private
  access/foreign-owner edits return 404. Public list/detail accept optional
  Bearer auth; a supplied invalid/expired token/header returns 401. Guests get
  likedByMe=false. All Track responses use Cache-Control: no-store.

List enrichment uses one author query for distinct page owners and at most one
membership query restricted to current user/page Track IDs, never per Track.
Guests skip membership queries; empty pages skip both enrichment queries.
GET list/detail counters and derived membership are separate reads, not one
transaction snapshot. POST/PATCH enrichment shares the write transaction's
snapshot. Use the dedicated Like endpoint's returned state after Like/Unlike.

## Upload and mixer integration

Current upload is POST `/api/uploads/audio`: Bearer auth, exactly one multipart
file in audio, MP3/WAV/FLAC up to 20 MiB, 10 attempts/account/15 minutes. It returns
201 `{data:{audioUrl,duration,fileSize,publicId}}`; it does not create a Track.
Frontend can compose 1-4 StemInput objects from uploads plus chosen names/order.
Select name/audioUrl/duration/fileSize explicitly; publicId is not a Stem field.
Separate requests versus a new batch endpoint remains a group decision.
The specification requires simultaneous multi-stem capability without explicitly
mandating a single HTTP request; no accepted frontend multi-upload flow is claimed.

Files must already be aligned. Backend stores metadata and does not align audio.
The confirmed timeline uses the longest stem; the old draft's shorter-stem-silence
rule is consistent with this proposal but was not separately confirmed in the
quoted feedback. Backend supports FLAC beyond the document's MP3/WAV formats.

## Decisions still open

- My Collection: Like-derived list versus independent saved collection.
- Stem management: metadata-only MVP versus whole-array replacement versus
  individual add/remove/replace/reorder, including stable-ID semantics.
- Download: application action gating with public CDN URLs versus controlled/
  expiring delivery. isDownloadable currently stores an owner-controlled flag;
  it does not prevent saving public playback bytes. No authorized download API
  exists. isPublic protects Track API access, not known public audio URLs.
- Multi-upload request design, partial failure/retry handling, and orphan asset
  cleanup. Deleting Track currently does not delete Cloudinary audio.
- Missing-author null behavior above awaits frontend acceptance.

Full payload examples and prior review context: [DATA_CONTRACT_PROPOSAL.md](DATA_CONTRACT_PROPOSAL.md).
