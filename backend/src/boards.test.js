const test = require("node:test");
const assert = require("node:assert");
const { handler } = require("./boards");

// Every case here is rejected by validation BEFORE any DynamoDB call, so these
// run without credentials, mocks, or a live table. Do not add a case whose
// happy path reaches ddb.send() — it would need AWS to pass.

function event(method, body, boardId) {
  return {
    requestContext: { http: { method } },
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

test("POST rejects a non-numeric season instead of storing NaN", async () => {
  const { code } = await status(event("POST", { format: "ppr", season: "abc" }));
  assert.strictEqual(code, 400);
});

test("POST rejects a non-integer season", async () => {
  const { code } = await status(event("POST", { format: "ppr", season: 2026.5 }));
  assert.strictEqual(code, 400);
});

test("POST rejects an out-of-range season", async () => {
  const { code } = await status(event("POST", { format: "ppr", season: 99999 }));
  assert.strictEqual(code, 400);
});

test("POST rejects a body of literal null rather than throwing", async () => {
  const { code, body } = await status(event("POST", "null"));
  assert.strictEqual(code, 400);
  assert.match(body.error, /JSON body/i);
});

test("POST rejects a JSON body that is an array", async () => {
  const { code } = await status(event("POST", "[1,2,3]"));
  assert.strictEqual(code, 400);
});

test("POST rejects a JSON body that is a bare string", async () => {
  const { code } = await status(event("POST", '"hello"'));
  assert.strictEqual(code, 400);
});

test("POST still rejects an unknown format", async () => {
  const { code, body } = await status(event("POST", { format: "superflex" }));
  assert.strictEqual(code, 400);
  assert.match(body.error, /format/i);
});

test("POST still rejects malformed JSON", async () => {
  const { code, body } = await status(event("POST", "{bad json"));
  assert.strictEqual(code, 400);
  assert.match(body.error, /JSON body/i);
});

test("PUT rejects an oversized playerId entry", async () => {
  const evt = event("PUT", { order: ["x".repeat(100)], version: 1 }, "abc");
  const { code, body } = await status(evt);
  assert.strictEqual(code, 400);
  assert.match(body.error, /playerId/i);
});

test("PUT accepts a realistically-sized playerId past the length check", async () => {
  // A real Sleeper id is ~4 chars. This must NOT be rejected for length —
  // it fails later on the duplicate check instead, proving length passed.
  const evt = event("PUT", { order: ["4034", "4034"], version: 1 }, "abc");
  const { code, body } = await status(evt);
  assert.strictEqual(code, 400);
  assert.match(body.error, /duplicate/i);
});

test("PUT rejects a body of literal null", async () => {
  const { code } = await status(event("PUT", "null", "abc"));
  assert.strictEqual(code, 400);
});

test("PUT still rejects a non-array order", async () => {
  const { code, body } = await status(event("PUT", { order: "nope", version: 1 }, "abc"));
  assert.strictEqual(code, 400);
  assert.match(body.error, /array/i);
});

test("PUT still rejects a non-integer version", async () => {
  const { code, body } = await status(event("PUT", { order: [], version: "x" }, "abc"));
  assert.strictEqual(code, 400);
  assert.match(body.error, /version/i);
});

test("OPTIONS preflight still returns 200", async () => {
  const { code } = await status(event("OPTIONS"));
  assert.strictEqual(code, 200);
});
