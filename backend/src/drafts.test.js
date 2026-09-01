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

// Success paths hit two tables in one request (e.g. auto-pick reads the
// draft from drafts-test, then reads/queries the pool from players-test), so
// a single fixed result isn't enough. Branch on the target table instead —
// callers pass the exact result shape each command needs (`{ Item }` for a
// Get, `{ Items }` for a Query). Any call to a table not in `map` (i.e. the
// Put/Update write-back) gets `{}`, which drafts.js ignores.
function stubByTable(map) {
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    const table = cmd?.input?.TableName;
    return map[table] || {};
  });
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

// Task 4 migrated drafts.js to the shared `json()` helper from lib/http.js
// and deleted the local corsHeaders(), which intentionally widened this
// header from "GET,POST,OPTIONS" to lib/http.js's ALLOWED_METHODS
// ("GET,POST,PUT,DELETE,OPTIONS") -- an approved change, not a regression:
// preflights are answered by the API Gateway and never reach this Lambda.
test("OPTIONS carries the shared-helper CORS methods header", async () => {
  const res = await handler(evt("OPTIONS", "/drafts"));
  assert.strictEqual(res.headers["Access-Control-Allow-Methods"], "GET,POST,PUT,DELETE,OPTIONS");
});

test("OPTIONS returns an empty JSON object body", async () => {
  const res = await handler(evt("OPTIONS", "/drafts"));
  assert.strictEqual(res.body, "{}");
});

test("OPTIONS response carries Vary: Accept-Encoding", async () => {
  const res = await handler(evt("OPTIONS", "/drafts"));
  assert.strictEqual(res.headers["Vary"], "Accept-Encoding");
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
  // Distinguishes the intended "Draft not found" branch from the router's
  // catch-all 404 ({ error: "Not found" }), which also returns 404 and would
  // otherwise let a routing regression pass this test silently.
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
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
  // See the "pick on a missing draft" test above: pins the branch, not just
  // the status code, since the router catch-all is also a 404.
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});

test("auto-pick in a completed draft is 409", async () => {
  stubSend({
    Item: { draftId: "d1", picked: [], picks: [{}], currentIndex: 1 },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {} })
  );
  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft already completed" });
});

test("sim-to-end on a missing draft is 404", async () => {
  stubSend({});
  const res = await handler(
    evt("POST", "/drafts/d1/sim-to-end", { draftId: "d1", body: {} })
  );
  assert.strictEqual(res.statusCode, 404);
  // See the "pick on a missing draft" test above: pins the branch, not just
  // the status code, since the router catch-all is also a 404.
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});

test("POST /drafts success returns a draftId", async () => {
  stubSend({}); // PutCommand result is ignored
  const res = await handler(
    evt("POST", "/drafts", { body: { teams: 8, rounds: 3, sport: "nfl", format: "standard" } })
  );
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepStrictEqual(Object.keys(body), ["draftId"]);
  assert.strictEqual(typeof body.draftId, "string");
  assert.ok(body.draftId.length > 0);
});

test("GET /drafts/{id} found returns the full draft object", async () => {
  const draftItem = {
    draftId: "d1",
    sport: "nfl",
    format: "standard",
    year: 2024,
    teams: 4,
    rounds: 2,
    userTeam: 2,
    rosterSlots: ["QB", "RB"],
    boardId: "board-1",
    picked: ["p1"],
    currentIndex: 1,
    picks: [
      { overall: 1, round: 1, team: 1, playerId: "p1", player: { id: "p1", name: "A" } },
      { overall: 2, round: 1, team: 2, playerId: null, player: null },
      { overall: 3, round: 2, team: 2, playerId: null, player: null },
      { overall: 4, round: 2, team: 1, playerId: null, player: null },
    ],
  };
  stubSend({ Item: draftItem }); // GET only issues one GetCommand
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1" }));
  assert.strictEqual(res.statusCode, 200);
  // Headers on a success-path response, so a headers regression on a success
  // branch (not just the error branches covered elsewhere) is caught.
  assert.strictEqual(res.headers["Content-Type"], "application/json");
  assert.ok(res.headers["Access-Control-Allow-Origin"]);
  assert.strictEqual(res.headers["Vary"], "Accept-Encoding");
  const body = JSON.parse(res.body);
  // Full top-level key set, so a field silently added or dropped in the
  // refactor fails this test.
  assert.deepStrictEqual(body, {
    draftId: "d1",
    sport: "nfl",
    format: "standard",
    year: 2024,
    teams: 4,
    rounds: 2,
    userTeam: 2,
    rosterSlots: ["QB", "RB"],
    boardId: "board-1",
    picked: ["p1"],
    currentIndex: 1,
    currentRound: 1,
    currentPick: 2,
    currentTeam: 2,
    completed: false,
    picks: [
      { overall: 1, round: 1, team: 1, playerId: "p1", player: { id: "p1", name: "A" } },
      { overall: 2, round: 1, team: 2, playerId: null, player: null },
      { overall: 3, round: 2, team: 2, playerId: null, player: null },
      { overall: 4, round: 2, team: 1, playerId: null, player: null },
    ],
  });
});

test("pick success returns { ok: true }", async () => {
  const draftItem = {
    draftId: "d1",
    sport: "nfl",
    format: "standard",
    picked: [],
    picks: [{ overall: 1, round: 1, team: 1, playerId: null, player: null }],
    currentIndex: 0,
  };
  const playerItem = {
    sport: "nfl",
    playerId: "p1",
    id: "p1",
    name: "Player One",
    position: "RB",
    team: "SF",
    rank: { standard: 5 },
    adp: { standard: 5.5 },
    tier: { standard: 1 },
  };
  stubByTable({
    "drafts-test": { Item: draftItem },
    "players-test": { Item: playerItem },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
});

test("auto-pick success returns { ok: true, picked }", async () => {
  const draftItem = {
    draftId: "d1",
    sport: "nfl",
    format: "standard",
    picked: [],
    picks: [{ overall: 1, round: 1, team: 1, playerId: null, player: null }],
    currentIndex: 0,
  };
  // A single-player pool makes the "best" pick deterministic regardless of
  // the scoring internals in pickBestForTeam: with only one candidate, it's
  // the only thing that can be chosen.
  const poolItems = [
    {
      sport: "nfl",
      id: "p1",
      playerId: "p1",
      name: "Player One",
      position: "RB",
      team: "SF",
      rank: { standard: 10 },
      adp: { standard: 12.3 },
      tier: { standard: 2 },
    },
  ];
  stubByTable({
    "drafts-test": { Item: draftItem },
    "players-test": { Items: poolItems },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {} })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), {
    ok: true,
    picked: {
      id: "p1",
      name: "Player One",
      position: "RB",
      team: "SF",
      rank: 10,
      adp: 12.3,
      tier: 2,
    },
  });
});

test("sim-to-end success returns { ok: true, completed }", async () => {
  const draftItem = {
    draftId: "d1",
    sport: "nfl",
    format: "standard",
    picked: [],
    picks: [{ overall: 1, round: 1, team: 1, playerId: null, player: null }],
    currentIndex: 0,
  };
  const poolItems = [
    {
      sport: "nfl",
      id: "p1",
      playerId: "p1",
      name: "Player One",
      position: "RB",
      team: "SF",
      rank: { standard: 10 },
      adp: { standard: 12.3 },
      tier: { standard: 2 },
    },
  ];
  stubByTable({
    "drafts-test": { Item: draftItem },
    "players-test": { Items: poolItems },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/sim-to-end", { draftId: "d1", body: {} })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { ok: true, completed: true });
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
    // currentIndex 0 with two picks queued keeps the completed-draft check
    // from short-circuiting before the pool load is reached.
    if (cmd?.input?.Key) {
      return { Item: { draftId: "d1", picked: [], picks: [{}, {}], currentIndex: 0 } };
    }
    const page = pages[queries] || { Items: [] };
    queries += 1;
    return page;
  });

  await handler(evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {} }));

  assert.strictEqual(queries >= 2, true, "should page past the first LastEvaluatedKey");
});
