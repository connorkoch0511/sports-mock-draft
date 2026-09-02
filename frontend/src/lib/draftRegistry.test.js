import test from "node:test";
import assert from "node:assert";
import { listDrafts, rememberDraft, forgetDraft } from "./draftRegistry.js";

// localStorage does not exist in Node. These modules read it at call time
// inside their functions, so a stub assigned here is picked up even though
// the import above is hoisted.
function useFakeStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return map;
}

function draft(id, extra) {
  return {
    id,
    teams: 12,
    rounds: 15,
    format: "standard",
    userTeam: 1,
    boardId: null,
    completed: false,
    ...extra,
  };
}

test("a remembered draft is listed", () => {
  useFakeStorage();
  rememberDraft(draft("d1"));

  const all = listDrafts();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].id, "d1");
  assert.strictEqual(all[0].teams, 12);
  assert.strictEqual(all[0].rounds, 15);
  assert.strictEqual(all[0].format, "standard");
  assert.strictEqual(all[0].userTeam, 1);
  assert.strictEqual(all[0].completed, false);
  assert.ok(typeof all[0].updatedAt === "number");
});

test("remembering an existing id updates in place rather than duplicating", () => {
  useFakeStorage();
  rememberDraft(draft("d1"));
  rememberDraft(draft("d1", { completed: true }));

  const all = listDrafts();
  assert.strictEqual(all.length, 1, "must not duplicate");
  assert.strictEqual(all[0].completed, true, "must reflect the newer value");
});

test("the most recently remembered draft comes first", () => {
  useFakeStorage();
  rememberDraft(draft("old"));
  rememberDraft(draft("new"));

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["new", "old"]);
});

test("re-remembering an older draft moves it to the front", () => {
  useFakeStorage();
  rememberDraft(draft("a"));
  rememberDraft(draft("b"));
  rememberDraft(draft("a"));

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["a", "b"]);
});

test("the list is capped at 50, dropping the oldest", () => {
  useFakeStorage();
  for (let i = 0; i < 55; i++) rememberDraft(draft(`d${i}`));

  const all = listDrafts();
  assert.strictEqual(all.length, 50);
  assert.strictEqual(all[0].id, "d54", "newest kept");
  assert.ok(!all.some((d) => d.id === "d0"), "oldest dropped");
});

test("forgetDraft removes only the named entry", () => {
  useFakeStorage();
  rememberDraft(draft("keep"));
  rememberDraft(draft("drop"));

  forgetDraft("drop");

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["keep"]);
});

test("forgetting an id that is not present changes nothing", () => {
  useFakeStorage();
  rememberDraft(draft("keep"));

  forgetDraft("never-existed");

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["keep"]);
});

test("a corrupt stored value yields an empty list rather than throwing", () => {
  useFakeStorage({ "perfectpick.myDrafts": "{not json" });
  assert.deepStrictEqual(listDrafts(), []);
});

test("a stored value that is not an array yields an empty list", () => {
  useFakeStorage({ "perfectpick.myDrafts": '{"id":"d1"}' });
  assert.deepStrictEqual(listDrafts(), []);
});

test("storage that throws is a silent no-op, not an exception", () => {
  globalThis.localStorage = {
    getItem() { throw new Error("storage unavailable"); },
    setItem() { throw new Error("storage unavailable"); },
  };

  assert.doesNotThrow(() => rememberDraft(draft("d1")));
  assert.doesNotThrow(() => forgetDraft("d1"));
  assert.deepStrictEqual(listDrafts(), []);
});

test("a stored array containing null yields only the usable entries", () => {
  useFakeStorage({
    "perfectpick.myDrafts": JSON.stringify([draft("d1"), null]),
  });

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["d1"]);
});

test("a stored array containing a string or number element yields only the usable entries", () => {
  useFakeStorage({
    "perfectpick.myDrafts": JSON.stringify([draft("d1"), "oops", 42]),
  });

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["d1"]);
});

test("a stored array containing an object with no id yields only the usable entries", () => {
  useFakeStorage({
    "perfectpick.myDrafts": JSON.stringify([draft("d1"), { teams: 12 }]),
  });

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["d1"]);
});

test("a usable entry missing optional fields is still returned", () => {
  const { boardId: _boardId, ...withoutBoardId } = draft("d1");
  useFakeStorage({
    "perfectpick.myDrafts": JSON.stringify([withoutBoardId]),
  });

  const all = listDrafts();
  assert.strictEqual(all.length, 1, "must not be dropped for lacking boardId");
  assert.strictEqual(all[0].id, "d1");
  assert.strictEqual(all[0].boardId, undefined);
});

test("a fully valid list round-trips unchanged", () => {
  useFakeStorage();
  rememberDraft(draft("a"));
  rememberDraft(draft("b"));

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["b", "a"]);
});

test("rememberDraft defaults to owned:false when not specified", () => {
  useFakeStorage();
  rememberDraft(draft("d1"));

  assert.strictEqual(listDrafts()[0].owned, false);
});

test("rememberDraft honors an explicit owned:true", () => {
  useFakeStorage();
  rememberDraft(draft("d1", { owned: true }));

  assert.strictEqual(listDrafts()[0].owned, true);
});

test("rememberDraft preserves an existing entry's owned flag through the create-then-hook-overwrite sequence", () => {
  useFakeStorage();
  // NewDraft.jsx marks ownership at the moment of creation, the only place
  // that knows the draft is new.
  rememberDraft(draft("d1", { owned: true }));
  // The draft page loads moments later; its useRememberDraft effect fires
  // and calls rememberDraft again for the same id WITHOUT an owned field --
  // this call shape matches useRememberDraft.js exactly. rememberDraft is a
  // full replace, not a merge, so if the owned flag were not carried
  // forward here it would be erased immediately and the whole fix would
  // silently do nothing.
  rememberDraft(draft("d1", { completed: true }));

  const all = listDrafts();
  assert.strictEqual(all.length, 1, "must not duplicate");
  assert.strictEqual(all[0].owned, true, "owned must survive the hook's overwrite");
  assert.strictEqual(all[0].completed, true, "the hook's own update must still apply");
});

test("rememberDraft without owned defaults to false for a brand-new id (no existing entry to preserve)", () => {
  useFakeStorage();
  rememberDraft(draft("never-seen-before"));

  assert.strictEqual(listDrafts()[0].owned, false);
});

test("a legacy entry stored with no owned key at all reads as falsy, not throwing", () => {
  const legacy = draft("d1"); // draft() never sets `owned` unless asked
  useFakeStorage({ "perfectpick.myDrafts": JSON.stringify([legacy]) });

  assert.ok(!listDrafts()[0].owned, "a pre-fix stored entry must read as not owned");
});

test("the board registry's store is left alone", () => {
  const map = useFakeStorage({ "perfectpick.myBoards": '[{"id":"b1","name":"My Board"}]' });
  rememberDraft(draft("d1"));

  assert.strictEqual(
    map.get("perfectpick.myBoards"),
    '[{"id":"b1","name":"My Board"}]',
    "drafts must not write to the boards key"
  );
});
