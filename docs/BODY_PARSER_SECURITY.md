# body-parser security checkpoint

Date: November 24, 2026 (Asia/Saigon). Status: local patch, not committed,
pushed, merged or deployed. Branch `fix/body-parser-security` from fetched
origin/dev **2d2c68eb97364acdb7c8df469950f08245a2408d**. Its base application tree
matches the previous main release b3c72c5. No shared service or database was used.

The separate quality-evaluation worktree and its five handoff files remain
unchanged, anchored to **b3c72c576ac7183bdfce955577de172ddac5253b**. Its 752-test,
performance and audit results are historical evidence for that SHA, not revised
to describe this dependency patch. The Track/Stem contract remains Draft.

## Target and dependency resolution

[GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) affects
body-parser 2.x before 2.4.0. A compressed frame followed by trailing bytes can
leave a decoder emitting an unhandled error after a response. The application
uses the default express.json() globally, before routing. The official
[v2.4.0 release](https://github.com/expressjs/body-parser/releases/tag/v2.4.0)
identifies the security fix; its Node requirement (>=18) fits the project's Node 24.

Before and after `npm explain body-parser`, `npm ls --all` and lockfile checks:

```text
stemforge-server
  -> express 5.2.1 (unchanged root range ^5.2.1)
     -> body-parser 2.3.0 -> 2.4.0 (Express range ^2.2.1)
        -> qs 6.16.0 -> 6.17.1 (new parser range ^6.16.1)
     -> the same deduplicated qs 6.17.1 (Express range ^6.14.0)
```

express-rate-limit and swagger-ui-express also declare Express peers; they use
the same installed Express, not additional parser copies. Inspection of every
installed node_modules package/subtree found **one** body-parser copy, 2.4.0.
There is no affected nested 2.x copy or separate 1.x copy in this application's tree.

The runtime update is npm-generated lockfile resolution only:

```powershell
npm.cmd update body-parser --package-lock-only --ignore-scripts --no-audit --no-fund
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd explain body-parser
npm.cmd ls body-parser qs --all
```

Exactly two resolved nodes changed: body-parser and qs. The parser requires a
newer qs; npm selected compatible 6.17.1 in both existing parent ranges.
content-type 2.1.0 and iconv-lite 0.7.3 already satisfied its increased minima,
so their installed versions did not change. All unrelated resolved packages and
application dependency ranges remain unchanged. No direct body-parser/qs entry,
overrides, force audit fix, parent upgrade or major upgrade was added.

package.json changes only test scripts: `test:json` and one explicit inclusion
in test:ci. src, runtime parser options, bootstrap, schema/index, upload, playback
and CORS code are unchanged. JSON compression is preserved; inflate=false is
not used as a workaround.

## Regression and evidence

New tests reuse the actual Express app, Auth route, validation and error handler;
database and password-comparison boundaries are controlled in-memory adapters.
JWT creation and User response serialization still use application code.
Existing Auth tests already cover ordinary valid JSON, malformed JSON and the
plain 100 KiB parser limit; those cases were reused rather than duplicated.

| Check | Result |
|---|---|
| Existing Auth/JWT suite, including valid/plain malformed/oversized JSON | 77 passed |
| Ordinary gzip, deflate and Brotli JSON reaches login with correct parsed values | 3 passed, HTTP 200 |
| Corrupt gzip / malformed inflated JSON / expanded body >100 KiB / unknown encoding | 4 passed, sanitized 400/400/413/415, no DB lookup |
| Trailing-gzip bytes in a dedicated child | Process survives, initial 200 then health 200 |
| Unsupported-charset compressed body in a dedicated child | Process survives, sanitized 415 then health 200 |
| Final full npm test on this patch, once | **761 passed, 0 failed** |

The nine new tests run once through `test:json` in test:ci. They are included in
761, not added again to the separate focused runs (9 + existing Auth 77).
Final suite breakdown: JSON 9, CORS 28, Auth 77, Tracks 410, idempotency 32,
uploads 59, multi-stem publish 7, Likes 51, realtime 40, recovery 26, index helpers 22.
Windows / Node 24.15.0 / npm 11.12.1 were used. GitHub/Ubuntu is still pending.
The final lockfile SHA-256 is:

```text
6c825dde5c2e944399c18719c2349cb477900360919a808676cf65fc1a7d1661
```

Crash-sensitive cases are fixed test fixtures, never a configurable target or
Production probe. Each child binds only 127.0.0.1, uses dummy config, accepts no
external URI, loads no .env, makes no DB/storage connection, has a nine-second
parent deadline and closes HTTP/agent/timers/IPC. It tests a bounded upstream
regression shape (~100 KiB), then allows delayed errors to surface and verifies
health. No uncaughtException handler masks a crash. No payload was sent to Render.

An independent local control using old body-parser 2.3.0 with Express's default
JSON middleware reproduced an unhandled zlib failure: response 200, then child
exit **1**. This minimal control is separate from the actual-app patched tests
and is **not** an additional automated test. Two earlier full-bootstrap attempts
timed out while loading the app and were terminated; they are retained as
inconclusive, not called reproduced crashes. All control/diagnostic children
exited; no database fixture or benchmark was needed.

## Audit comparison

| Metric (flagged package nodes) | Before | After |
|---|---:|---:|
| Total | 9 | 7 |
| High | 3 | 2 |
| Moderate | 6 | 5 |
| Critical | 0 | 0 |

Resolved:

- **GHSA-27r3-jxmh-p828**, body-parser compressed-body DoS.
- **GHSA-6pq8-jhm2-2vcw**, qs comma-stringify coercion DoS, resolved as a consequence
  of the parser's required transitive update. It was not a separate broad audit fix.

Remaining, outside this patch:

| Package | Severity | Underlying advisory IDs |
|---|---|---|
| mongoose | High | GHSA-gg4r-jv3p-qx3c; GHSA-wr5m-5jph-8m96; GHSA-8332-j7wj-wjw4; GHSA-6972-9mcm-vhwj |
| multer | High | GHSA-q7qp-rjg7-q26m |
| fast-uri | Moderate | GHSA-w74x-v6f9-j3xg; GHSA-xhq7-xmqj-769h; GHSA-wjr9-j795-jxcr; GHSA-333x-w4r6-6crp |
| ip-address | Moderate | GHSA-rxp7-6hxx-x8q5 |
| minimatch | Moderate | GHSA-g3hv-75wg-m249 |
| glob | Moderate | GHSA-3g3m-2fjr-6pw4; inherited minimatch warning |
| swagger-jsdoc | Moderate | Inherits glob chain; no additional distinct advisory |

Audit remains nonzero. No claim of an audit-clean or completely secure backend.
Raw before/after audit, explain/tree outputs, child-control results and test logs
are retained in a nonsecret external review bundle, not committed as local data.

## Reproduce and release

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd explain body-parser
npm.cmd ls body-parser qs --all
npm.cmd run test:json
npm.cmd run test:auth
npm.cmd test
npm.cmd audit --json
```

Audit is expected to return a nonzero exit while the unrelated seven findings
remain. No load benchmark is required for this focused dependency fix.

Nguyen should review, commit/push, await GitHub's Node 24/Ubuntu tests, merge the
feature-to-dev and dev-to-main PRs, then deploy using the committed lockfile.
Verify the build installs the patched dependency and the Dashboard Live commit
matches the merged main SHA. This session did not change build/service settings.

### Post-deploy read-only smoke

Use only a few GET/OPTIONS requests. No login, fixture, upload or malicious body:

```powershell
$apiBase = 'https://stemforge-server.onrender.com'
$frontendOrigin = 'https://stemforge-client.vercel.app'
curl.exe --fail --silent --show-error "$apiBase/api/health"
curl.exe --fail --silent --show-error --output NUL --dump-header - --header "Origin: $frontendOrigin" "$apiBase/api/tracks?page=1&limit=1"
curl.exe --fail --silent --show-error --output NUL --dump-header - "$apiBase/api/tracks/6adce3bb3952132ce5a50f15"
curl.exe --silent --show-error --output NUL --dump-header - --request OPTIONS --header "Origin: $frontendOrigin" --header 'Access-Control-Request-Method: GET' --header 'Access-Control-Request-Headers: authorization' "$apiBase/api/tracks"
```

Expect health/list/detail 200 and preflight 204 with the exact Production origin.
Health has no revision; these requests alone cannot prove the installed parser
version. Use CI/build dependency output and Dashboard commit evidence for that.
Never replay the compressed security payload on Production.
