import test from "node:test";
import assert from "node:assert";
import { claimableIds, claimKey } from "./claim.js";

test("only drafts this browser created are offered", () => {
  const { draftIds } = claimableIds({
    drafts: [
      { id: "mine", owned: true },
      { id: "opened-from-a-link", owned: false },
      { id: "also-mine", owned: true },
    ],
    boards: [],
  });
  assert.deepStrictEqual(draftIds, ["mine", "also-mine"]);
});

// The board registry only ever records a board at the moment this browser
// creates one, so every entry is a creation -- there is no `owned` flag to
// consult and none is needed.
// The flag only exists from 2026-09-01. Entries older than that carry no
// `owned` at all, and requiring it to be true froze them permanently.
test("a draft remembered before the owned flag existed is still offered", () => {
  const { draftIds } = claimableIds({
    drafts: [{ id: "legacy" }, { id: "mine", owned: true }],
    boards: [],
  });
  assert.deepStrictEqual(draftIds, ["legacy", "mine"]);
});

// Only an explicit false is a refusal: that is a draft the registry recorded
// as opened from somebody else's link, after the flag existed.
test("a draft explicitly marked not-owned is still never offered", () => {
  const { draftIds } = claimableIds({
    drafts: [{ id: "theirs", owned: false }],
    boards: [],
  });
  assert.deepStrictEqual(draftIds, []);
});

test("every remembered board is offered", () => {
  const { boardIds } = claimableIds({
    drafts: [],
    boards: [{ id: "b1" }, { id: "b2" }],
  });
  assert.deepStrictEqual(boardIds, ["b1", "b2"]);
});

test("corrupt registry entries are dropped rather than sent", () => {
  const { draftIds, boardIds } = claimableIds({
    drafts: [null, { owned: true }, { id: 7, owned: true }, { id: "ok", owned: true }],
    boards: [undefined, { id: "" }, { id: "b1" }],
  });
  assert.deepStrictEqual(draftIds, ["ok"]);
  assert.deepStrictEqual(boardIds, ["b1"]);
});

test("the lists are capped at what the endpoint accepts", () => {
  const drafts = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, owned: true }));
  const { draftIds } = claimableIds({ drafts, boards: [] });
  assert.strictEqual(draftIds.length, 50);
});

test("missing lists yield empty lists, not a throw", () => {
  assert.deepStrictEqual(claimableIds({}), { draftIds: [], boardIds: [] });
});

test("the marker is per account, so a second sign-in claims its own ids", () => {
  assert.notStrictEqual(claimKey("user-a"), claimKey("user-b"));
  assert.match(claimKey("user-a"), /user-a/);
});
