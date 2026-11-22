# Original stem download MVP

Status: backend implemented locally on November 22, 2026; not committed,
merged or deployed. The overall Track/Stem contract remains **Draft**.
This implements Nguyen's agreed download MVP, not approval of unrelated contract
choices or a claim of application frontend integration. A separate November 23
follow-up verified real Cloudinary delivery and a minimal local Chrome page;
Render Download acceptance remains pending.

## Frontend flow

1. Require a signed-in account. Show a download action for each stem only when
   the fetched Track has `isDownloadable: true`. This UI check is not authorization.
2. Call `GET /api/tracks/{trackId}/stems/{stemId}/download` through the existing API
   helper with the current Bearer token. Use `stemId`, not array index. No body,
   query parameters, publicId, filename or arbitrary URL is accepted as input.
3. A successful response is HTTP 200 JSON, **not** a redirect or file stream:

```json
{
  "data": {
    "trackId": "507f1f77bcf86cd799439044",
    "stemId": "507f1f77bcf86cd799439055",
    "downloadUrl": "<short-lived signed Cloudinary attachment URL>",
    "expiresAt": "<ISO 8601 UTC timestamp>"
  }
}
```

4. After checking that the response still belongs to the current Track/account,
   offer a normal link to `downloadUrl`, with `rel="noreferrer noopener"` if opening
   another tab. Label it with the stem's existing name. Cloudinary supplies the
   attachment filename; custom filename support is not promised by this MVP.
   Do not pass the link through an API helper that attaches Bearer headers. Do
   not assume the HTML `download` attribute forces a cross-origin download.
   A visible link avoids popup blockers caused by opening a window after await.
5. Disable repeated clicks while requesting a descriptor. Handle errors in the
   action without interrupting playback. Never log/persist the signed URL, place
   it in analytics or store it in Track/Stem. Clear it on account/Track change.
   Request another descriptor after expiry; do not loop retries on 401/403/404/422.

The API uses existing CORS and `Cache-Control: no-store`; there are no new custom
headers, environment variables or frontend origins to configure in this change.

## Authorization and errors

| Status | Meaning |
|---|---|
| 200 | Current authenticated viewer may download this original stem. |
| 400 | Invalid 24-hex Track/stem ID, or any query parameter. |
| 401 | Missing/invalid/expired token or missing account. |
| 403 | Visible Track has downloads disabled, including for its owner. |
| 404 | Track missing/foreign-private, or stem absent from the accessible Track. |
| 422 | Stored audio URL is outside the supported managed-original format. |
| 500 | Authentication, database, storage configuration or local signing failure; generic error. |

Errors use `{ "message": "..." }`. The database read is scoped to public OR
self-owned private Tracks before inspecting download/stem metadata. There is
no admin bypass or owner bypass of the download flag. Each descriptor request
rechecks access; no link cache is kept by the backend.

## Storage and delivery boundaries

The backend signs a **five-minute** Cloudinary original download URL locally
using the installed Node SDK's `utils.private_download_url`, `resource_type:
video`, `type: upload`, `attachment: true`, the stored original format and no
transformation. No file is fetched/proxied by Express and no upload, asset lookup,
delete or provider configuration request occurs while issuing the descriptor.
Signing always targets the official `https://api.cloudinary.com` endpoint.

Only exact HTTPS originals produced by the current uploader are supported:
`https://res.cloudinary.com/<configured-cloud>/video/upload/v<positive-version>/stemforge/audio/<24-hex-owner>/<UUID>.<mp3|wav|flac>`.
The complete stored string is validated (no credentials, port, query, fragment,
encoding, traversal, existing transformation, other cloud or delivery type).
The namespace owner's ID need not equal the Track owner: existing Track creation
allows reusing uploaded audio references. This is not proof of asset ownership.
Legacy/external audio URLs remain playable as before but return 422 here; no
fallback redirect or server-side fetch is attempted. No schema/asset ledger change.

A link already issued can be shared and remains usable until expiry even after
Sign out, download revocation, privacy change or Track DELETE. Track DELETE does
not delete the underlying Cloudinary asset. Existing public playback URLs can
still be saved directly. This gate is **not DRM** and does not make private Track
audio bytes private. ZIP/export mix, asset migration/revocation and protected
playback require separate scope.

The [official Cloudinary access-control guide](https://cloudinary.com/documentation/control_access_to_media#providing_time_limited_access_to_private_media_assets)
documents `type: upload`, signed download links and the delivery tradeoff: this
endpoint bypasses CDN caching and costs twice the delivery bandwidth. It avoids
new Render audio-proxy memory/egress and does not request audio transcoding.

## Verification and reproduction

Node 24 on Windows. No .env, shared database or real Cloudinary credentials are
needed for the following automated tests:

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run test:downloads
npm.cmd test
```

56 new Download tests pass through real Express routes/auth middleware and JWT,
with a mocked database boundary and real SDK URL signing using dummy keys. They
cover guest/invalid/expired/deleted-user authentication, public/private owner
access, flag enforcement, IDs/query rejection, stem membership, unsafe stored
URLs, original formats, signature/expiry, failure sanitization, cache policy and
Swagger. `test:tracks` includes this file once; full `npm test` passed 752 tests,
including Track/upload/Like regression. Do not add a standalone run to that count.

An optional manual probe uses the existing pinned isolated Mongo test tooling:

```powershell
npm.cmd ci --prefix scripts/verification/track-idempotency --ignore-scripts --no-audit --no-fund
node scripts/verification/stem-download.cjs
```

Six separate groups passed with MongoDB 8.0.34 WiredTiger / single-node replica
set and mongodb-memory-server 11.3.0. Real login, database reads, PATCH/DELETE
transactions and loopback HTTP run with a fresh marker. The probe accepts no URI
or arguments, clears inherited Mongo/provider credentials, validates the newly
created 127.0.0.1 topology before DDL and never falls back to shared MONGO_URI.
Its report is written under the OS Temp directory, not Git. Finally closes HTTP,
disconnects Mongoose, stops mongod and removes the validated data directory.
Mongo binary download uses the official fastdl.mongodb.org source and a Temp
cache; first setup requires network access.

These six groups are **not** extra automated-suite tests. They do not download
Cloudinary bytes. The separate provider/browser follow-up below covers those
layers and is not part of the automated count. Render Download deployment is
**not yet verified**. After review and normal feature -> dev -> main release,
verify Render with a separately authorized downloadable fixture; preserve the
permanent demo (downloads disabled), seed Tracks and assets. No new shared index
or provisioning step is required.

## Real provider and Chrome follow-up (November 23, 2026)

No Download runtime, test or test-script change was needed. The existing 752
passing automated tests and six isolated Mongo groups are retained as historical
evidence; they were not rerun for a new count. Manual smoke results are separate.

Only local Cloudinary configuration was selected in memory. All inherited Mongo
configuration was discarded: the backend connected only to a new 127.0.0.1
MongoDB 8.0.34 WiredTiger single-node replica set, with topology guards before
DDL. Fixtures were local accounts and private downloadable Tracks. The demo
Track API was read only to identify the existing Drums WAV; Cloudinary asset
metadata was checked read-only against the configured cloud, video/upload type,
namespace, public ID and WAV format. No shared DB connection, asset upload,
update/delete or service configuration operation occurred.

Real HTTP login, POST Track and the Download endpoint returned the correct new
Track/stem IDs, JSON descriptor and no-store cache policy. Signed parameters
matched the existing asset and local SDK signature; TTL stayed exactly 300
seconds. URL query input was rejected with 400; unauthenticated access returned
401. The backend issued JSON only, without proxying audio or changing playback.

Cloudinary returned 200, Content-Type audio/wav and
`Content-Disposition: attachment; filename="file.wav"`. The provider filename is
not the stem label. Original CDN bytes, signed-link bytes and the file saved by
normal headed Chrome 158.0.8127.36 on Windows were all **3,528,044 bytes**, SHA-256:

```text
8983909b053da3a457d3c5ed93ff420a1a4fe0a9db02581c147830263eaccaa5
```

Chrome used default transport behavior and a disposable context. The page logged
in locally, fetched the descriptor with Bearer, then the user-clicked link opened
the attachment separately. The file was actually saved and hashed; no Bearer
header reached Cloudinary, no page error occurred, and that user-click flow was
not blocked as a popup/download. Prefer this visible second-click link over an
automatic window.open after await. A browser's future policy/user settings may
differ; this is not an application frontend or mobile-browser acceptance claim.

The first external page harness omitted its fixture route and requested
/undefined (404), causing timeout. Only the external harness was corrected;
application source was unchanged. Its final focused browser run passed all five
groups; those groups repeat local/provider checks and are not added to 752.

The first actual URL was downloaded successfully before its unchanged
five-minute expiry, then that exact in-memory URL was requested again five
seconds after expiry. Cloudinary returned **401** with an 87-byte error response,
not audio. Expiry was 2026-11-22T18:51:08Z; the check ran at
2026-11-22T18:51:13.800Z (November 23, 01:51:13.800 Asia/Saigon).
No fresh URL was substituted for this assertion. The separate final Chrome
run used a newly issued URL; its own later expiry was not separately retested.

All three disposable smoke runs (initial, diagnostic and corrected Chrome run)
confirmed browser/HTTP closed, Mongo disconnected, replica set stopped and owned
local data/download directories removed. Failed harness attempts remain failed
in their raw reports; they are not rewritten as passing runs or added to the
existing automated count. No credential, token or signed URL is stored in the
sanitized reports or final review artifacts. Raw reports and external harnesses
stay in Temp, outside the feature diff. No application frontend changes or
Render Download acceptance are claimed.
