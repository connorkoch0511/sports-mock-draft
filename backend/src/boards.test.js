const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { handler } = require("./boards");

// This file holds two kinds of case. Most are rejected by validation BEFORE
// any DynamoDB call, so they run without credentials, mocks, or a live
// table. The rest — the pool-pagination cases below — deliberately do reach
// ddb.send(), and stub DynamoDBDocumentClient.prototype.send to fake it.

function event(method, body, boardId) {
  return {
    requestContext: { http: { method } },
    pathParameters: boardId ? { boardId } : undefined,
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
        ? body
        : JSON.stringify(body),
  };
}

async function status(evt) {
  const res = await handler(evt);
  return { code: res.statusCode, body: JSON.parse(res.body || "{}") };
}

test("POST rejects a non-numeric season instead of storing NaN", async () => {
  const { code } = await status(event("POST", { format: "ppr", season: "abc" }));
  assert.strictEqual(code, 400);
});

test("POST rejects a non-integer season", async () => {
  const { code } = await status(event("POST", { format: "ppr", season: 2026.5 }));
  assert.strictEqual(code, 400);
});

test("POST rejects an out-of-range season", async () => {
  const { code } = await status(event("POST", { format: "ppr", season: 99999 }));
  assert.strictEqual(code, 400);
});

test("POST rejects a body of literal null rather than throwing", async () => {
  const { code, body } = await status(event("POST", "null"));
  assert.strictEqual(code, 400);
  assert.match(body.error, /JSON body/i);
});

test("POST rejects a JSON body that is an array", async () => {
  const { code } = await status(event("POST", "[1,2,3]"));
  assert.strictEqual(code, 400);
});

test("POST rejects a JSON body that is a bare string", async () => {
  const { code } = await status(event("POST", '"hello"'));
  assert.strictEqual(code, 400);
});

test("POST still rejects an unknown format", async () => {
  const { code, body } = await status(event("POST", { format: "superflex" }));
  assert.strictEqual(code, 400);
  assert.match(body.error, /format/i);
});

test("POST still rejects malformed JSON", async () => {
  const { code, body } = await status(event("POST", "{bad json"));
  assert.strictEqual(code, 400);
  assert.match(body.error, /JSON body/i);
});

test("PUT rejects an oversized playerId entry", async () => {
  const evt = event("PUT", { order: ["x".repeat(100)], version: 1 }, "abc");
  const { code, body } = await status(evt);
  assert.strictEqual(code, 400);
  assert.match(body.error, /playerId/i);
});

test("PUT accepts a realistically-sized playerId past the length check", async () => {
  // A real Sleeper id is ~4 chars. This must NOT be rejected for length —
  // it fails later on the duplicate check instead, proving length passed.
  const evt = event("PUT", { order: ["4034", "4034"], version: 1 }, "abc");
  const { code, body } = await status(evt);
  assert.strictEqual(code, 400);
  assert.match(body.error, /duplicate/i);
});

test("PUT rejects a body of literal null", async () => {
  const { code } = await status(event("PUT", "null", "abc"));
  assert.strictEqual(code, 400);
});

test("PUT still rejects a non-array order", async () => {
  const { code, body } = await status(event("PUT", { order: "nope", version: 1 }, "abc"));
  assert.strictEqual(code, 400);
  assert.match(body.error, /array/i);
});

test("PUT still rejects a non-integer version", async () => {
  const { code, body } = await status(event("PUT", { order: [], version: "x" }, "abc"));
  assert.strictEqual(code, 400);
  assert.match(body.error, /version/i);
});

test("OPTIONS preflight still returns 200", async () => {
  const { code } = await status(event("OPTIONS"));
  assert.strictEqual(code, 200);
});

process.env.BOARDS_TABLE = "boards-test";
process.env.PLAYERS_TABLE = "players-test";

function poolPlayer(id, rank) {
  return {
    sport: "nfl",
    playerId: id,
    name: `Player ${id}`,
    position: "RB",
    team: "SF",
    rank: { standard: rank },
  };
}

test.afterEach(() => mock.restoreAll());

test("GET pages the player pool until the cursor is exhausted", async () => {
  const pages = [
    { Items: [poolPlayer("a", 1)], LastEvaluatedKey: { sport: "nfl", playerId: "a" } },
    { Items: [poolPlayer("b", 2)] },
  ];
  let query = 0;

  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    // The board fetch is a Get (carries Key); the pool fetch is a Query.
    if (cmd?.input?.Key) {
      return { Item: { boardId: "b1", name: "B", sport: "nfl", format: "standard", version: 1, order: [] } };
    }
    const page = pages[query] || { Items: [] };
    query += 1;
    return page;
  });

  const res = await handler(event("GET", undefined, "b1"));
  const body = JSON.parse(res.body);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(query, 2, "should query again while LastEvaluatedKey is present");
  assert.deepStrictEqual(body.rows.map((r) => r.playerId).sort(), ["a", "b"]);
});

test("the second pool query carries the first page's cursor", async () => {
  // Without this, a loop that never advances ExclusiveStartKey re-fetches
  // page one forever -- returning plausible data while burning the Lambda's
  // timeout on repeated 1MB reads.
  const cursor = { sport: "nfl", playerId: "a" };
  const seen = [];

  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.Key) {
      return { Item: { boardId: "b1", name: "B", sport: "nfl", format: "standard", version: 1, order: [] } };
    }
    seen.push(cmd.input.ExclusiveStartKey);
    return seen.length === 1
      ? { Items: [poolPlayer("a", 1)], LastEvaluatedKey: cursor }
      : { Items: [poolPlayer("b", 2)] };
  });

  await handler(event("GET", undefined, "b1"));

  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0], undefined, "first query starts with no cursor");
  assert.deepStrictEqual(seen[1], cursor, "second query resumes from the first page's key");
});
