const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");

process.env.DRAFTS_TABLE = "drafts-test";
process.env.PLAYERS_TABLE = "players-test";
process.env.BOARDS_TABLE = "boards-test";

const autoPick = require("./lib/autoPick");
const { handler } = require("./clock");

test.afterEach(() => mock.restoreAll());

/** A draft that is `n` picks from done, with its deadline `ms` in the past. */
function dueDraft(id, n, ms) {
  return {
    draftId: id,
    picks: Array.from({ length: n }, (_, i) => ({ team: (i % 2) + 1 })),
    picked: [],
    currentIndex: 0,
    pickDeadline: Date.now() - ms,
    seats: [{ team: 1, kind: "human", sub: "user-me" }],
  };
}

test("a long-overdue draft is drained, not advanced once", async () => {
  const d = dueDraft("d1", 3, 600000);
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.IndexName === "byClock") return { Items: [{ draftId: "d1" }] };
    return { Item: d };
  });
  // Each call advances the draft the way the real one does, leaving the new
  // deadline in the past until the draft runs out of picks.
  mock.method(autoPick, "autoPickAndAdvance", async ({ d: draft }) => {
    draft.currentIndex += 1;
    draft.pickDeadline = Date.now() - 1000;
    return { ok: true, picked: { id: "p" } };
  });
  const out = await handler();
  assert.equal(out.picks, 3);
  assert.equal(out.advanced, 1);
});

test("a draft whose deadline is now in the future is left alone", async () => {
  const d = dueDraft("d1", 3, 600000);
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.IndexName === "byClock") return { Items: [{ draftId: "d1" }] };
    return { Item: d };
  });
  mock.method(autoPick, "autoPickAndAdvance", async ({ d: draft }) => {
    draft.currentIndex += 1;
    draft.pickDeadline = Date.now() + 60000;
    return { ok: true, picked: { id: "p" } };
  });
  const out = await handler();
  assert.equal(out.picks, 1);
});

test("losing a race to a human ends that draft's turn, not the run", { timeout: 5000 }, async () => {
  const drafts = {
    d1: dueDraft("d1", 2, 600000),
    d2: dueDraft("d2", 2, 600000),
  };
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.IndexName === "byClock") {
      return { Items: [{ draftId: "d1" }, { draftId: "d2" }] };
    }
    const draftId = cmd.input.Key.draftId;
    return { Item: drafts[draftId] };
  });
  let calls = 0;
  mock.method(autoPick, "autoPickAndAdvance", async ({ draftId, d: draft }) => {
    calls += 1;
    if (draftId === "d1") return { ok: false, code: "race", error: "Somebody just picked" };
    draft.currentIndex += 1;
    draft.pickDeadline = Date.now() + 60000;
    return { ok: true, picked: { id: "p" } };
  });
  const out = await handler();
  assert.equal(calls, 2, "d2 must still be attempted after d1 loses its race");
  assert.equal(out.picks, 1);
  assert.equal(out.skipped, 1);
});

test("a draft that throws does not abort the run", async () => {
  const drafts = {
    d2: dueDraft("d2", 1, 600000),
  };
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.IndexName === "byClock") {
      return { Items: [{ draftId: "boom" }, { draftId: "d2" }] };
    }
    if (cmd.input.Key.draftId === "boom") throw new Error("table on fire");
    return { Item: drafts[cmd.input.Key.draftId] };
  });
  mock.method(autoPick, "autoPickAndAdvance", async ({ d: draft }) => {
    draft.currentIndex += 1;
    draft.pickDeadline = Date.now() + 60000;
    return { ok: true, picked: { id: "p" } };
  });
  const out = await handler();
  assert.equal(out.picks, 1);
  assert.equal(out.skipped, 1);
});

test("the wall-clock budget stops new drafts being started", async () => {
  const drafts = {
    d1: dueDraft("d1", 1, 600000),
    d2: dueDraft("d2", 1, 600000),
  };
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.IndexName === "byClock") {
      return { Items: [{ draftId: "d1" }, { draftId: "d2" }] };
    }
    const draftId = cmd.input.Key.draftId;
    return { Item: drafts[draftId] };
  });
  let picksMade = 0;
  mock.method(autoPick, "autoPickAndAdvance", async ({ d: draft }) => {
    picksMade += 1;
    draft.currentIndex += 1;
    draft.pickDeadline = Date.now() + 60000;
    return { ok: true, picked: { id: "p" } };
  });
  // Plenty of budget when the first draft starts, spent by the time the
  // second is considered: the first draft runs, the second is deferred.
  const context = { getRemainingTimeInMillis: () => (picksMade === 0 ? 60000 : 1000) };
  const out = await handler({}, context);
  assert.equal(out.advanced, 1);
  assert.equal(out.deferred, 1);
});

test("the drain budget stops mid-draft, not just between drafts", { timeout: 5000 }, async () => {
  const d = dueDraft("d1", 5, 600000);
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.IndexName === "byClock") return { Items: [{ draftId: "d1" }] };
    return { Item: d };
  });
  let picksMade = 0;
  mock.method(autoPick, "autoPickAndAdvance", async ({ d: draft }) => {
    picksMade += 1;
    draft.currentIndex += 1;
    // Still overdue, so a drain with no budget check would keep going.
    draft.pickDeadline = Date.now() - 1000;
    return { ok: true, picked: { id: "p" } };
  });
  // Healthy budget for the first pick, spent immediately after: the drain
  // must stop after one pick instead of draining all five.
  const context = { getRemainingTimeInMillis: () => (picksMade === 0 ? 60000 : 1000) };
  const out = await handler({}, context);
  assert.equal(out.picks, 1);
  assert.equal(out.advanced, 1);
  assert.equal(picksMade, 1);
});
