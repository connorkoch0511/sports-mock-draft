const test = require("node:test");
const assert = require("node:assert");

const { autoPickAndAdvance } = require("./autoPick");

// A unit-level pool, passed straight in via the `pool` param so these tests
// never touch loadPlayersForSport's QueryCommand -- what is being proven
// here is which id autoPickAndAdvance chooses, not how the pool is loaded.
// Shapes match what loadPlayersForSport would have produced: a flat `rank`
// number (already resolved for format), not the nested `{standard: N}} the
// players table stores it as.
//
//   board-pick   -- the board's clear favorite (rank 1), so any test that
//                   expects the board's answer expects this id.
//   queued-guy   -- ranked far worse (50) than board-pick, so picking him
//                   over board-pick can only be the queue's doing.
//   taken-guy    -- ranked well (2), used as the queue entry that gets
//                   filtered out because he's already gone.
//   some-kicker  -- a K, ranked well enough on paper but subject to the
//                   roster guard's -20000 kDef penalty until late.
const POOL_PLAYERS = [
  { id: "board-pick", name: "Board Pick", position: "RB", team: "AAA", rank: 1 },
  { id: "queued-guy", name: "Queued Guy", position: "WR", team: "BBB", rank: 50 },
  { id: "taken-guy", name: "Taken Guy", position: "WR", team: "CCC", rank: 2 },
  { id: "some-kicker", name: "Some Kicker", position: "K", team: "DDD", rank: 3 },
];
const POOL = {
  players: POOL_PLAYERS,
  byId: Object.fromEntries(POOL_PLAYERS.map((p) => [p.id, p])),
};

// advanceDraft's happy path is a single UpdateCommand; nothing here exercises
// a race or a pause, so a fake that always succeeds is enough. loadBoardRank
// is never reached either -- every draft below leaves boardId unset on both
// the seat and the draft, so boardIdForTeam resolves to null and
// loadBoardRank short-circuits before it would call ddb.send.
const fakeDdb = { send: async () => ({}) };

/**
 * A single-team, 30-pick draft whose only seat carries `queue`. Long (30,
 * not the usual handful) so that at currentIndex 24 the team still has 6
 * picks left -- comfortably more than kDefBlocked's "starters needed + 1"
 * threshold (2 + 1 = 3 with the default roster), so the roster guard is
 * still ACTIVE there. That's the point of the round-three kicker test below:
 * it has to catch a guard that would otherwise refuse the kicker, not one
 * that had already stood down.
 */
function draftWithSeat({ queue = [], picked = [], currentIndex = 0 } = {}) {
  return {
    draftId: "d1",
    sport: "nfl",
    format: "standard",
    picks: Array.from({ length: 30 }, (_, i) => ({ overall: i + 1, round: i + 1, team: 1 })),
    picked,
    currentIndex,
    version: 1,
    seats: [{ team: 1, kind: "human", sub: "user-me", queue }],
  };
}

const deps = {
  ddb: fakeDdb,
  draftId: "d1",
  playersTable: "players-test",
  draftsTable: "drafts-test",
  boardsTable: "boards-test",
  pool: POOL,
};

test("the clock takes the first queued player, ignoring the board", async () => {
  const d = draftWithSeat({ queue: ["queued-guy"] });
  const r = await autoPickAndAdvance({ ...deps, d });
  assert.strictEqual(r.picked.id, "queued-guy");
});

// The companion, so the test above cannot pass by accident: the same
// fixture with no queue must still pick by board.
test("an empty queue still picks by board", async () => {
  const d = draftWithSeat({ queue: [] });
  const r = await autoPickAndAdvance({ ...deps, d });
  assert.notStrictEqual(r.picked.id, "queued-guy");
});

test("a queued player already drafted is skipped for the next one", async () => {
  const d = draftWithSeat({ queue: ["taken-guy", "queued-guy"], picked: ["taken-guy"] });
  const r = await autoPickAndAdvance({ ...deps, d });
  assert.strictEqual(r.picked.id, "queued-guy");
});

// Deliberate: the roster guard refuses kickers early so the picker cannot
// wreck a roster while GUESSING. A queue is not a guess. Without this test
// somebody restores the guard and calls it a bug fix.
test("a queued kicker is drafted in round three, roster guard notwithstanding", async () => {
  const d = draftWithSeat({ queue: ["some-kicker"], currentIndex: 24 });
  const r = await autoPickAndAdvance({ ...deps, d });
  assert.strictEqual(r.picked.id, "some-kicker");
});
