import test from "node:test";
import assert from "node:assert";
import { adpTrio, PLATFORM_WIDE_NOTE } from "./adpSources.js";

test("all three sources render in a fixed order", () => {
  const trio = adpTrio(40.1, { espn: 28.4, yahoo: 55 });
  assert.deepStrictEqual(trio.map((t) => t.label), ["ours", "esp", "yah"]);
  assert.deepStrictEqual(trio.map((t) => t.text), ["40.1", "28.4", "55.0"]);
});

// A missing source must read as absent, never as a number.
test("a missing source is a dash, not a zero", () => {
  const trio = adpTrio(40.1, { espn: 28.4 });
  assert.deepStrictEqual(trio.map((t) => t.text), ["40.1", "28.4", "—"]);
});

test("no per-source data at all still shows our own number", () => {
  const trio = adpTrio(40.1, undefined);
  assert.deepStrictEqual(trio.map((t) => t.text), ["40.1", "—", "—"]);
});

test("a player nobody has an ADP for is all dashes", () => {
  assert.deepStrictEqual(adpTrio(null, undefined).map((t) => t.text), ["—", "—", "—"]);
});

// 0 is not a real ADP, and treating it as one would put the player first.
test("a zero is treated as no number", () => {
  assert.strictEqual(adpTrio(0, { espn: 0 })[0].text, "—");
  assert.strictEqual(adpTrio(0, { espn: 0 })[1].text, "—");
});

// Infinity satisfies `raw > 0` just as 0 fails it -- the guard must reject
// both ends of the number line, not just the low one.
test("Infinity is treated as no number, not a valid ADP", () => {
  const trio = adpTrio(Infinity, { espn: Infinity });
  assert.strictEqual(trio[0].value, null);
  assert.strictEqual(trio[0].text, "—");
  assert.strictEqual(trio[1].value, null);
  assert.strictEqual(trio[1].text, "—");
});

test("the platform-wide note says what it means", () => {
  assert.match(PLATFORM_WIDE_NOTE, /whole platform/);
});
