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

Public Track title search and genre/key/BPM filtering are implemented and verified on Render.
Tag filtering, most-liked ordering and NUL query validation are verified on Render.
Authenticated owned-Track listing is verified on Render.
Realtime MVP passed scoped REST/Socket.IO checks on Render Live 86aa3cb.
See the realtime section for verified scope and remaining local-only checks.
Audio/stem replacement remains pending.

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

## Backend CI

[Backend CI](.github/workflows/backend-ci.yml) runs on pull requests targeting
`dev` or `main`, using Node.js 24 on Ubuntu 24.04 and `npm ci` with the committed
lockfile. It is independent of the frontend and does not deploy the application.

Run the same automated suites locally with Node.js 24:

```sh
npm ci
npm test
```

`npm test` delegates to `npm run test:ci`: Tracks, uploads, Likes, realtime,
recovery-logic and index-logic unit tests. Suites list their test files explicitly;
they do not discover `*.local.js` or invoke seed/cleanup/Render checks or the index
provisioning CLI. Recovery/index tests use mocks, not actual database operations.

No `.env`, Atlas, Cloudinary credentials or production data are required. Tests
provide dummy configuration where needed, mock external services, and use local
HTTP/Socket.IO listeners; allow loopback networking. No custom secrets are used
in the workflow. Add new automated suites to `test:ci` explicitly.

Node 24 is an [LTS release](https://nodejs.org/en/about/previous-releases).
Actions are pinned to verified commit SHAs for official
[checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) and
[setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0).

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
The default `sort=newest` orders by `createdAt` descending, then `_id` descending.
`sort=mostLiked` orders by `likesCount` descending, then `createdAt` descending,
then `_id` descending. Both provide deterministic ties for fixed data. Likes can
change between requests, so offset pagination does not freeze a ranking snapshot.

Query parameters (each accepts one scalar value):

- `page`: positive integer, default 1.
- `limit`: integer from 1 to 100, default 12.
- `q`: literal title substring, case-insensitive.
- `genre`, `key`: case-insensitive full-value literal matches, with no fixed enum.
- `bpmMin`, `bpmMax`: inclusive positive finite BPM bounds; either can be omitted.
- `tag`: case-insensitive full-value literal match against one element of `tags`.
- `sort`: exactly `newest` (default) or `mostLiked`, case-sensitive; no trimming.

All supplied conditions combine with AND and `isPublic=true`, including for an
authenticated owner. The same filter is applied to data and total; `sort` changes
only the order and never the filter or total. Text filters
are trimmed and must be nonempty, with at most 100 characters before trimming.
Actual U+0000 (NUL) in q/genre/key/tag returns 400; it is not silently removed.
Regex characters such as `.*`, `+`, and `[]` are literal text. Matches preserve
accent distinctions; musical keys receive no enharmonic normalization. A tag
must match a whole array element: `Rock` does not match `Rock Remix`, and separate
elements cannot combine into a match. Use singular `tag`; plural `tags` is not a
supported query parameter. The 100-character bound also applies to tag.

BPM bounds accept plain decimal query strings of at most 32 characters, such as
`120` or `120.5`, and must be greater than zero. Fractions need digits before and
after the decimal point. Exponent/hex notation, signs, whitespace, nonfinite
values, and bpmMin greater than bpmMax return 400. Equal bounds mean exact BPM;
no integer rounding is applied. Omit unused filters rather than sending blanks.
Use normal URL encoding for values, especially `#` and `+` in musical keys.

Repeated values, arrays/nested query objects, MongoDB operators, and unsupported
parameters return 400. Only page/limit/q/genre/key/bpmMin/bpmMax/tag/sort are
accepted. Invalid sort values, including blank values or `MostLiked`, return 400.

Example:

```text
GET /api/tracks?page=2&limit=5
GET /api/tracks?q=demo&genre=Electronic&key=Am&bpmMin=120&bpmMax=140.5
GET /api/tracks?tag=electronic&sort=mostLiked&page=2&limit=5
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

`total` counts public tracks matching every supplied filter. When none match,
`totalPages` is zero. A page beyond the available results returns
an empty `data` array.

Invalid pagination or filter parameters return HTTP 400 with a readable
`message`. Database errors are forwarded to the error middleware.
Responses include `Cache-Control: no-store`.

### List my Tracks

```text
GET /api/tracks/mine
GET /api/tracks/mine?page=2&limit=5
```

Requires a valid Bearer token. Returns only Tracks whose artistId is the
authenticated account's _id, including both public and private Tracks. Only
page/limit are accepted: defaults page=1/limit=12, positive integer page, limit
1-100, and a safe integer pagination offset, exactly like public listing. Empty,
repeated, array/operator and invalid pagination values return 400. Other query
parameters, including artistId/isPublic/q/genre/key/BPM/tag/sort, return 400;
clients cannot select another owner. Missing, malformed, expired/invalid tokens
or tokens identifying a missing account return 401 before listing.

Ordering is always createdAt DESC then _id DESC. The response is
`{data: Track[], pagination:{page,limit,total,totalPages}}`, using the same owner
condition for data and total. An account without Tracks gets data=[]/total=0/
totalPages=0; beyond-last pages stay empty while total remains unchanged.
Each Track includes the same public artist allowlist and likedByMe for the
current account. Cache-Control remains no-store, including errors. Author/Like
lookups are batched for the page; empty pages skip enrichment queries.

The public GET /api/tracks endpoint keeps its public-only filter, optional
authentication, search/filter/sort and response behavior. /mine is registered
before / and /:trackId and does not pass through the public-only query validator.
Both list operations share pagination/execution/enrichment logic with separate
server-controlled scopes. No schema/index migration, collection API or Socket.IO
feature is introduced. The Track/Stem contract remains Draft.

Local verification passed 317 Track tests, 51 Like tests and 59 upload tests.
Ten real HTTP/local Atlas groups passed (82 responses) using two accounts and
15 marked Tracks. This covered authentication, empty-account isolation, own
public/private Tracks, other-owner exclusion, default/tied ordering, pagination,
Like state, public-list regression, invalid queries, batched DB commands and
Swagger. Cleanup left zero fixtures, preserved all preexisting data/main account
and indexes, closed the HTTP listener and disconnected DB in finally. Placeholder
audio URLs created no Cloudinary assets. The spent harness was removed; generated
reports remain local/ignored. Those local results predate the actual Render check
below and are not combined into a new test total.

On October 19, **10/10 actual Render groups passed** on release
**72424fa2efb7aebbb265c3f952ad1e7fa30576a1** (PR #40/#41; Live SHA confirmed by Nguyen
in Render Dashboard), with 95 HTTPS responses including three preflight requests.
A separate read-only preflight invocation made three more. Two marked accounts
and 15 Tracks verified authentication, empty-account/owner isolation, own
public/private Tracks, page/limit defaults and boundaries, tied ordering,
artist/likedByMe, Like/Unlike and public-only regression. All 24 invalid queries
returned 400/no-store. An account changed to private-only still received its two
owned Tracks and total=2. Deployed Swagger included the corrected shared
pagination descriptions. Production DB query instrumentation was not added;
batch-query behavior remains established by the earlier local verification.

Cleanup left zero fixture Users/Tracks/Likes and preserved all existing data,
protected main account and index catalogs. DB disconnected in finally. No assets,
local JWT signing or production fault injection were used. The spent harness was
removed and raw reports remain ignored/local. main/dev and their origin refs were
fast-forward synchronized to 72424fa, finishing on dev. Contract remains Draft.
See [released results](docs/PROJECT_STATUS.md#released-my-tracks-feature-october-19-2026).

### Discovery indexes

Keep the existing owner and public/newest indexes. The model additionally
declares the nonunique `public_tracks_most_liked` index:

```javascript
{ isPublic: 1, likesCount: -1, createdAt: -1, _id: -1 }
```

The public equality prefix followed by the complete sort keys supports the new
unfiltered ranking. Additional metadata/range predicates can still require
filtering; this is not a guarantee that every combination avoids scanning.
See MongoDB's [compound sort](https://www.mongodb.com/docs/manual/core/indexes/index-types/index-compound/sort-order/)
and [equality/sort/range](https://www.mongodb.com/docs/manual/tutorial/equality-sort-range-guideline/)
guidance. Every Like-count change also maintains this index, so there is write
and storage cost.

No tag index is added: the existing literal `$regex` with `i` preserves query
semantics, but [case-insensitive regex does not benefit from a collation index](https://www.mongodb.com/docs/manual/reference/operator/query/regex/).
A normalized tag field/index is a separate schema decision if scale warrants it.
No `syncIndexes`, `dropIndex`, or removal of existing indexes is introduced.
Current database configuration does not override Mongoose's autoIndex/autoCreate
defaults (both true). Model initialization can build declared indexes, but
startup explicitly awaits only TrackLike.init(), not Track.init(). HTTP readiness
therefore does not certify completion of the Track index build. Startup behavior
is unchanged by this feature.

Provision the index explicitly before releasing the new ranking query. From the
repository root, load private project credentials using the existing environment
or ignored .env; never put credentials in command arguments:

```powershell
# Read-only preflight and unhinted queryPlanner explain; inspect index.exists.
node scripts/ensure-track-most-liked-index.js
# Intentional, persistent, additive index creation; safe to rerun.
node scripts/ensure-track-most-liked-index.js --apply
# Verify idempotence: created=false and beforeCount=afterCount.
node scripts/ensure-track-most-liked-index.js --apply
# Focused utility tests; no database connection.
node --test --test-reporter=spec tests/track-most-liked-index.test.js
```

The script privately uses MONGO_URI/MONGO_USERNAME/MONGO_PASSWORD and DNS_SERVERS,
requires an explicit configured database, checks its identity, expected project
collections and protected main account, and disables automatic index/collection
creation. It reads the named schema declaration, creates only that index, and
refuses conflicting keys/options or equivalent keys under another name. Resolve
conflicts manually; it never drops or replaces indexes. Repeated apply verifies
the existing index without another createIndex call. Keep the new index after
verification: this is an intentional database metadata change, with write/storage
cost, rather than temporary fixture data.

Read-only before/after fingerprints verify all User/Track/Like data and old index
definitions. Do not run alongside unrelated writes if those preservation checks
must remain stable. The script records actual unhinted winning plans, disconnects
in finally, and saves nonsecret sf-context-*.json reports locally under the
existing docs/verification ignore rule. A successful inspect can report a missing
index; readiness requires index.exists=true with matching keys/options.

On October 19, the configured shared project Atlas database was provisioned:
Track indexes increased 3 to 4, then stayed 4 on repeat apply. The actual new
index has the exact declared ordered keys/name, v=2, and no unique, sparse,
partial, hidden, TTL or collation override. Before creation the public-only
mostLiked explain used SORT -> FETCH -> IXSCAN on the public/newest index; after
creation and on rerun it used LIMIT -> FETCH -> IXSCAN on
public_tracks_most_liked, with no blocking SORT and no hint. Existing data and
indexes were preserved; all runs disconnected. The database had 1 User and no
Tracks/Likes, so that provisioning check was index/plan evidence, not a load
benchmark. Subsequent actual Render tag/sort verification passed 12/12 groups
on release 559222a, with the existing index retained and verified. Recheck on any
different deployment database.

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

Automated baseline before the NUL validation follow-up:

| Suite | Tests |
| --- | --- |
| Tracks | 263 |
| Audio uploads | 59 |
| Likes | 51 |
| Local recovery runner | 26 |
| Total | 399 |

Controller tests cover public-query filters, sorting, pagination,
invalid parameters, and forwarding database errors.
Database queries are mocked; route tests use an ephemeral local HTTP server.
These tests do not connect to MongoDB or upload audio.

The search/filter addition also passed 10/10 real local HTTP + Atlas verification
groups with two marked accounts and nine Track fixtures. Literal matching,
inclusive BPM boundaries, combined filters, pagination/total, private access,
viewer context, invalid queries, and identical real find/count filters passed.
Cleanup verified zero fixture Users/Tracks/Likes, unchanged preexisting data/main
account, and DB disconnection. See the
[search verification summary](docs/PROJECT_STATUS.md#local-searchfilters-feature-october-18-2026).
Subsequent [Render search/filter verification](docs/PROJECT_STATUS.md#actual-render-searchfilter-verification-and-cleanup-october-18-2026)
passed 10/10 groups using two marked accounts and 14 Track fixtures, including
default pagination across 13 public Tracks and tied-timestamp ordering. All 30
invalid query cases returned 400; public-only results, filtered totals and viewer
context passed. Cleanup and preexisting-data/main-account preservation were
verified, with DB disconnection. Live commit `8691027` was confirmed by Nguyen
in Render Dashboard; main/dev were synchronized to it. Generated reports remain
local and ignored. That Render deployment predates the local tag/sort addition.

### Local tag and sort verification

Before the NUL fix, tag/sort passed **399 automated tests** (263 Tracks, 51 Likes,
59 uploads, 26 local recovery) and **11/11 local HTTP + real Atlas groups**.
Two marked accounts and ten Tracks exercised full-element literal tag matching,
case/trim/length rules, all-filter AND, explicit/default newest, mostLiked ties,
pagination/total, private visibility, viewer context and invalid queries. Likes
were created through the real API. Actual MongoDB commands confirmed identical
find/count filters and separate sort clauses in both modes.

After the NUL fix, **283/283 Track tests passed**, including the **132/132**
validator/controller/routes subset (not an additional total). Real loopback HTTP
with DB mocks rejected all 20 guest %00 requests before list/count/context or
User lookups; four literal-regex/textual-NUL controls returned 200. Trimming and
case-insensitivity remain unchanged. The earlier 399-test and Atlas results
predate this fix; no combined post-fix automated total is claimed. The subsequent
Render/Atlas verification below is a separate deployment check.

An initial harness-only comparison failed because the MongoDB driver represents
sort as a Map; after normalizing that observation, the full run passed with a
fresh marker. Both runs verified cleanup and preservation. The passing run
confirmed zero fixture Users/Tracks/Likes, unchanged preexisting data/main
account and Track indexes, DB disconnection, and no Cloudinary assets. Temporary
harnesses were removed; generated reports remain local and ignored.

The HTTP fixture run deliberately disabled automatic DDL and observed the new
index absent, with a blocking SORT. A subsequent explicit additive provisioning
run created and verified it, including repeat-apply and unhinted explain; see
[deployment instructions](#discovery-indexes). Nine focused index-utility tests
also passed. The earlier fixture reports remain unchanged. These checks are not
a production-scale performance benchmark or Render tag/sort verification.
Those earlier results are historical; the actual Render check below now confirms
the deployed feature.

### Actual Render tag and sort verification

On October 19, **12/12 groups passed** against the real Render HTTPS API on
release **559222ac47f197b1214f083d862818fdc3ccaa16** (PR #38/#39; Live SHA confirmed
by Nguyen in Render Dashboard). Two marked accounts, 14 Tracks (13 public/one
private) and nine initial real Like memberships verified literal/case/trim tag
matching, metadata/BPM AND filters, default/newest ordering, mostLiked count/time/ID
ties, pagination and matching totals, private access, artist/likedByMe, invalid
queries, and the deployed Swagger. All 20 %00 requests returned the exact 400 NUL
validation message; four literal/textual-NUL controls returned 200. Production
query instrumentation was not added; the prior mock tests prove the no-query
boundary. The run recorded 134 HTTPS responses including five preflight requests;
a separate read-only preflight invocation made five more.

The existing mostLiked index was verified without DDL. Unhinted public ranking
explain with fixtures used LIMIT -> FETCH -> IXSCAN on public_tracks_most_liked,
with no SORT. Cleanup left zero fixture Users/Tracks/Likes; all preexisting data,
protected main account and index catalogs were preserved. DB disconnected in
finally. No Cloudinary assets or production fault injection were used. The spent
harness was removed and generated reports remain local/ignored. This is not a
load benchmark. main/dev and their origin refs were synchronized by fast-forward
to 559222a; the workspace finished on dev. The Track/Stem contract remains Draft.
See the [self-contained results](docs/PROJECT_STATUS.md#released-tag-and-sort-feature-october-19-2026).

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
requiring those local reports. The
[October 18 Render verification](docs/PROJECT_STATUS.md#actual-render-verification-and-cleanup-october-18-2026)
passed 12/12 groups, with fixture cleanup and main-account preservation verified.

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

## Track realtime MVP (backend proposal, Draft)

Socket.IO shares the HTTP server/port; deploy one Node process/Render instance.
Guests can join public Tracks; owners can also join their private Tracks. Invalid
tokens reject the handshake. Token expiry removes membership and disconnects.
Counts measure room connections, including separate tabs, not audio playback.

Client events `track:join`/`track:leave` accept `{ trackId }` with ACK. Join/rejoin
returns a snapshot. Server events: `listeners:count`, `like:updated`,
`track:unavailable`, `auth:expired`. Like/Unlike remain REST. Notifications and
privacy/deletion revocation run after commit, never during retry/rollback.
Existing REST responses and access rules remain unchanged.

Read [the Draft event proposal](docs/REALTIME_EVENTS.md) for payloads, epoch/seq,
stale ACK handling and reconnect/rejoin. Phuc has not approved it. Epoch/seq do not
provide durable delivery. Redis/outbox, multiple instances and playback heartbeat
are outside MVP. Optional 30-second client resync remains a proposal.
Render Live **86aa3cb** passed **12/12 scoped groups** on October 19, 2026:
guest/owner-private access, WebSocket/polling and authentication, presence,
reconnect/rejoin snapshots, Like idempotency/concurrency, room switching,
committed privacy/deletion revocation, cascade and epoch recreation. The fixture
run recorded **53 HTTPS responses and 76 ACKs**; cleanup left zero temporary
Users/Tracks/Likes and preserved existing data, protected account and indexes.
DB disconnected; generated reports remain local/ignored. Earlier transport-failed
runs were cleaned and remain separate from this successful run.

JWT natural expiry, retry/rollback, publish-failure handling, process shutdown and
rate/pending bounds retain local test evidence; they were not newly exercised on
Render. No production fault injection or restart was performed. The configured
Origin was tested; Phuc's browser/Vercel integration and multi-instance operation
remain unverified. See [PROJECT_STATUS.md](docs/PROJECT_STATUS.md) for actual scope,
network retry details and separate historical test runs. Contracts remain Draft.

`npm run test:realtime` tests real loopback connections, auth/presence/lifecycle and
transaction retry/rollback/publish failure. Existing regression commands remain
`npm run test:tracks`, `npm run test:likes`, and `npm run test:uploads`.
