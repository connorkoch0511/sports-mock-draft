// backend/src/me.test.js
const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { handler } = require("./me");

process.env.DRAFTS_TABLE = "drafts-test";
process.env.BOARDS_TABLE = "boards-test";
process.env.DRAFT_MEMBERS_TABLE = "draft-members-test";

const ME = { sub: "user-me", email: "me@example.com" };

function event(body, claims) {
  return {
    requestContext: {
      http: { method: "POST" },
      ...(claims ? { authorizer: { jwt: { claims } } } : {}),
    },
    // Any path under /me: these two tests are about the 401 gate and the
    // catch-all, both of which fire before routing.
    rawPath: "/me/anything",
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

test.afterEach(() => mock.restoreAll());

test("a request without claims is 401", async () => {
  const res = await handler(event(undefined, undefined));
  assert.strictEqual(res.statusCode, 401);
});

test("an unknown path under /me is 404", async () => {
  const res = await handler({
    requestContext: { http: { method: "POST" }, authorizer: { jwt: { claims: ME } } },
    rawPath: "/me/nope",
  });
  assert.strictEqual(res.statusCode, 404);
});

const { QueryCommand, BatchGetCommand } = require("@aws-sdk/lib-dynamodb");

function getEvent(rawPath, claims) {
  return {
    requestContext: {
      http: { method: "GET" },
      ...(claims ? { authorizer: { jwt: { claims } } } : {}),
    },
    rawPath,
  };
}

test("GET /me/drafts without claims is 401", async () => {
  const res = await handler(getEvent("/me/drafts"));
  assert.strictEqual(res.statusCode, 401);
});

// GET /me/drafts no longer queries the byOwner index at all -- ownerId is who
// created a draft, and this list is who is *in* one, which the members table
// tracks. This drives both of its calls: a Query against that table for
// `sub`, then a BatchGet against the drafts table for whatever ids came
// back. `drafts` stands in for the drafts table (keyed by draftId); a member
// row naming an id missing from `drafts` behaves like DynamoDB itself does --
// BatchGet simply omits it from Responses, which is the "row outlived the
// draft" case these tests care about.
function listDraftsFor(sub, { members, drafts }) {
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd instanceof QueryCommand) {
      const me = cmd.input.ExpressionAttributeValues[":me"];
      return { Items: members.filter((m) => m.sub === me) };
    }
    if (cmd instanceof BatchGetCommand) {
      const table = process.env.DRAFTS_TABLE;
      const keys = cmd.input.RequestItems[table].Keys;
      return {
        Responses: { [table]: keys.map(({ draftId }) => drafts[draftId]).filter(Boolean) },
      };
    }
    return {};
  });
  return handler(getEvent("/me/drafts", { sub }));
}

// The listing now queries the members table AND the byOwner GSI (see the
// FIX 1 test below for why), both as QueryCommands -- so this collects every
// one seen rather than trusting a single captured `input`, which the union
// would make a race between two concurrent calls.
test("GET /me/drafts queries membership rows for the caller", async () => {
  const seen = [];
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd instanceof QueryCommand) seen.push(cmd.input);
    return { Items: [] };
  });
  await handler(getEvent("/me/drafts", ME));
  const membership = seen.find((i) => i.TableName === "draft-members-test");
  assert.ok(membership, "the members table is queried");
  assert.strictEqual(membership.ExpressionAttributeValues[":me"], "user-me");
});

// FIX 1: membership rows are written in exactly two places, both new --
// draft creation and joining -- and nothing backfills one for a draft that
// predates both. Querying the members table alone would make every draft
// anyone already has vanish from their list the moment this ships. The
// union with the byOwner GSI is what carries a draft like this one through:
// owned, but with no row in the members table at all.
test("a draft you own with no membership row still appears in your list", async () => {
  const draft = {
    draftId: "d1", ownerId: "alice", teams: 12, rounds: 15, format: "ppr",
    userTeam: 1, currentIndex: 0, createdAt: 1,
  };
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd instanceof QueryCommand) {
      if (cmd.input.TableName === "draft-members-test") return { Items: [] };
      if (cmd.input.IndexName === "byOwner") return { Items: [draft] };
      return { Items: [] };
    }
    if (cmd instanceof BatchGetCommand) {
      const table = process.env.DRAFTS_TABLE;
      const keys = cmd.input.RequestItems[table].Keys;
      return {
        Responses: { [table]: keys.map(({ draftId }) => (draftId === "d1" ? draft : null)).filter(Boolean) },
      };
    }
    return {};
  });
  const res = await handler(getEvent("/me/drafts", { sub: "alice" }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body).drafts.map((d) => d.draftId), ["d1"]);
});

test("GET /me/drafts shapes each row for the list", async () => {
  const res = await listDraftsFor("user-me", {
    members: [{ sub: "user-me", draftId: "d1" }],
    drafts: {
      d1: { draftId: "d1", ownerId: "user-me", teams: 12, rounds: 15, format: "ppr",
            userTeam: 4, seats: [{ team: 4, sub: "user-me", kind: "human" }],
            boardId: null, currentIndex: 3, createdAt: 1000 },
    },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), {
    drafts: [
      // ownerId is here on purpose, not incidentally: MyDrafts shows the
      // Delete control only when it matches the signed-in user, so dropping
      // it from this response would quietly remove Delete for everybody. The
      // fixture above has to set it, or this pin cannot see it going missing
      // -- which is exactly how the same omission hid inviteToken.
      { id: "d1", draftId: "d1", ownerId: "user-me", teams: 12, rounds: 15,
        format: "ppr", userTeam: 4, yourTeam: 4, boardId: null,
        completed: false, createdAt: 1000 },
    ],
  });
});

// userTeam is fixed at creation and belongs to whoever created the draft.
// yourTeam is derived per caller from seats, so the same draft row answers
// "team 1" for the creator and "team 2" for a joiner asking the identical
// list -- the same defect Task 6 fixed on the draft page itself, here for
// the drafts list.
test("a joiner sees their own seat, not the creator's team, in the list", async () => {
  const drafts = {
    d1: {
      draftId: "d1", ownerId: "alice", userTeam: 1, teams: 2, rounds: 1,
      format: "ppr", currentIndex: 0, createdAt: 1,
      seats: [
        { team: 1, sub: "alice", kind: "human" },
        { team: 2, sub: "bob", kind: "human" },
      ],
    },
  };
  const asAlice = await listDraftsFor("alice", { members: [{ sub: "alice", draftId: "d1" }], drafts });
  const asBob = await listDraftsFor("bob", { members: [{ sub: "bob", draftId: "d1" }], drafts });
  assert.strictEqual(JSON.parse(asAlice.body).drafts[0].yourTeam, 1);
  assert.strictEqual(JSON.parse(asBob.body).drafts[0].yourTeam, 2);
});

test("a draft whose picks are all made reports completed", async () => {
  const res = await listDraftsFor("user-me", {
    members: [{ sub: "user-me", draftId: "d1" }],
    drafts: {
      d1: { draftId: "d1", teams: 2, rounds: 2, format: "ppr", userTeam: 1,
            currentIndex: 4, createdAt: 1 },
    },
  });
  assert.strictEqual(JSON.parse(res.body).drafts[0].completed, true);
});

// A draft you joined -- never created, so byOwner would never have shown it.
test("a draft you joined appears in your list", async () => {
  const res = await listDraftsFor("bob", {
    members: [{ sub: "bob", draftId: "d1" }],
    drafts: { d1: { draftId: "d1", ownerId: "alice", createdAt: 1, teams: 12 } },
  });
  assert.deepStrictEqual(JSON.parse(res.body).drafts.map((d) => d.draftId), ["d1"]);
});

test("a draft you were never in does not", async () => {
  const res = await listDraftsFor("bob", {
    members: [],
    drafts: { d1: { draftId: "d1", ownerId: "alice", createdAt: 1 } },
  });
  assert.deepStrictEqual(JSON.parse(res.body).drafts, []);
});

// The seat is the truth; the row is a convenience. A row without a seat is a
// list entry that 404s on open, which is the safe direction for them to
// disagree in.
test("a membership row for a deleted draft is skipped rather than crashing", async () => {
  const res = await listDraftsFor("bob", {
    members: [{ sub: "bob", draftId: "gone" }],
    drafts: {},
  });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body).drafts, []);
});

test("GET /me/boards shapes each row for the list", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [{ boardId: "b1", name: "My PPR Board", format: "ppr", season: 2026, updatedAt: 5 }],
  }));
  const res = await handler(getEvent("/me/boards", ME));
  assert.deepStrictEqual(JSON.parse(res.body), {
    boards: [{ id: "b1", name: "My PPR Board", format: "ppr", season: 2026, updatedAt: 5 }],
  });
});

// "Newest first" was specified for both lists, but boards sort on updatedAt
// where drafts sort on createdAt -- two comparators, so one passing test does
// not cover the other.
test("the most recently touched board comes first", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [
      { boardId: "stale", name: "Stale", format: "ppr", season: 2026, updatedAt: 100 },
      { boardId: "fresh", name: "Fresh", format: "ppr", season: 2026, updatedAt: 900 },
    ],
  }));
  const res = await handler(getEvent("/me/boards", ME));
  assert.deepStrictEqual(JSON.parse(res.body).boards.map((b) => b.id), ["fresh", "stale"]);
});

test("the newest draft comes first", async () => {
  const res = await listDraftsFor("user-me", {
    members: [
      { sub: "user-me", draftId: "old" },
      { sub: "user-me", draftId: "new" },
    ],
    drafts: {
      old: { draftId: "old", teams: 2, rounds: 1, format: "ppr", userTeam: 1, currentIndex: 0, createdAt: 100 },
      new: { draftId: "new", teams: 2, rounds: 1, format: "ppr", userTeam: 1, currentIndex: 0, createdAt: 900 },
    },
  });
  assert.deepStrictEqual(JSON.parse(res.body).drafts.map((d) => d.id), ["new", "old"]);
});

// FIX: BatchGetCommand can legally return fewer items than asked for,
// handing back the rest as UnprocessedKeys. Without a retry those drafts
// silently vanish from the list -- no error, no retry, nothing.
test("UnprocessedKeys are retried until they clear", async () => {
  const drafts = {
    d1: { draftId: "d1", teams: 12, rounds: 15, format: "ppr", userTeam: 1, currentIndex: 0, createdAt: 1 },
    d2: { draftId: "d2", teams: 12, rounds: 15, format: "ppr", userTeam: 1, currentIndex: 0, createdAt: 2 },
  };
  let batchCalls = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd instanceof QueryCommand) {
      return { Items: [{ sub: "user-me", draftId: "d1" }, { sub: "user-me", draftId: "d2" }] };
    }
    if (cmd instanceof BatchGetCommand) {
      batchCalls += 1;
      const table = process.env.DRAFTS_TABLE;
      const keys = cmd.input.RequestItems[table].Keys;
      if (batchCalls === 1) {
        // Only the first key gets served; the second comes back unprocessed,
        // the way DynamoDB does under load -- the stub must actually stop
        // returning it as unprocessed once retried, or this test would pass
        // even without a retry.
        const [first, ...rest] = keys;
        return {
          Responses: { [table]: [drafts[first.draftId]].filter(Boolean) },
          UnprocessedKeys: rest.length ? { [table]: { Keys: rest } } : undefined,
        };
      }
      return {
        Responses: { [table]: keys.map(({ draftId }) => drafts[draftId]).filter(Boolean) },
      };
    }
    return {};
  });
  const res = await handler(getEvent("/me/drafts", { sub: "user-me" }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(
    JSON.parse(res.body).drafts.map((d) => d.id).sort(),
    ["d1", "d2"]
  );
  // One initial attempt plus exactly one retry -- proves the retry ran and
  // that it stopped once the keys cleared, not that it looped forever.
  assert.strictEqual(batchCalls, 2);
});

// If the keys never clear after the bounded number of retries, the listing
// must still return what it did get rather than hanging or throwing.
test("keys that never clear still return a partial list", async () => {
  const drafts = {
    d1: { draftId: "d1", teams: 12, rounds: 15, format: "ppr", userTeam: 1, currentIndex: 0, createdAt: 1 },
  };
  let batchCalls = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd instanceof QueryCommand) {
      return { Items: [{ sub: "user-me", draftId: "d1" }, { sub: "user-me", draftId: "stuck" }] };
    }
    if (cmd instanceof BatchGetCommand) {
      batchCalls += 1;
      const table = process.env.DRAFTS_TABLE;
      const keys = cmd.input.RequestItems[table].Keys;
      const stuck = keys.find((k) => k.draftId === "stuck");
      const rest = keys.filter((k) => k.draftId !== "stuck");
      return {
        Responses: { [table]: rest.map((k) => drafts[k.draftId]).filter(Boolean) },
        // "stuck" never clears, no matter how many times it's retried.
        UnprocessedKeys: stuck ? { [table]: { Keys: [stuck] } } : undefined,
      };
    }
    return {};
  });
  const res = await handler(getEvent("/me/drafts", { sub: "user-me" }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body).drafts.map((d) => d.id), ["d1"]);
  // Bounded: three attempts total, not an infinite loop chasing "stuck".
  assert.strictEqual(batchCalls, 3);
});
