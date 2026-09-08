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

test("GET /me/drafts queries membership rows for the caller", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd instanceof QueryCommand) input = cmd.input;
    return { Items: [] };
  });
  await handler(getEvent("/me/drafts", ME));
  assert.strictEqual(input.TableName, "draft-members-test");
  assert.strictEqual(input.ExpressionAttributeValues[":me"], "user-me");
});

test("GET /me/drafts shapes each row for the list", async () => {
  const res = await listDraftsFor("user-me", {
    members: [{ sub: "user-me", draftId: "d1" }],
    drafts: {
      d1: { draftId: "d1", teams: 12, rounds: 15, format: "ppr", userTeam: 4,
            boardId: null, currentIndex: 3, createdAt: 1000 },
    },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), {
    drafts: [
      { id: "d1", draftId: "d1", teams: 12, rounds: 15, format: "ppr", userTeam: 4,
        boardId: null, completed: false, createdAt: 1000 },
    ],
  });
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
