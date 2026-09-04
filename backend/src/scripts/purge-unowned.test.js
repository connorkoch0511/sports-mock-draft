// backend/scripts/purge-unowned.test.js
const test = require("node:test");
const assert = require("node:assert");
const { isPurgeable } = require("./purge-unowned");

test("a row with no ownerId is purgeable", () => {
  assert.strictEqual(isPurgeable({ draftId: "d1" }), true);
});

test("the legacy anon owner is purgeable", () => {
  assert.strictEqual(isPurgeable({ boardId: "b1", ownerId: "anon" }), true);
});

test("an empty ownerId is purgeable", () => {
  assert.strictEqual(isPurgeable({ ownerId: "" }), true);
});

// The whole safety property. A real owner means somebody signed in and
// claimed it, and deleting it would be destroying their work.
test("a row with a real owner is never purgeable", () => {
  assert.strictEqual(isPurgeable({ ownerId: "a1b2c3" }), false);
});
