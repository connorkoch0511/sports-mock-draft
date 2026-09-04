const test = require("node:test");
const assert = require("node:assert");
const { ANON, subOf, isUnowned, canMutate, buildSeats, isSeated } = require("./owner");

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

test("buildSeats gives one seat per team", () => {
  assert.strictEqual(buildSeats(12, 1, "me").length, 12);
});

test("buildSeats seats the creator at their own team", () => {
  const seats = buildSeats(4, 3, "me");
  assert.deepStrictEqual(seats[2], { team: 3, sub: "me", kind: "human" });
});

test("buildSeats fills every other team with a bot", () => {
  const seats = buildSeats(4, 3, "me");
  const bots = seats.filter((s) => s.kind === "bot");
  assert.strictEqual(bots.length, 3);
  assert.ok(bots.every((s) => s.sub === null));
});

test("buildSeats numbers teams from one, in order", () => {
  assert.deepStrictEqual(
    buildSeats(3, 1, "me").map((s) => s.team),
    [1, 2, 3]
  );
});

test("the person in a seat can see the draft", () => {
  assert.strictEqual(isSeated({ seats: buildSeats(4, 1, "me") }, "me"), true);
});

test("somebody in no seat cannot", () => {
  assert.strictEqual(isSeated({ seats: buildSeats(4, 1, "me") }, "them"), false);
});

// A bot seat carries sub: null. Without the kind check, a caller whose sub
// somehow read as null would match every bot seat in the table.
test("a null sub does not match the bot seats", () => {
  assert.strictEqual(isSeated({ seats: buildSeats(4, 1, "me") }, null), false);
});

// The case the `kind` check actually earns its place for. Without it this
// returns true, and -- verified -- no other test in this file notices, because
// the null-sub test it was written to justify is already satisfied by the
// typeof guard before any seat is read.
test("a non-human seat carrying a sub does not admit that person", () => {
  assert.strictEqual(
    isSeated({ seats: [{ team: 1, sub: "me", kind: "bot" }] }, "me"),
    false
  );
});

test("a draft with no seats admits nobody", () => {
  assert.strictEqual(isSeated({}, "me"), false);
  assert.strictEqual(isSeated({ seats: [] }, "me"), false);
});

test("isSeated tolerates junk in the seats list", () => {
  const draft = { seats: [null, "nope", { kind: "human" }, { team: 2, sub: "me", kind: "human" }] };
  assert.strictEqual(isSeated(draft, "me"), true);
});

test("isSeated tolerates a missing draft", () => {
  assert.strictEqual(isSeated(undefined, "me"), false);
});
