import test from "node:test";
import assert from "node:assert";
import { orderByBoard } from "./boardOrder.js";

// The players endpoint returns its pool already sorted by consensus rank,
// nulls last. These fixtures mirror that.
const POOL = [
  { id: "p1", name: "Alpha",   position: "RB", rank: 1,    adp: 1.2 },
  { id: "p2", name: "Bravo",   position: "WR", rank: 2,    adp: 2.4 },
  { id: "p3", name: "Charlie", position: "WR", rank: 3,    adp: 3.1 },
  { id: "p4", name: "Delta",   position: "TE", rank: null, adp: null },
  { id: "p5", name: "Echo",    position: "QB", rank: null, adp: null },
];

// A board that promotes Charlie to #1 and demotes Alpha to #3.
const ROWS = [
  { playerId: "p3", myRank: 1, consensusRank: 3, delta: 2 },
  { playerId: "p2", myRank: 2, consensusRank: 2, delta: 0 },
  { playerId: "p1", myRank: 3, consensusRank: 1, delta: -2 },
];

test("board players lead, in the user's order rather than consensus", () => {
  const out = orderByBoard(POOL, ROWS);
  assert.deepStrictEqual(out.slice(0, 3).map((p) => p.id), ["p3", "p2", "p1"]);
});

test("players absent from the board follow, keeping their original order", () => {
  const out = orderByBoard(POOL, ROWS);
  assert.deepStrictEqual(out.slice(3).map((p) => p.id), ["p4", "p5"]);
});

test("board players carry myRank and delta", () => {
  const out = orderByBoard(POOL, ROWS);
  assert.strictEqual(out[0].myRank, 1);
  assert.strictEqual(out[0].delta, 2);
  assert.strictEqual(out[2].myRank, 3);
  assert.strictEqual(out[2].delta, -2);
});

test("players absent from the board carry neither field", () => {
  const out = orderByBoard(POOL, ROWS);
  const off = out.find((p) => p.id === "p4");
  assert.strictEqual(off.myRank, undefined);
  assert.strictEqual(off.delta, undefined);
});

test("every player survives the merge exactly once", () => {
  const out = orderByBoard(POOL, ROWS);
  assert.strictEqual(out.length, POOL.length);
  assert.strictEqual(new Set(out.map((p) => p.id)).size, POOL.length);
});

test("null board rows return the pool untouched — the fallback contract", () => {
  const out = orderByBoard(POOL, null);
  assert.deepStrictEqual(out.map((p) => p.id), POOL.map((p) => p.id));
  assert.strictEqual(out[0].myRank, undefined);
});

test("empty board rows return the pool untouched", () => {
  const out = orderByBoard(POOL, []);
  assert.deepStrictEqual(out.map((p) => p.id), POOL.map((p) => p.id));
});

test("a board row for a player not in the pool is ignored, leaving no hole", () => {
  const rows = [...ROWS, { playerId: "ghost", myRank: 4, consensusRank: null, delta: null }];
  const out = orderByBoard(POOL, rows);
  assert.strictEqual(out.length, POOL.length);
  assert.ok(!out.some((p) => p == null));
  assert.ok(!out.some((p) => p.id === "ghost"));
});

test("an unsorted board row list is still ordered by myRank", () => {
  const shuffled = [ROWS[2], ROWS[0], ROWS[1]];
  const out = orderByBoard(POOL, shuffled);
  assert.deepStrictEqual(out.slice(0, 3).map((p) => p.id), ["p3", "p2", "p1"]);
});

test("does not mutate its inputs", () => {
  const poolSnapshot = JSON.stringify(POOL);
  const rowsSnapshot = JSON.stringify(ROWS);
  orderByBoard(POOL, ROWS);
  assert.strictEqual(JSON.stringify(POOL), poolSnapshot);
  assert.strictEqual(JSON.stringify(ROWS), rowsSnapshot);
});

// A board built for one scoring format against a pool ranked for another.
// The board covers p1 and p3; p2 and p6 are ranked in the pool but absent
// from it, which is exactly the case the old append-everything behavior
// mishandled.
const CROSS_POOL = [
  { id: "p1", name: "Alpha",   position: "RB", rank: 1 },
  { id: "p2", name: "Bravo",   position: "WR", rank: 2 },
  { id: "p3", name: "Charlie", position: "WR", rank: 3 },
  { id: "p6", name: "Foxtrot", position: "TE", rank: 4 },
  { id: "p7", name: "Golf",    position: "QB", rank: null },
];

const CROSS_ROWS = [
  { playerId: "p1", myRank: 1, consensusRank: 1, delta: 0 },
  { playerId: "p3", myRank: 3, consensusRank: 3, delta: 0 },
];

test("a ranked off-board player places by its rank, not after every board row", () => {
  const out = orderByBoard(CROSS_POOL, CROSS_ROWS);

  // p1 (board, 1), p2 (pool rank 2), p3 (board, 3), p6 (pool rank 4), p7 unranked.
  assert.deepStrictEqual(out.map((p) => p.id), ["p1", "p2", "p3", "p6", "p7"]);
});

test("an unranked off-board player still sorts last", () => {
  const out = orderByBoard(CROSS_POOL, CROSS_ROWS);
  assert.strictEqual(out[out.length - 1].id, "p7");
});

test("off-board ranked players keep their order relative to each other", () => {
  // The better-ranked player sits LATER in the pool than the worse-ranked
  // one, so this only passes if the comparator sorts by rank -- preserving
  // pool arrival order would put them the other way around.
  const pool = [
    { id: "worse-rank-earlier-slot", name: "Worse", position: "RB", rank: 5 },
    { id: "better-rank-later-slot", name: "Better", position: "WR", rank: 1 },
  ];
  const rows = [{ playerId: "ghost", myRank: 1, consensusRank: null, delta: null }];

  const out = orderByBoard(pool, rows);

  const offBoard = out
    .filter((p) => p.id === "worse-rank-earlier-slot" || p.id === "better-rank-later-slot")
    .map((p) => p.id);
  assert.deepStrictEqual(offBoard, ["better-rank-later-slot", "worse-rank-earlier-slot"]);
});

test("off-board players sort by consensus rank, not their arrival order in the pool", () => {
  // Deliberately out of rank order: rank ascends as pool index descends.
  // Sorting by rank and preserving pool order produce different answers.
  const pool = [
    { id: "d", name: "D", position: "RB", rank: 4 },
    { id: "c", name: "C", position: "WR", rank: 3 },
    { id: "b", name: "B", position: "TE", rank: 2 },
    { id: "a", name: "A", position: "QB", rank: 1 },
  ];
  const rows = [{ playerId: "ghost", myRank: 1, consensusRank: null, delta: null }];

  const out = orderByBoard(pool, rows);

  assert.deepStrictEqual(out.map((p) => p.id), ["a", "b", "c", "d"]);
});

test("a tie between a board rank and a pool rank goes to the board player", () => {
  const pool = [
    { id: "off", name: "Off",   position: "WR", rank: 2 },
    { id: "on",  name: "On",    position: "RB", rank: 9 },
  ];
  const rows = [{ playerId: "on", myRank: 2, consensusRank: 9, delta: 7 }];

  const out = orderByBoard(pool, rows);

  // Both claim position 2. The user's own ranking wins.
  assert.deepStrictEqual(out.map((p) => p.id), ["on", "off"]);
});

test("a board player promoted above a better-ranked off-board player still leads", () => {
  const pool = [
    { id: "consensus-top", name: "Top",     position: "RB", rank: 1 },
    { id: "my-favourite",  name: "Sleeper", position: "WR", rank: 50 },
  ];
  const rows = [{ playerId: "my-favourite", myRank: 1, consensusRank: 50, delta: 49 }];

  const out = orderByBoard(pool, rows);

  assert.deepStrictEqual(out.map((p) => p.id), ["my-favourite", "consensus-top"]);
});

test("off-board players still carry neither myRank nor delta after interleaving", () => {
  const out = orderByBoard(CROSS_POOL, CROSS_ROWS);
  const off = out.find((p) => p.id === "p2");
  assert.strictEqual(off.myRank, undefined);
  assert.strictEqual(off.delta, undefined);
});

test("every player survives the interleave exactly once", () => {
  const out = orderByBoard(CROSS_POOL, CROSS_ROWS);
  assert.strictEqual(out.length, CROSS_POOL.length);
  assert.strictEqual(new Set(out.map((p) => p.id)).size, CROSS_POOL.length);
});

test("a player ranked after the board was built is placed, not buried", () => {
  // The nightly sync ranks someone the board predates. Same bug in miniature.
  const pool = [
    { id: "a", name: "A",     position: "RB", rank: 1 },
    { id: "new", name: "New", position: "WR", rank: 2 },
    { id: "b", name: "B",     position: "TE", rank: 3 },
  ];
  const rows = [
    { playerId: "a", myRank: 1, consensusRank: 1, delta: 0 },
    { playerId: "b", myRank: 3, consensusRank: 3, delta: 0 },
  ];

  const out = orderByBoard(pool, rows);

  assert.deepStrictEqual(out.map((p) => p.id), ["a", "new", "b"]);
});

test("all-unranked off-board players preserve pool order among themselves", () => {
  const pool = [
    { id: "on",  name: "On", position: "RB", rank: 1 },
    { id: "u1",  name: "U1", position: "WR", rank: null },
    { id: "u2",  name: "U2", position: "TE", rank: null },
  ];
  const rows = [{ playerId: "on", myRank: 1, consensusRank: 1, delta: 0 }];

  const out = orderByBoard(pool, rows);

  assert.deepStrictEqual(out.map((p) => p.id), ["on", "u1", "u2"]);
});

test("board players unranked in the draft's format still lead, in myRank order", () => {
  // A PPR board driving a standard draft: board1/board2 are unranked in
  // this pool's format (p.rank is null) but still carry an explicit
  // myRank, which must win over ranked off-board players.
  const pool = [
    { id: "board1", name: "Board1", position: "QB", rank: null },
    { id: "off1",   name: "Off1",   position: "RB", rank: 10 },
    { id: "board2", name: "Board2", position: "WR", rank: null },
    { id: "off2",   name: "Off2",   position: "TE", rank: 20 },
  ];
  const rows = [
    { playerId: "board1", myRank: 1, consensusRank: null, delta: null },
    { playerId: "board2", myRank: 2, consensusRank: null, delta: null },
  ];

  const out = orderByBoard(pool, rows);

  assert.deepStrictEqual(out.map((p) => p.id), ["board1", "board2", "off1", "off2"]);
});
