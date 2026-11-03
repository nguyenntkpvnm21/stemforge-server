# Multi-request Track publishing: local integration verification

November 3, 2026 (Asia/Saigon). **Option A remains a backend proposal pending
group confirmation. Track/Stem contract: Draft.** This verifies API composition,
not a new batch endpoint or the frontend form. It follows the local planning draft
`docs/MULTI_STEM_UPLOAD_PLAN.md` preserved in the original checkout; the findings
below are self-contained and do not require that uncommitted file.

## Source, isolation and coverage boundaries

Work branch: `test/multi-stem-publish`, in a separate worktree based on freshly
fetched `origin/dev` **4e7094a00826c1b44820004e3f4ce3612e26430b** (CORS merged).
The original checkout/branch, plan and handoff files were not edited. This PR
changes only tests, test scripts and documentation; runtime, API, schema,
dependencies and lockfile are unchanged. Verification made no production requests.

The test uses the actual [Express app](../src/app.js), auth/Track/upload routes,
authentication middleware, real bcrypt login and server-issued JWT, multipart
parser, upload controller/service and Track response enrichment. Requests use an
ephemeral HTTP server bound to 127.0.0.1. Credentials/signing/provider configuration
are generated in memory, never written or printed; .env/server.js are not loaded.

Following existing test conventions, the DB boundary is a per-test in-memory
adapter using real Mongoose documents/validation/serialization and a **simulated**
transaction. Cloudinary upload_stream is a Writable fixture with explicitly
released callbacks, in-memory synthetic WAVs (0.01 seconds, 204 bytes each), HTTPS
placeholder URLs and tracked synthetic assets. No provider decoding, real CDN
delivery, Atlas transaction/retry semantics, browser CORS or audio playback is
established by this run. HTTPS and DB connection attempts fail closed. All clients
have request deadlines; teardown closes HTTP connections/server, settles pending
provider callbacks, clears fixture records/assets and resets the Auth limiter.
No DB was connected, so no real DB disconnect or remote cleanup is needed.

Completion order is controlled by provider callbacks and awaits per slot, not
sleep-based timing. Transport-loss controls run before the handler or at response
end after the simulated commit. All seven cases await their upload workers and
HTTP bodies. No Socket.IO server is attached. The node:test context restores
mocks after teardown; request/event waits have bounded Node-managed deadlines,
and the fixture adds no recurring timer. These tests do not validate general
production shutdown, cancellation or provider idempotency behavior.

Existing coverage reused rather than copied:

| Existing suite | Responsibility retained there |
| --- | --- |
| `auth-api.test.js`, `auth-jwt.test.js` | Register/login/me validation, hashing/JWT semantics, error privacy, expiry and rate limits. |
| `audio-upload-*.test.js` | Multipart/MIME/format, 20 MiB boundary, quota, provider metadata/errors and rejected-result cleanup. |
| Track create/validator/response/transaction/list suites | Input allowlists, generated IDs/model validation, private/owner access, pagination, response enrichment and rollback. |

The seven added cases bridge the HTTP requests and exercise **reference client
orchestration inside tests**. They do not demonstrate Phuc's UI or enforce client
draft completeness on the server. The current API legitimately accepts any valid
1-4-stem array; blocking publish until all selected slots succeed is client policy.

## Reproduce and results

From the worktree with Node.js 24 and the lockfile installed:

```powershell
npm.cmd ci
npm.cmd run test:publish-flow
```

Equivalent direct test command:

```powershell
node --test --test-reporter=spec tests/multi-stem-publish.test.js
```

Actual Windows/Node 24.15.0 targeted run: **7 passed, 0 failed/cancelled/skipped**.
The new named suite is explicitly included in `test:ci` after `test:uploads`.
The subsequent **`npm.cmd test` passed 611 tests**, zero failures/cancellations/
skips: CORS 28, Auth 77, Tracks 317, uploads 59, publishing 7, Likes 51, realtime
37, recovery 26, index 9. This includes the seven new cases; earlier standalone
runs are not added again. GitHub/Ubuntu execution has not been verified.

`npm.cmd ci` succeeded without changing the lockfile. Its audit summary reported
8 advisories (6 moderate, 2 high); no audit fix, dependency update or advisory
analysis was performed in this test-only task. The documentation sample below
was separately parsed and accepted by the current create validator; Markdown
relative targets and whitespace were checked. These are not additional tests in
the 611 total.

| Case | Actual HTTP observations and assertions |
| --- | --- |
| One stem | Login 200 -> single-file upload 201 -> private Track POST 201 -> owner detail 200 and My Tracks 200. Server-generated stemId, exact metadata and response context survive both reads. |
| Four stems, completion order changed | Two requests in flight; callbacks/client responses deliberately complete Bass -> Chords -> Lead -> Drums. Duplicate source filenames do not act as identity. POST/detail/My Tracks retain Drums -> Bass -> Chords -> Lead, unique stable stemId values and the corresponding uploaded metadata. |
| One upload rejected | Chords returns 415 while three assets succeed. Coordinator blocks Track POST; My Tracks total=0. Retry uploads only Chords: five provider calls for four successful assets, then POST/detail/My Tracks succeed without reuploading successes. |
| Track validation rejection | Upload succeeds; POST with numeric-string bpm returns 400 before Track.create/transaction. No Track, asset retained. Correct numeric bpm and reuse the result: 201, detail/My Tracks match, still only one upload. |
| Auth failures across stages | Missing/invalid token on upload returns 401 before provider call; missing/invalid token on Track POST returns 401 before create. No Track. Re-login normally as the same owner and reuse the uploaded audio; publishing succeeds. |
| Lost creation response after commit | Test-only HTTP wrapper destroys the connection at successful response end, after the simulated commit. Client gets unknown; My Tracks/detail recover the one matching committed Track. Exactly one POST, no automatic retry/reupload/deletion. |
| Lost connection before handler | Same client unknown state, but fixture knows Track.create/commit never ran and My Tracks is empty. Coordinator still does not retry. This contrasts with the committed case: a network error alone cannot decide whether a Track exists. |

Every successful case asserts StemInput has exactly name/audioUrl/duration/fileSize;
publicId remains in the upload result only. POST, detail and My Tracks return the
same Track/ordered stem IDs, public artist allowlist and likedByMe=false. Response
fields and publicId are not added to stored Track documents. Headers are no-store.

Lost-response faults live **only in the test HTTP fixture**, not runtime code.
The after-commit case compares owner, full intended metadata and ordered stem
metadata/URLs; matching title alone is insufficient. This fixture has only one
candidate. In production, scan paginated /mine if needed, verify details, stop on
multiple candidates, and do not interpret an empty early read as proof that an
in-flight write cannot commit. This is not a durable idempotency mechanism.

## Sample frontend payload

Authenticated `POST /api/tracks`, JSON. The example passes the current input
validator; URLs are placeholders, not real uploaded/playable assets. Replace each
URL/duration/fileSize with that slot's actual successful upload response. Keep
selection order and do not spread data.publicId into a stem.

```json
{
  "title": "Four-stem technical example",
  "genre": "Electronic",
  "bpm": 96,
  "key": "Am",
  "tags": ["technical-example"],
  "coverImageUrl": null,
  "description": "Illustrative payload; use metadata from actual upload responses.",
  "isPublic": true,
  "isDownloadable": false,
  "stems": [
    { "name": "Drums", "audioUrl": "https://example.invalid/audio/drums.wav", "duration": 20, "fileSize": 3528044 },
    { "name": "Bass", "audioUrl": "https://example.invalid/audio/bass.wav", "duration": 20, "fileSize": 3528044 },
    { "name": "Chords", "audioUrl": "https://example.invalid/audio/chords.wav", "duration": 20, "fileSize": 3528044 },
    { "name": "Lead", "audioUrl": "https://example.invalid/audio/lead.wav", "duration": 20, "fileSize": 3528044 }
  ]
}
```

Client-only slot IDs/names/order are kept locally: the upload endpoint accepts
one multipart audio file and no extra fields. Map each response back to its
captured slot, then select the four allowed StemInput fields in the chosen order.
Use returned stemId as mixer key after creation. Login passwords/tokens must not
enter recovery manifests or logs.

## Readiness and remaining backend gaps, ranked by upload impact

| Priority | Finding | Consequence and proposed next work (not implemented) |
| --- | --- | --- |
| High: recovery reliability | No upload/Track idempotency key or authoritative operation-status lookup. Fresh upload attempts generate new provider IDs. | Blind retry after network loss can duplicate assets or Tracks. Supervised integration can stop as unknown and reconcile; reliable unattended publishing requires an agreed persistent operation/idempotency design. Neither a batch request nor a local manifest solves this alone. |
| High: asset lifecycle and ownership | No durable upload ledger/linking/release API/general orphan cleanup. POST accepts arbitrary HTTPS URLs/client-supplied metadata and does not establish upload ownership. | Abandoned/replaced files and assets from failed Track creation remain. Account-scoped drafts prevent accidental mixing, not malicious reuse. Agree recorded ownership/reference tracking and safe cleanup with race/shared-reference/legacy protection before promising automatic lifecycle management. |
| Medium: capacity and resilience | 20 MiB/file, 10 authenticated attempts/account/15 minutes including failures; in-memory limiter; no declared aggregate/duration/storage quota. | Known successful slots should be reused, queue bounded and Retry-After honored. Decide stronger quotas, cancellation/reconciliation and concurrency bounds before expanding upload volume or adding a multi-file request. |
| Medium: visibility/download expectations | Audio delivery is public; isPublic/isDownloadable are not provider byte-access controls. | Not a blocker to a public demo with agreed wording. Strong private asset or download guarantees need a separate delivery/security design. |
| Group decision, not an established backend defect | Option A satisfies the tested sequence, but the specification's simultaneous-upload wording has no settled HTTP packaging interpretation. | Agree coordinated single-file requests versus a new batch endpoint with Phuc. Contract remains Draft. No runtime extension is required for the tested happy path. |
| Separate later scope | PATCH rejects stems; no add/remove/replace/reorder after creation or cover-upload route. | This test covers creation only, using null cover. Do not expand it into stem-management/collection/download implementation without agreement. |

**Usable now:** real login -> repeated existing single-file upload -> create one
Track with 1-4 ordered stems -> owner detail/My Tracks, including per-slot failure
handling and metadata/auth correction without reuploading successes. This requires
a frontend coordinator with the tested policies; no real frontend or cloud
integration is certified. UI double-submit prevention is useful but not durable
idempotency. The server API, schema and Draft contract remain unchanged.
