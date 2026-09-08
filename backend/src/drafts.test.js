const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { handler } = require("./drafts");

process.env.DRAFTS_TABLE = "drafts-test";
process.env.PLAYERS_TABLE = "players-test";

// `claims` is exactly the shape API Gateway's JWT authorizer puts on the
// event, which is the boundary this code actually depends on -- Cognito
// itself cannot run locally.
function evt(method, path, { draftId, body, claims } = {}) {
  return {
    requestContext: {
      http: { method },
      ...(claims ? { authorizer: { jwt: { claims } } } : {}),
    },
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

const ME = { sub: "user-me", email: "me@example.com" };
const THEM = { sub: "user-them", email: "them@example.com" };

function ownedDraft(ownerId, seatSub = ownerId) {
  return {
    draftId: "d1",
    ownerId,
    seats: [
      { team: 1, sub: seatSub, kind: "human" },
      { team: 2, sub: null, kind: "bot" },
    ],
    sport: "nfl",
    format: "standard",
    teams: 2,
    rounds: 1,
    userTeam: 1,
    picks: [
      { overall: 1, round: 1, team: 1, playerId: null, player: null },
      { overall: 2, round: 1, team: 2, playerId: null, player: null },
    ],
    picked: [],
    currentIndex: 0,
    version: 1,
  };
}

// Drives /pick all the way to its write, simulating a table where somebody
// else's pick has already moved currentIndex on since our stale read.
//
// This does not just make the UpdateCommand reject unconditionally -- a stub
// that rejects no matter what the command contains would still "pass" this
// test even if advance.js's ConditionExpression were deleted, since nothing
// here would notice. Instead this behaves the way DynamoDB actually does:
// it inspects the write's own ConditionExpression and only fails the request
// when one is present and does not hold against the server's index. Remove
// the guard from advance.js and this stub lets the write through, same as a
// real, unconditional UpdateCommand would -- which is exactly the silent
// overwrite this task exists to prevent, and exactly what should turn this
// test from green to red.
function pickAsWithConditionFailure(draft, sub, playerId) {
  const serverCurrentIndex = draft.currentIndex + 1;
  let draftGets = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.constructor.name === "UpdateCommand") {
      const expected = cmd.input.ExpressionAttributeValues?.[":expected"];
      if (cmd.input.ConditionExpression && expected !== serverCurrentIndex) {
        const e = new Error("The conditional request failed");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      return {};
    }
    if (cmd?.input?.TableName === "players-test") {
      return {
        Item: {
          playerId, id: playerId, name: "Test Back", position: "RB", team: "SF",
          rank: { standard: 1 }, adp: { standard: 1 }, tier: { standard: 1 },
        },
      };
    }
    draftGets += 1;
    if (draftGets === 1) return { Item: draft };
    // Somebody else's pick landed between our read and our write.
    return { Item: { ...draft, currentIndex: serverCurrentIndex, version: (draft.version || 0) + 1 } };
  });
  return handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId }, claims: { sub } })
  );
}

test("POST /drafts seats the creator", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    // A second PutCommand now writes the membership row after the draft's
    // own; only the draft's carries seats, so that's the one this test cares
    // about.
    if (cmd.input?.Item?.seats) put = cmd.input;
    return {};
  });
  await handler(
    evt("POST", "/drafts", { body: { teams: 4, rounds: 1, userTeam: 2 }, claims: ME })
  );
  assert.strictEqual(put.Item.seats.length, 4);
  assert.deepStrictEqual(put.Item.seats[1], { team: 2, sub: "user-me", kind: "human" });
  assert.strictEqual(put.Item.seats.filter((s) => s.kind === "bot").length, 3);
  // ownerId survives: it is who created it, which is a different question
  // from who may act in it, and delete still turns on it.
  assert.strictEqual(put.Item.ownerId, "user-me");
});

// The clamp in the POST /drafts branch (requestedTeam falls back to 1 when
// out of 1..teams) is the only thing standing between a bad request and an
// unreachable draft: buildSeats produces zero human seats for an
// out-of-range userTeam, so if the clamp were ever removed nobody could
// ever get seated in the draft they just created.
test("POST /drafts with an out-of-range userTeam still seats exactly one human", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    // A second PutCommand now writes the membership row after the draft's
    // own; only the draft's carries seats, so that's the one this test cares
    // about.
    if (cmd.input?.Item?.seats) put = cmd.input;
    return {};
  });
  await handler(
    evt("POST", "/drafts", { body: { teams: 4, rounds: 1, userTeam: 99 }, claims: ME })
  );
  assert.strictEqual(put.Item.seats.filter((s) => s.kind === "human").length, 1);
});

test("GET of a draft now requires claims", async () => {
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1" }));
  assert.strictEqual(res.statusCode, 401);
});

test("GET by somebody with no seat is 404, worded as not-found", async () => {
  stubSend({ Item: ownedDraft("user-them") });
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});

test("GET by the person seated in it works", async () => {
  stubSend({ Item: ownedDraft("user-me") });
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(res.statusCode, 200);
});

// Access is the seat, not the ownerId -- this is the case that proves it, and
// the one invitations will rely on.
test("somebody seated but not the owner can read and pick", async () => {
  const draft = ownedDraft("user-them", "user-me");
  stubByTable({
    "drafts-test": { Item: draft },
    "players-test": {
      Item: {
        playerId: "p1", id: "p1", name: "Test Back", position: "RB", team: "SF",
        rank: { standard: 1 }, adp: { standard: 1 }, tier: { standard: 1 },
      },
    },
  });
  const read = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(read.statusCode, 200);
  const pick = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" }, claims: ME })
  );
  assert.strictEqual(pick.statusCode, 200);
});

// /pick is covered above, but an invited person will spend most of their time
// on these two, and the guard being byte-identical across the three branches
// is an argument, not a test.
for (const [name, path] of [
  ["auto-pick", "/drafts/d1/auto-pick"],
  ["sim-to-end", "/drafts/d1/sim-to-end"],
]) {
  test(`somebody seated but not the owner can ${name}`, async () => {
    stubByTable({
      "drafts-test": { Item: ownedDraft("user-them", "user-me") },
      "players-test": {
        Items: [
          {
            playerId: "p1", id: "p1", name: "Test Back", position: "RB", team: "SF",
            rank: { standard: 1 }, adp: { standard: 1 }, tier: { standard: 1 },
          },
        ],
      },
    });
    const res = await handler(evt("POST", path, { draftId: "d1", claims: ME }));
    assert.strictEqual(res.statusCode, 200);
  });
}

test("picking without a seat is 404 even for the ownerId", async () => {
  // seats say user-them; ownerId says user-me. The seat decides.
  stubSend({ Item: { ...ownedDraft("user-me", "user-them") } });
  const res = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" }, claims: ME })
  );
  assert.strictEqual(res.statusCode, 404);
});

// Delete stays owner-only on purpose: an invited person must not be able to
// destroy the draft they were invited to.
test("DELETE still turns on ownerId, not on the seat", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const res = await handler(evt("DELETE", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(res.statusCode, 200);
  assert.match(input.ConditionExpression, /ownerId = :me/);
});

test("POST /drafts without claims is 401", async () => {
  const res = await handler(evt("POST", "/drafts", { body: { teams: 12 } }));
  assert.strictEqual(res.statusCode, 401);
});

test("POST /drafts stores the caller's sub as ownerId", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    // A second PutCommand now writes the membership row after the draft's
    // own; only the draft's carries seats, so that's the one this test cares
    // about.
    if (cmd.input?.Item?.seats) put = cmd.input;
    return {};
  });
  const res = await handler(
    evt("POST", "/drafts", { body: { teams: 2, rounds: 1 }, claims: ME })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(put.Item.ownerId, "user-me");
});

for (const [name, path] of [
  ["pick", "/drafts/d1/pick"],
  ["auto-pick", "/drafts/d1/auto-pick"],
  ["sim-to-end", "/drafts/d1/sim-to-end"],
]) {
  test(`${name} without claims is 401`, async () => {
    const res = await handler(
      evt("POST", path, { draftId: "d1", body: { playerId: "p1" } })
    );
    assert.strictEqual(res.statusCode, 401);
  });

  test(`${name} on someone else's draft is 404, worded as not-found`, async () => {
    stubSend({ Item: ownedDraft("user-them") });
    const res = await handler(
      evt("POST", path, { draftId: "d1", body: { playerId: "p1" }, claims: ME })
    );
    assert.strictEqual(res.statusCode, 404);
    // Byte-identical to a genuine miss: a distinguishable body confirms the id
    // exists, which is precisely what an id-guessing probe is looking for.
    assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
  });

  // A genuine pre-Task-1 draft predates the seats array entirely -- it isn't
  // "unowned with a seat nobody holds," it has no `seats` field at all. This
  // used to be readable-but-frozen (public GET, ownerless mutation refused);
  // now nobody is seated in it either, so both are refused the same way.
  // isSeated's Array.isArray guard is what keeps this from throwing.
  test(`${name} on a legacy pre-seats draft is 404`, async () => {
    stubSend({
      Item: {
        draftId: "d1",
        ownerId: undefined,
        sport: "nfl",
        format: "standard",
        teams: 2,
        rounds: 1,
        userTeam: 1,
        picks: [
          { overall: 1, round: 1, team: 1, playerId: null, player: null },
          { overall: 2, round: 1, team: 2, playerId: null, player: null },
        ],
        picked: [],
        currentIndex: 0,
        version: 1,
      },
    });
    const res = await handler(
      evt("POST", path, { draftId: "d1", body: { playerId: "p1" }, claims: ME })
    );
    assert.strictEqual(res.statusCode, 404);
  });
}

test("the owner can pick", async () => {
  stubByTable({
    "drafts-test": { Item: ownedDraft("user-me") },
    "players-test": {
      Item: {
        playerId: "p1",
        id: "p1",
        name: "Test Back",
        position: "RB",
        team: "SF",
        rank: { standard: 1 },
        adp: { standard: 1 },
        tier: { standard: 1 },
      },
    },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/pick", {
      draftId: "d1",
      body: { playerId: "p1" },
      claims: ME,
    })
  );
  assert.strictEqual(res.statusCode, 200);
});

// The defect this task exists for: two picks from the same currentIndex.
// Today both succeed and one is silently overwritten.
test("a pick that lost the race is refused, not silently dropped", async () => {
  const draft = {
    draftId: "d1", ownerId: "alice", currentIndex: 0, picked: [], version: 1,
    seats: [{ team: 1, sub: "alice", kind: "human" }],
    picks: [{ team: 1 }, { team: 1 }],
  };
  // The second write fails its condition, as DynamoDB would when another
  // request has already moved currentIndex on.
  const res = await pickAsWithConditionFailure(draft, "alice", "p1");
  assert.strictEqual(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.match(body.error, /somebody just picked/i);
  // The client needs to know where the draft actually is now.
  assert.ok(Number.isInteger(body.currentIndex));
});

// Superseded: sharing a link no longer grants access on its own. This task
// closes exactly the path this test used to assert -- rewritten to prove
// the refusal happens before the draft is even consulted, not merely that
// it happens.
test("GET of a draft without claims is 401, even when the draft exists", async () => {
  stubSend({ Item: ownedDraft("user-them") });
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1" }));
  assert.strictEqual(res.statusCode, 401);
});

test("DELETE without claims is 401", async () => {
  const res = await handler(evt("DELETE", "/drafts/d1", { draftId: "d1" }));
  assert.strictEqual(res.statusCode, 401);
});

test("DELETE deletes only on a matching ownerId", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const res = await handler(
    evt("DELETE", "/drafts/d1", { draftId: "d1", claims: ME })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(
    input.ConditionExpression,
    "ownerId = :me AND ownerId <> :anon"
  );
  assert.strictEqual(input.ExpressionAttributeValues[":me"], "user-me");
  assert.strictEqual(input.ExpressionAttributeValues[":anon"], "anon");
});

test("DELETE of someone else's draft is 404", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    const e = new Error("The conditional request failed");
    e.name = "ConditionalCheckFailedException";
    throw e;
  });
  const res = await handler(
    evt("DELETE", "/drafts/d1", { draftId: "d1", claims: THEM })
  );
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});

// The 404 tests above prove the answer. These prove nothing happened to get
// there -- a refactor that moved the ownership check below the UpdateCommand
// would still return 404 and keep every one of them green.
for (const [name, path] of [
  ["pick", "/drafts/d1/pick"],
  ["auto-pick", "/drafts/d1/auto-pick"],
  ["sim-to-end", "/drafts/d1/sim-to-end"],
]) {
  test(`${name} on someone else's draft writes nothing at all`, async () => {
    const calls = stubSend({ Item: ownedDraft("user-them") });
    await handler(
      evt("POST", path, { draftId: "d1", body: { playerId: "p1" }, claims: ME })
    );
    // Exactly one send: the Get that fetched the draft. Nothing after it.
    assert.strictEqual(calls(), 1);
  });
}

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
  const res = await handler(evt("GET", "/drafts/nope", { draftId: "nope", claims: ME }));
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});

test("pick without a playerId is 400", async () => {
  stubSend({});
  const res = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: {}, claims: ME })
  );
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Missing playerId" });
});

test("pick on a missing draft is 404", async () => {
  stubSend({});
  const res = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" }, claims: ME })
  );
  assert.strictEqual(res.statusCode, 404);
  // Distinguishes the intended "Draft not found" branch from the router's
  // catch-all 404 ({ error: "Not found" }), which also returns 404 and would
  // otherwise let a routing regression pass this test silently.
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});

test("picking an already-picked player is 409", async () => {
  // The caller must hold the seat, or access fails first and this never
  // reaches the already-picked check it's meant to exercise.
  stubSend({
    Item: {
      draftId: "d1",
      ownerId: "user-me",
      seats: [{ team: 1, sub: "user-me", kind: "human" }],
      picked: ["p1"],
      picks: [{}],
      currentIndex: 0,
    },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" }, claims: ME })
  );
  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Player already picked" });
});

test("picking in a completed draft is 409", async () => {
  stubSend({
    Item: {
      draftId: "d1",
      ownerId: "user-me",
      seats: [{ team: 1, sub: "user-me", kind: "human" }],
      picked: [],
      picks: [{}],
      currentIndex: 1,
    },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" }, claims: ME })
  );
  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft already completed" });
});

test("auto-pick on a missing draft is 404", async () => {
  stubSend({});
  const res = await handler(
    evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {}, claims: ME })
  );
  assert.strictEqual(res.statusCode, 404);
  // See the "pick on a missing draft" test above: pins the branch, not just
  // the status code, since the router catch-all is also a 404.
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});

test("auto-pick in a completed draft is 409", async () => {
  stubSend({
    Item: {
      draftId: "d1",
      ownerId: "user-me",
      seats: [{ team: 1, sub: "user-me", kind: "human" }],
      picked: [],
      picks: [{}],
      currentIndex: 1,
    },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {}, claims: ME })
  );
  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft already completed" });
});

test("sim-to-end on a missing draft is 404", async () => {
  stubSend({});
  const res = await handler(
    evt("POST", "/drafts/d1/sim-to-end", { draftId: "d1", body: {}, claims: ME })
  );
  assert.strictEqual(res.statusCode, 404);
  // See the "pick on a missing draft" test above: pins the branch, not just
  // the status code, since the router catch-all is also a 404.
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});

test("POST /drafts success returns a draftId", async () => {
  stubSend({}); // PutCommand result is ignored
  const res = await handler(
    evt("POST", "/drafts", { body: { teams: 8, rounds: 3, sport: "nfl", format: "standard" }, claims: ME })
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
    ownerId: "user-me",
    seats: [
      { team: 1, sub: null, kind: "bot" },
      { team: 2, sub: "user-me", kind: "human" },
    ],
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
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
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
    ownerId: "user-me",
    seats: [{ team: 1, sub: "user-me", kind: "human" }],
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
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" }, claims: ME })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
});

test("auto-pick success returns { ok: true, picked }", async () => {
  const draftItem = {
    draftId: "d1",
    ownerId: "user-me",
    seats: [{ team: 1, sub: "user-me", kind: "human" }],
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
    evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {}, claims: ME })
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

// The auto-pick response above tests `best`, the pool entry itself -- which
// already carried adpBySource before this fix. It never touched what actually
// gets stored on the pick, or what GET /drafts/{draftId} reads back. This one
// drives a real pick, then re-reads the draft the way the client would, so it
// exercises the stored `d.picks[i].player` snapshot end to end.
test("a picked player's per-source ADP survives into GET /drafts/{draftId}", async () => {
  const draftItem = {
    draftId: "d1",
    ownerId: "user-me",
    seats: [{ team: 1, sub: "user-me", kind: "human" }],
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
    adpBySource: { espn: 5.1, yahoo: 6.0 },
  };
  // Both handler calls read/write the same `draftItem`, so the pick's
  // in-place mutation of d.picks is what the later GET reads back -- exactly
  // the round trip the reviewer traced through the stored data.
  stubByTable({
    "drafts-test": { Item: draftItem },
    "players-test": { Item: playerItem },
  });

  const pickRes = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" }, claims: ME })
  );
  assert.strictEqual(pickRes.statusCode, 200);

  const getRes = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(getRes.statusCode, 200);
  const body = JSON.parse(getRes.body);
  assert.deepStrictEqual(body.picks[0].player.adpBySource, { espn: 5.1, yahoo: 6.0 });
});

// This checks the response envelope only -- `body.picked` is the pool entry
// (`best`), which already carried adpBySource before this fix and is a
// different object from what gets written onto d.picks[i].player. See the
// two "stored pick" tests below for the site that actually matters: the one
// the reviewer found had zero test coverage of any kind.
test("auto-pick's response body carries the pool entry's per-source ADP", async () => {
  const draftItem = {
    draftId: "d1",
    ownerId: "user-me",
    seats: [{ team: 1, sub: "user-me", kind: "human" }],
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
      adpBySource: { espn: 12.1, yahoo: 12.5 },
    },
  ];
  stubByTable({
    "drafts-test": { Item: draftItem },
    "players-test": { Items: poolItems },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {}, claims: ME })
  );
  const body = JSON.parse(res.body);
  assert.deepStrictEqual(body.picked.adpBySource, { espn: 12.1, yahoo: 12.5 });
});

// The two tests above (the manual "survives into GET" test up above, and the
// one right above this) never actually cover auto-pick's or sim-to-end's
// stored literal at drafts.js:363/407 -- deleting `...withAdpBySource(best.
// adpBySource)` from either site left the suite at 298/298 green. Drive the
// real handler and re-read the draft the way the client would, so the stored
// `d.picks[i].player` snapshot is what gets asserted.
test("auto-pick's stored pick carries per-source ADP into GET /drafts/{draftId}", async () => {
  const draftItem = {
    draftId: "d1",
    ownerId: "user-me",
    seats: [{ team: 1, sub: "user-me", kind: "human" }],
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
      adpBySource: { espn: 12.1, yahoo: 12.5 },
    },
  ];
  // Both handler calls read/write the same `draftItem`, so auto-pick's
  // in-place mutation of d.picks is what the later GET reads back.
  stubByTable({
    "drafts-test": { Item: draftItem },
    "players-test": { Items: poolItems },
  });

  const pickRes = await handler(
    evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {}, claims: ME })
  );
  assert.strictEqual(pickRes.statusCode, 200);

  const getRes = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(getRes.statusCode, 200);
  const body = JSON.parse(getRes.body);
  assert.deepStrictEqual(body.picks[0].player.adpBySource, { espn: 12.1, yahoo: 12.5 });
});

test("sim-to-end's stored pick carries per-source ADP into GET /drafts/{draftId}", async () => {
  const draftItem = {
    draftId: "d1",
    ownerId: "user-me",
    seats: [{ team: 1, sub: "user-me", kind: "human" }],
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
      adpBySource: { espn: 8.4, yahoo: 9.9 },
    },
  ];
  stubByTable({
    "drafts-test": { Item: draftItem },
    "players-test": { Items: poolItems },
  });

  const simRes = await handler(
    evt("POST", "/drafts/d1/sim-to-end", { draftId: "d1", body: {}, claims: ME })
  );
  assert.strictEqual(simRes.statusCode, 200);

  const getRes = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(getRes.statusCode, 200);
  const body = JSON.parse(getRes.body);
  assert.deepStrictEqual(body.picks[0].player.adpBySource, { espn: 8.4, yahoo: 9.9 });
});

test("sim-to-end success returns { ok: true, completed }", async () => {
  const draftItem = {
    draftId: "d1",
    ownerId: "user-me",
    seats: [{ team: 1, sub: "user-me", kind: "human" }],
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
    evt("POST", "/drafts/d1/sim-to-end", { draftId: "d1", body: {}, claims: ME })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { ok: true, completed: true });
});

test("an unrouted path is 404 Not found", async () => {
  // PATCH is not a method any branch handles (unlike DELETE, which is now
  // routed), so it still exercises the catch-all.
  const res = await handler(evt("PATCH", "/drafts/d1", { draftId: "d1" }));
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
  const queryStartKeys = [];
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    // The draft fetch is a Get (has Key); the pool fetch is a Query.
    // currentIndex 0 with two picks queued keeps the completed-draft check
    // from short-circuiting before the pool load is reached.
    if (cmd?.input?.Key) {
      return { Item: { draftId: "d1", ownerId: "user-me", seats: [{ team: 1, sub: "user-me", kind: "human" }], picked: [], picks: [{}, {}], currentIndex: 0 } };
    }
    queryStartKeys.push(cmd?.input?.ExclusiveStartKey);
    const page = pages[queries] || { Items: [] };
    queries += 1;
    return page;
  });

  await handler(evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {}, claims: ME }));

  assert.strictEqual(queries >= 2, true, "should page past the first LastEvaluatedKey");
});

// The test above only proves the loop iterates twice -- a stub serving
// pages purely by call index would pass that even if the handler never
// read LastEvaluatedKey and just re-fetched page 1 forever. Assert the
// cursor is actually threaded: the first Query has no ExclusiveStartKey,
// and the second carries the first page's LastEvaluatedKey.
test("the player pool query threads ExclusiveStartKey from the prior page's LastEvaluatedKey", async () => {
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
  const queryStartKeys = [];
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.Key) {
      return { Item: { draftId: "d1", ownerId: "user-me", seats: [{ team: 1, sub: "user-me", kind: "human" }], picked: [], picks: [{}, {}], currentIndex: 0 } };
    }
    queryStartKeys.push(cmd?.input?.ExclusiveStartKey);
    const page = pages[queries] || { Items: [] };
    queries += 1;
    return page;
  });

  await handler(evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", body: {}, claims: ME }));

  assert.strictEqual(queries, 2, "should query exactly twice for these two pages");
  assert.strictEqual(
    queryStartKeys[0],
    undefined,
    "the first Query must not carry an ExclusiveStartKey"
  );
  assert.deepStrictEqual(
    queryStartKeys[1],
    { sport: "nfl", id: "a" },
    "the second Query must carry the first page's LastEvaluatedKey"
  );
});

test("DELETE removes a draft and reports ok", async () => {
  stubSend({});
  const res = await handler(evt("DELETE", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
});

test("DELETE issues a DeleteCommand against the drafts table", async () => {
  let seen = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    seen = cmd;
    return {};
  });

  await handler(evt("DELETE", "/drafts/d1", { draftId: "d1", claims: ME }));

  assert.strictEqual(seen.constructor.name, "DeleteCommand");
  assert.strictEqual(seen.input.TableName, "drafts-test");
  assert.deepStrictEqual(seen.input.Key, { draftId: "d1" });
});

// Superseded by the ownership condition: a delete on an already-gone draft
// now fails its ConditionExpression exactly like a delete on someone else's
// draft does (see "DELETE of someone else's draft is 404" above), and the two
// cases are deliberately indistinguishable to the caller. The frontend is
// updated for this in a later task -- this is no longer idempotent by design.
test("deleting an already-gone draft is 404, not idempotent success", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    const e = new Error("The conditional request failed");
    e.name = "ConditionalCheckFailedException";
    throw e;
  });
  const res = await handler(
    evt("DELETE", "/drafts/never-existed", { draftId: "never-existed", claims: ME })
  );
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});

test("DELETE without a draftId falls through to the catch-all", async () => {
  stubSend({});
  const res = await handler(evt("DELETE", "/drafts"));
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Not found" });
});

// Listing goes by ownerId; access goes by seats. Those give the same answer
// only while a draft has exactly one human seat. When invitations arrive this
// test fails, which is the intended alarm -- otherwise /me/drafts would
// silently omit drafts you were invited to.
test("a new draft has exactly one human seat, and it is the owner", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    // A second PutCommand now writes the membership row after the draft's
    // own; only the draft's carries seats, so that's the one this test cares
    // about.
    if (cmd.input?.Item?.seats) put = cmd.input;
    return {};
  });
  await handler(evt("POST", "/drafts", { body: { teams: 8, rounds: 2 }, claims: ME }));
  const humans = put.Item.seats.filter((s) => s.kind === "human");
  assert.strictEqual(humans.length, 1);
  assert.strictEqual(humans[0].sub, put.Item.ownerId);
});

const { seatOf, teamOnClock, humanSeatCount } = require("./lib/owner");

const draftWith = (seats, currentIndex = 0, picks = [{ team: 1 }, { team: 2 }]) =>
  ({ seats, currentIndex, picks });

test("seatOf finds the seat a person holds", () => {
  const d = draftWith([
    { team: 1, sub: "alice", kind: "human" },
    { team: 2, sub: null, kind: "bot" },
  ]);
  assert.strictEqual(seatOf(d, "alice").team, 1);
  assert.strictEqual(seatOf(d, "bob"), null);
});

// A bot seat has sub null, and a signed-out caller has no sub. Neither may
// match the other, or a signed-out request would hold every bot seat.
test("a null sub matches no seat, including bot seats", () => {
  const d = draftWith([{ team: 1, sub: null, kind: "bot" }]);
  assert.strictEqual(seatOf(d, null), null);
  assert.strictEqual(seatOf(d, undefined), null);
  assert.strictEqual(seatOf(d, ""), null);
});

test("teamOnClock reads the pick the draft is on", () => {
  assert.strictEqual(teamOnClock(draftWith([], 0)), 1);
  assert.strictEqual(teamOnClock(draftWith([], 1)), 2);
});

test("a finished or malformed draft has nobody on the clock", () => {
  assert.strictEqual(teamOnClock(draftWith([], 2)), null);
  assert.strictEqual(teamOnClock({ picks: [], currentIndex: 0 }), null);
  assert.strictEqual(teamOnClock({}), null);
});

test("humanSeatCount counts only human seats", () => {
  assert.strictEqual(humanSeatCount(draftWith([
    { team: 1, sub: "a", kind: "human" },
    { team: 2, sub: "b", kind: "human" },
    { team: 3, sub: null, kind: "bot" },
  ])), 2);
  assert.strictEqual(humanSeatCount({}), 0);
});

// Mirrors what "the owner can pick" stubs by hand: the pick route reads the
// draft, then the player snapshot, before writing either back.
function pickAs(draft, sub, playerId) {
  stubByTable({
    "drafts-test": { Item: draft },
    "players-test": {
      Item: {
        playerId,
        id: playerId,
        name: "Test Back",
        position: "RB",
        team: "SF",
        rank: { standard: 1 },
        adp: { standard: 1 },
        tier: { standard: 1 },
      },
    },
  });
  return handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId }, claims: { sub } })
  );
}

test("picking out of turn is refused", async () => {
  // Two humans; team 1 is on the clock, and bob holds team 2.
  const draft = {
    draftId: "d1", ownerId: "alice", currentIndex: 0, picked: [], version: 1,
    seats: [
      { team: 1, sub: "alice", kind: "human" },
      { team: 2, sub: "bob", kind: "human" },
    ],
    picks: [{ team: 1 }, { team: 2 }],
  };
  const res = await pickAs(draft, "bob", "p1");
  assert.strictEqual(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /not your pick/i);
});

test("picking on your own turn is allowed", async () => {
  const draft = {
    draftId: "d1", ownerId: "alice", currentIndex: 0, picked: [], version: 1,
    seats: [
      { team: 1, sub: "alice", kind: "human" },
      { team: 2, sub: "bob", kind: "human" },
    ],
    picks: [{ team: 1 }, { team: 2 }],
  };
  const res = await pickAs(draft, "alice", "p1");
  assert.strictEqual(res.statusCode, 200);
});

// Being in the draft is still what decides whether you can SEE it. Only
// picking gained a second question.
test("somebody with no seat still gets 404 rather than 409", async () => {
  const draft = {
    draftId: "d1", ownerId: "alice", currentIndex: 0, picked: [], version: 1,
    seats: [{ team: 1, sub: "alice", kind: "human" }],
    picks: [{ team: 1 }],
  };
  const res = await pickAs(draft, "stranger", "p1");
  assert.strictEqual(res.statusCode, 404);
});

// Drives /join to its success path: one GetCommand to read the draft, then
// (usually) one UpdateCommand to claim a bot seat.
function joinAs(draft, sub, token) {
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.constructor.name === "GetCommand") return { Item: draft };
    return {}; // UpdateCommand result is ignored
  });
  return handler(
    evt("POST", "/drafts/d1/join", { draftId: "d1", body: { token }, claims: { sub } })
  );
}

// The seat race the whole task exists for: the first conditional write fails
// as though somebody else's write landed on that exact seat between our read
// and our write, and the retry must land on the next bot seat rather than
// giving up or clobbering the seat somebody else just took.
function joinAsWithFirstSeatTaken(draft, sub, token) {
  let updateCalls = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.constructor.name === "GetCommand") return { Item: draft };
    if (cmd.constructor.name === "UpdateCommand") {
      updateCalls += 1;
      if (updateCalls === 1) {
        const e = new Error("The conditional request failed");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      return {};
    }
    return {};
  });
  return handler(
    evt("POST", "/drafts/d1/join", { draftId: "d1", body: { token }, claims: { sub } })
  );
}

test("a wrong invite token is indistinguishable from a missing draft", async () => {
  const draft = { draftId: "d1", inviteToken: "real", seats: [{ team: 1, sub: "alice", kind: "human" }] };
  const wrong = await joinAs(draft, "bob", "guessed");
  const missing = await joinAs(null, "bob", "anything");
  assert.strictEqual(wrong.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(wrong.body), JSON.parse(missing.body));
});

test("joining takes the lowest bot seat", async () => {
  const draft = {
    draftId: "d1", inviteToken: "t", currentIndex: 0, picks: [], version: 1,
    seats: [
      { team: 1, sub: "alice", kind: "human" },
      { team: 2, sub: null, kind: "bot" },
      { team: 3, sub: null, kind: "bot" },
    ],
  };
  const res = await joinAs(draft, "bob", "t");
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).team, 2);
});

// Two people opening the link at once must not both get seat 2.
test("losing the seat race costs a retry, not a seat", async () => {
  const draft = {
    draftId: "d1", inviteToken: "t", currentIndex: 0, picks: [], version: 1,
    seats: [
      { team: 1, sub: "alice", kind: "human" },
      { team: 2, sub: null, kind: "bot" },
      { team: 3, sub: null, kind: "bot" },
    ],
  };
  // The first conditional write fails as though somebody just took seat 2.
  const res = await joinAsWithFirstSeatTaken(draft, "bob", "t");
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).team, 3);
});

test("re-opening the link when already seated is harmless", async () => {
  const draft = {
    draftId: "d1", inviteToken: "t", currentIndex: 0, picks: [], version: 1,
    seats: [{ team: 1, sub: "alice", kind: "human" }, { team: 2, sub: "bob", kind: "bot" }],
  };
  draft.seats[1] = { team: 2, sub: "bob", kind: "human" };
  const res = await joinAs(draft, "bob", "t");
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).team, 2);
});

test("a full draft says so", async () => {
  const draft = {
    draftId: "d1", inviteToken: "t", currentIndex: 0, picks: [], version: 1,
    seats: [{ team: 1, sub: "alice", kind: "human" }],
  };
  const res = await joinAs(draft, "bob", "t");
  assert.strictEqual(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /full/i);
});
