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
