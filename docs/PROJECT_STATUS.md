# StemForge project status

Last updated: October 18, 2026 (Asia/Saigon).

## Implemented functionality

Authentication (register/login/me, JWT, shared authentication rate limit), public
Track pagination, visibility-aware detail, authenticated creation, owner-only
metadata update/deletion, audio upload, and transactional Like/Unlike APIs.

Like endpoints are authenticated GET/PUT/DELETE `/api/tracks/:trackId/like` with
no request body. Public Tracks and the current owner's private Tracks are
accessible; another owner's private Track returns 404. PUT/DELETE are idempotent.
Membership and counter updates use transactions; DELETE Track cascades Likes in
the same transaction. Startup awaits the unique Track/user Like index.

The Track/Stem contract remains a draft awaiting Phuc's review. Audio/stem
replacement and orphan Cloudinary asset cleanup remain pending. Cloudinary audio
URLs use public delivery; Track visibility does not protect those URLs.

## Current local feature: public artist and likedByMe (October 18, 2026)

Status: implemented and reviewed; **306/306 automated tests**, real-MongoDB local
HTTP checks (10/10 groups), and rollback/recovery checks passed. Nguyen authorized
the feature commit and push on October 18. This record accompanies that release
preparation; no PR merge or deployment is included. **Render verification for this
feature remains pending.** Earlier dated sections retain their original results.
Branch: `feature/track-response-context`, based on released `7d6f2c6`.
Initial inspection found no tracked changes or unfinished search/filter code;
only the existing untracked handoff/review/evidence files. They were preserved.
The release synchronization and Render results below describe October 17's
release, not deployment verification of this new feature.

### Phuc's original-contract feedback and approval boundary

Nguyen supplied Phuc's original PR review (not a reply to the five later
questions). Phuc confirmed stemId/channel identity and array order, zero start,
max-duration timeline, maximum four stems, seconds/bytes units, nullable cover,
one normal account with Creator/Listener as activities, and response wrappers.
Nguyen authorized implementing Phuc's requested artist/likedByMe response fields.

The updated [contract](data-contract.md), [response sample](data-contract.json),
and [proposal](DATA_CONTRACT_PROPOSAL.md) remain **Draft** pending Phuc's final
review. A copied/approved client contract is not claimed. Collection semantics,
stem editing, download enforcement, multi-upload request/cleanup design remain
open. Activity-based account semantics are now confirmed, superseding the older
review's uncertainty on that specific point.

### Implementation and behavior

- List, detail, POST, and PATCH return existing Track fields plus artist and
  likedByMe. The shared response service serializes the original Track, then
  enriches it. No Track schema fields, migration, or input allowlist changes.
- artist exposes exactly _id/username/avatarUrl; projection and explicit output
  allowlisting prevent private User data from leaking. Missing owner User gives
  artist=null, preserving artistId and the accessible Track/list count. This
  null behavior is documented for frontend confirmation; lookup failures remain
  errors rather than being silently treated as missing records.
- likedByMe is current-account membership, false for guests. The public list
  now uses existing optional-auth middleware, as detail already did: invalid
  supplied credentials return 401. Logged-in owners still see only public Tracks
  in the public list; private detail/update ownership rules remain unchanged.
- A nonempty page uses one author query for distinct owners and at most one
  membership query for current user/page IDs. Guests skip membership reads;
  empty pages skip both. No per-Track lookups. GET list/detail reads are not a
  shared snapshot; POST/PATCH writes and enrichment now share a transaction.
  Dedicated Like endpoints retain their existing snapshot semantics.
- POST/PATCH reject artist and likedByMe as unknown input fields. Like endpoint
  isLiked/likesCount responses and transactional mutation/cascade are unchanged.
- POST/PATCH writes and author/membership enrichment use the same transaction
  session, sequential queries, and majority commit. Enrichment errors roll back
  the write; successful JSON responses are sent only after commit. A missing
  User still means artist=null; a query failure is propagated as an error.
- Swagger is consistent across all four Track response operations; README
  describes derived fields, authentication changes, and current test totals.

### Actual local verification

All **270 tests passed**, zero failures (25 added over the 245-test baseline):

- `npm.cmd run test:tracks`: 160 passed.
- `npm.cmd run test:likes`: 51 passed.
- `npm.cmd run test:uploads`: 59 passed.
- `git diff --check`: passed.

New checks cover guest/authenticated liked and unliked state, public author
allowlisting, absent author/avatar, Mongoose serialization/no computed schema
fields, a 100-Track page using constant query counts, empty pages, error
propagation, real router optional JWT auth, private Track access, POST/PATCH
shape and input rejection, and Swagger response/input consistency. Database
queries are mocked; no production data or Cloudinary assets were created.
The model fixture remains the storage shape; the contract JSON is the enriched
response shape. Historical Render evidence and its runner remain unchanged.

### Real MongoDB / local HTTP results (October 18, 2026)

Executed **14:03:38-14:03:56 Asia/Saigon** (07:03:38-07:03:56 UTC), using the real
Atlas configuration from private .env and the current app on an ephemeral
127.0.0.1 listener. No mocks, no externally running server, and no Render API
requests were used. Sandbox DB connectivity was blocked; approved execution
outside the sandbox passed preflight and the checks below. The failed read-only
preflight created no fixtures and its process was terminated.

Runner: [check-local-track-responses.js](../scripts/check-local-track-responses.js).
Evidence: [nonsecret manifest/results](verification/sf-context-20261018070338-5ff48482.json).
Marker: `sf-context-20261018070338-5ff48482`.

**10/10 verification groups passed, zero failed or blocked:**

| Check | Actual result |
| --- | --- |
| POST Track response | Created Tracks for two disposable authors; exact public artist fields and likedByMe=false. Tested HTTPS avatar string and null avatar. |
| Guest list/detail | Public fixtures returned matching _id/username/avatarUrl only, with likedByMe=false and no private User fields. |
| Account-specific membership | Both users initially unliked; B Like -> only B true/count 1; A Like -> both true/count 2; B Unlike -> only A true/count 1; A Unlike -> both false/count 0. Guest always false. HTTP list/detail and direct DB membership/counter checks agreed. Dedicated Like response retained trackId/isLiked/likesCount. |
| Public/private access | Guest, owner, and other-user lists contained public Tracks only; private fixture excluded. Private detail returned 404 for guest/other user, 200 for owner; owner's private Like appeared correctly. Foreign PATCH returned 404. |
| Invalid list authorization | Invalid Bearer token and malformed Basic authorization both returned 401. |
| PATCH response | Correct artist and likedByMe=true while owner liked the Track; false after Unlike; requested metadata changes were applied. |
| Rejected inputs | POST and PATCH with client artist or likedByMe returned 400. Rejected POSTs created no Track; raw stored Track fingerprint was unchanged after rejected PATCHes. |
| Missing author | Fresh public fixture had an artistId with no matching User. List/detail preserved Track and artistId with artist=null. A valid account could Like it and get likedByMe=true while artist stayed null. |
| Real query batching | MongoDB command monitoring observed one author query and zero membership queries for guest list; one author query and one membership query for authenticated list. No command payloads or secrets were logged. |
| Persisted shape | Raw DB inspection of every successfully created fixture confirmed artist and likedByMe were absent from stored Track documents. |

Created two accounts and four Tracks (three via HTTP POST, one explicit orphan-
author fixture via DB). Two additional planned negative POST fixtures were
rejected and never created. Placeholder HTTPS audio/avatar URLs were used;
**no Cloudinary assets were created** and no account credentials/tokens were
printed or written to the manifest.

Cleanup passed: **0 fixture users, 0 fixture Tracks, 0 fixture Likes remain**.
Normal Tracks were deleted through the owner-authenticated API; the orphan Track
was removed by exact ID/owner/marker in a transaction with its Like cascade.
Accounts were deleted by exact ID plus marker-derived username/email only after
checking they had no remaining Tracks/Likes. Before/after SHA-256 fingerprints
for every preexisting User/Track/Like document matched. Baseline contained one
User (the protected main account), zero Tracks, and zero Likes. Main account
existence and unchanged document fingerprint were independently checked.
The loopback HTTP server closed; `dbDisconnected=true` is recorded after finally.

No application or test code needed correction, so the existing 270-test automated
result remains the previously recorded run rather than a new run in this step.
`node --check scripts/check-local-track-responses.js` and `git diff --check` passed.
**Render has not been checked for artist/likedByMe**; previous Like release
verification must not be presented as verification of this uncommitted feature.

No disposable token/response files were created. Retain the runner because it is
reusable for future local response regression checks, with read-only default,
explicit --run, and validated --cleanup manifest recovery. Retain its nonsecret
manifest as evidence. Earlier handoff/Render files were preserved unchanged.

### Repeat local verification requested (October 18, 2026)

Reran the same reusable HTTP/real-Atlas runner at **18:21:19-18:21:33 Asia/Saigon**
(11:21:19-11:21:33 UTC) with a fresh marker:
`sf-context-20261018112119-82b3df75`.
[Repeat-run manifest/results](verification/sf-context-20261018112119-82b3df75.json)
record **10/10 groups passed**, two disposable accounts and four created Tracks.
All requested guest/authenticated, Like/Unlike, public/private, invalid-token,
POST/PATCH, privacy, raw persistence/input rejection, and orphan-author checks
passed again. Actual list enrichment remained one author query plus zero guest
membership queries or one authenticated membership query.

Cleanup again verified zero fixture users/Tracks/Likes; all preexisting collection
and main-account fingerprints matched, and finally recorded dbDisconnected=true.
The local HTTP server closed. No Cloudinary asset, secret file, or disposable
response file was created. The runner is retained for reuse; both nonsecret
local manifests are evidence, not unfinished fixture cleanup.

Application source fingerprints matched before/after this repeat run; no logic
or test changes were needed and the earlier 270 automated tests were not rerun.
The previous handoff files and Render evidence retain their hashes. **Render is
still untested for this feature.** No search/filter work, staging, commit, push,
or deployment occurred. The proposed feature commit now includes 21 files, adding
this repeat evidence to the existing 20-file list (before the recovery fixes below).

### Recovery runner corrections (October 18, 2026)

Fixed two issues found during review of the reusable runner, without changing
application/Track response logic:

- Explicit verification verdict requires exactly the 10 distinct expected groups
  to pass. Empty, partial, duplicate, or unknown groups cannot pass. Verification
  is independent of cleanup/preservation. Recovery preserves an existing verdict,
  checks, fatal evidence, and original completion time; it records lastRecovery
  separately. Legacy evidence is migrated conservatively, never promoted from
  checks alone; unsupported legacy pass claims are downgraded.
- Recovery now handles a recorded Track already missing from DB: recheck absence
  inside a transaction, then delete orphan Likes only for that fixture Track ID
  and recorded fixture account IDs. Likes referencing any foreign/main account
  cause refusal without deletion. Manifest/account/Track IDs, owners, markers,
  duplicate IDs, and preservation baseline are validated before cleanup. Existing
  User IDs are checked against the exact marker-derived identity. Existing Tracks
  still require matching owner/marker. Invalid manifests are not rewritten.

Extracted testable recovery helpers to
`scripts/lib/local-track-response-recovery.js`. **26/26 targeted offline tests
passed** with `npm.cmd run test:local-recovery`, covering status nonpromotion,
legacy compatibility, incomplete/duplicate groups, scoped orphan deletion,
retry/idempotency, transaction session usage, and refusal of foreign/main data.
The existing 270 application tests are unchanged and were not rerun for these
runner-only fixes; the project now has 296 automated tests across four suites.

Actual MongoDB verification of the fix:

1. [Interrupted recovery scenario](verification/sf-context-20261018113718-cf407867.json):
   created only marked fixture accounts/Track/Like, removed that fixture Track,
   then invoked the actual `--cleanup` CLI with **zero verification checks**.
   Orphan Like and fixture accounts were removed; cleanup/lastRecovery passed,
   verification and overall original status remained **incomplete (0/10)**.
   Original preexisting-data/main-account fingerprints matched; DB disconnected.
   This incomplete verdict is expected test evidence, not a failed feature check.
2. [Full HTTP regression after fix](verification/sf-context-20261018113902-ee366e0e.json):
   **10/10 groups passed** at 18:39:02-18:39:17 Asia/Saigon. Verification recorded
   passed with expectedGroups=10/completedGroups=10; cleanup passed with zero
   fixture users/Tracks/Likes, preserved all preexisting data/main account, and
   recorded dbDisconnected=true.

No application fault injection, Cloudinary assets, or Render requests were used.
The temporary fixture-setup harness was deleted after the recovery scenario;
retain only reusable helpers/tests/runner and nonsecret evidence. Earlier HTTP
manifests were not changed. Source fingerprints for application files are
unchanged. `node --check` and `git diff --check` passed. **Render remains untested
for this feature; no commit, push, or deployment occurred.**

### POST/PATCH enrichment rollback correction (October 18, 2026)

The original write-then-enrich path could return an error after already committing
the Track change. Replaced it with a transaction encompassing the write and both
enrichment reads, using the same ClientSession, snapshot reads, and majority
commit. Create uses the array form of Track.create with session; PATCH keeps its
owner filter and supplies session to findOneAndUpdate. The response service
accepts an optional session and executes both lookups sequentially when present.
Independent GET lookups may still run in parallel outside transactions. Response
JSON is sent only after the transaction promise resolves successfully. No error
fallback substitutes null/false for failed lookups; public/private rules, input
allowlists, response fields, and Like API names remain unchanged.

Swagger POST/PATCH describes rollback/commit timing; DELETE Track now explicitly
describes cascade of every account's related Likes in the same transaction and
rollback of both Track/Like deletion on failure. README/contract reflect the fix;
the overall contract still awaits Phuc's final approval.

All affected automated suites were rerun successfully: **306/306 tests passed**:
Tracks 170, Likes 51, uploads 59, recovery 26. Ten new tests cover sequential
session propagation, stopping after author errors, POST/PATCH enrichment failure,
successful response after commit, and suppression of success on commit failure.
Existing router tests now assert transaction sessions; Swagger test checks the
DELETE cascade description. Recovery regression tests still cover empty/partial
verification, legacy evidence, scoped orphan cleanup, and foreign/main-ID refusal.

Actual HTTP local + Atlas checks:

- [Rollback scenario results](verification/sf-write-rollback-20261018114826-6a9e0e75.json),
  18:48:26-18:48:33 Asia/Saigon: **8/8 scenario checks passed**. Four deliberate
  local-only author/membership enrichment failures (POST/PATCH each) returned
  HTTP 500 with no success data. Raw DB reads confirmed no Track persisted after
  failed POST and identical preexisting fixture metadata after failed PATCH.
  Actual MongoDB commands showed the write and enrichment reads using one
  session, followed by abortTransaction. The temporary harness performed real
  reads, then rejected them locally; no failure hook/env switch was added to
  application code or deployed. Success POST/PATCH still returned public artist
  and correct likedByMe, including two accounts' Like membership. Foreign PATCH
  remained 404 and guest likedByMe remained false.
- [Recovery evidence](verification/sf-context-20261018114826-6a9e0e75.json):
  intentionally removed only the marked fixture Track while leaving two fixture
  Likes, then invoked the actual --cleanup CLI with checks=[]. Both orphan Likes
  and fixture accounts were removed. Cleanup/lastRecovery passed; original
  status and verification remained incomplete (0/10). No false verification pass.
- [Full normal-flow HTTP regression](verification/sf-context-20261018115004-1526edb2.json):
  **10/10 groups passed** after the transaction correction, covering guest and
  per-account state, public/private permissions, POST/PATCH response/input rules,
  privacy, missing author, persisted shape, and real list query batching.

All these runs ended with zero fixture users/Tracks/Likes, matching preexisting
data/main-account fingerprints and dbDisconnected=true. No Cloudinary assets or
Render requests were made. Temporary local fault harness was deleted; retain
only the nonsecret results and automated tests. Old evidence remains unchanged.
No search/filter changes, commit, push, or deployment. Render has not verified
this feature. The proposed feature commit now contains 29 files below.

### Feature commit scope (reviewed for commit/push)

Feature implementation, tests, contract, and actual local evidence:

```text
README.md
package.json
src/controllers/track.controller.js
src/routes/track.routes.js
src/services/track-response.service.js
tests/track-create-validator.test.js
tests/track-create.test.js
tests/track-detail.test.js
tests/track-list.test.js
tests/track-update-validator.test.js
tests/track-update.test.js
tests/track-response-service.test.js
tests/track-response-routes.test.js
tests/track-write-transaction.test.js
tests/local-track-response-recovery.test.js
scripts/check-local-track-responses.js
scripts/lib/local-track-response-recovery.js
docs/data-contract.md
docs/data-contract.json
docs/DATA_CONTRACT_PROPOSAL.md
docs/REQUIREMENTS_REVIEW.md
docs/PROJECT_STATUS.md
docs/verification/sf-context-20261018070338-5ff48482.json
docs/verification/sf-context-20261018112119-82b3df75.json
docs/verification/sf-context-20261018113718-cf407867.json
docs/verification/sf-context-20261018113902-ee366e0e.json
docs/verification/sf-context-20261018114826-6a9e0e75.json
docs/verification/sf-write-rollback-20261018114826-6a9e0e75.json
docs/verification/sf-context-20261018115004-1526edb2.json
```

Previously untracked handoff artifacts remain unchanged. Preserve them in a
separate handoff/history documentation commit if they have not yet been recorded:
`AGENTS.md`, `scripts/check-render-likes.js`, and
`docs/verification/sf-render-likes-20261017071857-4621b3aa.json`.
Do not silently include them as new feature implementation or delete them.

Release preparation review found no spent temporary harnesses or secret/response
files in this scope. Retained JSON evidence contains only marked dummy fixture
identities/IDs, counts, fingerprints, and check results; no tokens, credentials,
connection strings, or copies of preexisting User documents. Recovery manifests
retain the exact fixture scope and preservation baseline needed for safe reuse.
Only documentation changed during commit preparation, so the successful 306-test
run and actual Atlas/HTTP results above were not rerun.

Next: commit this explicit file set and push feature/track-response-context, then
review a merge-commit PR into dev followed by dev into main. The second PR must
wait for the feature to reach dev. No PR is merged automatically. Phuc's final
confirmation of the updated Draft contract (including missing-author null) is
still pending. Render verification must follow deployment of this feature.

## Historical evidence supplied in the handoff

These are handed-over results, not checks rerun in this session:

- 245 automated tests passed: Tracks 135, uploads 59, Likes 51.
- Local Atlas checks passed authentication, ID validation, public/private access,
  repeated Like/Unlike, two accounts/counters, unique index enforcement,
  concurrency, Like racing DELETE Track, cascade, and cleanup.
- Local fault injection verified rollback for Like, Unlike, and DELETE Track.
  Do not repeat fault injection in production.
- Swagger Like GET/PUT/DELETE security, path parameters, absent request bodies,
  and documented response statuses were checked.
- Previous temporary local scripts/manifests were removed; main account was kept.

## Current session observations

- Initial branch: `feature/track-like-api`, commit `205ed2d`; working tree clean.
- `AGENTS.md` and this status file were absent on disk at session start and have
  been reconstructed from the supplied handoff. No preexisting handoff file was
  overwritten. README contains stale earlier summaries; application logic is
  unchanged.
- Git fetch verified `origin/main` at `7d6f2c6` and `origin/dev` at `a05864f`.
- Render health returned HTTP 200 with the expected service JSON.
- Direct sandbox network requests were blocked; approved external commands can
  reach Render and GitHub.
- Render Like verification, cleanup, main-account preservation, and main/dev
  synchronization are complete. See the actual results below.

## Render verification completed in this session

Executed October 17, 2026, 14:18:57-14:19:17 Asia/Saigon (07:18:57-07:19:17 UTC).
All eight verification groups passed; no requested check failed or remains
blocked. This is a finite functional/concurrency check, not a load test.

Local handoff evidence: `docs/verification/sf-render-likes-20261017071857-4621b3aa.json`.
Local handoff runner: `scripts/check-render-likes.js`. Both remain preserved
outside this feature commit; the historical results below are recorded here.
Marker: `sf-render-likes-20261017071857-4621b3aa`.

The runner registered two disposable accounts through Render, kept credentials
and tokens in memory, validated each token through Render `/api/auth/me`, and
matched the new account/Track IDs against the configured Atlas database. It did
not use the main account's credentials or assume matching JWT secrets. Seven
temporary Tracks used placeholder HTTPS audio URLs; no Cloudinary asset was
created. Production application logic was unchanged.

| Verification | Actual result |
| --- | --- |
| Authentication on Like GET/PUT/DELETE | Missing header, invalid token, and malformed authorization scheme returned 401; authentication also preceded malformed Track ID validation. |
| Track IDs | Short, long, nonhex, and malformed IDs returned 400 with valid authentication; a nonexistent valid ObjectId returned 404 for all three methods. |
| Public/private permissions | Guest public detail returned 200; guest private detail returned 404. Each private owner could GET/Like/Unlike their own Track. The other account received 404 for all Like methods. Private fixtures were absent from the public list. Foreign-owner DELETE Track returned 404. |
| Sequential/idempotent operations and two accounts | Repeated PUT did not add another Like; repeated DELETE did not decrement again. Per-account membership and shared counts followed 0 -> 1 -> 2 -> 1 -> 0. Track detail/list counters agreed with the Like API and persisted DB membership. Responses used no-store. |
| Concurrent requests | Three rounds of six duplicate PUTs, six duplicate DELETEs, six PUTs across two accounts, and eight mixed PUT/DELETE requests passed. Final account states, DB membership count, and Track counter agreed after each batch, without duplicate membership. |
| Cascade DELETE Track | A Track liked by both accounts returned 204 with an empty body on owner deletion. Direct DB checks confirmed no Track and no related Likes. Both users then received 404 for all Like methods; repeated Track deletion returned 404. |
| Like racing DELETE Track | Three rounds with two concurrent Likes and owner DELETE passed. Like responses were within the permitted 200/404 outcomes; DELETE returned empty 204. Each round left no Track or orphan Like records. |

Preflight confirmed the actual `unique_track_user_like` compound index is unique
on `trackId` and `userId`. No duplicate was deliberately inserted into production.
Rollback assurance remains the handed-over local fault-injection evidence;
production fault injection was neither introduced nor executed.

### Cleanup and protected main account

Cleanup passed: **0 temporary users, 0 temporary Tracks, 0 temporary Likes remain**.
Track deletion used the owner-authenticated Render API after exact marker/owner
checks. Account deletion used exact DB ID, marker-derived email, and username.
Final DB checks covered all recorded IDs and temporary account ownership.

Protected account `6acb9cdb457771b5ea947486` still exists. A SHA-256 snapshot of its
complete DB document, owned Tracks, and Like records matched before and after
verification/cleanup (owned Tracks: 0; Likes: 0). Neither its document nor its
associated Track/Like data changed. The manifest contains the digest and counts,
never the underlying account data, password hash, credentials, or tokens.

### Automated checks rerun in this session

All **245 tests passed, zero failed**:

- `npm.cmd run test:likes`: 51 passed.
- `npm.cmd run test:tracks`: 135 passed.
- `npm.cmd run test:uploads`: 59 passed.
- `node --check scripts/check-render-likes.js`: passed.

These results were independently rerun; the local real-database rollback checks
described above remain historical evidence and were not rerun.

## Git synchronization completed

Ran the documented sequence after successful Render checks and cleanup:
switch main, pull main with `--ff-only`, switch dev, pull dev with `--ff-only`,
merge main with `--ff-only`, then push origin dev. All commands succeeded.

`main`, `dev`, `origin/main`, and `origin/dev` now point to
`7d6f2c6916501966d4e2306e5662f480f0d2988a` (Like release PR #33 merge).
The checked-out branch is **dev**. No force, reset, or new application commit was
used. Source, tests, and dependency files matched the released main tree before
synchronization, so no test rerun was needed merely for the branch switch.

SHA-256 checks confirmed that AGENTS.md, PROJECT_STATUS.md, the verification
runner, and its result manifest survived branch synchronization unchanged.
This status file was then deliberately updated with the completed results.
These four new files remain untracked/uncommitted for review; existing release
history alone was pushed. No preexisting handoff files were removed.

## Remaining work

The requested Like release verification has no remaining failure or blocker.
Documentation/evidence can be committed in a later authorized documentation
change. The new requirements review below expands the product backlog beyond
the earlier handoff's audio/stem replacement and Cloudinary cleanup notes.

## Requirements and named responsibility review (October 17, 2026)

Read **WEB APPLICATION PROJECT.docx**, internal title **StemForge: An Interactive
Multi-Track Audio Streaming and Stem Sharing Platform**, and compared it with
backend `7d6f2c6`. Detailed source references, status matrix, uncertainties, and
recommended sequencing are in [REQUIREMENTS_REVIEW.md](REQUIREMENTS_REVIEW.md).
References use actual section/module/task headings; Word page numbers are
unverified. This was documentation analysis only: no feature implementation,
production operation, new test run, commit, or push occurred in this review.

The document's section 6 names **Nguyen Thai Khanh Nguyen** as **Back-end &
Architecture Lead**: server/Atlas, User/Track schemas, JWT/authorization,
multi-stem upload to Cloudinary, discovery/filtering/pagination/Like APIs,
Swagger, Render, and Socket.IO server rooms plus listeners:count/like:updated.
Its week 4 table also assigns Track/Stem CRUD to the backend workstream.

**Phan Ngoc Phuc** is **Front-end & Audio Engine Lead**: React/Vite/Tailwind,
discovery/personal/upload UI, Wavesurfer Multitrack, mixer controls and Web Audio
customization, REST integration, Vercel, and useTrackRoom/realtime UI.
The data contract is explicitly joint work (section 6, TUAN 3 task 4).
Do not silently assign individually unspecified collection tasks, cover upload,
download-enforcement design, demo assets, or final report/slide workload.

Current scope assessment:

- **Present:** server/Atlas, JWT, Track/Stem/Like models, Track metadata CRUD,
  ownership/private detail access, public pagination/newest ordering, REST Like,
  Swagger for all 13 existing REST operations, and verified Render backend.
- **Partial:** upload handles one audio file per request; Track updates exclude
  stems; creator download permission is stored as a flag with public CDN URLs;
  dashboard and collection have data foundations but no list APIs.
- **Missing in this backend:** multi-file stem upload, Genre/BPM-range/Key/tags/
  title search, most-liked sorting, authenticated owner-Track listing, current-
  user liked-Track listing, and Socket.IO listener-count/Like broadcasts.
- **Needs verification/agreement:** client/mixer/Vercel progress, actual cross-
  domain CORS and real-audio end-to-end flow, approved mirrored data contract,
  Creator/Listener account semantics, download guarantees, collection semantics,
  exact Stem CRUD operations, final deliverables, and licensed demo assets.

Important differences from the earlier handoff/short backlog:

- Section 3 Module 1 describes Creator/Listener groups, while section 4 explicitly
  uses user/admin and says every user can upload/listen. Code follows section 4;
  a separate unapproved draft proposes activity-based roles. Confirm before
  adding separate role gates.
- Required contract approval before week 4 is still unverified. Draft contract
  files exist on `docs/data-contract` at `9e041cd`, not in the released tree.
  The current test fixture is not proof of joint/client contract approval.
- Single-file upload and completed REST Likes are milestones, not completion of
  the required multi-upload and realtime product features. Automatic orphan
  asset cleanup is technical follow-up rather than an explicit standalone
  requirement; avoid prioritizing it ahead of missing core requirements without
  a concrete dependency.
- README still has stale planned-functionality claims and inconsistent old test
  totals. This review leaves it unchanged and preserves the actual 245-test
  evidence and Render cleanup results above.

Proposed next order within Nguyen's backend role: agree/mirror contract with
Phuc -> required multi-stem upload and agreed management gaps -> propose owner
listing for Phuc's dashboard -> search/filter/order -> agree collection backend
-> Socket.IO server -> joint integration and backend documentation/testing.
Collection/owner-list endpoint designs are proposals supporting documented
product needs, not fabricated individual assignments. Full rationale and
confirmation points are recorded in the linked review. No new feature is
authorized or started by this analysis.

## Data contract proposal prepared (October 17, 2026)

[DATA_CONTRACT_PROPOSAL.md](DATA_CONTRACT_PROPOSAL.md) records current response
types, create/PATCH allowlists, server-managed fields, access rules, audio-upload
mapping, Like state, pagination, errors, new proposals, and five group questions.
It is **draft, not approved**. Read existing draft `.md` and `.json` on branch
`docs/data-contract` at `9e041cd` using read-only Git; no checkout or replacement
of uncommitted files occurred. Existing handoff/evidence artifacts are preserved.

Correction to the earlier review: the specification requires simultaneous
multi-stem upload, but does not explicitly mandate one HTTP request. A new batch
endpoint versus a client flow using existing single-file requests is a group
decision; neither can be claimed accepted from the wording alone. The review's
upload row and recommendations have been clarified accordingly.

Creator/Listener as activities matches current code and the old draft, but joint
approval is unverified. My Collection is not explicitly equated with Likes in
the requirements. Stem-management and download options remain unselected.
Proposed work while awaiting answers: metadata search/filtering on public Tracks,
preserving existing fields, response wrappers, pagination, and default ordering.
Query semantics would be reviewed in that separate task. No application logic,
production data, Git branch, commit, or remote was changed in this proposal work.

## Environment and safety

- Workspace: `D:\stemforge-server`; Render: https://stemforge-server.onrender.com.
- `.env` contains database configuration. Never print its values. Production
  tokens must be validated with `/api/auth/me`; do not assume local JWT secrets
  match Render. Prefer disposable accounts and keep their tokens in memory.
- Protected main account: `6acb9cdb457771b5ea947486` (never delete).
- New fixtures need unique markers and manifests containing IDs/nonsecret data
  only. Restrict cleanup by IDs, marker, and ownership; never delete broadly.
- Honor `DNS_SERVERS` for Atlas SRV lookup and always disconnect DB in `finally`.
- Use `curl.exe -4` for Render when needed. Do not start another local server
  without checking for an existing listener. Temporary JS/JSON can restart nodemon.

## Release synchronization procedure (completed above)

After Render verification and cleanup, inspect the working tree, preserve all
handoff/evidence files, then run sequentially and stop on any error:

```powershell
git switch main
git pull --ff-only origin main
git switch dev
git pull --ff-only origin dev
git merge --ff-only main
git push origin dev
```

Keep dev checked out. Do not use hard resets or force pushes. Documentation and
verification artifacts remain uncommitted unless explicitly committed later.
