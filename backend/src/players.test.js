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
//
// Also records the ExclusiveStartKey each call was sent with, so tests can
// assert the cursor is actually threaded from one page's LastEvaluatedKey
// into the next page's request -- not just that the loop iterates the
// right number of times. A stub that serves pages purely by call index
// would pass even if the handler never read LastEvaluatedKey at all.
function stubPages(pages) {
  let call = 0;
  const startKeys = [];
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    startKeys.push(cmd?.input?.ExclusiveStartKey);
    const page = pages[call] || { Items: [] };
    call += 1;
    return page;
  });
  return { calls: () => call, startKeys };
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
  const stub = stubPages([
    { Items: [player("a", 1)], LastEvaluatedKey: { sport: "nfl", id: "a" } },
    { Items: [player("b", 2)], LastEvaluatedKey: { sport: "nfl", id: "b" } },
    { Items: [player("c", 3)] },
  ]);

  const { body } = await get();

  assert.strictEqual(stub.calls(), 3, "should keep querying until no LastEvaluatedKey");
  assert.deepStrictEqual(body.players.map((p) => p.id), ["a", "b", "c"]);
  assert.strictEqual(body.count, 3);
});

test("the cursor is threaded: each call's ExclusiveStartKey is the prior page's LastEvaluatedKey", async () => {
  const stub = stubPages([
    { Items: [player("a", 1)], LastEvaluatedKey: { sport: "nfl", id: "a" } },
    { Items: [player("b", 2)], LastEvaluatedKey: { sport: "nfl", id: "b" } },
    { Items: [player("c", 3)] },
  ]);

  await get();

  assert.strictEqual(stub.calls(), 3);
  assert.strictEqual(
    stub.startKeys[0],
    undefined,
    "the first call must not carry an ExclusiveStartKey"
  );
  assert.deepStrictEqual(
    stub.startKeys[1],
    { sport: "nfl", id: "a" },
    "the second call must carry the first page's LastEvaluatedKey"
  );
  assert.deepStrictEqual(
    stub.startKeys[2],
    { sport: "nfl", id: "b" },
    "the third call must carry the second page's LastEvaluatedKey"
  );
});

test("stops at the first page when there is no LastEvaluatedKey", async () => {
  const stub = stubPages([{ Items: [player("a", 1)] }]);

  const { body } = await get();

  assert.strictEqual(stub.calls(), 1, "must not query again once the key is absent");
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
  const stub = stubPages([]);

  const res = await handler({ requestContext: { http: { method: "OPTIONS" } } });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(stub.calls(), 0);
});

test("a ranked player with stats gets them, with the season", () => {
  stubPages([
    {
      Items: [
        {
          ...player("a", 1),
          stats: { gp: 17, rec_tgt: 129, pts_ppr: 416.6 },
          statsSeason: 2025,
        },
      ],
    },
  ]);

  return get().then(({ body }) => {
    assert.deepStrictEqual(body.players[0].stats, {
      gp: 17,
      rec_tgt: 129,
      pts_ppr: 416.6,
    });
    assert.strictEqual(body.players[0].statsSeason, 2025);
  });
});

test("an unranked player gets no stats, even when the item has them", () => {
  // This rule is what keeps the payload at 1.2x rather than 1.7x.
  const unranked = player("b", 0, { rank: {}, adp: {}, tier: {} });
  unranked.stats = { gp: 17 };
  unranked.statsSeason = 2025;

  stubPages([{ Items: [unranked] }]);

  return get().then(({ body }) => {
    assert.ok(!("stats" in body.players[0]), "unranked players carry no stats");
    assert.ok(!("statsSeason" in body.players[0]));
  });
});

test("a ranked player with no stats gets neither key", () => {
  stubPages([{ Items: [player("a", 1)] }]);

  return get().then(({ body }) => {
    assert.ok(!("stats" in body.players[0]));
    assert.ok(!("statsSeason" in body.players[0]));
  });
});

test("stats follow the format's own rank set, not a global one", () => {
  // Standard ranks 223 players and PPR ranks 272 in production, so the same
  // id legitimately carries stats on one format's response and not another's.
  const pprOnly = {
    ...player("a", 1),
    rank: { ppr: 5 },
    adp: { ppr: 5.5 },
    tier: { ppr: 1 },
    stats: { gp: 17 },
    statsSeason: 2025,
  };

  stubPages([{ Items: [pprOnly] }]);
  return get({ format: "ppr" }).then(({ body }) => {
    assert.strictEqual(body.players[0].statsSeason, 2025, "ranked in ppr, so stats appear");

    mock.restoreAll();
    stubPages([{ Items: [pprOnly] }]);
    return get({ format: "standard" }).then((res) => {
      assert.ok(
        !("stats" in res.body.players[0]),
        "not ranked in standard, so no stats on that response"
      );
    });
  });
});

test("the seven existing fields are unchanged when stats are present", () => {
  stubPages([
    { Items: [{ ...player("a", 1), stats: { gp: 17 }, statsSeason: 2025 }] },
  ]);

  return get().then(({ body }) => {
    const p = body.players[0];
    for (const k of ["id", "name", "position", "team", "rank", "adp", "tier"]) {
      assert.ok(k in p, `${k} must still be present`);
    }
  });
});

test("a ranked player's availability fields are returned", () => {
  stubPages([
    {
      Items: [
        { ...player("a", 1), injuryStatus: "Questionable", injuryBodyPart: "Hamstring", depthChartOrder: 1 },
      ],
    },
  ]);

  return get().then(({ body }) => {
    assert.strictEqual(body.players[0].injuryStatus, "Questionable");
    assert.strictEqual(body.players[0].injuryBodyPart, "Hamstring");
    assert.strictEqual(body.players[0].depthChartOrder, 1);
  });
});

test("availability keys are absent when the item has none", () => {
  stubPages([{ Items: [player("a", 1)] }]);

  return get().then(({ body }) => {
    for (const k of ["injuryStatus", "injuryBodyPart", "depthChartOrder"]) {
      assert.ok(!(k in body.players[0]), `${k} should not appear`);
    }
  });
});

test("an unranked player carries no availability fields", () => {
  // Same rule as stats: ranked players only, so the payload does not grow for
  // the ~3,600 nobody drafts.
  const unranked = player("b", 0, { rank: {}, adp: {}, tier: {} });
  unranked.injuryStatus = "IR";

  stubPages([{ Items: [unranked] }]);

  return get().then(({ body }) => {
    assert.ok(!("injuryStatus" in body.players[0]));
  });
});
