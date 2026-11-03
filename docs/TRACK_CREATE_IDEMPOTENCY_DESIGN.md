# POST Track idempotency: implementation and contract proposal

Implementation note: this is the preserved design snapshot from the earlier
design-only turn. The authorized backend implementation now accompanies this
branch; see [actual contract, verification limits and release procedure](TRACK_CREATE_IDEMPOTENCY.md).
Statements below about no runtime work/tests refer to that earlier design turn.

**Draft backend proposal - review required before implementation.**
November 3, 2026 (Asia/Saigon). Worktree branch:
`docs/track-create-idempotency`, based on freshly fetched `origin/dev`
**38161532e4515d2b0036988dc90b0728f4473275**, which merges PR #52.
Only this design document is added. No runtime/schema/index, dependency,
production, Cloudinary, commit or push operation is part of this design review.
The original checkout and handoff files remain intact. The Track/Stem contract
and upload option A remain Draft; this proposal does not approve either.

## 1. Existing behavior and the smallest proposed change

- [createTrack](../src/controllers/track.controller.js), lines 144-179, validates
  the request, then creates and enriches the Track in one transaction. Response
  is 201 `{data: Track}` only after commit; owner and counters are server-assigned.
  Options are primary reads, snapshot read concern and majority write concern.
- [enrichTracks](../src/services/track-response.service.js), lines 4-51, uses the
  same session sequentially in a transaction, with a public artist allowlist.
- [PR #52 evidence](MULTI_STEM_UPLOAD_VERIFICATION.md) covers seven localhost
  HTTP cases with mocked DB/provider, including response loss both before the
  handler and after a simulated commit. Both look unknown to the client; currently
  a new POST can create another Track. The documented 611 tests are prior evidence,
  not new tests of idempotency or actual Atlas concurrency.
- [Track](../src/models/Track.js) and [Stem](../src/models/stem.schema.js) contain
  no idempotency fields. Their response/input schemas must remain unchanged.
- [error middleware](../src/middlewares/error.middleware.js) returns `{message}`;
  forwarded 4xx errors lose their specific message. Known idempotency errors must
  be rendered explicitly by the controller, like known upload errors, rather
  than forwarded as generic 4xx errors.

**Proposed default:** optional `Idempotency-Key` for POST `/api/tracks`, with a
separate collection containing the successful creation response. Insert/update
that record in the **same transaction** as Track creation/enrichment. A unique
owner/key index is the concurrency authority. No local lock map, durable pending
lease, Redis, operation-status endpoint or change to Track/Stem is needed initially.
Clients without the header retain the existing path and duplicate-risk behavior.

## 2. Proposed request contract and payload identity

```text
POST /api/tracks
Authorization: Bearer <current token>
Content-Type: application/json
Idempotency-Key: <one opaque operation key, optional>

Body: existing CreateTrackRequest; no new JSON fields.
```

| Rule | Proposed contract |
| --- | --- |
| Scope | `(authenticated req.user._id, POST /api/tracks, key)`. A different account can independently use the same key. Never accept client artistId as the scope. |
| Key syntax | Exactly one header value matching `^[A-Za-z0-9._:-]{16,128}$`; case-sensitive. Reject empty, multiple, comma-joined, quoted or invalid values with 400. Header names remain case-insensitive. Recommend `crypto.randomUUID()` per intended creation. Do not use title, filename or a publicId as the operation key. |
| Validation order | JSON parser and authentication remain in their current order. In the authenticated handler validate header and existing body before any idempotency lookup/write. Invalid body stays 400, even when a key was previously used. Invalid/missing auth stays 401 before any replay. |
| Same payload | Compare the parsed, validated JSON body, with object keys recursively sorted and array order preserved. Ignore JSON formatting/property order; normal JSON numeric parsing makes 96 and 96.0 equal. Do not hash raw wire bytes. |
| Deliberately different | String whitespace/case, omitted versus explicit defaults, tag order, stem order/name/URL/duration/size or any other value change means different payload. Do not silently apply model trimming/default expansion for identity. This keeps hashing separate from Mongoose casting/defaults; clients must freeze the submitted body. |
| Hash | SHA-256 of UTF-8 `track-create:v1` plus a separator and canonical JSON. Store a hashVersion=1. Use a deterministic serializer for the accepted JSON types; do not introduce a hashing dependency. Only body fields that pass existing validation enter the hash. |
| Key storage | Store SHA-256 of the case-sensitive key as keyHash, not the raw header. Do not log raw keys, tokens or request bodies. Key possession grants no authentication or ownership rights. |

No client-supplied stemId/publicId/artist/likedByMe or other new body fields become
valid. Stable body identity v1 must remain supported for at least the retention
window across deployments; a future validator/hash change needs a compatibility
decision before rollout.

## 3. Response/error contract

All responses retain `Cache-Control: no-store`. These are proposed application
conventions, not a claim of conformance to a finalized header specification.

| Situation | Status/body | Headers and action |
| --- | --- | --- |
| No key | Existing 201 `{data: Track}` or existing error. | No new idempotency headers/queries. |
| New key, success | 201 `{data: Track}` after commit. | `Idempotency-Replayed: false`; `Idempotency-Key-Expires-At: <ISO-8601 UTC>`. |
| Active key, same payload | **201**, replay original `{data: Track}`. | `Idempotency-Replayed: true`, same expiration; no Track write or re-enrichment. |
| Active key, different valid payload | 409 `{message:"Idempotency-Key was already used with a different Track payload."}` | No Retry-After. Do not echo the key, hash, original body, Track ID or DB diagnostics in the error. |
| Same-key contention cannot yet be resolved | 409 `{message:"Track creation for this key is still being resolved. Retry with the same key and payload."}` | `Retry-After: 1`. This is retryable contention, not proof of a durable pending record. |
| Commit/DB outcome cannot be determined | 503 `{message:"Unable to confirm Track creation. Retry with the same Idempotency-Key and payload."}` | `Retry-After: 1`. Do not claim rollback or create again under a new key. |
| Invalid header | 400 `{message:"Idempotency-Key must be a single 16-128 character value using letters, digits, '.', '_', ':' or '-'."}` | No record written. |
| Invalid body, auth, oversized JSON | Existing 400/401/413 behavior. | No key is bound or consumed by these rejections. |
| Unrelated unexpected error | Existing sanitized 500. | Do not reinterpret all E11000/DB failures as idempotency conflicts. |

Only a **committed success** binds a key. Validation errors and known transaction
rollbacks are not cached. Two simultaneous different bodies can race for an unused
key: the first successful commit binds it; the other cannot also commit and must
resolve to a conflict/retryable outcome. Until that binding is visible, an exact
payload-mismatch answer is not guaranteed.

### Replay is a creation receipt, not a current GET

Store the JSON-safe original 201 body, not merely trackId. This preserves original
_id/stemId values, order, metadata and response context after lost responses, with
no new User/Like lookups that could fail after the original write already committed.
No password/email/private User fields or Authorization header enter the snapshot.

The snapshot may be older than later PATCHes, Likes or artist profile changes.
The client can GET detail to refresh current state. **Default proposed behavior
after DELETE is still replaying the creation receipt with the original ID**, not
recreating the Track; a current detail GET returns 404. DELETE must not remove
the retained idempotency record. An alternative is 410 when the original Track
has gone, but that changes replay semantics and requires a target existence read;
confirm this decision before implementation.

## 4. Separate model and exact index proposal

New model `TrackCreateIdempotency`, explicit collection `trackcreateidempotencies`:

| Field | Type / constraint |
| --- | --- |
| _id | Normal server-generated ObjectId. |
| ownerId | Required ObjectId from authentication; immutable for the record. |
| keyHash | Required 64-character lowercase SHA-256 hex; immutable. |
| requestHash | Required 64-character lowercase SHA-256 hex. |
| hashVersion | Required integer, currently 1. |
| trackId | Required ObjectId of the created Track. |
| responseBody | Required JSON-safe snapshot of `{data: Track}` after normal response serialization; status is implicitly always 201. Never reuse an unfiltered User object or req.body as a response. |
| completedAt | Required Date recorded near the end of the transaction. |
| expiresAt | Required Date = completedAt + 24 hours, not extended on replay. |

```javascript
// Proposal only. These declarations have NOT been applied.
index({ ownerId: 1, keyHash: 1 }, {
  unique: true, name: 'unique_owner_track_create_key'
});
index({ expiresAt: 1 }, {
  expireAfterSeconds: 0, name: 'track_create_key_expiry'
});
```

Use simple/binary collation. No status/pending/failed document is committed: the
record is written only after Track creation and enrichment succeed. No fields or
TTL index are added to `tracks`; expiration must never delete a Track. Ledger
contents are internal, not exposed by list/detail/Swagger Track schemas.

Collections/indexes must exist **before** the transaction path is enabled. Propose
model-local autoCreate/autoIndex disabled and an additive index provisioning CLI
following `ensure-track-most-liked-index.js`: inspect by default, explicit apply,
verify exact keys/options and preserve all existing indexes/data. Startup verifies
the collection and both indexes before listening; missing/incompatible indexes
fail readiness, never silently fall back to unsafe keyed writes. Keep TrackLike
index initialization. No syncIndexes, migration/backfill or DDL inside transactions.
No provisioning runs during this design task.

## 5. Transaction and concurrency algorithm

1. No header: keep the existing create path. Otherwise validate/hash, then perform
   a bounded primary/majority lookup for `(ownerId,keyHash)`. A valid unexpired
   result can immediately replay or reject a payload mismatch. Never use a
   secondary or a process cache to decide a key is free.
2. If no active result, enter `mongoose.connection.transaction()` with the existing
   primary/snapshot/majority options. Propose `timeoutMS: 10000` **only on this
   keyed path** to bound driver retry work; the lockfile has Mongoose 9.11.1 and
   MongoDB driver 7.7.0, whose local implementation forwards/supports this option.
   Validate timing/error propagation against the installed version during coding.
3. Inside the callback, read the ledger again using the session. Another request
   may have committed after the fast lookup. If active, resolve its hash/snapshot
   without creating another Track.
4. Otherwise sequentially create Track, enrich with the same session, serialize
   the JSON-safe success body, and insert the complete ledger record. Generate
   all attempt-local state inside the callback; a driver retry can rerun it.
5. For an expired record still present, **update that same ledger document** with
   the new successful operation instead of deleting/reinserting its unique key.
   Filter by its _id/owner/key and observed expiresAt; require matchedCount=1.
   Concurrent replacement or TTL deletion must abort/retry the entire transaction,
   not allow the staged Track to commit without its record.
6. Return only after the transaction promise resolves; then send 201 and replay/
   expiration headers. Ledger-write failure rolls back the Track just like an
   enrichment failure. No HTTP send, Cloudinary action or event emit occurs inside
   the callback. Do not call Promise.all inside it.
7. Catch specific ledger unique-index collisions/write conflicts **outside** the
   failed transaction. Perform one bounded primary/majority reconciliation read
   (proposed 2-second lookup budget). Resolve a complete unexpired record to 201
   or payload mismatch; unresolved known contention returns retryable 409.
8. For an unknown commit result or DB availability/timeout error, the same bounded
   reconciliation may recover a completed receipt. If it cannot, return 503 with
   the same-key retry instruction. An absent record on this read is not proof
   that an earlier commit cannot become visible. Do not delete/release a key or
   start a second fresh application transaction as an error-handler shortcut.
   A committed but incomplete/corrupt record is 503 and an internal operational
   alert, never permission to create another Track.

Do not wrap the transaction in a Promise.race that returns a timeout while DB
work keeps running unobserved. Use the driver budget and await its resolution/
reconciliation. These are bounded DB-work targets, not a guarantee that a proxy,
network or client connection stays alive for the full operation.

The compound unique index plus the shared atomic commit prevents two committed
Tracks for one account/key generation: if two callbacks stage different Tracks,
only one can persist the key; the other's entire Track write is rolled back.
An expired-row update similarly conflicts on the same document. This protection
does not depend on a single Node process. It does not enable multi-instance
realtime or other unrelated features.

During an in-flight transaction, another request can wait/retry inside the bounded
driver transaction, then return the receipt; if resolution exceeds the budget,
return 409/503 as above. This MVP deliberately makes no immediate, globally
observable `pending` status promise. Adding such a status requires a different
reservation/lease/fencing/recovery design. There is no in-memory queue, global
REST serialization or background in-flight timer to clean up.

Rollback removes both staged writes, so a later same-key attempt may succeed.
Driver handling of TransientTransactionError can retry the whole callback;
UnknownTransactionCommitResult handling retries the commit rather than blindly
rerunning application mutation. Preserve error labels; do not swallow DB errors
in the callback. If an HTTP client disconnects, do not start another operation or
delete the record; allow the bounded transaction to resolve. Retained receipts
survive process restarts and lost successful responses.

## 6. Retention and expiration contract

Propose **24 hours**, measured using the stored completedAt/expiresAt timestamps;
this covers normal upload-session/network recovery while bounding snapshot storage.
Record the time near the final write, not from the client clock or upload start.
The actual MongoDB commit follows that timestamp; the returned expiresAt is the
authoritative advertised boundary. Replays never extend it.

Compare `expiresAt <= serverNow` in application logic on every receipt decision.
TTL is eventual housekeeping, not the logical expiry mechanism. Once expired,
the same key (even the same body) may start a **new Track**, regardless of whether
TTL has physically removed the old record. If still present, replace its contents
atomically as step 5 above; never sweep/deletions across Tracks or assets.

The deduplication guarantee ends at expiration, not forever. After a long unknown
outcome, clients must reconcile intent before resubmitting outside that window;
changing the key does not resolve uncertainty. Deployments/clock configuration
must be consistent. Monitor ledger size; response snapshots add storage and this
proposal adds no new Track rate limit or asset quota.

## 7. CORS and OpenAPI changes

Current [REST CORS](../src/app.js), lines 22-26, sets only allowed origins. The
installed cors middleware reflects Access-Control-Request-Headers when no
allowedHeaders is configured, so Idempotency-Key is **not currently blocked by
an explicit header allowlist**. Keep this behavior and add preflight tests for
`authorization,content-type,idempotency-key`; do not replace it with a narrower
list that drops previously accepted headers.

Add REST `exposedHeaders` for Idempotency-Replayed,
Idempotency-Key-Expires-At and Retry-After, so browser code can read the proposed
response metadata. Preserve the shared exact origin policy, no-Origin clients,
Bearer auth and disabled cookie credentials. Socket.IO has no new keyed event or
header requirement; keep its origin/handshake policy unchanged. A request can be
preflight-allowed but still rejected by handler header validation.

In [track.routes.js](../src/routes/track.routes.js), document the optional header
only on POST, pattern/length, identity/expiry semantics, original/replayed 201
headers, and distinct 409/503 outcomes with Retry-After. Reuse `{message}` error
schema and existing Track response schema. Do not add fields to Track/Stem or
require the header globally. Document `Idempotency-Replayed` as an HTTP header
with string values `true`/`false`, not a JSON response property.

Coordinate client key/body persistence and parsing of response headers with Phuc.
Use the same key after reauthentication to the same account and after lost
responses; do not upload the files again solely to retry Track POST. Client API
helper changes must retain AbortError behavior. No frontend implementation is
claimed here, and old clients are not automatically protected.

## 8. Proposed implementation files and validation

| File(s) | Intended change |
| --- | --- |
| New `src/models/TrackCreateIdempotency.js` | Internal ledger schema, explicit collection and two indexes. No Track/Stem modification. |
| New `src/services/track-create-idempotency.service.js` | Header/hash helpers, keyed transactional create/replay, expiry and bounded reconciliation; typed known errors. |
| `src/controllers/track.controller.js` | Branch only when header is supplied; render known 400/409/503 messages/headers explicitly. Preserve the no-header path and all access rules. |
| New `scripts/ensure-track-idempotency-indexes.js`; `src/server.js` | Additive provision/inspection and read-only startup readiness verification. Honor DNS_SERVERS and disconnect in finally in the CLI. |
| `src/app.js`; `src/routes/track.routes.js` | Exposed response headers and OpenAPI POST contract, respectively. Origin policy/realtime logic unchanged. |
| New focused model/service tests; existing `track-write-transaction.test.js`, `multi-stem-publish.test.js`, `cors.test.js`, startup/index tests | Add coverage at the correct boundary and reuse the existing seven-case HTTP/provider fixture. Extend its DB adapter to model key persistence, not to pretend to prove MongoDB locking. |
| `package.json`, README, status and contract proposal docs | Explicit test file inclusion, deployment order, client examples and actual evidence. Keep proposed contract Draft until approved. |

Required tests before acceptance:

- No-header legacy regression; malformed/duplicate keys and existing body/auth
  errors before ledger access; no key/hash/private data leaks in errors or Track.
- Same account/key/body replays original 201 with exact Track/stem IDs and array
  order, no extra Track write or enrichment. Different property order matches;
  reordered stems/tags, different URL or explicit/omitted defaults conflict.
- Same key across accounts is independent; token renewal for the same account
  replays; missing/invalid token cannot retrieve a receipt. Active-key conflict
  messages and retryable headers remain in the existing error envelope.
- Concurrent same-key same/different bodies with controlled barriers, not sleeps:
  at most one committed Track; losers replay/conflict/retry as specified. Repeat
  with two independent service instances/DB sessions, without a shared local map.
- Enrichment/ledger insert/update/commit failures: no partial Track/receipt; known
  abort permits retry; unknown commit cannot trigger blind fallback or key deletion.
  Driver callback retry and commit retry must not persist duplicates or send early.
- Extend both PR #52 loss probes: after commit, same-key retry directly replays;
  before handler, same-key retry creates once. No-key unknown semantics stay as-is.
- Restart/process-loss recovery, absent/ambiguous reconciliation, and DB unavailability.
- Fixed-clock 24-hour boundary, replay without extending TTL, expired record present
  versus physically removed, concurrent expired-row replacement and TTL deletion.
  Existing Track/Like/Cloudinary data are untouched by expiration.
- Creation-receipt behavior after PATCH/Like/author change/DELETE, without
  re-enrichment, recreation or deletion of retained keys.
- Real allowed-origin preflight/exposure, denied-origin/no-Origin regressions,
  Swagger header/schema agreement, additive index idempotence and startup failure
  on missing/misconfigured unique/TTL indexes.

Run mocked HTTP suites first, then separately authorized replica-set/Atlas checks
for actual unique-index contention, rollback, TTL races and commit outcomes. Those
properties cannot be certified by the current in-memory adapter. Use scoped
fixtures and cleanup/disconnect safeguards; no production fault injection. A
later implementation must rerun affected Track/publishing/CORS/bootstrap/index
suites and npm test. No tests, DB connection, index creation or deployment were
run during this design turn.

## 9. Decisions for review

1. Approve optional single 16-128-character key and strict parsed-payload identity
   (including distinctions for whitespace, defaults and ordered arrays)?
2. Approve replaying the immutable original 201 creation receipt, including after
   Track edits/deletion, versus adding a 410 policy for deleted targets?
3. Approve 24-hour retention and the explicit possibility of a new Track after
   key expiry, with no automatic extension on replay?
4. Approve bounded wait/reconciliation with retryable 409/503 and no public durable
   pending/status endpoint for the initial implementation?

Cloudinary upload idempotency, pending-asset ownership/linking, orphan cleanup and
download delivery remain in a **separate asset-lifecycle design**. This feature
does not upload, delete, claim ownership of, or garbage-collect any audio asset.

## Technical references

These support the design; they are not runtime verification:

- [MongoDB unique indexes](https://www.mongodb.com/docs/manual/core/index-unique/):
  the compound uniqueness constraint arbitrates account/key ownership.
- [MongoDB transactions and retry behavior](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)
  and [Mongoose transactions](https://mongoosejs.com/docs/transactions.html):
  shared sessions, atomic commit and sequential transaction operations.
- [MongoDB TTL indexes](https://www.mongodb.com/docs/manual/core/index-ttl/):
  single-field background expiry cleanup, separate from application expiry logic.
- Installed-lockfile review: Mongoose 9.11.1 / mongodb 7.7.0. Local driver
  `lib/sessions.js` handles withTransaction timeoutMS and commit/callback retry;
  Mongoose `lib/connection.js` forwards transaction options. New runtime behavior
  still needs implementation tests against those versions.
