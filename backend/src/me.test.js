// backend/src/me.test.js
const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
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
