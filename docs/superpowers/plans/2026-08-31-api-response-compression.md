# API Response Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Note (2026-09-01):** This plan is complete and historical — nothing executes it automatically. Its scope control of leaving `/drafts` uncompressed was intentionally superseded by `docs/superpowers/plans/2026-09-01-backend-hardening.md`, which migrated `drafts.js` onto the shared `responder()` helper. If you run the post-deploy verification script below by hand, the "`/drafts` must still be PLAIN" check will now fail — that is expected, not a regression. See the note at that assertion for detail.

**Goal:** Gzip API responses so the draft page stops shipping 575 KB uncompressed, and stop sending three never-read fields on every player.

**Architecture:** A new `responder(event)` in the shared `lib/http.js` returns a request-bound `json(statusCode, body)` that gzips when the client accepts it. `players.js` and `boards.js` each shadow the imported `json` with one line, so their existing call sites compress unchanged. `players.js` additionally drops `status`, `updatedAt`, and `playerId`. `drafts.js` is deliberately untouched.

**Tech Stack:** Node.js 24 (CommonJS) Lambdas behind API Gateway HTTP API, `node:test`, AWS SAM.

**Source spec:** `docs/superpowers/specs/2026-08-31-api-response-compression-design.md`

## Global Constraints

- **Backend is CommonJS** (`"type": "commonjs"`) — `require` / `module.exports`. Runtime nodejs24.x.
- **No new dependencies.** `zlib` is built into Node.
- **Do not touch `backend/src/drafts.js`.** Its 21 hand-built returns are deferred by decision. Keeping the pick, auto-pick, and sim-to-end paths out of this change is a deliberate risk control.
- **Do not touch anything under `frontend/`.** Browsers decompress transparently; no client change is needed or wanted.
- **Compression only when the client asks.** A request without `Accept-Encoding: gzip` must receive byte-for-byte what it receives today.
- **Header lookup must be case-insensitive.** API Gateway payload format 2.0 lower-cases header names, but depending on that silently is how this becomes a no-op nobody notices.
- **The existing `json(statusCode, body)` export stays**, uncompressed and unchanged, so `drafts.js` and any unmigrated caller keep working.
- **Baseline is 41 backend unit tests, 31 frontend unit tests, 64 Playwright tests.** None may be weakened, skipped, or deleted.

---

## File Structure

**Backend — create**
- `backend/src/lib/http.test.js` — `node:test` units for the responder

**Backend — modify**
- `backend/src/lib/http.js` — add `responder(event)`
- `backend/src/players.js` — use the responder, drop three fields, delete its local `corsHeaders`
- `backend/src/boards.js` — use the responder

---

## Task 1: The gzip responder

Pure, testable without AWS. Test-first.

**Files:**
- Create: `backend/src/lib/http.test.js`
- Modify: `backend/src/lib/http.js`

**Interfaces:**
- Consumes: nothing
- Produces: `responder(event) → (statusCode, body) → LambdaProxyResponse`. Tasks 2 and 3 both call it. `ALLOWED_METHODS`, `corsHeaders`, and `json` keep their current exports and behavior.

- [ ] **Step 1: Write the failing tests**

`backend/src/lib/http.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const { responder, json, corsHeaders } = require("./http");

// A body big enough to clear the compression threshold, and repetitive
// enough that gzip visibly shrinks it — like the real players payload.
const BIG = { players: Array.from({ length: 200 }, (_, i) => ({
  id: String(i), name: `Player Number ${i}`, position: "WR", team: "SF", rank: i, adp: i + 0.5,
})) };

function evt(headers) {
  return { headers, requestContext: { http: { method: "GET" } } };
}

test("compresses when the client accepts gzip", () => {
  const res = responder(evt({ "accept-encoding": "gzip, deflate, br" }))(200, BIG);
  assert.strictEqual(res.isBase64Encoded, true);
  assert.strictEqual(res.headers["Content-Encoding"], "gzip");
});

test("the compressed body gunzips back to the original JSON", () => {
  const res = responder(evt({ "accept-encoding": "gzip" }))(200, BIG);
  const restored = zlib.gunzipSync(Buffer.from(res.body, "base64")).toString();
  assert.deepStrictEqual(JSON.parse(restored), BIG);
});

test("compression actually makes the payload smaller", () => {
  const res = responder(evt({ "accept-encoding": "gzip" }))(200, BIG);
  const raw = Buffer.byteLength(JSON.stringify(BIG));
  const sent = Buffer.byteLength(res.body, "base64");
  assert.ok(sent < raw / 2, `expected well under half of ${raw}, got ${sent}`);
});

test("sends plain JSON when no Accept-Encoding is present", () => {
  const res = responder(evt({}))(200, BIG);
  assert.strictEqual(res.isBase64Encoded, undefined);
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
  assert.deepStrictEqual(JSON.parse(res.body), BIG);
});

test("sends plain JSON when the client accepts other encodings but not gzip", () => {
  const res = responder(evt({ "accept-encoding": "deflate, br" }))(200, BIG);
  assert.strictEqual(res.isBase64Encoded, undefined);
  assert.deepStrictEqual(JSON.parse(res.body), BIG);
});

test("leaves a small body uncompressed even when gzip is accepted", () => {
  const res = responder(evt({ "accept-encoding": "gzip" }))(404, { error: "Not found" });
  assert.strictEqual(res.isBase64Encoded, undefined);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Not found" });
});

test("finds the header regardless of its casing", () => {
  const lower = responder(evt({ "accept-encoding": "gzip" }))(200, BIG);
  const upper = responder(evt({ "Accept-Encoding": "gzip" }))(200, BIG);
  const mixed = responder(evt({ "Accept-Encoding": "GZIP" }))(200, BIG);
  assert.strictEqual(lower.isBase64Encoded, true);
  assert.strictEqual(upper.isBase64Encoded, true, "uppercase header name missed");
  assert.strictEqual(mixed.isBase64Encoded, true, "uppercase header value missed");
});

test("CORS headers are identical on both paths", () => {
  const plain = responder(evt({}))(200, BIG);
  const gz = responder(evt({ "accept-encoding": "gzip" }))(200, BIG);
  for (const [k, v] of Object.entries(corsHeaders())) {
    assert.strictEqual(plain.headers[k], v, `plain missing ${k}`);
    assert.strictEqual(gz.headers[k], v, `gzip missing ${k}`);
  }
  assert.strictEqual(plain.headers["Content-Type"], "application/json");
  assert.strictEqual(gz.headers["Content-Type"], "application/json");
});

test("the status code passes through on both paths", () => {
  assert.strictEqual(responder(evt({}))(201, BIG).statusCode, 201);
  assert.strictEqual(responder(evt({ "accept-encoding": "gzip" }))(409, BIG).statusCode, 409);
});

test("a missing or malformed event degrades to plain JSON rather than throwing", () => {
  for (const bad of [undefined, null, {}, { headers: null }, { headers: "nope" }]) {
    const res = responder(bad)(200, BIG);
    assert.strictEqual(res.isBase64Encoded, undefined);
    assert.deepStrictEqual(JSON.parse(res.body), BIG);
  }
});

test("the original json() export is unchanged and never compresses", () => {
  const res = json(200, BIG);
  assert.strictEqual(res.isBase64Encoded, undefined);
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
  assert.deepStrictEqual(JSON.parse(res.body), BIG);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend/src && npm test`
Expected: FAIL — `responder is not a function`

- [ ] **Step 3: Write the implementation**

Replace the whole of `backend/src/lib/http.js`:

```js
const zlib = require("zlib");

const ALLOWED_METHODS = "GET,POST,PUT,DELETE,OPTIONS";

// Below this, gzip's overhead outweighs the saving.
const MIN_COMPRESS_BYTES = 1024;

function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

/**
 * Does this request say it can decode gzip?
 *
 * API Gateway's payload format 2.0 lower-cases header names, but this scans
 * case-insensitively anyway: relying on that silently is how compression
 * becomes a no-op nobody notices.
 */
function acceptsGzip(event) {
  const headers = event && event.headers;
  if (!headers || typeof headers !== "object") return false;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "accept-encoding") {
      return String(headers[key] || "").toLowerCase().includes("gzip");
    }
  }
  return false;
}

/**
 * A `json(statusCode, body)` bound to one request, which gzips the body when
 * the client accepts it and the payload is worth compressing.
 *
 * API Gateway base64-decodes the body when `isBase64Encoded` is true, and the
 * browser decompresses on the strength of the Content-Encoding header, so
 * callers and clients see no difference beyond the wire size.
 *
 * A client that did not ask for gzip receives byte-for-byte what it always did.
 */
function responder(event) {
  const gzipOk = acceptsGzip(event);

  return function json(statusCode, body) {
    const payload = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", ...corsHeaders() };

    if (!gzipOk || Buffer.byteLength(payload) < MIN_COMPRESS_BYTES) {
      return { statusCode, headers, body: payload };
    }

    return {
      statusCode,
      headers: { ...headers, "Content-Encoding": "gzip" },
      body: zlib.gzipSync(payload).toString("base64"),
      isBase64Encoded: true,
    };
  };
}

module.exports = {
  ALLOWED_METHODS,
  MIN_COMPRESS_BYTES,
  corsHeaders,
  json,
  responder,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend/src && npm test`
Expected: PASS — 52 tests (41 existing plus 11 new), 0 failing

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/http.js backend/src/lib/http.test.js
git commit -m "Add a gzip-aware response helper"
```

---

## Task 2: Compress and trim /players

The endpoint carrying the entire problem — 575 KB on every draft page load.

**Files:**
- Modify: `backend/src/players.js`

**Interfaces:**
- Consumes: `responder(event)` from `./lib/http`
- Produces: `/players` responses compressed and three fields lighter. Nothing downstream depends on this task.

- [ ] **Step 1: Import the shared helper and delete the local CORS function**

In `backend/src/players.js`, add below the existing `require` lines:

```js
const { responder } = require("./lib/http");
```

Then delete the entire local `corsHeaders` function — the one declaring
`"Access-Control-Allow-Methods": "GET,POST,OPTIONS"`.

**This widens one header.** The shared `corsHeaders()` advertises
`GET,POST,PUT,DELETE,OPTIONS` where the local one said `GET,POST,OPTIONS`. That header only
declares what the endpoint permits cross-origin; API Gateway still routes only the methods
the template defines, so `/players` remains GET-only in practice. It is a deliberate
consequence of using the shared helper, not an accident.

- [ ] **Step 2: Bind the responder and drop the hand-built headers**

Replace the opening of the handler. It currently reads:

```js
  const method = event.requestContext?.http?.method;
  const headers = { "Content-Type": "application/json", ...corsHeaders() };

  if (method === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
```

with:

```js
  const json = responder(event);
  const method = event.requestContext?.http?.method;

  if (method === "OPTIONS") return json(200, {});
```

The preflight body changes from `""` to `{}`. Browsers ignore a preflight body entirely and
read only the status and CORS headers, both unchanged.

- [ ] **Step 3: Drop the three unread fields**

In the `.map()` that builds each player, remove the `status`, `updatedAt`, and `playerId`
lines so the object reads:

```js
      .map((p) => ({
        id: p.id || p.playerId,
        name: p.name,
        position: p.position,
        team: p.team,
        rank: p.rank?.[format] ?? null,
        adp: p.adp?.[format] ?? null,
        tier: p.tier?.[format] ?? null,
      }))
```

`id` still falls back to `p.playerId`, so the value the frontend keys on is unchanged.
`Draft.jsx` builds `playersById` from `p.id` and looks up draft picks by `pk.playerId`;
`syncPlayers` writes both as the same string, so that lookup still resolves.

- [ ] **Step 4: Return through the responder**

Replace the final return:

```js
  return json(200, { sport, format, count: players.length, players });
```

- [ ] **Step 5: Verify the module loads and units still pass**

Run: `cd backend/src && node -e "require('./players.js'); console.log('ok')"`
Expected: `ok`

Run: `cd backend/src && npm test`
Expected: 52 passing, 0 failing

- [ ] **Step 6: Prove the response shape locally, before deploying**

Run this from `backend/src` — it invokes the handler's response path without AWS by
checking the helper directly against a realistic player object:

```bash
cd backend/src && node -e "
const { responder } = require('./lib/http');
const players = Array.from({length: 3900}, (_, i) => ({
  id: String(i), name: 'Player ' + i, position: 'WR', team: 'SF',
  rank: i, adp: i + 0.5, tier: 1,
}));
const body = { sport: 'nfl', format: 'ppr', count: players.length, players };
const plain = responder({ headers: {} })(200, body);
const gz = responder({ headers: {'accept-encoding':'gzip'} })(200, body);
const rawKb = (Buffer.byteLength(plain.body)/1024).toFixed(0);
const gzKb = (Buffer.byteLength(gz.body,'base64')/1024).toFixed(0);
console.log('uncompressed:', rawKb, 'KB');
console.log('compressed:  ', gzKb, 'KB');
console.log('ratio:       ', (gzKb/rawKb*100).toFixed(0) + '%');
"
```

Expected: compressed well under half the uncompressed size. Record both numbers in your report.

- [ ] **Step 7: Commit**

```bash
git add backend/src/players.js
git commit -m "Compress /players and drop three unread fields"
```

---

## Task 3: Compress /boards

**Files:**
- Modify: `backend/src/boards.js`

**Interfaces:**
- Consumes: `responder(event)` from `./lib/http`
- Produces: `/boards` responses compressed. Terminal task.

- [ ] **Step 1: Import the responder**

In `backend/src/boards.js`, change the existing `lib/http` require to also pull in `responder`:

```js
const { json, responder } = require("./lib/http");
```

Keep `json` in the import. It is the module-level fallback and removing it would break
nothing today but would make the shadowing below read as a mistake.

- [ ] **Step 2: Bind the responder inside the handler**

Add as the first line inside `exports.handler`, above the existing `boardsTable` line:

```js
  const json = responder(event);
```

This shadows the imported `json` for the whole handler body, so all 19 existing
`json(...)` calls compress without being edited. Change nothing else in the file.

- [ ] **Step 3: Verify the module loads and units still pass**

Run: `cd backend/src && node -e "require('./boards.js'); console.log('ok')"`
Expected: `ok`

Run: `cd backend/src && npm test`
Expected: 52 passing, 0 failing

- [ ] **Step 4: Confirm drafts.js was left alone**

Run: `cd /Users/connor/projects/sports-mock-draft && git diff --stat master -- backend/src/drafts.js`
Expected: no output. `drafts.js` is deliberately outside this change, and that is what keeps
the pick, auto-pick, and sim-to-end paths untouched.

- [ ] **Step 5: Validate the template**

Run: `cd backend && sam validate --lint`
Expected: valid, exit 0

- [ ] **Step 6: Commit**

```bash
git add backend/src/boards.js
git commit -m "Compress /boards responses"
```

---

## Verification

Before deploying:

```bash
cd backend/src && npm test                    # 52 unit tests
cd ../../frontend && npm run test:unit        # 31 unit tests, untouched
npm test                                      # 64 Playwright tests, untouched
cd ../backend && sam validate --lint          # exit 0
```

Deployment is backend-only: `cd backend && sam build && sam deploy`. No frontend deploy —
nothing under `frontend/` changed.

### Post-deploy verification — do not skip

`lib/http.js` is shared, and `isBase64Encoded` has not been proven against this stack.
Confirm all three endpoints by hand, including the one that should be **un**changed:

```bash
API=https://6q48e144hf.execute-api.us-east-1.amazonaws.com

# compressed vs not — sizes should differ dramatically, JSON should be identical
curl -s --compressed -D - -o /tmp/gz.json  -w '%{size_download} bytes\n' "$API/players?sport=nfl&format=ppr" | grep -iE 'content-encoding|bytes'
curl -s              -o /tmp/raw.json -w '%{size_download} bytes\n' "$API/players?sport=nfl&format=ppr"
python3 -c "import json;a=json.load(open('/tmp/gz.json'));b=json.load(open('/tmp/raw.json'));print('identical JSON:', a==b)"

# /boards must also be compressed
BID=$(curl -s -X POST "$API/boards" -H 'content-type: application/json' \
  -d '{"name":"deploy check","format":"ppr","season":2026}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['boardId'])")
curl -s --compressed -D - -o /dev/null "$API/boards/$BID" | grep -i content-encoding

# the control: /drafts must still be PLAIN, proving the change stayed in scope
DID=$(curl -s -X POST "$API/drafts" -H 'content-type: application/json' \
  -d '{"teams":12,"rounds":15,"format":"ppr"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['draftId'])")
curl -s --compressed -D - -o /dev/null "$API/drafts/$DID" \
  | grep -i content-encoding && echo "UNEXPECTED: drafts is compressed" \
  || echo "drafts: uncompressed, as intended"

# clean up the throwaway board
curl -s -X DELETE "$API/boards/$BID" -o /dev/null
```

Expected: `/players` and `/boards/:id` carry `content-encoding: gzip` and decode to JSON
identical to the uncompressed response; `/drafts/:id` carries no `content-encoding`.

> **Superseded (2026-09-01):** The `/drafts` control above was intentional scope-limiting at
> the time this plan was written — see `docs/superpowers/plans/2026-09-01-backend-hardening.md`,
> which deliberately migrated `drafts.js` onto the shared `responder()` and now gzips
> `/drafts/:id` too. Running this script today, `/drafts/:id` **will** carry
> `content-encoding: gzip` when the client accepts it, and the "UNEXPECTED: drafts is
> compressed" branch above will fire. That is the intended outcome of the later plan, not a
> regression here.

If the compressed response is unreadable in a browser, `isBase64Encoded` is not behaving as
expected on this stack — revert immediately rather than debugging in production, since two
live endpoints are affected.

## Notes for the implementer

- **Do not touch `drafts.js`.** Its 21 hand-built returns are a deliberate follow-up. Leaving it out is what keeps every pick path outside this change's blast radius.
- **Do not touch `frontend/`.** Browsers decompress transparently; `api.js` needs no change and adding one would be wrong.
- **The existing `json()` export must keep working uncompressed.** `drafts.js` does not use it today, but the test asserting it is unchanged is what stops a future refactor from silently altering it.
- **Run every command in the foreground.** An earlier agent on this project stranded itself waiting on a backgrounded test run.
