// backend/src/me.test.js
const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { handler } = require("./me");

process.env.DRAFTS_TABLE = "drafts-test";
process.env.BOARDS_TABLE = "boards-test";

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

const { QueryCommand } = require("@aws-sdk/lib-dynamodb");

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

test("GET /me/drafts queries the byOwner index for the caller", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return { Items: [] };
  });
  await handler(getEvent("/me/drafts", ME));
  assert.strictEqual(input.IndexName, "byOwner");
  assert.strictEqual(input.ExpressionAttributeValues[":me"], "user-me");
});

test("GET /me/drafts shapes each row for the list", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [
      { draftId: "d1", teams: 12, rounds: 15, format: "ppr", userTeam: 4,
        boardId: null, currentIndex: 3, createdAt: 1000 },
    ],
  }));
  const res = await handler(getEvent("/me/drafts", ME));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), {
    drafts: [
      { id: "d1", teams: 12, rounds: 15, format: "ppr", userTeam: 4,
        boardId: null, completed: false, createdAt: 1000 },
    ],
  });
});

test("a draft whose picks are all made reports completed", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [{ draftId: "d1", teams: 2, rounds: 2, format: "ppr", userTeam: 1,
              currentIndex: 4, createdAt: 1 }],
  }));
  const res = await handler(getEvent("/me/drafts", ME));
  assert.strictEqual(JSON.parse(res.body).drafts[0].completed, true);
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
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [
      { draftId: "old", teams: 2, rounds: 1, format: "ppr", userTeam: 1, currentIndex: 0, createdAt: 100 },
      { draftId: "new", teams: 2, rounds: 1, format: "ppr", userTeam: 1, currentIndex: 0, createdAt: 900 },
    ],
  }));
  const res = await handler(getEvent("/me/drafts", ME));
  assert.deepStrictEqual(JSON.parse(res.body).drafts.map((d) => d.id), ["new", "old"]);
});
