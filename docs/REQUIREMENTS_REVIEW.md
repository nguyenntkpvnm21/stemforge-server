# Requirements and responsibility review

Reviewed October 17, 2026 (Asia/Saigon), against backend commit `7d6f2c6`.
October 18 update: Nguyen supplied Phuc's original-contract PR feedback confirming
the activity-based account model, key mixer conventions, units/null cover, and
response wrappers. Updated [data-contract.md](data-contract.md) remains draft
pending review of artist/likedByMe and missing-author behavior. The comparison
below describes the released baseline unless explicitly updated; current local
feature changes are recorded in PROJECT_STATUS.md.
October 18 implementation update: title/genre/key/BPM discovery filters were
released through PR #36/#37 and passed 10/10 actual Render verification groups,
followed by verified fixture cleanup and main/dev synchronization to 8691027.
Tags and most-liked sorting were pending at that checkpoint. October 19:
singular tag filtering and newest/mostLiked selection are implemented locally
on feature/track-tags-sort; before the NUL fix, 399 automated tests and 11 corrected
local HTTP/Atlas groups passed with safe cleanup. After the fix, 283 Track tests
passed (including the 132-test validator/controller/routes subset), with 20 guest
%00 HTTP rejections before DB lookups and four literal/textual-NUL controls passing.
The separate 9-test index suite and Atlas index provisioning passed. These runs
are not added into a new total. Subsequently, tag/sort/NUL validation passed
12/12 actual Render groups on Live 559222a (PR #38/#39; Dashboard confirmation
from Nguyen). Cleanup, data/main-account/index preservation and DB disconnect
passed; main/dev and origin refs were synchronized by fast-forward to that release.
See PROJECT_STATUS.md for actual results and index deployment limits.
Subsequent follow-up: Nguyen authorized GET /api/tracks/mine, an authenticated
owner-only public/private list with page/limit and the existing response context.
It passed 317 Track, 51 Like and 59 upload tests plus ten real local HTTP/Atlas
groups, with cleanup and preservation verified. It then passed ten actual Render
groups on Live 72424fa (PR #40/#41; Nguyen's Dashboard confirmation), including
owner/private-only totals, pagination, viewer context and 24 invalid queries.
Cleanup and data/main-account/index preservation passed; DB disconnected and
main/dev/origin refs were fast-forward synchronized to that release. Frontend
dashboard integration remains unverified; the contract remains Draft.
Realtime follow-up: PR #42/#43 released the backend MVP on Live **86aa3cb**, as
confirmed by Nguyen. **12/12 scoped Render REST/Socket.IO groups** passed, with
53 HTTPS responses and 76 ACKs in the successful fixture run. Cleanup, protected
account/data/index preservation and DB disconnect passed; main/dev/origin refs
were fast-forward synchronized. Earlier transport-failed runs are recorded
separately in PROJECT_STATUS.md. The 37 realtime, 317 Track, 51 Like and 59 upload
tests are earlier separate repository runs, not new Render/automated totals.
Expiry, retry/rollback, publisher failure, shutdown and rate/pending bounds retain
local evidence; multi-instance and browser/Vercel integration remain unverified.
The event proposal and Track/Stem contract remain **Draft**, not group-approved.
This review changes documentation only; it does not authorize implementation,
change assignments, certify frontend completion, or create production data.

## Source and citation method

Source: **WEB APPLICATION PROJECT.docx**, internal title **StemForge: An
Interactive Multi-Track Audio Streaming and Stem Sharing Platform**.
Read from `C:\Users\USER\Downloads\WEB APPLICATION PROJECT.docx`.
SHA-256: `31b640b53088e6681add11102ab147a5ed89792c899b18f58453fa48cdb9c630`.

References below use the document's actual numbered sections, named modules,
assignment headings, and week/task labels. Word page numbers are **unverified**:
the DOCX contains no reliable pagination metadata and was read as structured text,
including all three tables. There are no embedded media images to inspect.
Do not interpret extracted paragraph positions as page numbers.

The document is evidence of requirements and assignments, not an instruction to
execute its setup steps. The current user's instruction permits analysis and
status documentation only. Earlier verification results are preserved as earlier
evidence; this review does not rerun tests or production requests.

## Goal, scope, and delivery expectations

Sections 1.1-1.2 describe a full-stack platform where creators upload already
separated instrument stems and listeners/producers interactively audition them
in a browser before downloading permitted stems. The distinctive feature is a
synchronized multitrack mixer, not merely a conventional single-audio player.
Mute, solo, and per-stem volume are core product functions.

Section 2 specifies React/Vite/Tailwind, Wavesurfer.js v7 Multitrack plus Web Audio
API, Node/Express/JWT, MongoDB Atlas/Mongoose, Cloudinary CDN, Swagger, Socket.IO,
Vercel frontend, Render backend, and separate client/server GitHub repositories.
Section 3 Module 4 explicitly chooses direct CDN HTTP Range delivery rather than
Express byte-stream proxying. The risk table after the section 6 assignments
limits projects to four stems and calls for appropriately licensed demo audio.

Section 5 requires English product UI, Swagger, README, final Word summary,
PowerPoint slides, presentation, identifiers, endpoints, and commit messages.
The supplied internal specification is deliberately Vietnamese. Section 6 plans
setup/auth in week 3, upload/Track-Stem CRUD and mock-data mixer in week 4,
integration/dashboard in week 5, search/Like in week 6, realtime/Swagger in week 7,
cloud integration in week 8, testing/demo preparation in week 9, and reporting in
weeks 10-11. No calendar dates establish the current course week.

References to buying stems do not specify checkout, payments, pricing, orders,
or a commerce assignment. Built-in AI separation is not specified: the final
TUAN 3 task 6 suggests external tools only to prepare demo stems. These features
must not be added to the backlog as mandatory implementations without agreement.

## Explicit assignments

### Nguyen Thai Khanh Nguyen - Back-end & Architecture Lead

Section 6, heading **Nguyễn Thái Khánh Nguyên (Back-end & Architecture Lead)**:

- Create `stemforge-server`, set up Node/Express, and connect MongoDB Atlas.
- Implement User/Track Mongoose schemas, JWT middleware, and user authorization.
- Implement simultaneous multi-stem file upload through Multer to Cloudinary and
  return CDN distribution URLs.
- Implement discovery/search filtering by Genre/BPM/Key, pagination, and Like APIs.
- Document all endpoints through Swagger UI `/api-docs`.
- Deploy the server to Render with a public API base URL.
- Implement Socket.IO server, Track rooms, `listeners:count`, and `like:updated`.

The section 6 **week 4** table additionally assigns Track/Stem CRUD to the backend
workstream. This is backend workstream evidence, distinct from the named list.

### Phan Ngoc Phuc - Front-end & Audio Engine Lead

Section 6, heading **Phan Ngọc Phúc (Front-end & Audio Engine Lead)**:

- Create `stemforge-client` with React/Vite/Tailwind.
- Implement discovery/search home UI, the personal page, and creator upload form.
- Integrate Wavesurfer.js Multitrack synchronization and per-stem waveforms.
- Implement mixer state for volume/mute/solo and synchronized Play/Pause/Seek.
- Customize gain/routing with Web Audio API GainNode/AudioContext where needed.
- Consume server REST APIs, including auth, Track lists, and upload.
- Deploy the frontend to Vercel.
- Implement `useTrackRoom`, listener-count badge, and realtime Like UI.

### Shared or unspecified ownership

Section 6's paragraph before the assignment headings says both members cooperate
on API integration. **TUAN 3, task 1** explicitly has both create cloud accounts.
**TUAN 3, task 4** explicitly requires both to agree the data contract and keep
`docs/data-contract.json` in both repositories; backend field changes must be
communicated to frontend in advance.

The final Word/slides/presentation workload, demo-audio preparation owner,
collection-specific frontend/backend task split, cover-image upload implementation,
and exact download enforcement design are **unspecified individually**. Do not
assign these to a named member just from their presence in the overall plan.
Backend endpoints needed by a frontend feature can be proposed to Nguyen under
his backend role, but that is a proposal, not a verbatim individual assignment.

## Requirements compared with the current repository

Statuses describe **this backend repository**. "Missing" means no corresponding
implementation in this tree, not proof that another repository has no work.
"Needs verification" means this evidence cannot establish completion.

| Requirement and document reference | Status | Code/evidence and practical limit |
| --- | --- | --- |
| Node/Express, Atlas, CORS, Render backend - sections 2 and 6, Nguyen; TUAN 3 tasks 1-3 | Present for backend | `src/app.js`, `src/config/database.js`, `src/server.js`; Render was verified earlier in this session. Real frontend-domain CORS integration remains unverified. |
| Register/login/JWT - section 3 Module 1; section 6 Nguyen | Present | `src/controllers/auth.controller.js`, `src/config/jwt.js`, `src/middlewares/auth.middleware.js`; registration, login, and me routes exist. |
| Creator/Listener permissions - section 3 Module 1 versus section 4 Users | Activity-based model confirmed by Phuc on October 18 | `src/models/User.js` uses user/admin; registration creates user. Ownership controls exist. No distinct Creator/Listener gates are needed for the confirmed model; no admin API is specified. |
| User/Track/embedded Stem/Like schema - section 4; section 6 Nguyen | Present; contract approval unverified | `src/models/{User,Track,stem.schema,TrackLike}.js`; stable stem IDs and 1-4 stems supported. Collection is named `tracklikes` in implementation versus conceptual Likes in the document; same relationship, not evidence of a requirement failure. |
| Upload metadata including title/Genre/BPM/Key/cover - section 3 Module 3 | Partial | Track creation accepts metadata and cover URL. No cover-image upload route; actual frontend form is outside this repository. The document does not specify who must implement a separate cover-upload endpoint. |
| Upload multiple stems simultaneously - section 3 Module 3; section 6 Nguyen and week 4 | Partial; multi-stem client flow unverified, request design undecided | `src/middlewares/audio-upload.middleware.js:31` sets files=1 and `.single('audio')` at line 50. Existing POST `/api/uploads/audio` accepts one MP3/WAV/FLAC, max 20 MiB. The document requires simultaneous multi-file capability but does not explicitly require one HTTP request. Whether several single-file uploads satisfy the requirement needs group agreement and integration verification. |
| Track/Stem CRUD - section 6 week 4 | Partial | `src/controllers/track.controller.js` supports Track create/detail/metadata update/delete. `src/validators/track.validator.js:21` excludes stems from updates. No stem-specific change/replace/delete API. Exact independent Stem CRUD semantics require agreement. |
| Owner's personal library/dashboard - section 3 Module 3; section 6 Phuc UI and week 5 | Backend Render verified; frontend integration unverified | Nguyen authorized GET /api/tracks/mine: mandatory auth, req.user._id scope, own public/private Tracks, page/limit, consistent owner data/total, newest/_id DESC and artist/likedByMe. Ten actual Render groups passed on 72424fa, including a private-only owner and rejected client scope changes; cleanup/data/main-account/index preservation passed. Public list stays public-only. Earlier local tests are recorded separately in PROJECT_STATUS.md; Phuc's dashboard integration remains unverified. |
| Search Genre/BPM range/Key/tags/title keyword - section 3 Module 4; section 6 Nguyen explicitly Genre/BPM/Key | Implemented; Render verified October 18/19 | q/genre/key/BPM have October 18 Render evidence. Tag follow-up passed 12/12 actual Render groups on 559222a, including literal/full-element/case/trim tag matching, all-filter AND, data/total consistency and NUL validation. Cleanup/main-account/index preservation verified; see PROJECT_STATUS.md for separate historical automated/local results. |
| Pagination and newest/most-liked ordering - section 3 Module 4; section 6 Nguyen | Implemented; Render verified October 19 | newest keeps createdAt/_id DESC; mostLiked uses likesCount/createdAt/_id DESC. Actual Render checks passed real Like counts, time/ID ties, pages and invariant totals. Existing compound index was verified without DDL; unhinted public ranking used IXSCAN without SORT. Cleanup, existing data/indexes and main account preservation passed. Not a load benchmark; see PROJECT_STATUS.md. |
| Like/Unlike and count - section 3 Module 4; section 6 Nguyen | REST and scoped realtime Render verified | REST responses/transactions remain unchanged. Actual Render checks on 86aa3cb passed idempotent/concurrent membership changes and shared like:updated broadcasts; private/deletion revocation and Like cascade passed. Retry/rollback and publish-failure evidence remains local. Payloads are a Draft backend proposal, not group approval. |
| My Collection - section 3 Module 4 | Partial data foundation; listing missing | TrackLike stores membership and individual Track Like state is queryable, but no API lists a user's liked Tracks. Exact meaning of collection and its individual task split are unspecified; confirm whether it is the Like-derived collection rather than a separate saved list. |
| Synchronized mixer, waveform, volume/mute/solo, seek - section 3 Module 2; section 6 Phuc | Needs verification in frontend | Backend returns ordered stems with names/URLs/duration. This Express repository cannot establish whether Wavesurfer, React controls, AudioContext user gesture handling, or sample/real-data synchronization work. |
| CDN Range streaming - section 2; section 3 Module 4 architecture note | Backend URL delivery present; multitrack integration unverified | Cloudinary service uses resource_type=video and public upload delivery. Earlier handoff records a 206 Range check. This review did not repeat it or validate aligned demo stems and browser playback. No Express streaming proxy is required by the document. |
| Creator sets download permission and listener downloads permitted stems - section 3 Module 1; section 4 isDownloadable | Partial; enforcement semantics unspecified | Boolean can be stored/changed, but no download authorization endpoint exists. Public `audioUrl` still permits fetching bytes independently of the flag. Whether UI action gating is sufficient needs confirmation. |
| Socket.IO room track:{trackId}, listener counts, Like updates/reconnect behavior - section 3 Module 5; section 6 named assignments and week 7 | Backend MVP scoped Render verified; client integration unverified | Socket.IO shares the HTTP server. Twelve actual Render groups on 86aa3cb passed guest/public and owner/private access, connection counts, duplicate operations, transport reconnect/explicit rejoin, concurrent Like updates/switches and committed privacy/deletion revocation. Counts measure connections, not audio playback. See REALTIME_EVENTS.md (Draft) and PROJECT_STATUS.md for scope, network retries, cleanup and local-only failure/lifecycle checks. No multi-instance support or Phuc client hook/UI completion is established. |
| Swagger for all endpoints - section 2; section 6 Nguyen/week 7 | Present for existing REST scope; realtime proposal documented separately | Generated OpenAPI documents implemented REST operations. Socket events/ACKs, permissions, epoch/seq, stale ACK handling and reconnect behavior are in REALTIME_EVENTS.md, explicitly Draft pending group review. |
| Client repository, Vercel site, complete upload -> discovery -> mixer flow - section 2; section 6 Phuc and weeks 5-9 | Needs verification | Client code/live URL not supplied in this workspace; do not infer frontend progress or production CORS/real-audio flow from backend success. |
| English final deliverables, slides, report, demo assets - sections 5-6 and risks table | Partial / needs verification | Code/Swagger use English; README has stale functionality/test summaries. Final report/slides/presentation and licensed demo data are not established by this repository. Individual assignment is unspecified. |

## Differences, ambiguities, and decisions to confirm

1. **Roles:** section 3 Module 1 describes Creator and Listener/Producer groups,
   but section 4 says role=user/admin and every user can upload/listen. Current
   code follows section 4. A draft on branch `docs/data-contract`, commit `9e041cd`,
   proposes Creator/Listener as activities, not account types. That proposal is
   was not proof of joint approval at the initial review. Phuc's October 18
   feedback now explicitly confirms the activity-based interpretation; no new
   Creator/Listener gates are planned. Other contract decisions remain open.
2. **Contract milestone:** section 6 week 3/TUAN 3 task 4 requires an agreed,
   mirrored contract before week 4. Handoff still calls it draft. The released
   tree lacks `docs/data-contract.json` and `docs/data-contract.md`; those exist on
   the separate `docs/data-contract` branch. `tests/fixtures/track-contract-draft.json`
   is a test snapshot, not evidence of agreement or a mirrored client document.
   The old draft also says Track endpoints are not implemented, which is stale.
3. **Multi-file upload:** the document explicitly requires simultaneous multi-stem
   upload capability; the handoff accurately describes single-file upload as
   completed. It does not explicitly require all files in one HTTP request.
   Earlier wording implying a mandatory batch endpoint was too strong. Agree
   separate single-file calls versus one multipart batch, field names/limits,
   ordering/names, and partial failure handling. The current building block is
   not evidence of an accepted, integrated multi-stem user flow. Current size
   limits are implementation choices; the document fixes the maximum four stems.
4. **Downloads:** document permission wording is broader than what a public URL
   and boolean alone enforce. The draft and Swagger describe application action
   gating, which may be acceptable but is not explicitly approved by the product
   requirement. Agree what is promised; do not claim public audio cannot be saved.
5. **CRUD/collection:** week 4 says Track/Stem CRUD without operation detail;
   Module 4 names My Collection without an explicit storage model or individual
   task split. Confirm expected stem edits and whether collections derive from
   Likes. No automatic new assignment has been made.
6. **Progress wording:** completing Like verification does not complete the
   whole backend scope. Search/filtering, likes ordering, multi-upload, and
   Socket.IO are documented requirements absent from the earlier short list of
   pending audio replacement/asset cleanup. README also still has earlier
   "planned" claims and inconsistent 125/133/192 test totals; the verified total
   is 245. This review records discrepancies without rewriting the README.
7. **Formats/asset lifecycle:** MP3/WAV are specified; FLAC support is an existing
   extension, not a conflict unless the group restricts formats. Automatic orphan
   Cloudinary cleanup is recorded technical follow-up, not explicitly mandated
   as a standalone feature in this document. Rejected-upload cleanup already
   exists; general post-delete/replacement cleanup does not.

## Recommended next work for Nguyen (proposal, not a new assignment)

1. **Close the contract decisions with Phuc first.** Confirm the existing schema,
   role interpretation, upload mapping, permission semantics, collection meaning,
   and mixer assumptions. Update and mirror the approved contract in both repos.
   The document expressly makes this shared work (TUAN 3 task 4).
2. **Agree and complete the multi-stem upload workflow.** This is explicitly
   Nguyen's backend responsibility and a week 4 dependency for the upload form
   and real mixer data; batch versus separate requests remains open. Define
   bounded upload/result behavior and cleanup for partial failure. Decide
   necessary Stem CRUD together before changing the established contract; keep
   standalone asset-maintenance work subordinate to the required product flow.
3. **Integrate the creator-dashboard API.** The authorized /api/tracks/mine owner
   listing is Render verified, including private-only accounts; frontend
   integration remains to be verified. Remaining Stem-management
   choices still require agreement. The named dashboard UI assignment is Phuc's.
4. **Verify discovery integration.** Genre, BPM range, Key, tags, title search and
   newest/most-liked order have actual Render evidence. Frontend integration
   remains to be verified (Module 4; Nguyen's search/pagination responsibility).
5. **Agree and provide the collection backend.** If My Collection is Like-derived,
   propose a paginated current-user liked-Track list with visibility handling.
   The exact collection assignment/design remains unspecified until agreed.
6. **Agree and verify Socket.IO client integration.** Backend rooms, connection
   counts, committed Like events and scoped Render checks are complete. Review
   the Draft event proposal with Phuc, integrate useTrackRoom with reconnect/rejoin,
   stale ACK handling and heart-state refresh, then verify the browser flow. No
   new backend scope or individual assignment is inferred from deployment success.
7. **Verify integration and backend delivery.** Maintain English Swagger/tests for
   each addition, verify actual Vercel-to-Render CORS, and jointly demonstrate
   upload -> discover -> synchronized mixer -> permitted download and realtime
   updates using licensed audio. Update stale backend README and record results.

This order follows the document's dependency sequence rather than assuming the
current calendar week. Existing Like tests and Render verification do not need
to be repeated solely for this documentation review. Commit/publish the review
through the normal documentation PR workflow only when separately authorized.
