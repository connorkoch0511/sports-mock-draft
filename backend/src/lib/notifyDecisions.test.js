const test = require("node:test");
const assert = require("node:assert");
const { decideNotifications } = require("./notifyDecisions");

function draft({ currentIndex, picks, seats, draftId = "d1" }) {
  return { draftId, currentIndex, picks, seats };
}
const SEATS = [
  { team: 1, kind: "human", sub: "user-a" },
  { team: 2, kind: "human", sub: "user-b" },
  { team: 3, kind: "bot", sub: null },
];

test("nothing is sent when the pick did not move", () => {
  // Pauses, board changes and seat-board writes all land on this stream.
  const d = draft({ currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS });
  assert.deepEqual(decideNotifications(d, { ...d, pausedAt: 123 }), []);
});

test("the seat now on the clock is told it is their turn", () => {
  const before = draft({ currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS });
  const after = draft({ currentIndex: 1, picks: [{ team: 1, playerId: "p1" }, { team: 2 }], seats: SEATS });
  const out = decideNotifications(before, after);
  assert.equal(out.length, 1);
  assert.equal(out[0].sub, "user-b");
  assert.equal(out[0].kind, "your-turn");
});

test("a bot's turn tells nobody", () => {
  const before = draft({ currentIndex: 1, picks: [{ team: 1 }, { team: 2 }, { team: 3 }], seats: SEATS });
  const after = draft({ currentIndex: 2, picks: [{ team: 1 }, { team: 2, playerId: "p2" }, { team: 3 }], seats: SEATS });
  assert.deepEqual(decideNotifications(before, after), []);
});

test("a pick the clock made tells the person it was made for", () => {
  const before = draft({ currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS });
  const after = draft({
    currentIndex: 1,
    picks: [{ team: 1, playerId: "p1", auto: true, player: { name: "Jahmyr Gibbs" } }, { team: 2 }],
    seats: SEATS,
  });
  const out = decideNotifications(before, after);
  const mine = out.find((n) => n.kind === "picked-for-you");
  assert.ok(mine, "the seat that was picked for must be told");
  assert.equal(mine.sub, "user-a");
  assert.match(mine.body, /Gibbs/);
});

test("a pick a person made tells only the next seat", () => {
  const before = draft({ currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS });
  const after = draft({
    currentIndex: 1,
    picks: [{ team: 1, playerId: "p1", player: { name: "Jahmyr Gibbs" } }, { team: 2 }],
    seats: SEATS,
  });
  const kinds = decideNotifications(before, after).map((n) => n.kind);
  assert.deepEqual(kinds, ["your-turn"]);
});

test("a finished draft has nobody on the clock", () => {
  const before = draft({ currentIndex: 1, picks: [{ team: 1 }, { team: 2 }], seats: SEATS });
  const after = draft({
    currentIndex: 2,
    picks: [{ team: 1 }, { team: 2, playerId: "p2", auto: true, player: { name: "Bijan Robinson" } }],
    seats: SEATS,
  });
  const kinds = decideNotifications(before, after).map((n) => n.kind);
  assert.deepEqual(kinds, ["picked-for-you"], "no your-turn past the end of the draft");
});
