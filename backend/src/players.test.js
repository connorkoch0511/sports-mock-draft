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
