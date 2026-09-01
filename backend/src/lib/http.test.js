const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const { responder, json, corsHeaders } = require("./http");

// A body big enough to clear the compression threshold, and repetitive
// enough that gzip visibly shrinks it — like the real players payload.
const BIG = { players: Array.from({ length: 200 }, (_, i) => ({
  id: String(i), name: `Player Number ${i}`, position: "WR", team: "SF", rank: i, adp: i + 0.5,
})) };

function evt(headers) {
  return { headers, requestContext: { http: { method: "GET" } } };
}

test("compresses when the client accepts gzip", () => {
  const res = responder(evt({ "accept-encoding": "gzip, deflate, br" }))(200, BIG);
  assert.strictEqual(res.isBase64Encoded, true);
  assert.strictEqual(res.headers["Content-Encoding"], "gzip");
});

test("the compressed body gunzips back to the original JSON", () => {
  const res = responder(evt({ "accept-encoding": "gzip" }))(200, BIG);
  const restored = zlib.gunzipSync(Buffer.from(res.body, "base64")).toString();
  assert.deepStrictEqual(JSON.parse(restored), BIG);
});

test("compression actually makes the payload smaller", () => {
  const res = responder(evt({ "accept-encoding": "gzip" }))(200, BIG);
  const raw = Buffer.byteLength(JSON.stringify(BIG));
  const sent = Buffer.byteLength(res.body, "base64");
  assert.ok(sent < raw / 2, `expected well under half of ${raw}, got ${sent}`);
});

test("sends plain JSON when no Accept-Encoding is present", () => {
  const res = responder(evt({}))(200, BIG);
  assert.strictEqual(res.isBase64Encoded, undefined);
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
  assert.deepStrictEqual(JSON.parse(res.body), BIG);
});

test("sends plain JSON when the client accepts other encodings but not gzip", () => {
  const res = responder(evt({ "accept-encoding": "deflate, br" }))(200, BIG);
  assert.strictEqual(res.isBase64Encoded, undefined);
  assert.deepStrictEqual(JSON.parse(res.body), BIG);
});

test("leaves a small body uncompressed even when gzip is accepted", () => {
  const res = responder(evt({ "accept-encoding": "gzip" }))(404, { error: "Not found" });
  assert.strictEqual(res.isBase64Encoded, undefined);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Not found" });
});

test("finds the header regardless of its casing", () => {
  const lower = responder(evt({ "accept-encoding": "gzip" }))(200, BIG);
  const upper = responder(evt({ "Accept-Encoding": "gzip" }))(200, BIG);
  const mixed = responder(evt({ "Accept-Encoding": "GZIP" }))(200, BIG);
  assert.strictEqual(lower.isBase64Encoded, true);
  assert.strictEqual(upper.isBase64Encoded, true, "uppercase header name missed");
  assert.strictEqual(mixed.isBase64Encoded, true, "uppercase header value missed");
});

test("CORS headers are identical on both paths", () => {
  const plain = responder(evt({}))(200, BIG);
  const gz = responder(evt({ "accept-encoding": "gzip" }))(200, BIG);
  for (const [k, v] of Object.entries(corsHeaders())) {
    assert.strictEqual(plain.headers[k], v, `plain missing ${k}`);
    assert.strictEqual(gz.headers[k], v, `gzip missing ${k}`);
  }
  assert.strictEqual(plain.headers["Content-Type"], "application/json");
  assert.strictEqual(gz.headers["Content-Type"], "application/json");
});

test("Vary: Accept-Encoding is present on the compressed response", () => {
  const res = responder(evt({ "accept-encoding": "gzip" }))(200, BIG);
  assert.strictEqual(res.headers["Vary"], "Accept-Encoding");
});

test("Vary: Accept-Encoding is present on the plain response", () => {
  const res = responder(evt({}))(200, BIG);
  assert.strictEqual(res.headers["Vary"], "Accept-Encoding");
});

test("Vary: Accept-Encoding is present on a small body that stays uncompressed", () => {
  const res = responder(evt({ "accept-encoding": "gzip" }))(404, { error: "Not found" });
  assert.strictEqual(res.isBase64Encoded, undefined);
  assert.strictEqual(res.headers["Vary"], "Accept-Encoding");
});

test("the status code passes through on both paths", () => {
  assert.strictEqual(responder(evt({}))(201, BIG).statusCode, 201);
  assert.strictEqual(responder(evt({ "accept-encoding": "gzip" }))(409, BIG).statusCode, 409);
});

test("a missing or malformed event degrades to plain JSON rather than throwing", () => {
  for (const bad of [undefined, null, {}, { headers: null }, { headers: "nope" }]) {
    const res = responder(bad)(200, BIG);
    assert.strictEqual(res.isBase64Encoded, undefined);
    assert.deepStrictEqual(JSON.parse(res.body), BIG);
  }
});

test("the original json() export is unchanged and never compresses", () => {
  const res = json(200, BIG);
  assert.strictEqual(res.isBase64Encoded, undefined);
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
  assert.deepStrictEqual(JSON.parse(res.body), BIG);
});

test("gzip;q=0 is a refusal, not consent", () => {
  const json = responder({ headers: { "accept-encoding": "gzip;q=0" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
  assert.strictEqual(res.isBase64Encoded, undefined);
});

test("gzip;q=0.000 is also a refusal", () => {
  const json = responder({ headers: { "accept-encoding": "gzip;q=0.000" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
});

test("a positive q-value still accepts gzip", () => {
  const json = responder({ headers: { "accept-encoding": "gzip;q=0.8" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], "gzip");
});

test("a wildcard accepts gzip", () => {
  const json = responder({ headers: { "accept-encoding": "*" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], "gzip");
});

test("a refused wildcard does not accept gzip", () => {
  const json = responder({ headers: { "accept-encoding": "*;q=0" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
});

test("gzip is still found among several codings with spacing", () => {
  const json = responder({ headers: { "accept-encoding": "br;q=1.0, gzip ; q=0.5 , deflate" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], "gzip");
});

test("a coding merely containing 'gzip' does not count", () => {
  const json = responder({ headers: { "accept-encoding": "notgzip" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
});

test("a malformed q-value fails closed to no compression", () => {
  const json = responder({ headers: { "accept-encoding": "gzip;q=banana" } });
  const res = json(200, { pad: "x".repeat(4000) });
  assert.strictEqual(res.headers["Content-Encoding"], undefined);
});
