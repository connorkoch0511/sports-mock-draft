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
    rawPath: "/me/claim",
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function conditionalFailure() {
  const e = new Error("The conditional request failed");
  e.name = "ConditionalCheckFailedException";
  return e;
}

test.afterEach(() => mock.restoreAll());

test("claiming without claims is 401", async () => {
  const res = await handler(event({ draftIds: ["d1"] }));
  assert.strictEqual(res.statusCode, 401);
});

test("a successful claim reports the ids it took", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({}));
  const res = await handler(
    event({ draftIds: ["d1", "d2"], boardIds: ["b1"] }, ME)
  );
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), {
    claimed: { drafts: ["d1", "d2"], boards: ["b1"] },
    skipped: { drafts: [], boards: [] },
  });
});

test("the claim sets ownerId to the caller only when nobody owns it", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  await handler(event({ draftIds: ["d1"] }, ME));
  assert.strictEqual(input.ExpressionAttributeValues[":me"], "user-me");
  assert.match(input.ConditionExpression, /attribute_not_exists\(ownerId\)/);
  // The legacy boards literal has to be claimable too, or every board created
  // before accounts existed stays frozen forever.
  assert.strictEqual(input.ExpressionAttributeValues[":anon"], "anon");
});

// The case the spec calls out by name: an id somebody else already owns must
// change nothing and say so.
test("claiming an already-owned resource steals nothing and reports it skipped", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    throw conditionalFailure();
  });
  const res = await handler(event({ draftIds: ["d1"], boardIds: ["b1"] }, ME));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), {
    claimed: { drafts: [], boards: [] },
    skipped: { drafts: ["d1"], boards: ["b1"] },
  });
});

test("an empty claim is a 200 that did nothing", async () => {
  const res = await handler(event({}, ME));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), {
    claimed: { drafts: [], boards: [] },
    skipped: { drafts: [], boards: [] },
  });
});

test("a non-array draftIds is a 400, not a 500", async () => {
  const res = await handler(event({ draftIds: "d1" }, ME));
  assert.strictEqual(res.statusCode, 400);
});

test("more ids than the registries can hold is a 400", async () => {
  const res = await handler(
    event({ draftIds: Array.from({ length: 51 }, (_, i) => `d${i}`) }, ME)
  );
  assert.strictEqual(res.statusCode, 400);
});

test("a malformed body is a 400", async () => {
  const res = await handler({
    requestContext: {
      http: { method: "POST" },
      authorizer: { jwt: { claims: ME } },
    },
    rawPath: "/me/claim",
    body: "not json",
  });
  assert.strictEqual(res.statusCode, 400);
});

test("an unknown path under /me is 404", async () => {
  const res = await handler({
    requestContext: {
      http: { method: "POST" },
      authorizer: { jwt: { claims: ME } },
    },
    rawPath: "/me/nope",
    body: "{}",
  });
  assert.strictEqual(res.statusCode, 404);
});
