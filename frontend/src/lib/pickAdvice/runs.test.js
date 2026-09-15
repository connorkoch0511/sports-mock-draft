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
