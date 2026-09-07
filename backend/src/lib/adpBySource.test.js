const test = require("node:test");
const assert = require("node:assert");
const { withAdpBySource } = require("./adpBySource");

test("field absent yields no key at all", () => {
  assert.deepStrictEqual(withAdpBySource(undefined), {});
});

test("an empty map is suppressed, not passed through", () => {
  assert.deepStrictEqual(withAdpBySource({}), {});
});

test("a populated map passes through under adpBySource", () => {
  assert.deepStrictEqual(withAdpBySource({ espn: 28.4, yahoo: 55 }), {
    adpBySource: { espn: 28.4, yahoo: 55 },
  });
});

// A 0 inside a populated map is a genuine stored value, not a signal that the
// map is "empty" -- only a map with zero keys is suppressed.
test("a 0 value inside a populated map still passes through", () => {
  assert.deepStrictEqual(withAdpBySource({ espn: 0 }), { adpBySource: { espn: 0 } });
});
