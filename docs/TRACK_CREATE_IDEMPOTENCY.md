# Optional Track creation idempotency

Implemented locally on `feature/track-create-idempotency`, based on dev
`38161532e4515d2b0036988dc90b0728f4473275` (November 3, 2026).
Backend choices follow Nguyen's implementation authorization. The overall
Track/Stem contract and multi-stem upload option A remain **Draft**; this is not
Phuc's approval or evidence of frontend integration.

## HTTP contract

Only POST `/api/tracks` interprets the optional `Idempotency-Key` header.
Authentication and existing CreateTrackRequest validation still apply.

- One parsed ASCII value matching `^[A-Za-z0-9._:-]{16,128}$`, case-sensitive.
  UUIDs are supported. Empty/invalid or repeated headers are 400; merged comma
  values are rejected. HTTP parser normalization of outer whitespace is not
  additional application trimming; embedded whitespace is invalid.
- Scope is authenticated account + this endpoint + key. No client owner/ID field
  is accepted. Same key under a different account is independent.
- With no header, the existing create transaction runs with no receipt queries.
- Hash v1: SHA-256 of `track-create:v1\n` plus canonical parsed/validated JSON.
  Object property order and JSON formatting do not matter. Arrays, string
  whitespace/case and explicit versus omitted defaults matter. No normalization
  to Mongoose defaults is performed for hashing. Freeze key/body for retries.
- Only a committed success binds the key. Invalid body/auth and known rollback
  do not consume it. Keep the existing StemInput allowlist: name, audioUrl,
  duration, fileSize; no publicId or new JSON field.

| Situation | Status/body | Response headers |
| --- | --- | --- |
| First keyed success | 201 `{data: Track}`, only after commit | Idempotency-Replayed: false; Idempotency-Key-Expires-At: ISO UTC |
| Same active key/body | 201, original serialized JSON, same Track/stem IDs | Idempotency-Replayed: true; original expiration |
| Same active key, different valid payload | 409 `{message:"Idempotency-Key was already used with a different Track payload."}` | No Retry-After |
| Unresolved key contention | 409 `{message:"Track creation for this key is still being resolved. Retry with the same key and payload."}` | Retry-After: 1 |
| Unknown commit or unavailable DB/lookup | 503 `{message:"Unable to confirm Track creation. Retry with the same Idempotency-Key and payload."}` | Retry-After: 1 |
| Invalid key/body/auth | Existing `{message}` envelope, 400/401/413 as applicable | No successful receipt created |

All Track responses retain Cache-Control: no-store. Unexpected unrelated errors
keep the sanitized existing error handling. A duplicate on another unique index
is not converted into a key conflict. Known idempotency errors are rendered by
the controller so the generic 4xx middleware does not erase their messages.

Replay is an immutable **creation receipt**, not a current GET. Later metadata,
artist, Like state or deletion does not change it. Replay after DELETE returns
the old 201 receipt and does not recreate the Track; detail can return 404.
Refresh detail separately for current state. A reauthenticated account can reuse
its key; an invalid/expired token cannot replay anything.

Receipt retention is 24 hours from its recorded completion timestamp near the
final transactional write, advertised as expiresAt. Replay never extends it.
Application comparisons enforce expiry independently of eventual TTL deletion.
At/after expiry the same key can create a new Track. An unknown outcome older
than the window still requires reconciliation before a new publishing intent.

## Persistence, transactions and concurrency

Internal collection: `trackcreateidempotencies`, model
[TrackCreateIdempotency](../src/models/TrackCreateIdempotency.js).
It contains ownerId, keyHash, requestHash, hashVersion=1, trackId, JSON-safe
responseBody, completedAt and expiresAt. No raw key, Authorization, credential
or unfiltered User is stored. Track and Stem schemas are unchanged.

Two named declarations, in addition to the normal _id index:

```javascript
{ key: { ownerId: 1, keyHash: 1 }, unique: true, name: 'unique_owner_track_create_key' }
{ key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'track_create_key_expiry' }
```

The service first reads a receipt on primary with majority read concern and a
2-second lookup timeout. Receipt command buffering is disabled, so a disconnected
model does not queue reads while awaiting reconnect. Otherwise it runs a transaction with the existing
primary/snapshot/majority settings and timeoutMS=10000, rechecks the receipt,
creates Track, enriches sequentially with the same session, serializes the JSON,
and writes the complete receipt. No committed pending lease exists.

Concurrent new-key transactions can stage writes, but the unique receipt index
arbitrates the commit: the losing transaction must roll back its Track.
An expired receipt still present is replaced using the same document with
observed _id/owner/key/expiry guards; TTL deletion or another replacement forces
rollback/retry rather than committing an unpaired Track. No delete-and-reinsert
of a unique key inside the same transaction is used.

The installed Mongoose 9.11.1 forwards timeoutMS to mongodb 7.7.0 withTransaction.
TransientTransactionError can retry the callback; UnknownTransactionCommitResult
can retry commit. The service preserves labels, including causes, and does one
bounded primary reconciliation after recognized failures. Unknown outcomes do not
authorize key deletion or a fresh application mutation in an error handler.
No Promise.all or early Promise.race response runs inside/around the transaction.
Budgets bound driver work, not proxy/client lifetime.

No process-local lock, recurring timer or queue is added. There are no Cloudinary
calls, event emissions or HTTP sends inside the transaction. Mongoose owns session
cleanup; success is sent after the transaction resolves. Receipts survive restart.

## Index provisioning and release procedure

**Isolated replica-set verification is recorded below. Independent review and
deployment DB index provisioning remain release prerequisites. No shared or
production database/index was changed in this task.**

1. Complete independent review, using the isolated replica-set results and their
   topology limits below. Do not infer multi-node failover durability from mock
   tests or a one-node replica set.
2. Use the approved maintenance checkout containing the CLI. Supply the project's
   existing DB configuration privately, selecting the database explicitly. The
   CLI honors DNS_SERVERS, checks users/tracks/tracklikes exist and verifies the
   selected database; never paste URI/passwords into reports.
3. Inspect without DDL:

   ```powershell
   node scripts/ensure-track-idempotency-indexes.js --dry-run
   ```

   Default is also dry-run. Exit 0 means ready; 2 means required objects are
   missing; 1 means failure/conflict. Missing objects are reported without writes.
4. Only after approval for that exact database, provision:

   ```powershell
   node scripts/ensure-track-idempotency-indexes.js --apply
   node scripts/ensure-track-idempotency-indexes.js --dry-run
   ```

   Apply creates only the missing receipt collection/indexes, validates the whole
   existing catalog first, preserves old indexes and verifies afterward. Rerun is
   safe. Conflicting names/keys/unique/TTL/collation/partial/sparse/hidden options
   stop rather than drop/replace. No syncIndexes is used. The CLI always attempts
   DB disconnect in finally and suppresses sensitive DB diagnostics.
5. Merge feature -> dev -> main and deploy only after provisioning/verification.
   Startup keeps TrackLike.init, then performs read-only receipt collection/index
   verification before Socket.IO attach/listen. The new model disables automatic
   collection/index creation. Missing indexes fail readiness; there is no unsafe
   fallback. Startup failure disconnects DB.
6. Run separately authorized scoped post-deployment HTTP checks and cleanup.
   Keep receipts if rolling back code: dropping them would discard recovery
   history. Old clients still work but lack keyed duplicate protection.

No new environment variable, dependency or credentials are required by the API.
The existing REST origin allowlist is unchanged. Request-header reflection
already permits Idempotency-Key in preflight; CORS now exposes
Idempotency-Replayed, Idempotency-Key-Expires-At and Retry-After. Socket.IO policy
is unchanged. Swagger documents only the POST header, 201 headers and 409/503.

## Verification and limits

Commands (Node 24, Windows):

```powershell
npm.cmd ci
npm.cmd run test:idempotency
npm.cmd test
```

Tests exercise actual localhost HTTP app/routes/middleware/validators, real
bcrypt/JWT and JSON serialization. DB/provider are isolated mocks; synthetic WAV
uploads never reach Cloudinary. The old seven multi-stem cases remain, plus keyed
retries for both transport-loss points using the same HTTP/provider fixture.
Counters/membership changes test creation-snapshot semantics; existing Like
suites retain coverage of actual REST Like/Unlike mutation behavior.

Service tests use controlled barriers for mock concurrent sessions, rollback,
expiry and TTL deletion/replacement. Installed-driver tests invoke its real
withTransaction with stubbed commits and no connection, asserting callback versus
commit retry behavior. Index/CLI tests use an in-memory catalog; bootstrap tests
verify readiness, failure cleanup and shutdown without late listeners.

Actual final full `npm.cmd test`: **659 passed**, zero fail/cancel/skip, including
32 idempotency cases (21 service/model/driver, 11 HTTP/Swagger), 7 existing publish
cases, 22 index tests and 40 realtime/bootstrap tests. See PROJECT_STATUS.md for
the complete breakdown. Targeted runs are not counted again. npm ci left the
lockfile unchanged and reported 8 audit advisories (6 moderate, 2 high); no
dependency fix was attempted.
At that initial checkpoint, no local mongod/Docker executable was available and
the real replica-set checks were outstanding. The follow-up below closes the
single-node transaction/concurrency/TTL gap. The 659-test result remains the
existing automated run at that checkpoint. During final review it was rerun after
the strict key-character check below: **659 passed again**, zero fail/cancel/skip.
GitHub/Ubuntu, Render and shared Atlas remain unverified for this feature.

Final review hardened parseKey to reject every character outside the ASCII
allowlist, including a final line terminator that JavaScript's `$` anchor alone
would accept. Node's HTTP parser already rejects such wire headers; service
validation now enforces the rule independently. Extra assertions were added to
the existing parser case, without changing the number of automated tests.

## Isolated real MongoDB verification (November 3, 2026)

Environment: Windows 10.0.26200, Node 24.15.0, application Mongoose 9.11.1 and
mongodb driver 7.7.0. Opt-in tool package mongodb-memory-server **11.3.0**;
actual buildInfo confirmed mongod **8.0.34**, Windows x64, **WiredTiger**.
MongoMemoryReplSet started one member, bound to 127.0.0.1 on a dynamically selected
port, with a unique replica-set/database name and generated test-only credentials.
No Docker, existing mongod, project .env or shared database was used.

The binary was downloaded with MD5 checking enabled from MongoDB's official
[Windows archive](https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.0.34.zip),
listed in the [official release archive](https://www.mongodb.com/try/download/community-edition/releases).
The first attempt supplied MONGOMS_DOWNLOAD_URL explicitly; memory-server 11.3.0's
archive-name parser rejected the `windows` platform segment with
`Expected "input" to have Regex Matches`, before download/start. Removing that
override and using the pinned version with MONGOMS_DOWNLOAD_MIRROR set to
`https://fastdl.mongodb.org` let its default Windows URL generator download and
start the same official binary. TLS verification was not disabled.

### Reproduction from a fresh checkout

Reusable probe code is versioned in a separate private tools package:

```text
scripts/verification/track-idempotency/
  run.cjs
  app-worker.cjs
  cli-worker.cjs
  package.json
  package-lock.json
```

From the repository root on Node 24, install both lockfiles and opt in explicitly:

```powershell
npm.cmd ci
npm.cmd ci --prefix scripts/verification/track-idempotency --ignore-scripts
node scripts/verification/track-idempotency/run.cjs
```

The nested lockfile pins the test tool's dependency graph. It does not change the
application lockfile/runtime dependencies. --ignore-scripts prevents the tool's
install-time binary download; the explicit run downloads the pinned official
binary if it is not cached. No existing URI, DB or credential argument is accepted.
The application checkout is resolved relative to the script. npm test/test:ci do
not install or run this probe. Linux/macOS behavior remains unverified; the
memory-server downloader selects the corresponding official platform archive.

Reports/data are created under an OS temporary `stemforge-idempotency-proof-*`
directory, outside the checkout. Binaries are cached separately under OS temporary
`stemforge-mongodb-binary-cache`. The runner prints the nonsecret report path.
Its verification status requires exactly 15 successful groups; cleanup is recorded
independently and cannot upgrade incomplete verification to passed. Timeouts are
cleared on settlement, barriers are released, and cleanup stages continue even if
another cleanup stage fails. Live mongod data is never removed after a failed stop.

The original three external scripts, binary cache and sanitized earlier reports
are preserved at `C:\Users\USER\AppData\Local\Temp\stemforge-mongo-proof-20261103-f77533bf`.
They are historical local evidence, not prerequisites for reproducing the probe.
Nothing from their node_modules, binary cache, database directories or reports is
included in the feature diff.

Each invocation starts its own replica set and generates a new marker/report.
It uses only the URI returned by that new set. Before DDL/cleanup it validates
the exact captured URI, loopback host/port, database, replicaSet parameter and
live hello identity. Child processes also validate the URI before connecting.
There is no fallback to MONGO_URI. Child environment variables come from a small
OS-only allowlist plus generated fixture values; dotenv loading is disabled only
in these test-only workers. Passwords/JWTs stay in memory/IPC and are not in reports.

Two independent child processes run actual src/server.js and the HTTP app with
separate Mongoose clients/sessions. Login uses real bcrypt/JWT against temporary
Users; Track payloads use placeholder HTTPS audio URLs. Actual Cloudinary upload
and destroy are forbidden by test-only worker hooks. The CLI worker invokes the
actual CLI against the same guarded temporary DB. Fault/barrier hooks exist only
in these opt-in workers; no production fault injection was added.

### Final result: 15/15 external probe groups passed

| Group | Actual evidence |
| --- | --- |
| Index provisioning/readiness | Actual CLI missing dry-run exit 2; startup exit 1 before listen; apply/dry-run exit 0; repeated apply created zero indexes and preserved the catalog. |
| Incorrect indexes | Wrong unique option and wrong TTL interval refused by CLI/startup; only owned test indexes restored. No syncIndexes. |
| Identical concurrent requests | Twelve HTTP requests across two app processes all returned 201, identical JSON/Track ID/four stem IDs; DB contained one Track and one receipt. |
| Different payload concurrency | Simultaneous valid payloads under the same owner/key returned 201/409; subsequent losing payload remained 409; only one Track/receipt. |
| Account scope | Same key under two real authenticated test accounts produced two distinct Tracks and two receipts. |
| Rollback before enrichment | Real Track insert followed by thrown enrichment error returned 500; zero Track/receipt; same-key retry on other process created exactly one pair. |
| Rollback after enrichment | Real enrichment reads then error rolled back Track; same-key retry succeeded once. |
| Rollback after receipt insertion | Error after actual receipt insert rolled back both writes; retry created exactly one pair. |
| Lost HTTP response | Worker destroyed response socket after actual commit; other process replayed original 201 receipt without duplicate. |
| Server unknown commit | mongod failCommand once on commitTransaction, error code 1 with UnknownTransactionCommitResult; command monitoring observed two commit commands, one Track insert, one committed pair. |
| Lost successful commit ACK | Test-only wrapper awaited real successful commit then threw UnknownTransactionCommitResult once; driver sent another successful commit command; one Track insert/pair. This is controlled ACK suppression, not a real network failure. |
| Unresolved commit budget | Repeated server commit errors, blocked 1200ms per command, exhausted the 10s driver budget; HTTP returned 503/Retry-After: 1. After failpoint removal, six same-key retries returned 409 while server state remained unresolved, then 201 after 69,885ms, one Track/receipt. |
| Expired receipt retained | With TTL monitor paused, two app processes contended to reuse an expired existing row; both received the same new receipt; old plus one new Track, one receipt. |
| Real TTL deletion race | Actual TTL monitor deleted the expired row while a transaction was paused after Track insert; update failed with code 112/TransientTransactionError, driver retried callback (two insert attempts); only one new Track committed. |
| PATCH/DELETE then replay | Actual REST mutations changed/deleted Track; retries replayed original JSON; deleted Track remained absent and receipt remained. |

The first fault probe used code 91 (ShutdownInProgress) with an overly strict 201
expectation and received the contract-allowed 503. The final targeted retry probe
uses code 1 plus the explicit unknown-commit label to isolate commit retry from
shutdown error handling. Another initial probe incorrectly expected immediate
201 after clearing sustained commit faults; actual 409 exposed the unresolved
server transaction. The final probe waits for actual server resolution while
preserving key/body. Neither trial established an application defect, and no
runtime/test-source fix was required. Their reports remain local with the final
report; they are not counted as additional passed tests. A later parser hardening
change during final review is described above and is unrelated to these trials.

### Final-review rerun of the versioned probe

The in-repository runner passed **15/15 groups** and exited 0 on the final source,
using the same pinned tool/binary versions. Local report:
`C:\Users\USER\AppData\Local\Temp\stemforge-idempotency-proof-N8DBTZ\result-4598dfc4cb0fd6cb.local.json`.
The sustained-fault case again returned 503, six retryable 409s, then 201 after
70,178ms; the TTL race again observed two insert attempts and one new committed
Track. Explicit app sessions were balanced at shutdown: 20/20 in process A and
21/21 in process B. Both verification and cleanup statuses were passed; all five
cleanup flags below were true. This rerun replaces no historical checkpoint and
is not another 15 automated tests. The earlier in-repository run also passed
15/15; its local report remains under `stemforge-idempotency-proof-83CGpu`.

### Cleanup and limits

The final runner exited 0. Its finally report confirmed childrenExited,
databaseDropped, connectionClosed, replStopped and dataDirectoryRemoved were all
true. Workers release barriers and use actual server SIGTERM shutdown; the parent
disconnects Mongoose, stops MongoMemoryReplSet and removes only its validated own
data path. Temporary credentials, sessions and connections cease with their
clients/server. Earlier failed trials also completed all five cleanup checks.
Only tool scripts, sanitized local reports and the reusable binary cache remain;
no run-data directory or test node/mongod process remained after the final run.

This is **single-node** transaction/unique-index/concurrency evidence, not primary
stepdown/election, multi-node majority durability, OS network ACK-loss or production
deployment evidence. Failpoints require enableTestCommands on the disposable
server only. No shared Atlas, Render or Cloudinary operation was performed; no
shared indexes were provisioned. The remaining release procedure above still
applies. Keep the 15 opt-in probe groups separate from the 659 automated tests.

Cloudinary asset ownership/linking, upload idempotency, cleanup and controlled
download delivery remain a separate lifecycle task. This implementation only
deduplicates Track creation; it neither uploads again nor deletes any asset.
