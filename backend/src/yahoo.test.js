const test = require("node:test");
const assert = require("node:assert");

function event(body, sub = "user-1") {
  return {
    requestContext: { http: { method: "POST" }, authorizer: { jwt: { claims: { sub } } } },
    body: JSON.stringify(body),
  };
}

test("a request without a code is refused", async () => {
  const { handler } = require("./yahoo");
  const res = await handler(event({}));
  assert.strictEqual(res.statusCode, 400);
});

test("a signed-out request is refused", async () => {
  const { handler } = require("./yahoo");
  const res = await handler({ requestContext: { http: { method: "POST" } }, body: "{}" });
  assert.strictEqual(res.statusCode, 401);
});

// The secret is the one thing that must never travel.
test("no response body ever carries the secret or the token", async () => {
  process.env.YAHOO_CLIENT_ID = "id";
  process.env.YAHOO_CLIENT_SECRET = "SUPER-SECRET";
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ access_token: "TOKEN-123" }) });
  try {
    const { handler } = require("./yahoo");
    const res = await handler(event({ code: "abc" }));
    assert.ok(!JSON.stringify(res).includes("SUPER-SECRET"), "the secret must not appear");
    assert.ok(!JSON.stringify(res).includes("TOKEN-123"), "the access token must not appear");
  } finally {
    global.fetch = realFetch;
  }
});

test("a rejected code exchange says the sign-in could not be confirmed", async () => {
  process.env.YAHOO_CLIENT_ID = "id";
  process.env.YAHOO_CLIENT_SECRET = "s";
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, text: async () => "invalid_grant" });
  try {
    const { handler } = require("./yahoo");
    const res = await handler(event({ code: "expired" }));
    assert.strictEqual(res.statusCode, 502);
    assert.match(JSON.parse(res.body).message, /could not confirm/i);
  } finally {
    global.fetch = realFetch;
  }
});
