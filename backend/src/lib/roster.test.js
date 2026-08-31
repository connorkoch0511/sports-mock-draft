const test = require("node:test");
const assert = require("node:assert");
const {
  DEFAULT_ROSTER,
  parseRosterSlots,
  rosterNeed,
  kDefBlocked,
} = require("./roster");

// The three real leagues this feature was designed against.
const ARCADE = ["QB","RB","RB","WR","WR","TE","FLEX","FLEX","K","DEF","BN","BN","BN","BN","BN"];
const JOES = ["QB","RB","RB","WR","WR","WR","TE","FLEX","K","DEF","BN","BN","BN","BN","BN","BN"];

function counts(o = {}) {
  return { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0, ...o };
}

test("parses a real 16-slot roster", () => {
  const r = parseRosterSlots(JOES);
  assert.deepStrictEqual(r.starters, { QB: 1, RB: 2, WR: 3, TE: 1, K: 1, DEF: 1 });
  assert.strictEqual(r.flex, 1);
  assert.strictEqual(r.bench, 6);
  assert.deepStrictEqual(r.unknown, []);
});

test("parses a roster with two FLEX slots", () => {
  const r = parseRosterSlots(ARCADE);
  assert.deepStrictEqual(r.starters, { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 });
  assert.strictEqual(r.flex, 2);
  assert.strictEqual(r.bench, 5);
});

test("unrecognised slots count as bench and are reported", () => {
  const r = parseRosterSlots(["QB", "SUPER_FLEX", "TAXI", "BN"]);
  assert.strictEqual(r.bench, 3);
  assert.deepStrictEqual(r.unknown, ["SUPER_FLEX", "TAXI"]);
});

test("an empty roster parses to zeroes rather than throwing", () => {
  const r = parseRosterSlots([]);
  assert.deepStrictEqual(r.starters, { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 });
  assert.strictEqual(r.flex, 0);
  assert.strictEqual(r.bench, 0);
});

test("DEFAULT_ROSTER reproduces the pre-feature hardcoded targets", () => {
  const r = parseRosterSlots(DEFAULT_ROSTER);
  assert.deepStrictEqual(r.starters, { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 });
  assert.strictEqual(r.flex, 0);
});

test("need equals the missing dedicated starters", () => {
  const r = parseRosterSlots(JOES);
  assert.strictEqual(rosterNeed(counts(), "RB", r), 2);
  assert.strictEqual(rosterNeed(counts({ RB: 1 }), "RB", r), 1);
  assert.strictEqual(rosterNeed(counts(), "WR", r), 3);
  assert.strictEqual(rosterNeed(counts(), "QB", r), 1);
});

test("FLEX adds no demand while dedicated slots are still unfilled", () => {
  const r = parseRosterSlots(JOES);
  // One RB short of the dedicated two: need reflects the dedicated gap only.
  assert.strictEqual(rosterNeed(counts({ RB: 1, WR: 3, TE: 1 }), "RB", r), 1);
});

test("FLEX opens demand for RB, WR and TE once dedicated slots are full", () => {
  const r = parseRosterSlots(JOES);
  const filled = counts({ QB: 1, RB: 2, WR: 3, TE: 1 });
  assert.strictEqual(rosterNeed(filled, "RB", r), 1);
  assert.strictEqual(rosterNeed(filled, "WR", r), 1);
  assert.strictEqual(rosterNeed(filled, "TE", r), 1);
});

test("FLEX never creates demand for QB, K or DEF", () => {
  const r = parseRosterSlots(JOES);
  const filled = counts({ QB: 1, RB: 2, WR: 3, TE: 1, K: 1, DEF: 1 });
  assert.strictEqual(rosterNeed(filled, "QB", r), 0);
  assert.strictEqual(rosterNeed(filled, "K", r), 0);
  assert.strictEqual(rosterNeed(filled, "DEF", r), 0);
});

test("a filled FLEX closes the demand it opened", () => {
  const r = parseRosterSlots(JOES);
  // The third RB fills the single FLEX slot.
  const filled = counts({ QB: 1, RB: 3, WR: 3, TE: 1 });
  assert.strictEqual(rosterNeed(filled, "RB", r), 0);
  assert.strictEqual(rosterNeed(filled, "WR", r), 0);
});

test("two FLEX slots take two extra players before closing", () => {
  const r = parseRosterSlots(ARCADE);
  const base = { QB: 1, RB: 2, WR: 2, TE: 1 };
  assert.strictEqual(rosterNeed(counts(base), "WR", r), 2);
  assert.strictEqual(rosterNeed(counts({ ...base, WR: 3 }), "WR", r), 1);
  assert.strictEqual(rosterNeed(counts({ ...base, WR: 4 }), "WR", r), 0);
});

test("need is zero everywhere once all starters are filled — bench is best-available", () => {
  const r = parseRosterSlots(JOES);
  const full = counts({ QB: 1, RB: 3, WR: 3, TE: 1, K: 1, DEF: 1 });
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    assert.strictEqual(rosterNeed(full, pos, r), 0, `${pos} should have no need`);
  }
});

test("K and DEF stay blocked while many picks remain, regardless of other starters", () => {
  const r = parseRosterSlots(JOES);
  // Neither K nor DEF filled yet: kDefSlotsNeeded is 2, so blocked while
  // picksRemaining > 3 — whether or not the other starters are done.
  assert.strictEqual(kDefBlocked(counts(), r, 16), true);
  assert.strictEqual(kDefBlocked(counts({ QB: 1, RB: 2, WR: 3, TE: 1 }), r, 16), true);
});

test("K and DEF unblock once picks remaining drop to slots-still-needed plus one", () => {
  const r = parseRosterSlots(JOES);
  const c = counts(); // K and DEF both still needed: threshold is 2 + 1 = 3
  assert.strictEqual(kDefBlocked(c, r, 4), true);
  assert.strictEqual(kDefBlocked(c, r, 3), false);
  assert.strictEqual(kDefBlocked(c, r, 1), false);
});

test("the threshold tightens as K/DEF slots are filled", () => {
  const r = parseRosterSlots(JOES);
  const kFilled = counts({ K: 1 }); // only DEF still needed: threshold is 1 + 1 = 2
  assert.strictEqual(kDefBlocked(kFilled, r, 3), true);
  assert.strictEqual(kDefBlocked(kFilled, r, 2), false);

  const bothFilled = counts({ K: 1, DEF: 1 }); // nothing needed: threshold is 0 + 1 = 1
  assert.strictEqual(kDefBlocked(bothFilled, r, 2), true);
  assert.strictEqual(kDefBlocked(bothFilled, r, 1), false);
});

test("the gate scales across draft lengths: a 33-round-sized remainder blocks, a near-exhausted one does not", () => {
  const r = parseRosterSlots(JOES);
  const c = counts();
  // Early in a 33-round draft the team still has 32 picks left: blocked.
  assert.strictEqual(kDefBlocked(c, r, 32), true);
  // In the draft's final few picks: unblocked.
  assert.strictEqual(kDefBlocked(c, r, 2), false);
});

test("does not mutate its inputs", () => {
  const r = parseRosterSlots(JOES);
  const c = counts({ RB: 1 });
  const snapshot = JSON.stringify(c);
  rosterNeed(c, "RB", r);
  kDefBlocked(c, r);
  assert.strictEqual(JSON.stringify(c), snapshot);
});
