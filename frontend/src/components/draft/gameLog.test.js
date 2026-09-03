import test from "node:test";
import assert from "node:assert";
import { withByeGaps, gapLabel, statValue, snapShare, columnsFor } from "./gameLog.js";

const wk = (n, extra = {}) => ({ wk: n, ...extra });

test("consecutive missed weeks collapse into one span", () => {
  const out = withByeGaps([wk(1), wk(2), wk(4)], 18);

  assert.deepStrictEqual(
    out.map((e) => (e.played ? `p${e.wk}` : gapLabel(e))),
    ["p1", "p2", "3", "p4", "5-18"]
  );
});

test("a single missed week is named on its own, not as a range", () => {
  const out = withByeGaps([wk(1), wk(3)], 3);
  const gap = out.find((e) => !e.played);
  assert.strictEqual(gapLabel(gap), "2");
});

test("a leading gap is kept — he missed the start of the season", () => {
  const out = withByeGaps([wk(4)], 4);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(gapLabel(out[0]), "1-3");
  assert.strictEqual(out[1].played, true);
});

test("every played week survives collapsing", () => {
  const played = [1, 5, 6, 12, 17];
  const out = withByeGaps(played.map((n) => wk(n)), 18);
  assert.deepStrictEqual(out.filter((e) => e.played).map((e) => e.wk), played);
});

test("a season with no games is one span, not eighteen rows", () => {
  const out = withByeGaps([], 18);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(gapLabel(out[0]), "1-18");
});

test("weeks stop at the season's progress, so unplayed weeks are not absences", () => {
  const out = withByeGaps([wk(1), wk(2)], 5);
  assert.deepStrictEqual(
    out.map((e) => (e.played ? `p${e.wk}` : gapLabel(e))),
    ["p1", "p2", "3-5"]
  );
});

// A field Sleeper omitted in a week he PLAYED is a real zero; the "did not
// play" case never reaches here because those weeks are gaps.
test("a missing stat in a played week reads as zero", () => {
  assert.strictEqual(statValue({ rec: 4 }, "rec"), 4);
  assert.strictEqual(statValue({ rec: 4 }, "rec_td"), 0);
  assert.strictEqual(statValue({ rec_td: "3" }, "rec_td"), 0);
  assert.strictEqual(statValue(null, "rec"), 0);
});

// Null, not 0: "played no snaps" and "we don't know his snaps" are different
// claims and only one of them is a fact.
test("snap share is null when either half is unknown", () => {
  assert.strictEqual(snapShare({ off_snp: 40, tm_off_snp: 62 }), 65);
  assert.strictEqual(snapShare({ off_snp: 40 }), null);
  assert.strictEqual(snapShare({ tm_off_snp: 62 }), null);
  assert.strictEqual(snapShare({ off_snp: 0, tm_off_snp: 62 }), 0);
  assert.strictEqual(snapShare({ off_snp: 40, tm_off_snp: 0 }), null);
});

test("columns follow the position", () => {
  assert.ok(columnsFor("QB").some((c) => c.key === "pass_int"));
  assert.ok(!columnsFor("RB").some((c) => c.key === "pass_int"));
  assert.ok(columnsFor("RB").some((c) => c.key === "rush_att"));
  assert.ok(columnsFor("WR").some((c) => c.key === "rec_tgt"));
  assert.deepStrictEqual(columnsFor("DEF"), []);
});
