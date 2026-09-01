# Backend Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three latent backend gaps (unpaginated Queries, no `/players` coverage, `acceptsGzip` treating a refusal as consent) and finish the `drafts.js` responder migration the compression work deferred.

**Architecture:** Four tasks, ordered so the riskiest change lands last and lands protected. Task 1 fixes `acceptsGzip` in isolation. Task 2 fixes `players.js` pagination and establishes a DynamoDB stubbing pattern the backend has never had. Task 3 writes characterization tests that pin `drafts.js`'s *current* response shapes and fixes its pagination. Task 4 then performs the responder migration, with Task 3's tests as the proof that no response changed.

**Tech Stack:** Node.js 24 (CommonJS), AWS SDK v3 (`@aws-sdk/lib-dynamodb`), `node:test`, AWS SAM.

## Global Constraints

- **The backend is CommonJS.** `require`/`module.exports` only. The frontend is ESM; mixing them is a defect.
- **No new dependencies.** No `backend/src/package.json` changes. `zlib` and `node:test` are built in.
- **No frontend change.** Nothing under `frontend/` is touched.
- **No schema change.** No DynamoDB table, index, or SAM template change.
- **Response bodies, status codes, and field names do not change** — except the `drafts.js` OPTIONS body, which becomes `{}` (from `""`) as the spec specifies.
- **No change to bot scoring, roster logic, or snake order.** This work is response shaping and read completeness only.
- Tests are run with `cd backend/src && npm test`. There is no `backend/package.json`; the package lives at `backend/src/package.json`.
- Existing suites must stay green: **55 backend unit tests**, 74 Playwright, 31 frontend unit.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `backend/src/lib/http.js` | Shared response helper; CORS; gzip decision | Task 1 — `acceptsGzip` q-value parsing |
| `backend/src/lib/http.test.js` | Responder + gzip unit tests | Task 1 — q-value cases |
| `backend/src/players.js` | `GET /players` | Task 2 — pagination |
| `backend/src/players.test.js` | `/players` shape + pagination | Task 2 — **new** |
| `backend/src/drafts.js` | All draft endpoints | Task 3 — pagination; Task 4 — responder migration |
| `backend/src/drafts.test.js` | Draft response shapes | Task 3 — **new** |

### The DynamoDB stubbing pattern (verified working before this plan was written)

The backend has never stubbed DynamoDB — `boards.test.js` says so explicitly and only tests paths that reject before any call. This plan establishes the pattern. It was proven against the real handler:

```js
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");

mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({ Items: [] }));
```

Handlers build their client at module load with `DynamoDBDocumentClient.from(...)`, which returns an instance whose `send` resolves through the prototype — so patching the prototype intercepts it. Tests must set the relevant table env var (`PLAYERS_TABLE`, `DRAFTS_TABLE`) before calling the handler, and must call `mock.restoreAll()` afterwards so one test's stub cannot leak into the next.

---

## Task 1: `acceptsGzip` must treat `gzip;q=0` as a refusal

**Files:**
- Modify: `backend/src/lib/http.js` (the `acceptsGzip` function)
- Test: `backend/src/lib/http.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no signature change. `acceptsGzip(event)` stays internal; `responder(event)` and `json(statusCode, body)` keep their exact current signatures. Later tasks depend on `responder` being unchanged.

**Background:** `Accept-Encoding: gzip;q=0` means the client is *refusing* gzip (RFC 9110 §12.5.3 — a q-value of 0 means "not acceptable"). The current implementation is `.includes("gzip")`, which reads that refusal as consent and would send a gzipped body to a client that asked for none. An absent `q` parameter means 1.0.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/lib/http.test.js`:

```js
test("gzip;q=0 is a refusal, not consent", () => {
  const json = responder({ headers: { "accept-encoding": "gzip;q=0" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
  assert.strictEqual(res.isBase64Encoded, undefined);
});

test("gzip;q=0.000 is also a refusal", () => {
  const json = responder({ headers: { "accept-encoding": "gzip;q=0.000" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
});

test("a positive q-value still accepts gzip", () => {
  const json = responder({ headers: { "accept-encoding": "gzip;q=0.8" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], "gzip");
});

test("a wildcard accepts gzip", () => {
  const json = responder({ headers: { "accept-encoding": "*" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], "gzip");
});

test("a refused wildcard does not accept gzip", () => {
  const json = responder({ headers: { "accept-encoding": "*;q=0" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
});

test("gzip is still found among several codings with spacing", () => {
  const json = responder({ headers: { "accept-encoding": "br;q=1.0, gzip ; q=0.5 , deflate" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], "gzip");
});

test("a coding merely containing 'gzip' does not count", () => {
  const json = responder({ headers: { "accept-encoding": "notgzip" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
});

test("a malformed q-value fails closed to no compression", () => {
  const json = responder({ headers: { "accept-encoding": "gzip;q=banana" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend/src && npm test 2>&1 | tail -20
```

Expected: FAIL. `gzip;q=0`, `gzip;q=0.000`, `*;q=0`, `notgzip`, and `gzip;q=banana` all fail — the current substring match accepts all five. `gzip;q=0.8`, `*`, and the spaced-codings case already pass.

Record which of the eight fail. If `gzip;q=0` passes at this step, stop and report it — the test is not exercising the bug.

- [ ] **Step 3: Replace the substring match with q-value parsing**

In `backend/src/lib/http.js`, replace the body of `acceptsGzip` with:

```js
function acceptsGzip(event) {
  const headers = event && event.headers;
  if (!headers || typeof headers !== "object") return false;

  let value = null;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "accept-encoding") {
      value = String(headers[key] || "");
      break;
    }
  }
  if (!value) return false;

  // RFC 9110: a comma-separated list of codings, each optionally carrying a
  // ";q=" weight. q=0 means "not acceptable" -- a refusal, not consent, which
  // a substring match for "gzip" reads backwards. An absent q means 1.0.
  for (const part of value.split(",")) {
    const [rawCoding, ...params] = part.split(";");
    const coding = rawCoding.trim().toLowerCase();
    if (coding !== "gzip" && coding !== "*") continue;

    const qParam = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="));
    if (!qParam) return true;

    const q = Number(qParam.slice(2));
    // A malformed weight fails closed: sending plain JSON is always safe,
    // sending gzip to a client that cannot decode it is not.
    if (Number.isFinite(q) && q > 0) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend/src && npm test 2>&1 | tail -12
```

Expected: PASS. All backend tests green — 55 pre-existing plus the 8 added here = 63.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/http.js backend/src/lib/http.test.js
git commit -m "Treat Accept-Encoding q=0 as the refusal it is

acceptsGzip matched the substring \"gzip\", so \"gzip;q=0\" -- a client
explicitly refusing gzip per RFC 9110 -- read as consent and would have
received a gzipped body it said it could not take. Also accepted
\"notgzip\" as a match. Now parses codings and q-values, and fails closed
on a malformed weight: plain JSON is always safe, gzip to a client that
cannot decode it is not."
```

---

## Task 2: Paginate `players.js` and give it its first tests

**Files:**
- Modify: `backend/src/players.js` (the `QueryCommand` call)
- Create: `backend/src/players.test.js`

**Interfaces:**
- Consumes: `responder(event)` from `lib/http.js`, unchanged by Task 1.
- Produces: the DynamoDB stubbing pattern documented in File Structure above, which Task 3 reuses.

**Background:** A DynamoDB Query page tops out at 1MB. `boards.js` pages through `ExclusiveStartKey`/`LastEvaluatedKey` for exactly this reason and carries a comment saying so. `players.js` runs the same Query against the same table with no loop. Against production today the table holds 3,875 items and a single page returns all of them with a null `LastEvaluatedKey` — so **nothing is truncated right now**. This fix is for when the pool grows, and it matters because the failure is silent: a short list, not an error.

- [ ] **Step 1: Write the failing test file**

Create `backend/src/players.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { handler } = require("./players");

process.env.PLAYERS_TABLE = "players-test";

function player(id, rank, extra) {
  return {
    sport: "nfl",
    id,
    playerId: id,
    name: `Player ${id}`,
    position: "RB",
    team: "SF",
    rank: { standard: rank, ppr: rank + 100 },
    adp: { standard: rank + 0.5, ppr: rank + 100.5 },
    tier: { standard: 1, ppr: 2 },
    status: "ACT",
    updatedAt: 1234567890,
    ...extra,
  };
}

// Returns the given pages in order. Any call past the last page yields an
// empty page, so an over-eager loop cannot hang.
function stubPages(pages) {
  let call = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    const page = pages[call] || { Items: [] };
    call += 1;
    return page;
  });
  return () => call;
}

async function get(query) {
  const res = await handler({
    requestContext: { http: { method: "GET" } },
    queryStringParameters: query || {},
  });
  return { code: res.statusCode, body: JSON.parse(res.body) };
}

test.afterEach(() => mock.restoreAll());

test("returns every page, not just the first", async () => {
  const calls = stubPages([
    { Items: [player("a", 1)], LastEvaluatedKey: { sport: "nfl", id: "a" } },
    { Items: [player("b", 2)], LastEvaluatedKey: { sport: "nfl", id: "b" } },
    { Items: [player("c", 3)] },
  ]);

  const { body } = await get();

  assert.strictEqual(calls(), 3, "should keep querying until no LastEvaluatedKey");
  assert.deepStrictEqual(body.players.map((p) => p.id), ["a", "b", "c"]);
  assert.strictEqual(body.count, 3);
});

test("stops at the first page when there is no LastEvaluatedKey", async () => {
  const calls = stubPages([{ Items: [player("a", 1)] }]);

  const { body } = await get();

  assert.strictEqual(calls(), 1, "must not query again once the key is absent");
  assert.strictEqual(body.count, 1);
});

test("drops the three fields the response no longer ships", async () => {
  stubPages([{ Items: [player("a", 1)] }]);

  const { body } = await get();
  const keys = Object.keys(body.players[0]);

  for (const gone of ["status", "updatedAt", "playerId"]) {
    assert.ok(!keys.includes(gone), `${gone} should not be in the response`);
  }
});

test("keeps the seven fields the frontend reads", async () => {
  stubPages([{ Items: [player("a", 1)] }]);

  const { body } = await get();
  const keys = Object.keys(body.players[0]).sort();

  assert.deepStrictEqual(keys, ["adp", "id", "name", "position", "rank", "team", "tier"]);
});

test("selects rank, adp and tier for the requested format", async () => {
  stubPages([{ Items: [player("a", 1)] }]);

  const { body } = await get({ format: "ppr" });

  assert.strictEqual(body.format, "ppr");
  assert.strictEqual(body.players[0].rank, 101);
  assert.strictEqual(body.players[0].adp, 101.5);
  assert.strictEqual(body.players[0].tier, 2);
});

test("sorts by rank, with unranked players last", async () => {
  stubPages([
    {
      Items: [
        player("mid", 5),
        player("none", 0, { rank: {}, adp: {}, tier: {} }),
        player("top", 1),
      ],
    },
  ]);

  const { body } = await get();

  assert.deepStrictEqual(body.players.map((p) => p.id), ["top", "mid", "none"]);
  assert.strictEqual(body.players[2].rank, null);
});

test("OPTIONS returns 200 without querying DynamoDB", async () => {
  const calls = stubPages([]);

  const res = await handler({ requestContext: { http: { method: "OPTIONS" } } });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls(), 0);
});
```

- [ ] **Step 2: Run the tests to verify the pagination cases fail**

```bash
cd backend/src && npm test 2>&1 | tail -25
```

Expected: FAIL on `"returns every page, not just the first"` — `calls()` is 1, not 3, and only player `a` comes back. The other six tests pass, because the shape, sorting, format selection, and OPTIONS behavior are all already correct.

If the pagination test passes here, stop and report it.

- [ ] **Step 3: Add the pagination loop**

In `backend/src/players.js`, replace the single `const res = await ddb.send(new QueryCommand({...}))` block and the `(res.Items || [])` that follows it. The mapping, sorting, and response are unchanged — only how `items` is gathered changes:

```js
  // A Query page tops out at 1MB; the players table (~3,900 items) is close
  // enough to that ceiling that a single page could silently drop players,
  // so page through ExclusiveStartKey/LastEvaluatedKey until exhausted.
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "#s = :sport",
        ExpressionAttributeNames: { "#s": "sport" },
        ExpressionAttributeValues: { ":sport": sport },
        ExclusiveStartKey,
      })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const players = items
    .map((p) => ({
      id: p.id || p.playerId,
      name: p.name,
      position: p.position,
      team: p.team,
      rank: p.rank?.[format] ?? null,
      adp: p.adp?.[format] ?? null,
      tier: p.tier?.[format] ?? null,
    }))
    .sort((a, b) => (a.rank ?? 999999) - (b.rank ?? 999999));
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend/src && npm test 2>&1 | tail -12
```

Expected: PASS — 63 from Task 1 plus the 7 added here = 70.

- [ ] **Step 5: Commit**

```bash
git add backend/src/players.js backend/src/players.test.js
git commit -m "Paginate the players Query and cover /players with tests

A DynamoDB Query page caps at 1MB. boards.js pages through
LastEvaluatedKey for that reason; players.js ran the same Query against
the same table with no loop. Production returns all 3,875 players in one
page today, so nothing is truncated yet -- but the failure mode is a
silently short list rather than an error, which is worth closing before
the pool grows.

Adds the backend's first DynamoDB-stubbing tests, covering pagination,
the trimmed response shape (no status/updatedAt/playerId), rank sorting
with unranked players last, and format selection."
```

---

## Task 3: Pin `drafts.js` response shapes, then paginate it

**Files:**
- Modify: `backend/src/drafts.js` (the `loadPlayersForSport` Query)
- Create: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: the stubbing pattern from Task 2.
- Produces: `drafts.test.js`, which Task 4 relies on to prove its refactor changed no response.

**Background:** These are characterization tests. Their job is to record what `drafts.js` returns *today*, before Task 4 rewrites how it builds responses. Every assertion here must be written against current behavior and must pass before Task 4 begins — a test written against the post-migration shape would defeat the purpose.

`drafts.js` routes on `method` plus `rawPath`: `POST /drafts`, `GET /drafts/{id}`, `POST /drafts/{id}/pick`, `POST /drafts/{id}/auto-pick`, `POST /drafts/{id}/sim-to-end`.

- [ ] **Step 1: Write the characterization tests**

Create `backend/src/drafts.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { handler } = require("./drafts");

process.env.DRAFTS_TABLE = "drafts-test";
process.env.PLAYERS_TABLE = "players-test";

function evt(method, path, { draftId, body } = {}) {
  return {
    requestContext: { http: { method } },
    rawPath: path,
    pathParameters: draftId ? { draftId } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

// Every ddb.send() returns `result`. Enough for the not-found and
// already-completed paths, which are what these tests assert.
function stubSend(result) {
  let call = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    call += 1;
    return result;
  });
  return () => call;
}

test.afterEach(() => mock.restoreAll());

test("OPTIONS returns 200", async () => {
  const res = await handler(evt("OPTIONS", "/drafts"));
  assert.strictEqual(res.statusCode, 200);
});

test("OPTIONS carries the CORS origin header", async () => {
  const res = await handler(evt("OPTIONS", "/drafts"));
  assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "*");
});

test("GET of a missing draft is 404 with its error message", async () => {
  stubSend({});
  const res = await handler(evt("GET", "/drafts/nope", { draftId: "nope" }));
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});

test("pick without a playerId is 400", async () => {
  stubSend({});
  const res = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: {} })
  );
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Missing playerId" });
});

test("pick on a missing draft is 404", async () => {
  stubSend({});
  const res = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" } })
  );
  assert.strictEqual(res.statusCode, 404);
});

test("picking an already-picked player is 409", async () => {
  stubSend({
    Item: { draftId: "d1", picked: ["p1"], picks: [{}], currentIndex: 0 },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" } })
  );
  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Player already picked" });
});

test("picking in a completed draft is 409", async () => {
  stubSend({
    Item: { draftId: "d1", picked: [], picks: [{}], currentIndex: 1 },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" } })
  );
  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft already completed" });
});

test("auto-pick on a missing draft is 404", async () => {
  stubSend({});
  const res = await handler(
    evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {} })
  );
  assert.strictEqual(res.statusCode, 404);
});

test("auto-pick in a completed draft is 409", async () => {
  stubSend({
    Item: { draftId: "d1", picked: [], picks: [{}], currentIndex: 1 },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {} })
  );
  assert.strictEqual(res.statusCode, 409);
});

test("sim-to-end on a missing draft is 404", async () => {
  stubSend({});
  const res = await handler(
    evt("POST", "/drafts/d1/sim-to-end", { draftId: "d1", body: {} })
  );
  assert.strictEqual(res.statusCode, 404);
});

test("an unrouted path is 404 Not found", async () => {
  const res = await handler(evt("DELETE", "/drafts/d1", { draftId: "d1" }));
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Not found" });
});

test("every response is JSON with CORS headers", async () => {
  stubSend({});
  const res = await handler(evt("GET", "/drafts/nope", { draftId: "nope" }));
  assert.strictEqual(res.headers["Content-Type"], "application/json");
  assert.ok(res.headers["Access-Control-Allow-Origin"]);
});

test("a client sending no Accept-Encoding gets uncompressed JSON", async () => {
  stubSend({});
  const res = await handler(evt("GET", "/drafts/nope", { draftId: "nope" }));
  assert.strictEqual(res.isBase64Encoded, undefined);
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
});
```

- [ ] **Step 2: Run the tests to verify they all pass against current behavior**

```bash
cd backend/src && npm test 2>&1 | tail -12
```

Expected: PASS — 70 from Task 2 plus the 13 added here = 83.

These describe existing behavior, so **every one must pass now**. A failure here means the test is wrong, not the code. Fix the test, not `drafts.js`.

- [ ] **Step 3: Write the failing pagination test**

Append to `backend/src/drafts.test.js`:

```js
test("the player pool query pages until exhausted", async () => {
  const pages = [
    {
      Items: [
        { sport: "nfl", id: "a", playerId: "a", name: "A", position: "RB", team: "SF", rank: { standard: 1 } },
      ],
      LastEvaluatedKey: { sport: "nfl", id: "a" },
    },
    {
      Items: [
        { sport: "nfl", id: "b", playerId: "b", name: "B", position: "WR", team: "KC", rank: { standard: 2 } },
      ],
    },
  ];
  let queries = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    // The draft fetch is a Get (has Key); the pool fetch is a Query.
    if (cmd?.input?.Key) {
      return { Item: { draftId: "d1", picked: [], picks: [{}], currentIndex: 1 } };
    }
    const page = pages[queries] || { Items: [] };
    queries += 1;
    return page;
  });

  // Reaches the pool load before the completed-draft check short-circuits
  // only on sim-to-end; a 409 here still proves how many pages were read.
  await handler(evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {} }));

  assert.strictEqual(queries >= 2, true, "should page past the first LastEvaluatedKey");
});
```

- [ ] **Step 4: Run it and confirm the pagination test fails**

```bash
cd backend/src && npm test 2>&1 | tail -20
```

Expected: FAIL on `"the player pool query pages until exhausted"`.

If it passes, the handler short-circuited before loading the pool — adjust the stubbed `Item` so the completed check does not fire (`currentIndex: 0` with a longer `picks` array), re-run, and confirm you see the failure before continuing. Report what you changed.

- [ ] **Step 5: Add the pagination loop to `loadPlayersForSport`**

In `backend/src/drafts.js`, replace the single `QueryCommand` send inside `loadPlayersForSport` with the same loop used elsewhere. Keep the rest of the function — filtering, mapping, sorting — exactly as it is:

```js
  // A Query page tops out at 1MB; the players table (~3,900 items) is close
  // enough to that ceiling that a single page could silently drop players,
  // so page through ExclusiveStartKey/LastEvaluatedKey until exhausted.
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "#s = :sport",
        ExpressionAttributeNames: { "#s": "sport" },
        ExpressionAttributeValues: { ":sport": sport },
        ExclusiveStartKey,
      })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
```

Then change the line that consumed the old result. It currently reads:

```js
  const players = (res.Items || [])
    .filter((p) => p && ALLOWED_POS.has(p.position))
```

and becomes:

```js
  const players = items
    .filter((p) => p && ALLOWED_POS.has(p.position))
```

The `.filter().map()` chain below it, and the rest of the function, are unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd backend/src && npm test 2>&1 | tail -12
```

Expected: PASS — 84 total.

- [ ] **Step 7: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js
git commit -m "Pin drafts.js response shapes and paginate its pool query

Adds the first tests drafts.js has ever had. They are characterization
tests: they record what each endpoint returns today so the responder
migration that follows can prove it changed nothing.

Also pages the player-pool Query through LastEvaluatedKey, the same gap
just closed in players.js -- a Query page caps at 1MB and this one read
only the first."
```

---

## Task 4: Migrate `drafts.js` to the shared responder

**Files:**
- Modify: `backend/src/drafts.js` (19 returns, the local `corsHeaders`, the local `headers` const)

**Interfaces:**
- Consumes: `responder(event)` from `lib/http.js` (Task 1), and `drafts.test.js` (Task 3) as the regression net.
- Produces: nothing new. This task deletes code and changes no signature.

**Background:** The compression work deferred this, estimating "21 mechanical edits inside the highest-traffic handler." Reading the file lowers that estimate: all **19** hand-built returns share one `headers` const built at `drafts.js:163`, and every body is a plain `JSON.stringify(...)`. So this is one uniform substitution, not 19 judgment calls.

Two deliberate behavior changes, both from the approved spec:

1. **OPTIONS body**: `body: ""` becomes `json(200, {})`, whose body is `"{}"`. `boards.js` already does this. No client reads a preflight body.
2. **CORS methods widen** from `GET,POST,OPTIONS` to `GET,POST,PUT,DELETE,OPTIONS`. Established harmless in the compression review: preflights never reach the Lambda — the gateway answers them with the wider list already.

- [ ] **Step 1: Update the OPTIONS test for its new body**

The only assertion in `drafts.test.js` that must change is the preflight body, and only if one asserts on it. In `backend/src/drafts.test.js`, add:

```js
test("OPTIONS returns an empty JSON object body", async () => {
  const res = await handler(evt("OPTIONS", "/drafts"));
  assert.strictEqual(res.body, "{}");
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd backend/src && npm test 2>&1 | tail -15
```

Expected: FAIL — the current OPTIONS branch returns `body: ""`.

- [ ] **Step 3: Bind the responder and delete the local CORS helper**

In `backend/src/drafts.js`:

`drafts.js` does not require `lib/http` today — it has its own copy of everything. Add the
require alongside the existing `@aws-sdk` requires at the top of the file:

```js
const { responder } = require("./lib/http");
```

Delete the local `corsHeaders()` function (lines 21-28):

```js
function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}
```

Replace the local `headers` const (line 163) with the responder binding, so it reads:

```js
  const json = responder(event);
```

- [ ] **Step 4: Convert all 19 returns**

Every hand-built return becomes a `json(...)` call. The single-line form:

```js
return { statusCode: 404, headers, body: JSON.stringify({ error: "Draft not found" }) };
```

becomes:

```js
return json(404, { error: "Draft not found" });
```

The multi-line form:

```js
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ draftId: id }),
      };
```

becomes:

```js
      return json(200, { draftId: id });
```

And the OPTIONS branch:

```js
  if (method === "OPTIONS") {
    return json(200, {});
  }
```

Apply this to every one. When finished, `grep -n "statusCode" backend/src/drafts.js` must print nothing.

- [ ] **Step 5: Verify no hand-built response or duplicate helper survives**

```bash
cd backend/src
grep -n "statusCode\|corsHeaders\|const headers" drafts.js
```

Expected: no output. Any match is a missed conversion — fix it before continuing.

- [ ] **Step 6: Run the full backend suite**

```bash
cd backend/src && npm test 2>&1 | tail -12
```

Expected: PASS — 85 tests. Task 3's characterization tests passing unchanged is the evidence that the migration preserved every status code, error message, and header.

- [ ] **Step 7: Confirm the migration actually enabled compression**

```bash
cd backend/src && node -e "
process.env.DRAFTS_TABLE='t'; process.env.PLAYERS_TABLE='t';
const { mock } = require('node:test');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
mock.method(DynamoDBDocumentClient.prototype, 'send', async () => ({}));
const { handler } = require('./drafts');
handler({
  requestContext: { http: { method: 'GET' } },
  rawPath: '/drafts/x',
  pathParameters: { draftId: 'x' },
  headers: { 'accept-encoding': 'gzip' },
}).then((r) => console.log('404 body compressed?', r.isBase64Encoded === true, '(expected false: under the 1KB threshold)'));
"
```

Expected: `404 body compressed? false (expected false: under the 1KB threshold)`. A short error body must stay uncompressed — this confirms the threshold still governs and the responder is wired in rather than compressing everything.

- [ ] **Step 8: Validate the SAM template still builds**

```bash
cd backend && sam validate --lint 2>&1 | tail -3
```

Expected: exit 0, template valid. No template change was made; this confirms nothing was disturbed.

- [ ] **Step 9: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js
git commit -m "Migrate drafts.js to the shared responder

The compression work deferred this, estimating 21 bespoke edits inside
the app's highest-traffic handler. In fact all 19 hand-built returns
shared one headers const and a plain JSON.stringify, so it was a single
uniform substitution.

The ~40KB draft payload now compresses, and the duplicate corsHeaders is
gone. Two intended behavior changes: the OPTIONS body is now {} rather
than empty, matching boards.js, and the advertised CORS methods widen to
match the shared helper -- harmless, since preflights are answered by
the gateway and never reach this Lambda.

The characterization tests added alongside pass unchanged, which is the
evidence no status code, error message, or header moved."
```

---

## Verification Summary

After all four tasks:

| Check | Command | Expected |
|---|---|---|
| Backend unit | `cd backend/src && npm test` | 85 pass, 0 fail |
| Frontend unit | `cd frontend && npm run test:unit` | 31 pass |
| Playwright | `cd frontend && npx playwright test` | 74 pass |
| SAM template | `cd backend && sam validate --lint` | exit 0 |

The frontend is untouched; its suites are listed to confirm the change stayed in the backend.

## Post-Deploy Verification (controller runs this, not a task)

Against the deployed stack, exercising a real draft end to end — this is what actually covers the migration, since no unit test reaches the success paths of `pick`, `auto-pick`, or `sim-to-end`:

1. `POST /drafts` — create a 12-team, 15-round draft
2. `GET /drafts/{id}` — with and without `--compressed`; decoded JSON must be identical
3. `POST /drafts/{id}/pick` — make a real pick; confirm it lands
4. `POST /drafts/{id}/auto-pick` — confirm a bot pick lands
5. `POST /drafts/{id}/sim-to-end` — confirm completion
6. `GET /players` — with and without `--compressed`; confirm the count still matches the table

Record the compressed and uncompressed sizes for the draft payload, so the migration's benefit is measured rather than assumed.
