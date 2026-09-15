import test from "node:test";
import assert from "node:assert";
import { detectRuns } from "./runs.js";

// A pick that carries a player. `team` is the seat that made it.
function pick(team, id, position) {
  return { overall: 0, round: 1, team, playerId: id, player: { id, position } };
}

// startable: every id passed is startable at its position.
function startableOf(players) {
  const m = new Map();
  for (const p of players) {
    if (!m.has(p.position)) m.set(p.position, new Set());
    m.get(p.position).add(String(p.id));
  }
  return m;
}

// A board with `n` startable players at each listed position.
function board(counts) {
  const out = [];
  let id = 1000;
  for (const [position, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) out.push({ id: id++, position });
  }
  return out;
}

// A board where `startable` is a genuine subset of `available` -- for each
// position, `total` players exist on the board but only the first `startable`
// of them are startable. Unlike board()+startableOf(), this makes the two
// populations numerically different, which is the only way to catch a
// regression that computes the expected share from the wrong one.
function boardWithSubset(spec) {
  const available = [];
  const startable = new Map();
  let id = 1000;
  for (const [position, { total, startable: startCount }] of Object.entries(spec)) {
    const ids = new Set();
    for (let i = 0; i < total; i++) {
      const pid = id++;
      available.push({ id: pid, position });
      if (i < startCount) ids.add(String(pid));
    }
    startable.set(position, ids);
  }
  return { available, startable };
}

test("a position going far above its expected rate is a run", () => {
  // 8 picks by others, 5 of them RB. Observed 5/8 = 0.625.
  // Board left: 10 RB of 40 startable -> expected 0.25. 0.625 >= 0.4375. Fires.
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "RB"), pick(4, 3, "WR"), pick(5, 4, "RB"),
    pick(6, 5, "RB"), pick(7, 6, "TE"), pick(8, 7, "RB"), pick(9, 8, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

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
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

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
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("the count includes picks of players nobody would start", () => {
  // Four RBs taken, only one of them startable. The sentence this feeds has
  // to be true of the Draft Board, so all four count. Startable governs the
  // EXPECTED rate, never the observed count.
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const startable = startableOf(available);
  const made = [
    pick(2, 9001, "RB"), pick(3, 9002, "RB"), pick(4, 9003, "RB"),
    pick(5, 9004, "RB"), pick(6, 10, "WR"), pick(7, 11, "WR"),
    pick(8, 12, "TE"), pick(9, 13, "WR"),
  ];
  const runs = detectRuns({ made, mySlot: 1, available, startable });

  assert.deepStrictEqual(runs.get("RB"), { count: 4, window: 8 });
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
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("window reports how many picks it actually saw, not RUN_WINDOW", () => {
  // Only four picks have been made. A reason built from this must say
  // "of the last 4", never "of the last 8".
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "RB"), pick(4, 3, "RB"), pick(5, 4, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

  assert.deepStrictEqual(runs.get("RB"), { count: 3, window: 4 });
});

test("a position with no startable players left never runs", () => {
  // Expected share is 0, so any observed share is infinitely above it.
  // Firing here would be meaningless: there is nobody left worth the urgency.
  const available = board({ WR: 20, TE: 10 }); // no RBs left at all
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "RB"), pick(4, 3, "RB"), pick(5, 4, "RB"),
    pick(6, 5, "WR"), pick(7, 6, "WR"), pick(8, 7, "TE"), pick(9, 8, "WR"),
  ];
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("no picks yet means no runs, and does not throw", () => {
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({
    made: [], mySlot: 1, available, startable: startableOf(available),
  });

  assert.strictEqual(runs.size, 0);
});

// Every other test in this file builds `startable` with startableOf(available),
// which makes startable numerically identical to available -- so a regression
// that computed the expected share from raw `available` counts (instead of
// `startable`) would pass every one of them unchanged. This is the exact bug
// that once made scarcityFactor fire zero times on live data: only ~30 of the
// ~891 running backs on a real board are ever startable, and a share taken
// over the whole pool never looks like a departure from it.
//
// SWAPPING THE POPULATION MUST FAIL THIS TEST: if detectRuns is changed to
// divide by available counts instead of startable counts, RB's expected share
// jumps from 0.25 (10 startable of 40 startable-total) to 0.7692 (100
// available of 130 available-total), the threshold jumps from 0.4375 to
// 1.3462, and 0.625 no longer clears it. Do not "simplify" this fixture back
// to startableOf(available) -- that is precisely what makes the two
// populations indistinguishable.
test("expected rate is computed over startable, never over raw available (population split)", () => {
  // RB is a flooded position: 100 on the board, only 10 startable. WR and TE
  // are fully startable, same as every other test's fixtures.
  const { available, startable } = boardWithSubset({
    RB: { total: 100, startable: 10 },
    WR: { total: 20, startable: 20 },
    TE: { total: 10, startable: 10 },
  });
  // 5 of the last 8 picks by others are RB. Observed 5/8 = 0.625.
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "RB"), pick(4, 3, "WR"), pick(5, 4, "RB"),
    pick(6, 5, "RB"), pick(7, 6, "TE"), pick(8, 7, "RB"), pick(9, 8, "WR"),
  ];

  const runs = detectRuns({ made, mySlot: 1, available, startable });

  // Correct: expected = 10 startable RB / 40 startable total = 0.25.
  // Threshold = 0.25 * 1.75 = 0.4375. Observed 0.625 clears it comfortably
  // (43% over threshold). Using raw available instead: expected =
  // 100/130 = 0.7692, threshold = 1.3462 -- 0.625 would not come close.
  assert.deepStrictEqual(runs.get("RB"), { count: 5, window: 8 });
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
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

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
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

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
  const runs = detectRuns({
    made, mySlot: null, available, startable: startableOf(available),
  });

  // 6 RB of 8 = 0.75 observed. expected = 10/40 = 0.25, threshold = 0.4375.
  // 0.75 clears it comfortably (71% over threshold).
  assert.deepStrictEqual(runs.get("RB"), { count: 6, window: 8 });
});
