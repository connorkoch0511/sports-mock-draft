# Backend Hardening: Pagination, Coverage, and the drafts.js Migration

**Date:** 2026-09-01
**Status:** Approved, ready for implementation planning
**Scope:** Backend only — no frontend change, no schema change

---

## Summary

Close the three cheapest real gaps left by the compression work, and finish the
migration it deliberately deferred.

---

## Motivation

Four items, each already identified and each with a different reason for existing.

### 1. Single-page DynamoDB Queries — latent, not broken

`boards.js` pages through `ExclusiveStartKey`/`LastEvaluatedKey` and carries a comment
explaining why: a Query page tops out at 1MB, and the players table is close enough to
that ceiling that one page could silently drop players. `players.js` and `drafts.js` run
the same Query against the same table **without** that loop.

Measured against production before writing this spec:

```
table item count:            3,875
single-page Query returned:  3,875
LastEvaluatedKey:            null
GET /players count:          3,875
```

**Nothing is being truncated today.** The payload still fits in one page. This is a
latent bug that bites when the pool grows or a field is added — and it fails silently,
returning a short list rather than an error. That is the argument for fixing it now
rather than after it starts dropping players.

### 2. No test covers `/players`

The compression work trimmed `status`, `updatedAt`, and `playerId` from the response and
shipped it with no test asserting the resulting shape. There is no `players.test.js` at
all.

### 3. `acceptsGzip` treats a refusal as consent

```js
return String(headers[key] || "").toLowerCase().includes("gzip");
```

`Accept-Encoding: gzip;q=0` means the client is *refusing* gzip. The substring match
reads it as acceptance. No browser sends it, so this has never fired — but it is a
correctness gap in the one function that decides whether a client can decode the body.

### 4. `drafts.js` never migrated to the shared responder

The compression spec deferred this, reasoning it meant "21 mechanical edits inside the
handler that runs on every pick, auto-pick, and sim." Reading the file changes that
estimate. Every hand-built return uses **one** shared `headers` const built once at
`drafts.js:163`, and every body is a plain `JSON.stringify(...)`:

```js
return { statusCode: 404, headers, body: JSON.stringify({ error: "Draft not found" }) };
```

So the migration is a single uniform substitution across 19 sites, not 21 bespoke edits.
The risk that justified deferring it is materially lower than the earlier spec assumed.
The gain: the ~40KB draft payload gets compressed, and the duplicate `corsHeaders()` goes
away.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Pagination | Copy the `boards.js` loop verbatim into both handlers | It already exists, is already reviewed, and already carries the explanatory comment |
| Proving pagination | Unit test with a faked two-page DynamoDB response | The fix is unobservable against real data (one page today), so without this it is unverifiable and can silently regress |
| `acceptsGzip` | Parse q-values rather than substring-match | `gzip;q=0` is a refusal; sending it a gzipped body is the exact failure the function exists to prevent |
| OPTIONS body in `drafts.js` | `body: ""` → `json(200, {})` | `boards.js` already does this. No client reads a preflight body, and two conventions is worse than one change |
| CORS methods in `drafts.js` | Accept the widening to `GET,POST,PUT,DELETE,OPTIONS` | Already established harmless: preflights never reach the Lambda; the gateway answers them with the wider list itself |
| `drafts.js` bot logic | Untouched | The migration is response-shaping only. No pick, scoring, or roster logic changes |

---

## Architecture

### `backend/src/lib/http.js` — q-value parsing

`acceptsGzip` splits `Accept-Encoding` on commas, and for each entry compares the coding
name against `gzip` and `*`, reading any `;q=` parameter. An entry accepts gzip only when
its q-value is greater than zero. An absent `q` means 1.0 per RFC 9110.

Cases that must resolve correctly:

| Header | Accepts gzip |
|---|---|
| `gzip` | yes |
| `gzip, deflate, br` | yes |
| `gzip;q=0.8` | yes |
| `gzip;q=0` | **no** |
| `gzip;q=0.000` | **no** |
| `*` | yes |
| `*;q=0` | **no** |
| `deflate, br` | no |
| absent / malformed | no |

Malformed input must fail open to *no compression* — returning uncompressed bytes is
always safe; returning gzip to a client that cannot decode it is not.

### `backend/src/players.js` and `backend/src/drafts.js` — pagination

Both replace their single `QueryCommand` with the accumulate-until-exhausted loop from
`boards.js:46-64`, including its comment. No other logic changes.

### `backend/src/drafts.js` — responder migration

- `const json = responder(event);` as the first statement of the handler, matching
  `boards.js` and `players.js`
- All 19 hand-built returns become `json(status, body)`
- The local `corsHeaders()` (lines 21-28) is deleted; the local `headers` const at line
  163 is deleted with it
- The OPTIONS branch becomes `return json(200, {})`

Response bodies, status codes, and field names are otherwise unchanged.

### `backend/src/players.test.js` — new

Covers the response shape the compression work created and the pagination the fix adds.
The handler is exercised with a stubbed DynamoDB client so no AWS call is made.

---

## Risk

`drafts.js` is the highest-traffic handler in the app — every pick, auto-pick, and
sim-to-end routes through it. Three things bound the risk:

1. **The substitution is uniform.** Every site has the same shape, so there is no
   per-site judgment to get wrong.
2. **The gzip path is opt-in.** A client that does not send `Accept-Encoding: gzip` gets
   exactly the bytes it gets today. The q-value fix only ever *narrows* who receives
   compression.
3. **Post-deploy verification exercises a real draft end to end** — create, pick,
   auto-pick, sim to completion — against the deployed stack, compressed and
   uncompressed, rather than asserting from unit tests alone.

The honest caveat: no existing test suite covers `drafts.js` response shaping. The
end-to-end verification is what actually proves the migration, which is why it runs a
full draft rather than a single request.

---

## Testing

### Unit — `backend/src/lib/http.test.js` (extend)

Every row of the q-value table above, asserted directly against `acceptsGzip` behavior
via `responder`. The `gzip;q=0` case must fail against the current substring
implementation — if it passes before the fix, it is not testing the fix.

### Unit — `backend/src/players.test.js` (new)

- Present in each player: `id`, `name`, `position`, `team`, `rank`, `adp`, `tier`
- **Absent** from each player: `status`, `updatedAt`, `playerId`
- Players are sorted by rank, with null ranks last
- **Pagination:** a stub returning `LastEvaluatedKey` on page 1 and omitting it on page 2
  yields players from *both* pages. This must fail against the current single-page
  implementation
- `format` and `sport` query parameters select the right rank/adp/tier values

### Unit — `backend/src/drafts.test.js` (new)

There is no test file for `drafts.js` today — the existing backend suites are
`boards.test.js`, `lib/http.test.js`, `lib/reconcile.test.js`, and `lib/roster.test.js`.
This file is created by this work and covers response shaping only, with a stubbed
DynamoDB client:

- Every migrated status code still returns its original status and error message
- No response carries `isBase64Encoded` when the request sends no `Accept-Encoding`

### Post-deploy verification

Against the deployed stack: create a draft, make a manual pick, trigger an auto-pick, sim
to completion, and fetch the result — each compressed and uncompressed, confirming
identical decoded JSON. This is the check that actually covers the migration.

---

## Out of Scope

- **Any frontend change.** Browsers decompress transparently; nothing client-side moves.
- **Any change to bot scoring, roster logic, or snake order.** Response shaping only.
- **Caching the player pool in Lambda module scope.** Still a separate decision.
- **Paginating or filtering the `/players` response.** This makes the *read* complete;
  it does not make the payload smaller.
- **The "My drafts" registry and the draft-page UX items.** Separate work, already
  sequenced after this.
