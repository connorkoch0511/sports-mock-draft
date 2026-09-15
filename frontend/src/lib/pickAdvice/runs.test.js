import test from "node:test";
import assert from "node:assert";
import { detectRuns } from "./runs.js";

// A pick that carries a player. `team` is the seat that made it.
function pick(team, id, position) {
  return { overall: 0, round: 1, team, playerId: id, player: { id, position } };
}

// A pick whose player carries a rank, so the reconstructed board can be sorted.
function rankedPick(team, id, position, rank) {
  return {
    overall: 0, round: 1, team, playerId: id,
    player: { id, position, rank },
  };
}

// Players still on the board, ranked.
function ranked(entries) {
  return entries.map(([id, position, rank]) => ({ id, position, rank }));
}

// A board with `n` players at each listed position, RANKED so the top of the
// board is a mix of positions in proportion to `counts` -- not one block per
// position. compareRank leaves unranked players in insertion order, so an
// unranked board (what this helper built before Task 1) put whichever
// position was listed first in `counts` at the very top of the reconstructed
// board every time: RB, here, since every call site lists it first. That
// silently gave every "should fire" test in this file an expected RB share
// near 1.0 once detectRuns started reconstructing the board instead of
// reading it live -- ranks are what make the fixture mean what its comments
// say. Each position's players are spread evenly across [0, 1) by their
// within-position index, the standard trick for interleaving several
// streams by relative share (same idea as Bresenham's line algorithm).
function board(counts) {
  const positions = Object.entries(counts);
  const seeded = [];
  for (const [position, n] of positions) {
    for (let i = 0; i < n; i++) seeded.push({ position, key: (i + 0.5) / n });
  }
  // Stable sort: a tie (two positions landing on the same fractional slot)
  // keeps `counts`'s declared order, which is deterministic and not what any
  // test here asserts on.
  seeded.sort((a, b) => a.key - b.key);

  return seeded.map((s, i) => ({ id: 1000 + i, position: s.position, rank: i + 1 }));
}

test("a position going far above its expected rate is a run", () => {
  // 8 picks by others, 5 of them RB. Observed 5/8 = 0.625.
  // Reconstructed board: the window's 8 picks plus `available` puts the top 8
  // of a 10 RB/20 WR/10 TE board (board() interleaves by relative share) at
  // 2 RB, 4 WR, 2 TE -- expected 2/8 = 0.25. 0.625 >= 0.25 * 1.75 = 0.4375.
  // Fires. (Re-based for Task 1: `board()` used to leave every player
  // unranked, so the reconstructed top 8 was just the first 8 insertion-order
  // entries -- 8 RB, since board() lists RB first -- and expected came out to
  // 8/8 = 1.0, well above 0.625. This test failed until board() carried
  // ranks.)
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "RB"), pick(4, 3, "WR"), pick(5, 4, "RB"),
    pick(6, 5, "RB"), pick(7, 6, "TE"), pick(8, 7, "RB"), pick(9, 8, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({ made, mySlot: 1, available });

  assert.deepStrictEqual(runs.get("RB"), { count: 5, window: 8 });
});

test("a position going at its expected rate is not a run", () => {
  // 2 RB of 8 = 0.25 observed, against 0.25 expected. Not a departure --
  // and below RUN_MIN_COUNT anyway.
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "WR"), pick(4, 3, "WR"), pick(5, 4, "WR"),
    pick(6, 5, "RB"), pick(7, 6, "TE"), pick(8, 7, "WR"), pick(9, 8, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({ made, mySlot: 1, available });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("your own picks do not count toward a run", () => {
  // Seat 1 is the user and took three of the four RBs. Without the filter
  // this is 4 RB of 8; with it, 1 RB of 5, which is not a run.
  const made = [
    pick(1, 1, "RB"), pick(1, 2, "RB"), pick(1, 3, "RB"), pick(2, 4, "RB"),
    pick(3, 5, "WR"), pick(4, 6, "WR"), pick(5, 7, "TE"), pick(6, 8, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({ made, mySlot: 1, available });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("the count includes picks of players nobody would start", () => {
  // Five RBs taken, at ids (9001-9005) that don't appear anywhere on
  // `available` -- they are already off the board by the time this factor
  // runs. The sentence this feeds has to be true of the Draft Board, so all
  // five count regardless. Same board and window shape as "a position going
  // far above its expected rate is a run": expected 2/8 = 0.25, observed
  // 5/8 = 0.625 clears 0.4375. Fires.
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const made = [
    pick(2, 9001, "RB"), pick(3, 9002, "RB"), pick(4, 9003, "RB"),
    pick(5, 9004, "RB"), pick(6, 9005, "RB"), pick(7, 11, "WR"),
    pick(8, 12, "TE"), pick(9, 13, "WR"),
  ];
  const runs = detectRuns({ made, mySlot: 1, available });

  assert.deepStrictEqual(runs.get("RB"), { count: 5, window: 8 });
});

test("only the last RUN_WINDOW picks are considered", () => {
  // Eight RBs, all of them older than the window, followed by 8 non-RB picks
  // by others. Nothing should be running.
  //
  // Eight and not six: with six, widening RUN_WINDOW to 20 gives 6/14 = 0.4286
  // against a 0.4375 threshold, so the mutation in Task 3 would survive by a
  // hundredth. Eight gives 8/16 = 0.5 and the mutation turns this red.
  const made = [
    ...Array.from({ length: 8 }, (_, i) => pick(2, i + 1, "RB")),
    pick(2, 20, "WR"), pick(3, 21, "WR"), pick(4, 22, "WR"), pick(5, 23, "TE"),
    pick(6, 24, "WR"), pick(7, 25, "WR"), pick(8, 26, "TE"), pick(9, 27, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({ made, mySlot: 1, available });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("window reports how many picks it actually saw, not RUN_WINDOW", () => {
  // Only six picks have been made. A reason built from this must say
  // "of the last 6", never "of the last 8".
  //
  // K is 6 too (nobody's own picks are mixed in here), so the reconstructed
  // board is `available` plus these same 6 picks -- board()'s top 6 of a
  // 10 RB/20 WR/10 TE board are 2 RB, 3 WR, 1 TE, expected 2/6 = 0.3333.
  // Observed 5/6 = 0.8333 clears 0.3333 * 1.75 = 0.5833. Fires.
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "RB"), pick(4, 3, "RB"), pick(5, 4, "RB"),
    pick(6, 5, "RB"), pick(7, 6, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({ made, mySlot: 1, available });

  assert.deepStrictEqual(runs.get("RB"), { count: 5, window: 6 });
});

test("a position absent from the reconstructed board's best K is a run", () => {
  // The board never offers RB in its top 8 (there are none on it at all), so
  // expected is 0 -- but 5 of the window's 8 other-team picks were RB, the
  // strongest possible departure. This position ONLY fires because expected
  // is 0, not despite it: a board with no opinion on a position that is
  // nonetheless flying off the shelf is exactly what a run looks like. (This
  // pins the fix for the finding that used to assert the opposite here --
  // that the old `if (left === 0) continue;` guard from the deleted
  // startable model should stay dead: an expected share of 0 must fire, not
  // be skipped.)
  const available = board({ WR: 20, TE: 10 }); // no RBs left at all
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "RB"), pick(4, 3, "RB"), pick(5, 4, "RB"),
    pick(6, 5, "RB"), pick(7, 6, "WR"), pick(8, 7, "WR"), pick(9, 8, "TE"),
  ];
  const runs = detectRuns({ made, mySlot: 1, available });

  assert.deepStrictEqual(runs.get("RB"), { count: 5, window: 8 });
});

test("no picks yet means no runs, and does not throw", () => {
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({ made: [], mySlot: 1, available });

  assert.strictEqual(runs.size, 0);
});

// The only other test aimed at the RUN_MULTIPLE threshold uses a count of 2,
// which is below RUN_MIN_COUNT (3) and short-circuits via `continue` before
// the ratio is ever evaluated -- so it can't tell whether RUN_MULTIPLE itself
// is doing anything. This test clears RUN_MIN_COUNT and puts the observed
// share strictly BETWEEN expected and expected * RUN_MULTIPLE, so it isolates
// the multiplier: it fires if and only if RUN_MULTIPLE is weak enough to pull
// the threshold down to (or below) 0.375.
test("a share between expected and expected * RUN_MULTIPLE is not a run (isolates RUN_MULTIPLE)", () => {
  // 3 of the last 8 picks by others are RB -- at RUN_MIN_COUNT, not below it.
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "WR"), pick(4, 3, "RB"), pick(5, 4, "WR"),
    pick(6, 5, "RB"), pick(7, 6, "TE"), pick(8, 7, "WR"), pick(9, 8, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({ made, mySlot: 1, available });

  // expected = 10/40 = 0.25. observed = 3/8 = 0.375, which is above expected
  // (so it IS a departure) but below expected * 1.75 = 0.4375 (so it does not
  // clear the RUN_MULTIPLE bar). 0.375 sits comfortably at the midpoint of
  // that gap, not against either edge.
  assert.strictEqual(runs.get("RB"), undefined);
});

// Every RUN_MULTIPLE-focused fixture above pairs a low observed share with a
// low count, so it can't tell whether RUN_MIN_COUNT is doing anything: lower
// the minimum and the ratio still blocks those fixtures on its own. This is
// the shape only RUN_MIN_COUNT gates -- a count below the minimum, paired
// with a ratio that clears RUN_MULTIPLE by a wide margin.
test("a low count that clears RUN_MULTIPLE by a wide margin is still not a run (isolates RUN_MIN_COUNT)", () => {
  // Only two picks have been made, by others, both RB. window.length = 2,
  // count = 2 -- below RUN_MIN_COUNT (3). Observed 2/2 = 1.0 against expected
  // 10/40 = 0.25 clears expected * RUN_MULTIPLE (0.4375) by a wide margin
  // (128% over), so nothing but the minimum count is holding this back.
  const made = [pick(2, 1, "RB"), pick(3, 2, "RB")];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({ made, mySlot: 1, available });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("mySlot null counts every pick as someone else's -- nothing to exclude as your own", () => {
  // No known seat for the user (e.g. the board is being read before the user
  // has joined a seat) means detectRuns cannot exclude anything as "your own
  // pick," so all 8 made picks count toward both the window and the count --
  // including the 5 credited to team 1, who would be filtered out if mySlot
  // were 1.
  const made = [
    pick(1, 1, "RB"), pick(1, 2, "RB"), pick(1, 3, "RB"), pick(1, 4, "RB"),
    pick(1, 5, "RB"), pick(2, 6, "RB"), pick(3, 7, "WR"), pick(4, 8, "TE"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({ made, mySlot: null, available });

  // 6 RB of 8 = 0.75 observed. K is 8 (nothing is excluded as "your own" with
  // mySlot null, so takenSince is the same 8 picks as the window). The
  // reconstructed top 8 of a 10 RB/20 WR/10 TE board are 2 RB, 4 WR, 2 TE,
  // expected 2/8 = 0.25, threshold 0.4375. 0.75 clears it comfortably.
  assert.deepStrictEqual(runs.get("RB"), { count: 6, window: 8 });
});

test("picks that match the board are not a run", () => {
  // The board's best eight when these picks began were 5 RB and 3 WR, and
  // exactly 5 RB and 3 WR went. The board predicted it; there is nothing to
  // report. Under the OLD baseline this fired, because 5/8 RB observed beat
  // RB's share of the remaining startable pool.
  const made = [
    rankedPick(2, "rb1", "RB", 1), rankedPick(3, "rb2", "RB", 2),
    rankedPick(4, "wr1", "WR", 3), rankedPick(5, "rb3", "RB", 4),
    rankedPick(6, "rb4", "RB", 5), rankedPick(7, "wr2", "WR", 6),
    rankedPick(8, "rb5", "RB", 7), rankedPick(9, "wr3", "WR", 8),
  ];
  // Whatever is left is ranked below everything that just went.
  const available = ranked([
    ["te1", "TE", 9], ["te2", "TE", 10], ["qb1", "QB", 11], ["qb2", "QB", 12],
    ["wr9", "WR", 13], ["wr10", "WR", 14], ["rb9", "RB", 15], ["k1", "K", 16],
  ]);

  const runs = detectRuns({ made, mySlot: 1, available });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("picks that depart from the board are a run", () => {
  // The board's best eight were 1 TE and 7 others, and 5 TEs went. Nobody
  // taking the board's advice would have produced that.
  const made = [
    rankedPick(2, "te1", "TE", 1), rankedPick(3, "te2", "TE", 20),
    rankedPick(4, "wr1", "WR", 2), rankedPick(5, "te3", "TE", 21),
    rankedPick(6, "te4", "TE", 22), rankedPick(7, "wr2", "WR", 3),
    rankedPick(8, "te5", "TE", 23), rankedPick(9, "wr3", "WR", 4),
  ];
  const available = ranked([
    ["rb1", "RB", 5], ["rb2", "RB", 6], ["wr4", "WR", 7], ["rb3", "RB", 8],
    ["wr5", "WR", 9], ["rb4", "RB", 10], ["wr6", "WR", 11], ["rb5", "RB", 12],
  ]);

  const runs = detectRuns({ made, mySlot: 1, available });

  assert.deepStrictEqual(runs.get("TE"), { count: 5, window: 8 });
});

test("the board is reconstructed, not read live", () => {
  // THE LOAD-BEARING TEST. Five RBs went, and they were the board's five best
  // -- so this is not a run. But they are gone from `available` now, so an
  // implementation that reads the CURRENT top of the board sees zero RBs in
  // it, computes an expected RB share of 0, and fires on any observed share
  // at all. That is the factor firing on its own aftermath.
  const made = [
    rankedPick(2, "rb1", "RB", 1), rankedPick(3, "rb2", "RB", 2),
    rankedPick(4, "rb3", "RB", 3), rankedPick(5, "wr1", "WR", 4),
    rankedPick(6, "rb4", "RB", 5), rankedPick(7, "wr2", "WR", 6),
    rankedPick(8, "rb5", "RB", 7), rankedPick(9, "wr3", "WR", 8),
  ];
  // Not one running back near the top of what remains.
  const available = ranked([
    ["wr4", "WR", 9], ["wr5", "WR", 10], ["te1", "TE", 11], ["wr6", "WR", 12],
    ["qb1", "QB", 13], ["wr7", "WR", 14], ["te2", "TE", 15], ["qb2", "QB", 16],
    ["rb9", "RB", 80], ["rb10", "RB", 81],
  ]);

  const runs = detectRuns({ made, mySlot: 1, available });

  assert.strictEqual(
    runs.get("RB"),
    undefined,
    "reading the live board would make this fire on its own aftermath"
  );
});

test("an unranked reconstruction can't form a trustworthy top-K, so it stays silent", () => {
  // Nothing here carries a rank at all -- neither the 8 still-available
  // players nor the 8 taken since the window began. `compareRank` ties every
  // unranked pair, and a stable sort leaves ties in their original
  // `[...available, ...takenSince]` order, so `takenSince` sorts entirely
  // below `available` and contributes nothing to `bestK`: reading
  // `boardThen.slice(0, K)` degenerates into a literal read of `available`,
  // i.e. the LIVE board. `available` was built with no RB at all -- as it
  // would be, once RB is the position that just got heavily drafted -- so
  // that live read computes an expected RB share of 0 and fires on the 5/8
  // observed. The guard's job is to notice `available`'s 0 ranked players
  // plus `takenSince`'s 0 ranked players can't form a trustworthy top 8 and
  // decline to speak instead.
  const available = [
    { id: "a1", position: "WR" }, { id: "a2", position: "WR" },
    { id: "a3", position: "TE" }, { id: "a4", position: "TE" },
    { id: "a5", position: "WR" }, { id: "a6", position: "WR" },
    { id: "a7", position: "TE" }, { id: "a8", position: "WR" },
  ];
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "RB"), pick(4, 3, "RB"), pick(5, 4, "RB"),
    pick(6, 5, "RB"), pick(7, 6, "WR"), pick(8, 7, "WR"), pick(9, 8, "TE"),
  ];
  const runs = detectRuns({ made, mySlot: 1, available });

  assert.strictEqual(
    runs.get("RB"),
    undefined,
    "without the finite-rank guard this reads like the live board and fires"
  );
});

test("the user's own interleaved picks widen K past window.length", () => {
  // K counts picks by ANY seat since the window began; the window (and its
  // count) only ever counts other teams'. Every other fixture in this file
  // has K === window.length, so it can't tell K's slice from window.length's.
  // Here two of the user's own picks (mine1, mine2) land inside the window's
  // span, so K is 10 while window.length stays 8 -- and the reconstructed
  // board's best 10 is a genuinely bigger, differently-shared slice than its
  // best 8.
  //
  // The other-team picks (o1..o8) are 5 RB, 3 WR -- observed 5/8 = 0.625,
  // same as the other RB-run fixtures. The reconstructed board is ranked so
  // that:
  //   - top 8  (ranks 1-8):  2 RB, 6 WR -- expected 2/8  = 0.25, threshold 0.4375
  //   - top 10 (ranks 1-10): 4 RB, 6 WR -- expected 4/10 = 0.4,  threshold 0.7
  // At the correct K = 10, 0.625 does not clear 0.7: no run. Using
  // window.length (8) for both the slice and the denominator instead of K --
  // one of the two mutations the finding names -- would compute the top-8
  // numbers instead, clear 0.4375, and fire. That's the bug this pins.
  const wrA1 = { id: "wrA1", position: "WR", rank: 1 };
  const wrA2 = { id: "wrA2", position: "WR", rank: 3 };
  const available = [wrA1, wrA2];

  const o1 = rankedPick(2, "o1", "RB", 2);
  const mine1 = rankedPick(1, "mine1", "WR", 4);
  const o6 = rankedPick(7, "o6", "WR", 5);
  const o7 = rankedPick(8, "o7", "WR", 6);
  const o8 = rankedPick(9, "o8", "WR", 7);
  const o2 = rankedPick(3, "o2", "RB", 8);
  const o3 = rankedPick(4, "o3", "RB", 9);
  const o4 = rankedPick(5, "o4", "RB", 10);
  // Unranked: irrelevant to the top-10 reconstruction, but still counted in
  // the window (o5) and still correctly excluded as the user's own (mine2).
  const o5 = pick(6, "o5", "RB");
  const mine2 = pick(1, "mine2", "WR");

  const made = [o1, mine1, o2, mine2, o3, o4, o5, o6, o7, o8];
  const runs = detectRuns({ made, mySlot: 1, available });

  assert.strictEqual(
    runs.get("RB"),
    undefined,
    "using window.length instead of K would fire on the top-8 numbers"
  );
});
