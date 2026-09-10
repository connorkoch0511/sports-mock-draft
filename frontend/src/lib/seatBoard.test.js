import test from "node:test";
import assert from "node:assert";
import { boardOptions, boardIdFromValue, CONSENSUS } from "./seatBoard.js";

test("consensus is always offered, first", () => {
  const opts = boardOptions([], null);
  assert.equal(opts[0].value, CONSENSUS);
  assert.match(opts[0].label, /consensus/i);
});

test("your own boards are listed", () => {
  const opts = boardOptions([{ id: "b1", name: "Zero RB" }], null);
  assert.deepEqual(opts.map((o) => o.value), [CONSENSUS, "b1"]);
  assert.equal(opts[1].label, "Zero RB");
});

test("an inherited board you do not own is still offered, so the select is not blank", () => {
  // The seat inherits the draft's board, which belongs to whoever created it
  // and so is absent from your list. Without this entry the select renders
  // empty and quietly misreports what the clock will actually do.
  const opts = boardOptions([{ id: "b1", name: "Zero RB" }], "b-creator");
  assert.ok(opts.some((o) => o.value === "b-creator"));
  assert.match(opts.find((o) => o.value === "b-creator").label, /draft's board/i);
});

test("a board that IS yours is not offered twice", () => {
  const opts = boardOptions([{ id: "b1", name: "Zero RB" }], "b1");
  assert.equal(opts.filter((o) => o.value === "b1").length, 1);
});

test("an unnamed board still gets a label", () => {
  assert.equal(boardOptions([{ id: "b1" }], null)[1].label, "Untitled board");
});

test("the empty value means consensus, not 'unset'", () => {
  assert.equal(boardIdFromValue(""), null);
  assert.equal(boardIdFromValue("b1"), "b1");
});
