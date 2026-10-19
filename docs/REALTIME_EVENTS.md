# Track realtime events (Draft)

**Backend MVP proposal; not an approved group contract.** Phuc and Nguyen still
need to confirm the events, connection-count meaning, access policy and client
reconciliation rules below. The Track/Stem contract also remains Draft.

## Connection and authorization

Socket.IO 4.x uses the REST HTTP server/port, default `/socket.io` path and default
polling/WebSocket transports. Browser Origin must equal `FRONTEND_URL` (default
`http://localhost:5173`); non-browser clients without Origin are allowed. Origin
checking is not authentication. No token belongs in a URL or log.

Connect with `auth: { token: accessToken }`, or omit token for a guest. An explicitly
supplied empty/invalid/expired token rejects the connection, never falls back to
guest. The existing HS256 JWT issuer/audience and User existence checks apply.
`connect_error` has `error.data.code` (`UNAUTHENTICATED` or `INTERNAL_ERROR`).

Guests can join public Tracks. Authenticated accounts can join public Tracks and
their own private Tracks; no admin override. Absent/inaccessible Tracks both return
`NOT_FOUND`. Account existence, expiry and Track access are checked on every join,
including duplicate joins. A failed join leaves the previous room unchanged,
except a denied rejoin to that same room removes stale membership. Authentication
failure disconnects the socket. Account deletion is detected on the next join;
there is no database change-stream subscription in this MVP.

At JWT expiry the server removes membership, emits
`auth:expired { code: "UNAUTHENTICATED" }`, then disconnects. Refresh credentials
through the existing HTTP flow and reconnect with a valid token; changing token
on an already joined connection does not refresh authentication. Expiry timers
are cleared on disconnect/shutdown. Network loss is detected by Socket.IO's
transport heartbeat; presence can be stale until disconnect detection.

## Client events and acknowledgements

Both client events require an ACK callback and exactly `{ trackId: string }`, a
24-hex ObjectId, normalized to lowercase. Events without ACK are ignored. Additional
keys, arrays, invalid IDs and operator objects return `INVALID_PAYLOAD`.

| Client event | Successful ACK `data` | Meaning |
| --- | --- | --- |
| `track:join` | `{ trackId, listenersCount, likesCount, epoch, listenersSeq, likesSeq }` | Access-checked snapshot, including the joining connection. Duplicate join refreshes the snapshot without increasing count. Joining another permitted Track leaves the previous one. |
| `track:leave` | `{ trackId, left: boolean }` | Removes membership only if this is the socket's active Track. Duplicate/stale leave succeeds with `left: false`. |

Success envelope: `{ ok: true, data: ... }`.
Error envelope: `{ ok: false, error: { code, message } }`.
Codes: `INVALID_PAYLOAD`, `UNAUTHENTICATED`, `NOT_FOUND`, `RATE_LIMITED`,
`INTERNAL_ERROR`. Branch on code, not English message text. Room requests are
limited to 30 valid requests/10 seconds/socket and eight pending requests/socket.
Maximum inbound Socket.IO payload: 16 KiB. On ACK timeout, do not infer whether the
operation happened; rejoin for a snapshot.

## Server events

| Event | Payload | Audience |
| --- | --- | --- |
| `listeners:count` | `{ trackId, count, epoch, seq }` | Current members of `track:{trackId}` after membership changes. |
| `like:updated` | `{ trackId, likesCount, epoch, seq }` | Current members, after a committed REST Like/Unlike actually changes membership. |
| `track:unavailable` | `{ trackId, code: "NOT_FOUND" }` | Connections removed after committed privacy change or deletion. No private/delete distinction. |
| `auth:expired` | `{ code: "UNAUTHENTICATED" }` | Expired connection, immediately before server disconnect. |

One socket has at most one Track room. Counts describe **connections in a room**,
not unique people or active audio playback. Multiple tabs count separately,
including owner/guest tabs. Join/leave are idempotent; switching, disconnect and
expiry remove old membership. No playback heartbeat/audio transport is implemented.

`like:updated` has no user ID, `isLiked` or `likedByMe`. Like/Unlike stay REST; use
their existing `{ data: { trackId, isLiked, likesCount } }` response for the current
user's heart. Refresh detail/Like state after reconnect when needed. No socket
event mutates a Like.

## Epoch, sequence and stale ACK rules

- `epoch` is a random UUID per in-memory room incarnation. It changes after the
  last member leaves and the room is recreated, or after process restart.
- Independent nonnegative sequences start at zero: `listenersSeq` and `likesSeq`.
  First join increments listeners to one. Each count broadcast increments its
  topic's sequence once; duplicate joins and Like no-ops do not. These are not
  MongoDB revisions, timestamps or cross-process identifiers.
- Join ACK establishes the Track/epoch and both sequence baselines. Each event
  uses its topic's `seq`. Apply only a higher seq for the same Track/epoch; never
  regress on an older same-epoch snapshot. State may advance before an ACK arrives.
- Maintain a client join generation per desired Track/connection. Ignore ACKs from
  previous connections, route selections or superseded requests. Register handlers
  once. Buffer events during the current join until its successful ACK, then apply
  matching-epoch events above snapshot seq. Handling `track:unavailable`, disconnect
  or a new join generation invalidates outstanding ACKs and old buffered events.
- On unexpected epoch, detected sequence gap or ACK timeout, request a fresh join
  snapshot. A different-epoch event is not a replacement snapshot. Discard unrelated
  Track events. A sequence gap does not imply that replay is available.

Connection recovery is disabled. After **every** `connect`, explicitly join the
still-desired Track and consume its snapshot. Use client reconnect backoff.
Server-initiated disconnect (including expiry) requires explicit reconnect after
refreshing credentials. A join resync every 30 seconds is an optional client
proposal, not an MVP requirement. **Epoch/seq do not provide durable delivery.**
Notifications are best effort; no replay, log, outbox or exactly-once guarantee.

## Commit ordering, lifecycle and deployment

Join, Like mutations, PATCH and DELETE share a queue **per Track**, never a global
REST queue. Each socket separately orders room requests. Membership changes use
the synchronous default in-memory adapter; switching never acquires nested Track
locks. Disconnect cleanup does not wait for either queue. Lookups completing after
disconnect cannot recreate membership. Idle queue entries, empty rooms,
disconnected clients and expiry timers are removed.

Existing transaction sessions and sequential queries are retained. Broadcasts and
revocations run after commit, outside transaction callbacks, inside the Track
queue. Retried/aborted callbacks cannot publish; the final committed result decides
whether a Like changed. Publish errors log event/error type only and cannot turn
committed mutations into REST failure or rerun them.

After PATCH to private, guests/foreign accounts leave; owner sockets remain.
DELETE removes all members with `track:unavailable`; Like cascade stays in that
transaction. Rollback does not revoke access. Client must stop the unavailable
view/audio and invalidate pending join ACKs. This cannot revoke a previously
disclosed public Cloudinary URL or downloaded audio.

Deploy **one Node process on one Render instance**. State is lost on restart;
clients reconnect/rejoin. SIGTERM/SIGINT closes sockets/HTTP, drains coordinated
work and disconnects DB (20-second shutdown deadline). Direct DB/other-process
writes are not observed. Multiple workers/instances or overlapping old/new deploy
processes do not share counts/queues/broadcasts; coherence during overlap is not
guaranteed. Scaling needs shared adapter/presence and event consistency design;
polling across instances also needs sticky sessions. Redis, outbox, durable replay,
multi-instance and playback heartbeat are outside MVP.

## Deployment verification (October 19, 2026)

Render Live **86aa3cb** passed **12/12 scoped REST/Socket.IO groups**, including
public/owner-private access, invalid-token rejection, WebSocket/polling, connection
counts, duplicate operations, transport reconnect with explicit rejoin, shared
Like events, concurrent operations, postcommit private/delete revocation and room
epoch recreation. A separate raw Engine.IO request with a disallowed Origin
returned **403 / code 4 / Forbidden**. The fixture run recorded 53 HTTPS responses
and 76 ACKs, followed by verified cleanup/data/index preservation and DB disconnect.

Natural JWT expiry, retry/rollback, publisher failure, process shutdown/restart and
rate/pending bounds were not injected/exercised on Render; earlier local tests
cover the implemented failure/lifecycle behavior. This is not a multi-instance,
load or browser/Vercel integration result. Transport failures/retries and prior
cleaned attempts are recorded separately in [PROJECT_STATUS.md](PROJECT_STATUS.md).
Deployment verification does not approve this **Draft backend event proposal** or
the Draft Track/Stem contract.
