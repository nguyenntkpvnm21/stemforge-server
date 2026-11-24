# Mongoose security checkpoint

Date: November 24, 2026 (Asia/Saigon). Status: local patch, not staged,
committed, pushed, merged or deployed. Branch `fix/mongoose-security` from
fetched `origin/dev` **64face461cd83fb66938ae6c18ed200fd9a99e6c** (body-parser
PR #63 merged). Fetched main was 8f8798533bb5da4863f9a6e2240a899edeabc63c.
This patch does not use the former body-parser branch as its base.

The separate quality-evaluation worktree's five handoff files remain unchanged,
anchored to **b3c72c576ac7183bdfce955577de172ddac5253b**. Its historical 752-test,
performance and audit figures are not results for this patch. The previous
body-parser checkpoint is also retained. The overall contract remains Draft.

## Minimal dependency change

The root range remains `mongoose: ^9.11.1`; package.json is unchanged.

| Installed path | Before | After | Reason |
|---|---|---|---|
| stemforge-server -> mongoose | 9.11.1 | 9.11.4 | Requested security patch |
| mongoose -> kareem | 3.4.0 | 3.4.1 | Exact dependency required by 9.11.4 |
| mongoose -> mquery | 6.0.0 | 6.0.1 | Exact dependency required by 9.11.4 |

Exactly these three lockfile nodes changed (11 insertions, 11 deletions).
The installed tree contains one Mongoose copy. MongoDB driver 7.7.0,
Multer 2.4.0, Express 5.2.1, body-parser 2.4.0 and qs 6.17.1 are unchanged.
No overrides, new direct dependency, major upgrade, schema/index/API change,
sanitizeFilter change or application source change was made.

The official [9.11.4 release](https://github.com/Automattic/mongoose/releases/tag/9.11.4)
and package metadata were checked. Both Mongoose versions require Node >=20.19.0,
compatible with the project's Node 24. npm's current latest 9.x was 9.13.0;
a publication cutoff selected the requested patch without widening the manifest
or pulling that newer minor and its driver changes. The cutoff is one second
after 9.11.4's official registry publication timestamp.

```powershell
npm.cmd update mongoose --package-lock-only --ignore-scripts --no-audit --no-fund --before=2026-10-23T17:05:34.476Z
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd explain mongoose
npm.cmd ls mongoose kareem mquery mongodb multer body-parser qs --all
npm.cmd audit --json
```

Review the lockfile after any future resolution; the cutoff documents this
specific update, not a policy to keep dependencies indefinitely at that date.
The evaluated lockfile SHA-256 is:

```text
36531c37126d4527706cdff760cfcdcaa14a8cba4d159aa4bf27bc2a077ea62d
```

## Final source verification

Windows 11 x64; Intel Core Ultra 7 155H, 22 logical CPUs, 31.61 GiB RAM;
Node 24.15.0, npm 11.12.1. After a clean npm ci, the complete automated suite
ran **once** on the final patched dependency tree:

```powershell
npm.cmd test
```

Result: **761 passed, 0 failed, 0 cancelled, 0 skipped**. In this revision npm
test invokes test:ci (it is not a placeholder). Counts by explicit suite:
JSON 9, CORS 28, Auth 77, Tracks 410, idempotency 32, uploads 59, publish flow 7,
Likes 51, realtime 40, recovery 26, index helpers 22. Focused suites are included
once; separate Mongo probes below are not added to this total. No new automated
test or npm script was necessary for this lockfile-only runtime update.

### Separate real-MongoDB evidence

Reused the existing opt-in runners and test workers, with MongoMemoryReplSet
11.3.0 / official MongoDB 8.0.34 / WiredTiger / one replica-set node bound to
127.0.0.1. Each run used generated credentials and a guarded, disposable database;
no project .env/shared URI fallback or shared DB/provider connection was used.

| Probe layer | Actual result | Relevant coverage |
|---|---|---|
| Transaction/CRUD adapter | 17/17 groups passed | Non-key CRUD, API/model validation, private access, Like cascade; PATCH enrichment rollback; two-process concurrency; receipt replay and rollback |
| Existing Collection runner | 7/7 groups passed | Real aggregation and Track.hydrate(), ACL before pagination/total, hidden/orphan Tracks, Like/Unlike, ordering, DELETE |
| Existing Download runner | 6/6 groups passed | Real Auth/read/PATCH/DELETE, owner/private/download flag, stem identity and stored URL validation; local dummy signing only |

The transaction adapter reuses the repository's actual app-worker.cjs and
cli-worker.cjs. It retains 15 idempotency groups and adds two targeted groups:
non-key CRUD/validation/Like cascade, and PATCH enrichment-failure rollback with
metadata/timestamps unchanged. Twelve same-owner/key/payload HTTP requests across
two independent application processes produced one Track and one receipt with
identical JSON and stem IDs. Different-payload contention returned 201/409;
account scope, rollback at three POST boundaries and lost-HTTP-response replay
also passed.

Controlled local mongod failCommand caused UnknownTransactionCommitResult and
commit retry with one Track insertion; a separate test-worker post-commit ACK
suppression exercised the response-loss boundary. Sustained commit faults
returned 503, followed by retry statuses 409/503/409/409/409/201 as the server
resolved the operation. An absent receipt or timeout was never interpreted as
proof of rollback. Retained-expiry contention and an actual TTL deletion race
passed; the latter observed TransientTransactionError/write-conflict retry.
PATCH/DELETE followed by replay preserved the original receipt without recreation.
These are single-node controlled-fault results, not a multi-node election,
network partition, Production or failover acceptance test.

Reproduction from this checkout:

```powershell
npm.cmd ci --prefix scripts/verification/track-idempotency --ignore-scripts --no-audit --no-fund
node scripts/verification/track-collection.cjs
node scripts/verification/stem-download.cjs
# Run with the checkout as the current directory; adapter is in the external handoff.
node "D:\Temp\USER\stemforge-mongoose-proof-20261124-fa9a910d\mongoose-transaction-probe.cjs"
```

The external adapter is not an automated-suite addition or a production fault
hook. It asserts Mongoose 9.11.4, accepts no URI argument and verifies loopback,
port, database and replica-set identity before database operations. It avoids
the older runner's database-drop cleanup: it disconnects, stops its own replica
set and removes only its validated owned data directory. Repository workers and
optional tooling lockfile are unchanged. The adapter and sanitized raw reports
are retained outside Git with commands in the handoff; move that directory and
adjust its path when reproducing on another machine.

An initial adapter attempt terminated with native exit -1073740791 and produced
no result report. It is inconclusive, not a passed group; local data remained.
After checking no owned process remained, its exact generated data directory
was removed. The direct retry above completed all 17 groups. Successful reports
confirm HTTP/child processes closed, all sessions ended (25/25 and 21/21 across
the two workers), parent connections disconnected, mongod stopped and owned data
removed. Final process inspection found no process belonging to these runs.
No database drop was used. The binary cache is retained for reuse.

## Audit and conditional upload exception

Main-project lockfile audit changed from **7 flagged package nodes (2 high,
5 moderate)** to **6 (1 high, 5 moderate)**, zero critical in both runs.
These are package-node counts, not counts of distinct advisories. All Mongoose
entries below disappeared from the post-patch audit:

- [GHSA-gg4r-jv3p-qx3c](https://github.com/advisories/GHSA-gg4r-jv3p-qx3c)
- [GHSA-wr5m-5jph-8m96](https://github.com/advisories/GHSA-wr5m-5jph-8m96)
- [GHSA-8332-j7wj-wjw4](https://github.com/advisories/GHSA-8332-j7wj-wjw4)
- [GHSA-6972-9mcm-vhwj](https://github.com/advisories/GHSA-6972-9mcm-vhwj)

Remaining package nodes are Multer (high), fast-uri, glob, ip-address, minimatch
and swagger-jsdoc (moderate, including transitive attribution). The earlier
body-parser/qs advisories remain absent. These other dependency updates are
outside this patch; no claim of a zero-vulnerability audit is made.

**Conditional exception:** Multer remains 2.4.0 with
[GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m), affected
2.x before 2.5.0. Its asynchronous-fileFilter teardown condition is not present
in the current synchronous callback in src/middlewares/audio-upload.middleware.js.
POST /api/uploads/audio authenticates and rate-limits before single-file parsing;
limits are one file, 20 MiB, no fields and one part. Async Cloudinary upload occurs
after parsing and does not make fileFilter asynchronous. This is a scoped
exception, not proof of general upload/DoS safety. Re-triage and patch **before
introducing an async filter**; reassess if upstream advisory conditions change.

## Release and limitations

No runtime logic, index provisioning, service setting or migration is needed.
After review, the user can commit/push and merge feature -> dev -> main. Deploy
with npm ci using this lockfile, not npm update. GitHub/Ubuntu and Render have
not been verified for this patch. Keep the existing idempotency index readiness
mechanism; no index command is part of this release.

After deployment, confirm the Live commit in Render Dashboard (health does not
prove a revision), inspect startup and perform only a few read-only requests:
GET /api/health, GET /api/tracks?page=1&limit=1, public demo detail
/api/tracks/6adce3bb3952132ce5a50f15, and production-origin GET/OPTIONS CORS.
Preserve demo/seed/assets and verify response shapes. Do not send exploit bodies,
run load/fault probes or mutate shared fixtures as part of this smoke.

No benchmark was repeated: there was no observed regression warranting it.
No shared DB, Cloudinary, Render/Vercel request or configuration change occurred.
The earlier quality/performance figures stay attached to b3c72c5 and cannot be
presented as this patch's Production, throughput or security guarantees.
