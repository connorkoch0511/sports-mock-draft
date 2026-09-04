const test = require("node:test");
const assert = require("node:assert");
const { ANON, subOf, isUnowned, canMutate } = require("./owner");

function evt(claims) {
  return claims === undefined
    ? {}
    : { requestContext: { authorizer: { jwt: { claims } } } };
}

test("subOf reads the sub claim API Gateway passes", () => {
  assert.strictEqual(subOf(evt({ sub: "user-1", email: "a@b.c" })), "user-1");
});

test("subOf is null with no authorizer on the event", () => {
  assert.strictEqual(subOf(evt()), null);
});

test("subOf is null for an undefined event", () => {
  assert.strictEqual(subOf(undefined), null);
});

test("subOf is null when the claims carry no sub", () => {
  assert.strictEqual(subOf(evt({ email: "a@b.c" })), null);
});

test("subOf is null for an empty-string sub", () => {
  assert.strictEqual(subOf(evt({ sub: "" })), null);
});

test("subOf is null for a non-string sub", () => {
  assert.strictEqual(subOf(evt({ sub: 42 })), null);
});

test("an item with no ownerId is unowned", () => {
  assert.strictEqual(isUnowned({ draftId: "d1" }), true);
});

// boards.js has written this literal on every create since the board editor
// shipped, so it is the common case for existing data, not a curiosity.
test("the legacy \"anon\" ownerId counts as unowned", () => {
  assert.strictEqual(isUnowned({ ownerId: ANON }), true);
});

test("an empty-string ownerId is unowned", () => {
  assert.strictEqual(isUnowned({ ownerId: "" }), true);
});

test("an item with a real ownerId is owned", () => {
  assert.strictEqual(isUnowned({ ownerId: "user-1" }), false);
});

test("isUnowned tolerates a missing item", () => {
  assert.strictEqual(isUnowned(undefined), true);
});

test("the owner may mutate", () => {
  assert.strictEqual(canMutate({ ownerId: "user-1" }, "user-1"), true);
});

test("a different signed-in user may not mutate", () => {
  assert.strictEqual(canMutate({ ownerId: "user-1" }, "user-2"), false);
});

test("nobody may mutate an unowned item -- it is frozen until claimed", () => {
  assert.strictEqual(canMutate({ ownerId: ANON }, "user-1"), false);
  assert.strictEqual(canMutate({}, "user-1"), false);
});

test("a null sub may not mutate an item whose ownerId is somehow null", () => {
  assert.strictEqual(canMutate({ ownerId: null }, null), false);
});
