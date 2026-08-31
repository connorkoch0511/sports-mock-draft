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
