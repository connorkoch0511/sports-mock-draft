const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { handler } = require("./boards");

// This file holds two kinds of case. Most are rejected by validation BEFORE
// any DynamoDB call, so they run without credentials, mocks, or a live
// table. The rest — the pool-pagination cases below — deliberately do reach
// ddb.send(), and stub DynamoDBDocumentClient.prototype.send to fake it.

function event(method, body, boardId, claims) {
  return {
    requestContext: {
      http: { method },
      ...(claims ? { authorizer: { jwt: { claims } } } : {}),
    },
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

const ME = { sub: "user-me", email: "me@example.com" };

test("POST rejects a non-numeric season instead of storing NaN", async () => {
  const { code } = await status(
    event("POST", { format: "ppr", season: "abc" }, undefined, ME)
  );
  assert.strictEqual(code, 400);
});

test("POST rejects a non-integer season", async () => {
  const { code } = await status(
    event("POST", { format: "ppr", season: 2026.5 }, undefined, ME)
  );
  assert.strictEqual(code, 400);
});

test("POST rejects an out-of-range season", async () => {
  const { code } = await status(
    event("POST", { format: "ppr", season: 99999 }, undefined, ME)
  );
  assert.strictEqual(code, 400);
});

test("POST rejects a body of literal null rather than throwing", async () => {
  const { code, body } = await status(event("POST", "null", undefined, ME));
  assert.strictEqual(code, 400);
  assert.match(body.error, /JSON body/i);
});

test("POST rejects a JSON body that is an array", async () => {
  const { code } = await status(event("POST", "[1,2,3]", undefined, ME));
  assert.strictEqual(code, 400);
});

test("POST rejects a JSON body that is a bare string", async () => {
  const { code } = await status(event("POST", '"hello"', undefined, ME));
  assert.strictEqual(code, 400);
});

test("POST still rejects an unknown format", async () => {
  const { code, body } = await status(
    event("POST", { format: "superflex" }, undefined, ME)
  );
  assert.strictEqual(code, 400);
  assert.match(body.error, /format/i);
});

test("POST still rejects malformed JSON", async () => {
  const { code, body } = await status(event("POST", "{bad json", undefined, ME));
  assert.strictEqual(code, 400);
  assert.match(body.error, /JSON body/i);
});

test("POST /boards without claims is 401", async () => {
  const { code } = await status(event("POST", { format: "ppr" }));
  assert.strictEqual(code, 401);
});

test("POST /boards stores the caller's sub, not the anon literal", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    put = cmd.input;
    return {};
  });
  const res = await handler(event("POST", { format: "ppr" }, undefined, ME));
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(put.Item.ownerId, "user-me");
  mock.restoreAll();
});

test("PUT rejects an oversized playerId entry", async () => {
  const evt = event("PUT", { order: ["x".repeat(100)], version: 1 }, "abc", ME);
  const { code, body } = await status(evt);
  assert.strictEqual(code, 400);
  assert.match(body.error, /playerId/i);
});

test("PUT accepts a realistically-sized playerId past the length check", async () => {
  // A real Sleeper id is ~4 chars. This must NOT be rejected for length —
  // it fails later on the duplicate check instead, proving length passed.
  const evt = event("PUT", { order: ["4034", "4034"], version: 1 }, "abc", ME);
  const { code, body } = await status(evt);
  assert.strictEqual(code, 400);
  assert.match(body.error, /duplicate/i);
});

test("PUT rejects a body of literal null", async () => {
  const { code } = await status(event("PUT", "null", "abc", ME));
  assert.strictEqual(code, 400);
});

test("PUT still rejects a non-array order", async () => {
  const { code, body } = await status(
    event("PUT", { order: "nope", version: 1 }, "abc", ME)
  );
  assert.strictEqual(code, 400);
  assert.match(body.error, /array/i);
});

test("PUT still rejects a non-integer version", async () => {
  const { code, body } = await status(
    event("PUT", { order: [], version: "x" }, "abc", ME)
  );
  assert.strictEqual(code, 400);
  assert.match(body.error, /version/i);
});

test("PUT without claims is 401", async () => {
  const { code } = await status(
    event("PUT", { order: ["p1"], version: 1 }, "b1")
  );
  assert.strictEqual(code, 401);
});

test("PUT requires a matching, non-anon ownerId in its condition", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return { Attributes: { version: 2 } };
  });
  const res = await handler(
    event("PUT", { order: ["p1"], version: 1 }, "b1", ME)
  );
  assert.strictEqual(res.statusCode, 200);
  assert.match(input.ConditionExpression, /ownerId = :me/);
  assert.match(input.ConditionExpression, /ownerId <> :anon/);
  assert.strictEqual(input.ExpressionAttributeValues[":me"], "user-me");
  assert.strictEqual(input.ExpressionAttributeValues[":anon"], "anon");
  mock.restoreAll();
});

test("PUT on someone else's board is 404, not 409", async () => {
  let call = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    call += 1;
    if (call === 1) {
      const e = new Error("The conditional request failed");
      e.name = "ConditionalCheckFailedException";
      throw e;
    }
    // The follow-up Get that decides which failure this was.
    return { Item: { boardId: "b1", ownerId: "user-them", version: 1 } };
  });
  const res = await handler(
    event("PUT", { order: ["p1"], version: 1 }, "b1", ME)
  );
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Board not found" });
  mock.restoreAll();
});

test("PUT by the owner at a stale version is still a 409 with the current one", async () => {
  let call = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    call += 1;
    if (call === 1) {
      const e = new Error("The conditional request failed");
      e.name = "ConditionalCheckFailedException";
      throw e;
    }
    return { Item: { boardId: "b1", ownerId: "user-me", version: 7 } };
  });
  const res = await handler(
    event("PUT", { order: ["p1"], version: 1 }, "b1", ME)
  );
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(JSON.parse(res.body).currentVersion, 7);
  mock.restoreAll();
});

test("DELETE without claims is 401", async () => {
  const { code } = await status(event("DELETE", undefined, "b1"));
  assert.strictEqual(code, 401);
});

test("DELETE requires a matching, non-anon ownerId in its condition", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const res = await handler(event("DELETE", undefined, "b1", ME));
  assert.strictEqual(res.statusCode, 200);
  assert.match(input.ConditionExpression, /ownerId = :me/);
  assert.match(input.ConditionExpression, /ownerId <> :anon/);
  assert.strictEqual(input.ExpressionAttributeValues[":me"], "user-me");
  assert.strictEqual(input.ExpressionAttributeValues[":anon"], "anon");
  mock.restoreAll();
});

// Every board created before this phase carries ownerId "anon" -- the literal
// boards.js itself wrote. It is the single most common stored value on this
// table, so the freeze is asserted here at the handler, not only against
// canMutate in owner.test.js.
test("PUT on an unclaimed legacy board is 404, not an adoption", async () => {
  let call = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    call += 1;
    if (call === 1) {
      const e = new Error("The conditional request failed");
      e.name = "ConditionalCheckFailedException";
      throw e;
    }
    return { Item: { boardId: "b1", ownerId: "anon", version: 1 } };
  });
  const res = await handler(
    event("PUT", { order: ["p1"], version: 1 }, "b1", ME)
  );
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Board not found" });
  mock.restoreAll();
});

test("DELETE of someone else's board is 404", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    const e = new Error("The conditional request failed");
    e.name = "ConditionalCheckFailedException";
    throw e;
  });
  const res = await handler(event("DELETE", undefined, "b1", ME));
  assert.strictEqual(res.statusCode, 404);
  mock.restoreAll();
});

test("OPTIONS preflight still returns 200", async () => {
  const { code } = await status(event("OPTIONS"));
  assert.strictEqual(code, 200);
});

test("GET of a board now requires claims", async () => {
  const { code } = await status(event("GET", undefined, "b1"));
  assert.strictEqual(code, 401);
});

test("GET of somebody else's board is 404", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Item: { boardId: "b1", ownerId: "user-them", sport: "nfl", format: "ppr" },
  }));
  const res = await handler(event("GET", undefined, "b1", ME));
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Board not found" });
  mock.restoreAll();
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
      return { Item: { boardId: "b1", ownerId: "user-me", name: "B", sport: "nfl", format: "standard", version: 1, order: [] } };
    }
    const page = pages[query] || { Items: [] };
    query += 1;
    return page;
  });

  const res = await handler(event("GET", undefined, "b1", ME));
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
      return { Item: { boardId: "b1", ownerId: "user-me", name: "B", sport: "nfl", format: "standard", version: 1, order: [] } };
    }
    seen.push(cmd.input.ExclusiveStartKey);
    return seen.length === 1
      ? { Items: [poolPlayer("a", 1)], LastEvaluatedKey: cursor }
      : { Items: [poolPlayer("b", 2)] };
  });

  await handler(event("GET", undefined, "b1", ME));

  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0], undefined, "first query starts with no cursor");
  assert.deepStrictEqual(seen[1], cursor, "second query resumes from the first page's key");
});
