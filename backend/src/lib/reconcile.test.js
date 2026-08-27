const test = require("node:test");
const assert = require("node:assert");
const { reconcile } = require("./reconcile");

function pool(...entries) {
  return entries.map(([playerId, consensusRank]) => ({
    playerId,
    name: `Player ${playerId}`,
    position: "WR",
    team: "SF",
    consensusRank,
  }));
}

test("empty stored order returns the full pool in consensus order", () => {
  const { rows, changelog } = reconcile([], pool(["b", 2], ["a", 1], ["c", 3]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["a", "b", "c"]);
  assert.deepStrictEqual(rows.map((r) => r.myRank), [1, 2, 3]);
  assert.ok(rows.every((r) => r.isNew));
  assert.deepStrictEqual(changelog, { added: 3, removed: 0 });
});

test("unchanged pool preserves user order exactly", () => {
  const { rows, changelog } = reconcile(["c", "a", "b"], pool(["a", 1], ["b", 2], ["c", 3]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["c", "a", "b"]);
  assert.ok(rows.every((r) => !r.isNew));
  assert.deepStrictEqual(changelog, { added: 0, removed: 0 });
});

test("delta is consensusRank minus myRank", () => {
  const { rows } = reconcile(["c", "a", "b"], pool(["a", 1], ["b", 2], ["c", 3]));
  const byId = Object.fromEntries(rows.map((r) => [r.playerId, r]));
  assert.strictEqual(byId.c.myRank, 1);
  assert.strictEqual(byId.c.consensusRank, 3);
  assert.strictEqual(byId.c.delta, 2);
  assert.strictEqual(byId.b.delta, -1);
});

test("a departed player is dropped and counted", () => {
  const { rows, changelog } = reconcile(["a", "gone", "b"], pool(["a", 1], ["b", 2]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["a", "b"]);
  assert.deepStrictEqual(changelog, { added: 0, removed: 1 });
});

test("a new player lands after the last kept player with a better consensus rank", () => {
  const { rows, changelog } = reconcile(["a", "b"], pool(["a", 1], ["b", 3], ["new", 2]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["a", "new", "b"]);
  assert.strictEqual(rows[1].isNew, true);
  assert.deepStrictEqual(changelog, { added: 1, removed: 0 });
});

test("a new player better than everything lands at the front", () => {
  const { rows } = reconcile(["a", "b"], pool(["a", 2], ["b", 3], ["new", 1]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["new", "a", "b"]);
});

test("user's top pick is not displaced by a higher-consensus newcomer", () => {
  // "sleeper" is consensus #300 but the user ranks them #1.
  const { rows } = reconcile(["sleeper", "star"], pool(["sleeper", 300], ["star", 1], ["new", 2]));
  assert.strictEqual(rows[0].playerId, "sleeper");
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["sleeper", "star", "new"]);
});

test("ties break by playerId for determinism", () => {
  const { rows } = reconcile([], pool(["z", 1], ["a", 1]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["a", "z"]);
});

// Defensive: loadPool filters unranked players out, but reconcile is a pure
// function and must stay total over its input domain.
test("players with a null consensus rank sort last", () => {
  const { rows } = reconcile([], pool(["a", null], ["b", 5]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["b", "a"]);
});

test("does not mutate its inputs", () => {
  const stored = ["a", "b"];
  const live = pool(["a", 1], ["b", 2]);
  reconcile(stored, live);
  assert.deepStrictEqual(stored, ["a", "b"]);
  assert.strictEqual(live.length, 2);
});
