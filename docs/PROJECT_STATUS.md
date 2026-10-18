# StemForge project status

Last updated: October 19, 2026 (Asia/Saigon).

## Implemented functionality

Authentication (register/login/me, JWT, shared authentication rate limit), public
Track metadata/tag filtering, newest/most-liked ordering and pagination,
visibility-aware detail, authenticated creation, owner-only
metadata update/deletion, audio upload, and transactional Like/Unlike APIs.

Like endpoints are authenticated GET/PUT/DELETE `/api/tracks/:trackId/like` with
no request body. Public Tracks and the current owner's private Tracks are
accessible; another owner's private Track returns 404. PUT/DELETE are idempotent.
Membership and counter updates use transactions; DELETE Track cascades Likes in
the same transaction. Startup awaits the unique Track/user Like index.

The Track/Stem contract remains a draft awaiting Phuc's review. Audio/stem
replacement and orphan Cloudinary asset cleanup remain pending. Cloudinary audio
URLs use public delivery; Track visibility does not protect those URLs.

## Local tag and sort feature (October 19, 2026)

Current branch: `feature/track-tags-sort`, created from synchronized dev `8691027`.
Four existing Render-verification documents were preserved and committed
separately as **a3348d4**, `docs: record Track search deployment verification`,
before feature edits. Handoff files and ignored reports remain preserved. Tag/sort
is prepared for feature -> dev -> main PRs; it is **not deployed or tested on Render**.
The overall Track/Stem contract remains **Draft**, not approved.

### Behavior and compatibility

- Singular tag matches one full element of tags using escaped literal regex,
  case-insensitive and accent-sensitive. It is trimmed, nonempty, and at most
  100 characters before trimming, exactly like genre/key. It does not match
  substrings or combine separate array elements. Plural tags is still rejected.
- sort accepts only exact case-sensitive newest or mostLiked. Omission means
  newest: createdAt DESC, _id DESC. mostLiked: likesCount DESC, createdAt DESC,
  _id DESC. Blank, padded, repeated, nested/operator and unknown values return
  400. Sort clauses are selected from predefined keys/directions.
- Tag combines with q/genre/key/BPM and isPublic=true using AND. One filter is
  shared by data and total; sort is separate and does not change total. Existing
  pagination, wrappers, public-only visibility (also for owners), optional
  authentication, no-store, artist/likedByMe and Like/write behavior are retained.
- No data fields, dependency or response schema changed; the Track model adds
  one index declaration. Ordering is deterministic for fixed data. Changing Like
  counts between requests can move records between offset-based pages.

### Index assessment

Declared nonunique index `public_tracks_most_liked`:
`{isPublic:1, likesCount:-1, createdAt:-1, _id:-1}`. Existing owner/newest indexes
are retained. The public equality prefix and complete ranking keys support the
new sort; combined metadata/range filters can still require filtering. Like
updates incur index-maintenance/storage cost. No tag multikey/collation index is
added because case-insensitive regex is not collation-aware. Sources:
[compound sort](https://www.mongodb.com/docs/manual/core/indexes/index-types/index-compound/sort-order/),
[regex index limitations](https://www.mongodb.com/docs/manual/reference/operator/query/regex/).

The earlier HTTP fixture run found **the new index absent**, with a blocking SORT.
That run set autoIndex=false/autoCreate=false, performed no DDL, and preserved the
index catalog. Its evidence remains unchanged. The subsequent authorized index
provisioning below deliberately adds persistent database metadata.

### Explicit index provisioning (October 19, 2026)

Code inspection: src/config/database.js passes credentials without overriding
autoIndex/autoCreate. Installed Mongoose defaults both to true and Model.init()
ensures indexes when enabled. src/server.js imports app/models before connecting
and explicitly waits only for TrackLike.init(), not Track.init(); HTTP readiness
does not prove that the new Track index is ready. No startup/application behavior
was changed for provisioning.

Reusable script: scripts/ensure-track-most-liked-index.js. Default invocation is
read-only inspection; --apply creates only the exact named schema declaration.
Automatic DDL is disabled in the script. It honors DNS_SERVERS, loads credentials
privately, requires the configured database name to match, verifies project
collections/protected account, refuses name/key/options or equivalent-key alias
conflicts, compares data and existing-index fingerprints, and disconnects in
finally. It does not use syncIndexes, dropIndex, data writes or cleanup deletion.
See README Discovery indexes for deployment commands and conflict handling.

**Actual shared-project Atlas results, 01:02:04-01:02:23 Asia/Saigon**
(October 18, 18:02:04-18:02:23 UTC):

| Operation | Actual result |
| --- | --- |
| Read-only preflight | Configured DB identity, three project collections and protected main account verified. Index absent; Track catalog stayed at 3. Unhinted public-only mostLiked plan: SORT -> FETCH -> IXSCAN on isPublic_1_createdAt_-1__id_-1. |
| First --apply | Created exactly public_tracks_most_liked; Track catalog 3 -> 4. Actual ordered keys: isPublic:1, likesCount:-1, createdAt:-1, _id:-1; name matches, v=2. No unique, sparse, partial, hidden, TTL or collation override. |
| Repeat --apply | Index already valid; created=false, catalog 4 -> 4, no duplicate/additional index. |
| Actual explain after both apply runs | find({isPublic:true}), sort likesCount/createdAt/_id DESC, limit 12, queryPlanner, no hint. Winning plan LIMIT -> FETCH -> IXSCAN on public_tracks_most_liked, with no SORT stage. No application hint added. |
| Preservation | All preexisting User/Track/Like data fingerprints and all old indexes matched in all three runs. Only the intended index was added in the first apply; no other catalog changes. Main account intact; counts remained 1 User, 0 Tracks, 0 Likes. |
| Resources/evidence | No fixture data, assets, fault injection or temporary harness created. All three runs recorded dbDisconnected=true. Reports remain ignored/local and contain no credentials or copies of User records. |

Local report markers, retained without modifying earlier HTTP evidence:
sf-context-20261018180204-38693eaa (inspect),
sf-context-20261018180214-96dcee24 (create),
sf-context-20261018180221-a89ea99c (repeat).
The **index addition is intentional and retained**, with existing data/indexes
preserved. This verifies the actual configured shared database, not another
environment. Empty Track data means this is not a performance/load benchmark;
combined metadata/range filters can choose other plans. Tag/sort deployment and
Render verification remain pending; the contract remains Draft.

**9/9 focused utility tests passed**, plus node --check and git diff --check:
read-only absence, exact creation, repeat no-op, key-order/direction conflict,
semantic options conflict, equivalent-key alias, schema drift, server defaults,
DDL failure and old-index preservation. No source/startup changes were made in
this index follow-up, so the existing 399 application/recovery tests were not
rerun. The reusable script and its tests are the only new feature files here.

### Automated and real HTTP verification

Before the NUL follow-up, **399/399 automated tests passed:** Tracks 263,
Likes 51, uploads 59, recovery 26.
Added 27 tests for literal tag/element matching, combined filters, query limits,
sort allowlisting/defaults, total/pagination/viewer preservation and additive
index declaration. The HTTP mock now simulates declared ordering; existing
expectations were corrected to respect descending _id for tied timestamps.

NUL review follow-up: q/genre/key/tag now reject actual U+0000 with HTTP 400
before list/count/enrichment queries; the character is not removed. Literal
escaping, trimming and case-insensitivity are unchanged, including acceptance of
the textual backslash-u0000 sequence and literal percent-00 text. Added 20 tests
across validator/controller/routes. The focused suite passed **132/132** and
the full npm run test:tracks suite passed **283/283**. Through real loopback HTTP,
20 guest requests containing encoded %00 (alone, leading, embedded, trailing or
with surrounding spaces) returned the exact validation message, with zero calls
to Track.find/countDocuments, User.find/findById or TrackLike.find. Four HTTP
controls with ordinary regex metacharacters/textual NUL representations returned
200 and forwarded the expected escaped filters. Database methods were mocked to
prove the boundary; no Atlas/Render access or fixture data was needed. Existing
authentication order remains unchanged. Swagger documents NUL rejection; this
follow-up is included in feature/track-tags-sort. Earlier Atlas/HTTP reports remain historical.

First local attempt: **October 19, 00:33:16-00:33:34 Asia/Saigon**, marker
`sf-context-20261018173316-87495a01` (UTC marker date is October 18). Nine HTTP
behavior groups passed, but the command-observer group failed with
`Actual sort mismatch`: the harness JSON-stringified the driver's Map as {}.
Driver source/formatSort inspection confirmed the representation issue. Index
assessment had not run. This report remains failed (10/11 groups completed);
cleanup had zero remaining fixtures, all preexisting data/main account and Track
indexes matched, and DB disconnected. No application fix was needed.

Corrected only the disposable harness's Map observation, then reran everything
with a fresh marker **sf-context-20261018173540-9a87cc10**:
**October 19, 00:35:40-00:35:56 Asia/Saigon** (October 18, 17:35:40-17:35:56 UTC).
The current app used an ephemeral loopback HTTP listener with real Atlas and
private environment configuration, honoring DNS_SERVERS. No Render requests,
Cloudinary assets or production fault injection were used.

**11/11 groups passed, 90 real HTTP responses:**

| Check | Actual result |
| --- | --- |
| Fixture setup | Two marked accounts and ten HTTP-created Tracks; nine real Like memberships, controlled fixture timestamps and one popular Track switched private. No fabricated counters. |
| Tag matching | Regex metacharacters were literal; mixed case/trim passed. Near values and split elements did not match; 100-character tag accepted; operator-looking string treated literally. |
| Combined filters | Tag with title, genre/key and inclusive BPM bounds returned five expected public Tracks; conflicting predicates returned empty data and zero total. |
| Default/newest | Omitted and explicit newest returned identical timestamp/_id-descending order and pagination. |
| MostLiked/ties | Real count=2 outranked count=1/0; equal counts used createdAt, and equal count/time used _id. |
| Pagination/total | Both modes returned total=6/totalPages=3 for the same tag filter (limit=2). Three pages had exact nonoverlapping IDs; beyond-last page was empty with total unchanged. |
| Privacy/auth | Guest/owner/other lists in both modes excluded the popular private fixture. Matching its title returned zero even to owner. Detail remained owner 200 and other-user 404. |
| Response context | Public artist allowlist and independent viewer Like state stayed correct, including paged results. Unlike changed ranking and current viewer state while total and another account's membership stayed correct. |
| Invalid queries | All 21 invalid tag/sort/other-query cases returned 400; invalid token returned 401 for each sort. |
| Commands/Swagger | Real find/count filters matched for both modes; normalized sort Maps had the declared order and were absent from filters. Swagger exposed nine supported parameters and exact sort enum/default. |
| Index assessment | New declaration present in code; physical index absent on shared Atlas, blocking SORT observed, automatic DDL disabled, old index catalog preserved. |

Both generated JSON reports remain ignored/local, without tokens, passwords or
copies of preexisting User documents; this summary is self-contained on GitHub.
Cleanup was restricted to manifest IDs, marker/description/title and owner or
exact marked account identity. Track and fixture-Like removal used one session
sequentially per transaction and refused foreign/unmarked records. **Zero fixture
Users, Tracks or Likes remain**. Before/after fingerprints for all preexisting
User/Track/Like records and the protected main account matched, as did the Track
index catalog. HTTP listener closed and dbDisconnected=true recorded in finally.
The spent harness was removed. The feature release remains pending through
feature -> dev -> main PRs; no automatic merge or deployment is performed.

## Released search/filters feature (October 18, 2026)

**Actual Render search/filter verification passed 10/10 groups**, followed by
verified fixture cleanup and main/dev synchronization. Feature commit `3dc0e26`
was merged through PR #36 (feature -> dev) and PR #37 (dev -> main).
The release/Live commit is **`869102741d4453253deabbdd4e1939f5df6ec79c`**.
Nguyen explicitly confirmed Live `8691027` in Render Dashboard during this check.
The API health response does not expose a build SHA; public GitHub deployment
metadata supplied no SHA attestation, so the Live SHA is attributed to that
Dashboard confirmation rather than inferred from health or branch state alone.

### Actual Render search/filter verification and cleanup (October 18, 2026)

Target: https://stemforge-server.onrender.com. Executed
**20:59:58-21:00:19 Asia/Saigon** (13:59:58-14:00:19 UTC), marker
`sf-context-20261018135958-6694a6ec`. All feature requests used the real Render
HTTPS API. Two disposable accounts registered and logged in through Render;
their tokens were validated with /auth/me and exact fixture identities matched
against privately configured Atlas before Track creation. Tokens/passwords
stayed in memory; no local JWT signing secret or application listener was used.
Read-only preflight verified health, the deployed Swagger's seven parameters,
400 for empty q, and 401 for an invalid supplied token before fixtures were made.

Created **two marked accounts and 14 Track fixtures: 13 public, one private**,
all through Render POST using placeholder HTTPS audio URLs. Only the marked
accounts' avatar fields were adjusted to exercise HTTPS/null artist avatars.
Three exact marked Tracks received the same fixture timestamp to verify the
secondary _id ordering. No existing records were modified.

**10/10 groups passed, zero failed or blocked:**

| Check | Actual Render result |
| --- | --- |
| Authentication/setup | Registration, login, /auth/me, exact Atlas identity and all 14 POST responses passed. Computed fields were absent from raw stored fixtures. |
| No filters/defaults | Default page=1/limit=12 and page 2 matched the actual public DB count and createdAt-desc/_id-desc order. The 13 public fixtures crossed the default page boundary; three tied timestamps exercised _id ordering. |
| q | Case-insensitive substrings and query trimming matched the expected IDs. Brackets, plus, parentheses, anchors, pipe and backslash were literal; wildcard-looking text did not expand matches. Accent distinctions were preserved. |
| genre/key | Case-insensitive, trimmed full-value matches for Electro (Live), A+ and URL-encoded C# passed. Similar longer genres/keys were excluded. |
| BPM | One-sided and two-sided ranges included exact boundaries. Fractional bounds, equal 130.5/130.50, and exact 80.25 matched correctly. |
| AND/data/total/pages | Combined title/genre/key/BPM returned exactly two expected IDs and total=2. Pages 1/2 (limit=1), beyond-last page, and conflicting conditions with data=[]/total=0/totalPages=0 passed. |
| Public/private | Guest, owner and other-account lists returned all 13 matching public fixtures and excluded the private fixture. Searching its exact title returned zero even for owner. Detail remained owner 200 and guest/other user 404. |
| artist/likedByMe | Both authors exposed exactly _id/username/avatarUrl, including HTTPS/null avatars. Guest false, each account's independent Like membership, combined-filter membership and Unlike state passed. |
| Invalid queries/auth | All 30 empty/overlong/repeated/object/operator/unsupported/bad-BPM/bad-pagination cases returned 400. Invalid Bearer and malformed Basic authorization returned 401. Tags/Like sorting remain unsupported. |
| Deployed Swagger | Exact parameter set, text/BPM limits, inclusive/AND/literal descriptions, response-only context fields, and 400/401 documentation matched. |

The ignored local JSON records **92 HTTP responses** during the fixture lifecycle,
plus four read-only preflight requests outside that counter. Verification has
expected/completedGroups=10 and status=passed; renderTested=true, cleanup and
preservation passed, and dbDisconnected=true. This versioned summary is readable
without the generated report; no JSON report is added to Git.

Cleanup removed only exact manifest Track IDs with matching title, marker,
description and owner IDs, and Likes restricted to fixture Track/account IDs.
Track/Like removal used the same transaction session sequentially. Foreign or
unmarked identities were refused; only the two exact marked accounts were
deleted after checking they owned no remaining Tracks/Likes. **Zero fixture Users,
Tracks or Likes remain.** Before/after fingerprints for every preexisting
User/Track/Like document and the protected main account matched. DB disconnected
in finally; the spent temporary harness was deleted. No Cloudinary assets,
secret files, application changes, production fault injection, tags or Like-sort
implementation were involved. Actual filter effects and data/total were verified
over HTTP; internal find/count command monitoring remains the earlier local
evidence. The previous 372 automated tests were not rerun for deployment/docs
verification because source, tests and dependencies were unchanged.

### Main/dev synchronization after search verification (October 18, 2026)

Tracked working tree was clean, and the tested feature tree matched released
main. After Render checks and cleanup, executed: switch main -> pull --ff-only
origin main -> switch dev -> pull --ff-only origin dev -> merge --ff-only main ->
push origin dev. All steps succeeded without conflicts, reset, force push or a
new merge commit. Remote refs were independently verified: local main/dev and
origin/main/dev all equal `869102741d4453253deabbdd4e1939f5df6ec79c`.

All 13 handoff/local-report files fingerprinted before synchronization retained
their hashes, including this run's report. Current branch: **dev**. Documentation
updates for that verification were subsequently committed as a3348d4 before the
tag/sort work above. The contract remains **Draft** awaiting Phuc's final review.
At that release checkpoint, tags and most-liked ordering were still next steps.

## Local search/filters feature (October 18, 2026)

Historical local verification checkpoint; the later Render results are above.

Branch: `feature/track-search-filters`, created from dev `d5501f1`. Existing
Render-verification documentation was preserved and committed separately as
`aa2e469` with message `docs: record Track response context deployment verification`.
Untracked handoff files and ignored reports were preserved. Search/filter code
was implemented and verified locally before its reviewed 11-file commit/push.
Search/filtering had not yet been deployed or checked on Render at that checkpoint.
The Track/Stem contract remains Draft pending Phuc's final review.

GET `/api/tracks` now supports:

- q: literal, case-insensitive title substring.
- genre/key: case-insensitive full-value literal matches, no enum or musical-key
  equivalence mapping. All three text values are trimmed, nonempty, at most 100
  characters before trimming, and accent-sensitive. Regex syntax is escaped.
- bpmMin/bpmMax: inclusive, optional one-sided bounds; equal bounds mean exact
  BPM. Accept positive finite plain decimals up to 32 characters, including
  fractional BPM. Reject exponent/hex notation, signs, whitespace, nonfinite or
  nonpositive values, and inverted ranges. Query numeric strings are converted
  to numbers; POST/PATCH still require actual JSON numbers as before.
- All conditions combine with AND and isPublic=true. One constructed filter is
  passed to both find and countDocuments. Existing pagination validation,
  createdAt/_id descending ordering, artist/likedByMe enrichment, public-only
  visibility (including owners), optional authentication, and no-store remain.
- Accept only page/limit/q/genre/key/bpmMin/bpmMax as scalar query parameters;
  repeated, nested/operator, empty, or unsupported values return 400. Unknown
  parameters were previously ignored; the new explicit allowlist returns 400.
  Invalid supplied authentication still returns 401 before query validation.

No model fields, response wrappers, indexes, dependencies, Like endpoint behavior,
or write/transaction paths changed. Bounded regex matching uses existing metadata;
this adds no relevance ranking or text index. **Tags and most-liked sorting remain
next steps** and are not accepted as query parameters yet.

### Automated search/filter verification

**372/372 tests passed, zero failures:** Tracks 236, Likes 51, uploads 59,
local recovery 26. Added 66 tests covering literal metacharacters and unsafe
inputs, case/full-value matching, lengths and BPM bounds, identical data/total
filters, sorting/pagination/viewer context, actual Express query parsing and
authentication, and Swagger parameters. Existing response/write/Like/upload and
recovery checks remain passing. These automated DB operations are mocked.

### Actual local HTTP + Atlas search verification

Executed **19:57:13-19:57:27 Asia/Saigon** (12:57:13-12:57:27 UTC), marker
`sf-context-20261018125713-4d6cb5a7`, using the current app on an ephemeral loopback
listener and private Atlas configuration, honoring DNS_SERVERS. The generated
local-only JSON is ignored; this summary contains the results independently.
No Render requests, Cloudinary assets, or production fault injection were used.

**10/10 groups passed, 72 real HTTP responses:**

| Check | Actual result |
| --- | --- |
| Fixture setup | Registered two marked users, validated tokens with /auth/me, and created nine Tracks over HTTP with HTTPS audio placeholders. |
| Literal/case/accent search | An entire title containing brackets, plus, parentheses, anchors, pipe, and backslash matched literally. Uppercase queries matched; Cafe did not match Café, while CAFÉ did. Regex wildcard text did not expand matches. |
| Genre/key | Trimmed, case-insensitive exact matches worked for Electro (Live) and A+; similar longer genres/keys were excluded. |
| BPM | Inclusive endpoints, fractional 130.5, one-sided ranges, and equal bounds returned exactly the expected fixture IDs and totals. |
| AND | Title/genre/key/BPM combined correctly. Deliberately conflicting conditions yielded data=[]/total=0/totalPages=0. |
| Pagination/order | Two pages matched the actual createdAt/_id descending DB order. Total/totalPages remained correct, including beyond-last-page and unchanged no-filter defaults. |
| Viewer context | Both authors' exact public artist fields and guest false state passed. Each viewer's own Like membership, filtered membership, and Unlike response agreed. |
| Private access | The matching private fixture was absent even from its owner's filtered list; detail remained owner 200, guest/other user 404. |
| Invalid queries/auth | Empty/overlong/repeated/nested/operator/unsupported parameters, bad BPM ranges, and bad pagination returned 400. Invalid Bearer and malformed Basic authorization returned 401. |
| Actual DB filter/Swagger | MongoDB command monitoring observed identical Track find and count aggregate match filters for one combined HTTP request. Swagger exposed exactly the seven supported parameters. |

Cleanup used exact manifest IDs, owner IDs, title, marker/description, and marked
account identities; Track and fixture-Like removal shared one sequential
transaction session. Foreign/unmarked records were refused. **Zero fixture Users,
Tracks, or Likes remain**. Before/after fingerprints of all preexisting users,
Tracks, Likes and the protected main account matched. The HTTP listener closed
and dbDisconnected=true was recorded in finally. The spent temporary harness was
deleted; no secret/token or raw preexisting-user document was saved.

Swagger, README, proposal, and requirements coverage were updated. Static diff
checks passed. Deployment-verification documentation was committed separately;
the search/filter scope was then committed/pushed as 3dc0e26.
Application tests were not rerun during commit preparation because code was
unchanged; generated JSON reports and handoff artifacts remain outside the commit.

## Released feature: public artist and likedByMe (October 18, 2026)

Status: implemented and reviewed; **306/306 automated tests**, real-MongoDB local
HTTP checks (10/10 groups), and rollback/recovery checks passed. **Actual Render
verification passed 12/12 groups on October 18**, followed by verified fixture
cleanup and main/dev synchronization. See the Render results below. The feature
was committed as `cf6f60c`, documentation cleanup as `b90017d`, and released through
PR #34 (feature -> dev) and PR #35 (dev -> main). Release synchronization finished
on dev; local/remote main and dev shared
`d5501f15c1b2fa21a042d5664c883b09748e56ef`.
Generated reports remain local and ignored by Git; versioned summaries are
self-contained. Earlier local milestones retain their original verification
scope; statements that Render was pending describe those earlier checkpoints.
Initial inspection found no tracked changes or unfinished search/filter code;
only the existing untracked handoff/review/evidence files. They were preserved.
The separately labeled October 17 Like-release results are historical; the
October 18 Render section verifies the artist/likedByMe feature itself.

### Actual Render verification and cleanup (October 18, 2026)

Target: https://stemforge-server.onrender.com. Executed
**19:25:53-19:26:11 Asia/Saigon** (12:25:53-12:26:11 UTC), marker
`sf-context-20261018122553-1612e91f`. A disposable local harness sent real HTTPS
requests to Render, using Render-issued registration/login tokens validated with
`/api/auth/me`. Exact marked fixture identities were matched against privately
configured Atlas before Track checks. No local application server or JWT signing
secret was used. HTTP behavior and the deployed Swagger confirmed the feature;
the service's health endpoint does not expose a deployment commit SHA.

**12/12 groups passed, zero failed or blocked:**

| Check | Actual Render result |
| --- | --- |
| Authentication and DB identity | Two disposable accounts registered, logged in, passed /auth/me, and matched exact Atlas fixture identities. |
| POST response | Three successful Track creates returned artist with exactly _id/username/avatarUrl and likedByMe=false; both HTTPS and null avatar cases passed. |
| Guest list/detail | Public fixtures returned correct public author fields only and likedByMe=false; no private User fields appeared. |
| Two-account membership and counters | Before/after Like and Unlike, list/detail reflected each viewer independently, with guest false. Repeated Like/Unlike remained idempotent; Like responses and stored counters/membership agreed. |
| Public/private access | Guest, owner, and other-user lists remained public-only. Private detail was 200 for owner and 404 for guest/other user; the owner's private Like state was correct. Foreign PATCH returned 404. |
| Authorization and IDs | Invalid Bearer and malformed Basic authorization on list returned 401. Invalid Track ID returned 400; absent Track returned 404; guest POST/PATCH returned 401. |
| PATCH response | artist stayed correct; likedByMe was false with only the other account's Like, true after owner Like, then false after owner Unlike. Metadata updates succeeded. |
| Response-only inputs | POST/PATCH with artist or likedByMe returned 400. Rejected POSTs created no Track; stored fixture metadata fingerprint was unchanged after rejected PATCHes. |
| Missing author | One explicit marked DB fixture had no matching User. Render list/detail retained Track/artistId with artist=null; a valid viewer's Like still produced likedByMe=true. |
| Stored shape | Raw Atlas reads confirmed no artist or likedByMe field in any created Track fixture. |
| DELETE cascade | A foreign delete returned 404; owner DELETE returned empty 204 and removed the Track plus Likes from both accounts. Subsequent detail returned 404. |
| Deployed Swagger | Public artist allowlist, read-only response fields, rejected create/PATCH inputs, optional auth/401, and DELETE Like cascade matched the deployed documentation. |

The local-only manifest records **85 HTTP responses** during fixture verification
and cleanup, in addition to three read-only preflight requests (health, Swagger,
invalid-token list). It records verification passed with expected/completed=12,
status=passed, renderTested=true, cleanup/preservation passed, and
dbDisconnected=true. The JSON report is ignored and is not required to read this
summary on GitHub.

Created two fixture Users and four Tracks (three through Render POST, one direct
missing-author fixture); two negative POST fixtures were rejected. Cleanup was
limited to exact fixture IDs, marker, title, and owner/account identities. Normal
Tracks were removed through the owner-authenticated Render API with Like cascade;
the missing-author fixture was removed transactionally by exact DB scope. Only
the two disposable accounts were deleted. **Zero fixture Users, Tracks, or Likes
remain.** Before/after fingerprints of all preexisting User/Track/Like documents
matched, including the protected main account. DB disconnected in finally.

No Cloudinary assets, secret files, application changes, or production fault
injection were involved. The temporary harness was deleted after successful
cleanup. Enrichment-failure rollback and internal query batching remain supported
by the earlier local evidence; neither was inferred from production internals or
retested through fault injection on Render. The previous 306 automated tests were
not rerun because application/test/dependency code was unchanged.

### Main/dev synchronization after Render verification (October 18, 2026)

Tracked working tree was clean before synchronization. After the successful
Render checks, cleanup, and preservation checks, ran the documented sequence:
switch main -> pull --ff-only origin main -> switch dev -> pull --ff-only origin
dev -> merge --ff-only main -> push origin dev. Every step succeeded without a
force push, reset, or new merge commit. Remote refs were independently checked:
local main/dev and origin/main/dev all equal
`d5501f15c1b2fa21a042d5664c883b09748e56ef` (release PR #35).

The checked feature tree matched the released main tree. Hash checks verified
all 11 handoff/local-report files fingerprinted before synchronization were
preserved across switches, including the new Render report. Synchronization
finished on dev. Documentation of these results was subsequently committed as
aa2e469 before search/filter implementation; no further release/deploy was made.
The contract remains **Draft** awaiting Phuc's final review.

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

### Initial automated verification (historical)

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
Marker: `sf-context-20261018070338-5ff48482`.
The complete result summary follows; the generated manifest is local-only.

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
At this local milestone, Render had not been checked for artist/likedByMe; the
later October 18 Render section above records the actual production requests.

No disposable token/response files were created. Retain the runner because it is
reusable for future local response regression checks, with read-only default,
explicit --run, and validated --cleanup manifest recovery. Its nonsecret manifest
is retained locally for audit. Earlier handoff/Render files remain unchanged.

### Repeat local verification requested (October 18, 2026)

Reran the same reusable HTTP/real-Atlas runner at **18:21:19-18:21:33 Asia/Saigon**
(11:21:19-11:21:33 UTC) with a fresh marker:
`sf-context-20261018112119-82b3df75`.
This repeat recorded **10/10 groups passed**, two disposable accounts and four
created Tracks; its generated manifest remains local-only.
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
The previous handoff files and Render evidence retain their hashes. **Render was
still untested at that repeat-run checkpoint.** No search/filter work, staging,
commit, push, or deployment occurred during that repeat verification.

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

1. **Interrupted recovery scenario**, 18:37 Asia/Saigon:
   created only marked fixture accounts/Track/Like, removed that fixture Track,
   then invoked the actual `--cleanup` CLI with **zero verification checks**.
   Orphan Like and fixture accounts were removed; cleanup/lastRecovery passed,
   verification and overall original status remained **incomplete (0/10)**.
   Original preexisting-data/main-account fingerprints matched; DB disconnected.
   This incomplete verdict is expected test evidence, not a failed feature check.
2. **Full HTTP regression after fix**:
   **10/10 groups passed** at 18:39:02-18:39:17 Asia/Saigon. Verification recorded
   passed with expectedGroups=10/completedGroups=10; cleanup passed with zero
   fixture users/Tracks/Likes, preserved all preexisting data/main account, and
   recorded dbDisconnected=true.

No application fault injection, Cloudinary assets, or Render requests were used.
The temporary fixture-setup harness was deleted after the recovery scenario;
retain reusable helpers/tests/runner and local-only nonsecret reports. Earlier HTTP
manifests were not changed. Source fingerprints for application files are
unchanged. `node --check` and `git diff --check` passed. **Render was untested at
this recovery-fix checkpoint; no commit, push, or deployment occurred then.**

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

- **Rollback scenario results**,
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
- **Recovery scenario**, 18:48 Asia/Saigon:
  intentionally removed only the marked fixture Track while leaving two fixture
  Likes, then invoked the actual --cleanup CLI with checks=[]. Both orphan Likes
  and fixture accounts were removed. Cleanup/lastRecovery passed; original
  status and verification remained incomplete (0/10). No false verification pass.
- **Full normal-flow HTTP regression**, 18:50:04-18:50:21 Asia/Saigon:
  **10/10 groups passed** after the transaction correction, covering guest and
  per-account state, public/private permissions, POST/PATCH response/input rules,
  privacy, missing author, persisted shape, and real list query batching.

All these runs ended with zero fixture users/Tracks/Likes, matching preexisting
data/main-account fingerprints and dbDisconnected=true. No Cloudinary assets or
Render requests were made. The temporary local fault harness was deleted.
Nonsecret generated reports remain local-only; the results are summarized above.
No search/filter changes or deployment occurred during that local check. Render
verification was pending then; its later actual results are recorded above.
The final feature PR scope after report cleanup was 23 versioned files below.

### Final feature PR scope after report cleanup

Feature implementation, tests, contract, ignore rules, and verification summaries:

```text
.gitignore
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
```

Previously untracked handoff artifacts remain unchanged. Preserve them in a
separate handoff/history documentation commit if they have not yet been recorded:
`AGENTS.md`, `scripts/check-render-likes.js`, and
`docs/verification/sf-render-likes-20261017071857-4621b3aa.json`.
Do not silently include them as new feature implementation or delete them.

Exactly seven generated JSON reports added by the initial feature commit are
removed from Git tracking and retained locally without modification. Ignore rules
cover only /docs/verification/sf-context-*.json and
/docs/verification/sf-write-rollback-*.json; other files in that directory remain
eligible for version control. No history rewrite or database operation is needed.
The local recovery manifests retain exact fixture IDs/markers/owners and baseline
fingerprints. Versioned summaries above preserve the actual outcomes, including
the expected incomplete 0/10 verdict in interrupted recovery checks, without
depending on local report files. No spent temporary harness is retained.
Only documentation and ignore/tracking rules changed during PR cleanup, so the
successful 306-test run and actual Atlas/HTTP results above were not rerun.

Completed since that PR preparation: documentation cleanup pushed as b90017d,
PR #34/#35 merged upstream, actual Render verification passed, fixtures removed,
and main/dev synchronized as recorded above. Phuc's final confirmation of the
updated Draft contract (including missing-author null) is still pending.

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

## Historical session observations (October 17, 2026)

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

## Historical Render Like verification (October 17, 2026)

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

## Historical Git synchronization (October 17, 2026)

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
