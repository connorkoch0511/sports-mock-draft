# API Response Compression

**Date:** 2026-08-31
**Status:** Approved, ready for implementation planning
**Scope:** Backend only — no frontend change, no schema change

---

## Summary

Gzip API responses in the shared HTTP helper, and stop shipping three never-read fields
on every player.

---

## Motivation

The draft page is slow, and measurement shows it is not the code.

| | Lambda execution | Response size | Compressed | Client time |
|---|---|---|---|---|
| `GET /boards/:id` | 0.8–1.5s | 35 KB | no | ~3–4s |
| `GET /players` | 1.0–2.5s | **575 KB** | no | **20–60s** |

CloudWatch shows both Lambdas finishing in about a second. The rest is transfer:
**API Gateway HTTP APIs do not compress responses**, and nothing in the handlers does
either.

The contrast that proves the diagnosis: the CloudFront-served JS bundle *is* compressed
on request — 313 KB drops to 100 KB. Static assets get gzip; API responses get none.

Two consequences worth stating plainly:

- The board's ~3 seconds is roughly 1s of Lambda and 2s of shipping 35 KB. Fixing the
  board alone would have addressed the smaller half of the problem.
- `/players` is the real bottleneck, and it blocks everything — the board cannot begin
  loading until the draft resolves, which waits on the player pool.

Measurements were taken on a link running about 35 KB/s. That is a slow connection, and
it is exactly the condition under which an uncompressed 575 KB payload becomes a minute
instead of four seconds.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Where compression lives | `backend/src/lib/http.js` | The shared helper both migrated handlers route through, so future endpoints get it free. |
| How handlers opt in | `const json = responder(event)` shadowing the import | Gives the responder access to request headers without threading `event` through dozens of call sites. Existing `json(...)` calls are untouched. |
| When to compress | Only when the client sends `Accept-Encoding: gzip`, and only above a size threshold | A client that cannot decode must never receive binary. Below ~1 KB, compression costs more than it saves. |
| Dropped fields | `status`, `updatedAt`, `playerId` from `/players` | Verified unread. See below. |
| Frontend | No change | Browsers decompress transparently; `api.js` still receives plain JSON from `res.text()`. |

---

## Compression — `backend/src/lib/http.js`

A new `responder(event)` returns a `json(statusCode, body)` bound to that request.

```js
responder(event) → (statusCode, body) → LambdaProxyResponse
```

Behavior:

- Serializes `body` to JSON exactly as today
- If the request's `accept-encoding` header includes `gzip` **and** the serialized body
  exceeds `MIN_COMPRESS_BYTES` (1024), gzip it, base64-encode it, and return
  `Content-Encoding: gzip` with `isBase64Encoded: true`
- Otherwise return the plain JSON body exactly as today
- CORS headers are unchanged in both paths

`zlib.gzipSync` is built into Node. No dependency is added.

The existing `json(statusCode, body)` export stays, unchanged and uncompressed, so any
call site not yet migrated keeps working. `corsHeaders()` and `ALLOWED_METHODS` are
untouched.

Header lookup must be case-insensitive. API Gateway HTTP API payload format 2.0
lower-cases header names, but relying on that silently is how a working feature becomes a
silent no-op.

---

## Handler changes

**Only `boards.js` already routes through `json()`.** `players.js` and `drafts.js` build
responses by hand, each with its own duplicated `corsHeaders()`:

| | `json()` calls | hand-built returns |
|---|---|---|
| `boards.js` | 19 | 0 |
| `players.js` | 0 | 3 |
| `drafts.js` | 0 | 21 |

**`boards.js`** gains one line at the top of the handler:

```js
const json = responder(event);
```

This shadows the imported `json`, so all 19 existing calls compress without being edited.

**`players.js`** gains the same line, and its 3 hand-built returns become `json(...)`
calls. Its local `corsHeaders()` is deleted in favour of the shared one. One of those
three returns is the 575 KB response — the entire problem, for a three-site diff.

**`drafts.js` is deliberately left alone.** Its 21 hand-built returns would be 21
mechanical edits inside the handler that runs on every pick, auto-pick, and sim — the
highest-traffic code in the app — to compress a ~40 KB payload worth about a second. The
risk is not proportionate to the gain. Its duplicate `corsHeaders()` survives for now, and
migrating it stays available as a follow-up once the compression path has proven itself in
production on two endpoints.

No response shape, status code, or field changes in either migrated handler.

---

## Payload trim — `backend/src/players.js`

Three fields come out of the mapped player object:

- `status` — never read by any page
- `updatedAt` — never read by any page
- `playerId` — every `playerId` reference in the frontend is on a **board row**
  (`row.playerId`) or a **draft pick** (`pk.playerId`), never on a player from this
  endpoint. `Draft.jsx` builds `playersById` keyed on `p.id`, and `syncPlayers` sets
  `id` and `playerId` to the same string, so the pick lookup at `Draft.jsx:497`
  continues to resolve.

`id`, `name`, `position`, `team`, `rank`, `adp`, and `tier` remain.

---

## Risk

**This is the highest blast-radius change in the project so far.** `lib/http.js` is shared
by every endpoint; a mistake in the compression path breaks all of them at once, not one
feature.

Three mitigations:

1. **The gzip path only engages when the client asks for it.** Anything that does not send
   `Accept-Encoding: gzip` — curl without `--compressed`, an old client, a health check —
   receives exactly the bytes it receives today.
   Scope is also deliberately limited: `drafts.js` is untouched, so the pick, auto-pick,
   and sim-to-end paths cannot be affected by this change at all.
2. **The responder is unit tested** on both paths, including that the base64 body
   round-trips back to the original JSON rather than merely being non-empty.
3. **Every endpoint is verified with curl immediately after deploy**, compressed and
   uncompressed, rather than assumed.

One honest caveat: `isBase64Encoded` is documented for HTTP API payload format 2.0 and is
expected to work here, but it has not been proven against this stack. The post-deploy
verification is what confirms it, and it is why the plan checks every endpoint rather than
one.

---

## Testing

### Unit — `backend/src/lib/http.test.js` (`node:test`)

- A client sending `Accept-Encoding: gzip` with a large body gets `isBase64Encoded: true`,
  a `Content-Encoding: gzip` header, and a body that **gunzips back to the original JSON**
- A client sending no `Accept-Encoding` gets plain JSON, no `Content-Encoding` header, and
  no `isBase64Encoded`
- A client sending `Accept-Encoding: deflate, br` — no gzip — gets plain JSON
- A body under the threshold stays uncompressed even when gzip is accepted
- Header lookup works whether the header arrives as `Accept-Encoding` or `accept-encoding`
- CORS headers are present and identical on both paths
- The status code passes through on both paths
- A missing or malformed `event` degrades to plain JSON rather than throwing

### Existing suites

41 backend unit tests, 31 frontend unit tests, and 64 Playwright tests must all still
pass. Playwright mocks responses at the route level and is unaffected by transport
encoding.

### Post-deploy verification

For `/players` and `/boards/:id`: request with and without `--compressed`, confirm the
compressed response carries `content-encoding: gzip`, that the decoded JSON is
byte-identical to the uncompressed response, and record the size and timing difference.

Also request `/drafts/:id` and confirm it still returns plain uncompressed JSON exactly as
before — it is the control that proves the change stayed inside its scope.

---

## Out of Scope

- **Caching the player pool in Lambda module scope.** Would cut the ~1s server time on
  warm containers, but raises staleness questions against a table the nightly sync
  rewrites. Separate decision.
- **Putting CloudFront in front of the API.** A larger infrastructure change.
- **Paginating or filtering `/players`.** The endpoint still returns the full pool; this
  work makes that cheap to transfer, not smaller to compute.
- **The single-page DynamoDB Query in `players.js` and `drafts.js`**, which can silently
  truncate above 1 MB. Pre-existing and tracked separately.
- **Migrating `drafts.js` to the shared responder**, and deleting its duplicate
  `corsHeaders()`. Deferred by decision, not oversight — see Handler changes.
