# My Collection frontend handoff (local backend feature)

Date: November 22, 2026 (Asia/Saigon). Branch: `feature/my-collection-api`.
Base: `ce5be9cfecc0111e50726a3aff9ca974b4607a9f` from fetched `origin/dev`.
Not committed, pushed, merged, deployed or tested on Render. No shared DB/index,
production data or Cloudinary operation is included. The overall Track/Stem and
realtime contracts remain **Draft**.

## Requirement interpretation and authorization boundary

Source: **WEB APPLICATION PROJECT.docx**, section 3 Module 4, states Like and a
"My Collection" page for listeners. Section 4 describes Likes as userId/trackId
membership. It does not specify named collections, multiple saved folders,
collection CRUD or a separate collection membership schema. This backend MVP
therefore exposes the liked-Track list under Nguyen's current implementation
request. It does not claim to implement future independently named collections;
that would need a separate agreed model. Backend delivery does not complete the
frontend My Collection page or approve the full data contract.

## HTTP contract

```http
GET /api/tracks/liked?page=1&limit=12
Authorization: Bearer <current access token>
```

This static route is registered before `/:trackId`. Authentication is mandatory;
use `auth: "required"` in the current frontend API helper. Do not retry a rejected
personal collection read as guest. Keep tokens out of URLs/logs and abort/fence
old requests after page/account changes, Sign out or unmount.

| Query | Rule |
| --- | --- |
| page | Default 1; decimal positive integer string, no leading zero/fraction/exponent; safe integer and safe offset |
| limit | Default 12; same integer syntax, range 1-100 |
| Others | Unsupported, including userId, artistId, isPublic, q, tag and sort; return 400 |

Repeated or object/operator forms are rejected. Clients cannot change account or
visibility scope. A request body cannot select another account.

Success is 200 `{data: [...], pagination: {page, limit, total, totalPages}}`, with
`Cache-Control: no-store`. Empty collection: `data=[]`, `total=0`, `totalPages=0`.
A beyond-last page is empty but keeps the accessible total. Count includes only
that account's liked Tracks which still exist and are public or owned by it.
Foreign-private titles/IDs/metadata and orphan Like records do not leak through
rows, totals or gaps caused by filtering after pagination.

Order: Like `createdAt DESC`, then Like `_id DESC`. This differs from Track
creation order and from mostLiked. Like timestamps/IDs are not response fields.
Unlike removes membership; re-Like creates a new membership and moves it to the
front. Duplicate Like does not reorder it. No filter/sort extension is promised.

Each item uses the existing Track response, including stable stemId/order,
artistId, `artist: {_id, username, avatarUrl}` (or null), and `likedByMe` for this
account. Internal version keys and Like documents are not returned. Missing User
keeps an otherwise accessible Track with artist=null; lookup failure is an error,
not null/false fallback. In a stable state all returned Tracks are likedByMe=true.
Mutations can occur after the aggregation and before/after context refresh; this
is not a cross-request snapshot or durable collection cursor. Refetch after changes.

| Error | Behavior |
| --- | --- |
| 400 | Invalid/repeated/nested/unsupported query or unsafe offset; no collection query |
| 401 | Missing, malformed, invalid/expired token or missing User; no guest collection |
| 500 | Auth, aggregation or enrichment failure; sanitized message, no false empty success |

Errors retain `{message: string}`. Global REST CORS already permits the existing
Authorization header; no new header/environment configuration is introduced.
This endpoint will not exist on Render until the feature is released.

## UI integration

```javascript
const query = new URLSearchParams({ page: String(page), limit: "12" });
return apiFetch(`/api/tracks/liked?${query}`, { auth: "required", signal });
```

Use collection-specific loading/error/empty states and the normal Track cards.
Keep this separate from My Tracks: My Tracks means ownership; this endpoint means
Like membership plus access. Like/Unlike remain PUT/DELETE `/api/tracks/:id/like`
and retain `{data:{trackId,isLiked,likesCount}}`. Reload/invalidate this list after
mutations. If a removal shrinks the last page, use the refreshed total to select
a valid page, without letting an obsolete response navigate a newer selection.
Clear personalized data on session changes and ignore old response/401 callbacks.

Visibility changes do not remove a Like. A newly foreign-private Track disappears
from this list and its total; if public access returns, retained membership can
make it appear again. DELETE Track cascades Likes in the existing transaction.
An orphan Like is defensively ignored. This API never changes memberships/assets.
Private Track API access and isDownloadable are not protection for a previously
known public CDN URL. This feature adds no download/asset lifecycle capability.

## Query and index boundary

One TrackLike aggregation matches the authenticated user, joins existing Tracks,
checks public/self-owned-private access, then facets data and count from that same
input. Only the selected page is hydrated and passed to existing batched Track
response enrichment: one author query and one membership query, not per Track.
Empty pages skip enrichment reads. No unbounded Like-ID array is collected in Node.

No Track/Like schema, startup or index declaration/provisioning changes. The
existing unique index starts with trackId, not userId; assess a user-leading index
with measured workloads if collection sizes grow. This is not a performance or
scale certification. No hint, syncIndexes or shared DDL is used by this feature.

## Reproduction and verification layers

```powershell
npm.cmd ci
npm.cmd run test:collection
npm.cmd test
```

The focused suite uses real routes/controllers/authentication JWT and loopback
HTTP, with DB aggregation/enrichment adapters. Cross-request Like changes use a
committed-membership fixture; existing Like suites retain transaction coverage.
These mocks do not establish MongoDB aggregation/transaction behavior.

Optional real-Mongo verification reuses the repository's already pinned tool
manifest, without changing application dependencies:

```powershell
npm.cmd ci --prefix scripts/verification/track-idempotency --ignore-scripts
node scripts/verification/track-collection.cjs
```

The opt-in runner accepts no URI or credentials, never loads .env, disables
model auto-indexing, and uses a fresh 127.0.0.1 single-node WiredTiger replica set.
It verifies the generated URI/database/replica-set identity before disposable DB
DDL/fixture mutations. It runs actual Auth/Like/PATCH/DELETE and the collection
aggregation through HTTP. No provider operations occur. Its finally block stops
HTTP/Mongoose/mongod and removes only its own validated temporary data directory;
no database-drop command is issued. Reports and MongoDB binary cache stay outside
the repository. The seven opt-in groups are not added to automated test totals.

## Actual results (November 22, 2026)

- `npm.cmd run test:collection`: 37/37 passed using isolated loopback/mock DB
  fixtures, zero failures/skips. This new file runs exactly once within test:tracks.
- Full `npm.cmd test` / test:ci passed all 696 automated cases: CORS 28, Auth 77,
  Tracks 354 (including the 37 new collection cases), idempotency 32, uploads 59,
  multi-stem publishing 7, Likes 51, realtime 40, recovery 26 and indexes 22.
  The earlier standalone 37-test run is not added again to 696.
- Optional real-Mongo runner: 7/7 groups passed on MongoDB 8.0.34, WiredTiger,
  one-node replica set bound to 127.0.0.1, using mongodb-memory-server 11.3.0.
  The final probe rerun after cleanup hardening also passed the same seven groups;
  it is not another seven automated tests. Both runs cleaned their resources.
- Actual Mongo HTTP evidence covers login/JWT, empty/authenticated reads, real
  Like/Unlike, account scope, PATCH privacy changes, stable Like-time/ID pages,
  orphan joins, missing author/allowlist, transactional Track DELETE cascade,
  all-hidden totals and bad query handling. This is not a load/failover benchmark.
- Final teardown flags all true: HTTP closed, Mongoose disconnected, mongod
  stopped and its validated temporary data directory removed. Only a sanitized
  report and reusable official-binary cache remain outside Git. No shared DB,
  index, protected account, existing Track, provider asset or Render was touched.

`npm ci` kept the application lockfile unchanged and reported nine audit
advisories (six moderate, three high). Dependency/audit remediation is separate;
no audit fix or unrelated version update was performed. No Render/Atlas acceptance
or frontend My Collection implementation is claimed. The contract remains Draft.
