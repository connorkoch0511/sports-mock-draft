import test from "node:test";
import assert from "node:assert";
import { picksForSlot, largestGap } from "./snake.js";

test("slot 1 in a 12-team snake gets picks 1 and 24", () => {
  const picks = picksForSlot(1, 12, 3);
  assert.deepStrictEqual(picks, [1, 24, 25]);
});

test("slot 3 in a 12-team snake", () => {
  const picks = picksForSlot(3, 12, 3);
  assert.deepStrictEqual(picks, [3, 22, 27]);
});

test("last slot picks back-to-back at the turn", () => {
  const picks = picksForSlot(12, 12, 2);
  assert.deepStrictEqual(picks, [12, 13]);
});

test("one round yields exactly one pick", () => {
  assert.deepStrictEqual(picksForSlot(5, 10, 1), [5]);
});

test("largestGap finds the longest wait between picks", () => {
  assert.strictEqual(largestGap([3, 22, 27]), 19);
});

test("largestGap of a single pick is zero", () => {
  assert.strictEqual(largestGap([7]), 0);
});
