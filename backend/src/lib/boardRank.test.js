const test = require("node:test");
const assert = require("node:assert");
const { rankFromOrder, consensusRank, UNRANKED } = require("./boardRank");

test("board position is the rank", () => {
  const r = rankFromOrder(["p9", "p3"]);
  assert.equal(r({ id: "p9", rank: 400 }), 0);
  assert.equal(r({ id: "p3", rank: 1 }), 1, "your order beats consensus order");
});

test("a player missing from the board sorts behind everyone on it, in consensus order", () => {
  const r = rankFromOrder(["p1", "p2"]);
  // A board written in July does not list a player added in August. That
  // player is not unranked -- he is good, just not on the list.
  assert.equal(r({ id: "rookie", rank: 5 }), 7);
  assert.equal(r({ id: "scrub", rank: 300 }), 302);
  assert.ok(r({ id: "rookie", rank: 5 }) > r({ id: "p2", rank: 999 }));
});

test("an unranked off-board player stays a finite number", () => {
  const r = rankFromOrder(["p1"]);
  const v = r({ id: "nobody", rank: null });
  assert.ok(Number.isFinite(v), "Infinity would poison pickBestForTeam's arithmetic");
  assert.equal(v, 1 + UNRANKED);
});

test("consensusRank is what an absent board falls back to", () => {
  assert.equal(consensusRank({ rank: 12 }), 12);
  assert.equal(consensusRank({ rank: null }), UNRANKED);
});

test("a duplicated id keeps its first (best) position", () => {
  const r = rankFromOrder(["p1", "p2", "p1"]);
  assert.equal(r({ id: "p1", rank: 9 }), 0);
});
