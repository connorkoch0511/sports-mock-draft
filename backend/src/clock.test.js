const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");

process.env.DRAFTS_TABLE = "drafts-test";
process.env.PLAYERS_TABLE = "players-test";
process.env.BOARDS_TABLE = "boards-test";

const { PICK_MS } = require("./lib/advance");
const { handler } = require("./clock");

test.afterEach(() => mock.restoreAll());

// These tests drive the REAL autoPickAndAdvance and the REAL advanceDraft
// against a fake DynamoDB, and that is the whole point of the file.
//
// The previous version mocked `autoPick.autoPickAndAdvance` and had the mock
// set `pickDeadline = Date.now() - 1000` after every pick. No real code path
// has ever produced that value: advanceDraft writes a deadline in the FUTURE.
// So the drain looked drained while, against the real write, it made exactly
// one pick and stopped -- the bug the drain exists to prevent, hidden by a
// test that mocked the very write whose value the loop reads. A test may not
// mock the thing it is asserting about.

/** Nine players, ranked 1..9, enough for any draft these tests run. */
const POOL = [
  { sport: "nfl", playerId: "p1", id: "p1", name: "One", position: "RB", team: "AAA", rank: { standard: 1 } },
  { sport: "nfl", playerId: "p2", id: "p2", name: "Two", position: "WR", team: "BBB", rank: { standard: 2 } },
  { sport: "nfl", playerId: "p3", id: "p3", name: "Three", position: "RB", team: "CCC", rank: { standard: 3 } },
  { sport: "nfl", playerId: "p4", id: "p4", name: "Four", position: "WR", team: "DDD", rank: { standard: 4 } },
  { sport: "nfl", playerId: "p5", id: "p5", name: "Five", position: "QB", team: "EEE", rank: { standard: 5 } },
  { sport: "nfl", playerId: "p6", id: "p6", name: "Six", position: "TE", team: "FFF", rank: { standard: 6 } },
  { sport: "nfl", playerId: "p7", id: "p7", name: "Seven", position: "RB", team: "GGG", rank: { standard: 7 } },
  { sport: "nfl", playerId: "p8", id: "p8", name: "Eight", position: "WR", team: "HHH", rank: { standard: 8 } },
  { sport: "nfl", playerId: "p9", id: "p9", name: "Nine", position: "QB", team: "III", rank: { standard: 9 } },
];

/** A draft `n` picks from done whose deadline passed `ms` ago. */
function dueDraft(id, n, ms) {
  return {
    draftId: id,
    sport: "nfl",
    format: "standard",
    picks: Array.from({ length: n }, (_, i) => ({ overall: i + 1, round: 1, team: (i % 2) + 1 })),
    picked: [],
    currentIndex: 0,
    pickDeadline: Date.now() - ms,
    clockRunning: "1",
    version: 1,
    seats: [{ team: 1, kind: "human", sub: "user-me" }],
  };
}

function conditionalCheckFailed() {
  const e = new Error("The conditional request failed");
  e.name = "ConditionalCheckFailedException";
  return e;
}

/**
 * A fake DynamoDB that is honest about the two things these tests depend on:
 * it stores what an UpdateCommand writes, and it enforces the
 * ConditionExpressions the code relies on. Gets return a deep copy, because
 * the real thing does and because handing out the stored object would let a
 * caller's in-memory mutation satisfy the very condition it is being tested
 * against.
 */
function installDdb({ store, due = [], players = POOL, onUpdate } = {}) {
  const seen = { queries: [], updates: [], gets: 0 };
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    // Yield to the event loop once per command. Without this, a mutated-away
    // loop guard makes the drain spin on an unbroken chain of already-
    // resolved promises -- pure microtasks, no macrotask boundary -- which
    // starves node:test's timer-based per-test timeout and lets the loop run
    // until the process dies of OOM instead of failing at the test's
    // timeout. Do not remove this thinking it's dead code.
    await new Promise((r) => setImmediate(r));

    const input = cmd.input;
    const kind = cmd.constructor.name;

    if (kind === "QueryCommand" && input.IndexName === "byClock") {
      seen.queries.push(input);
      return { Items: due.map((draftId) => ({ draftId })) };
    }
    if (kind === "QueryCommand" && input.TableName === "players-test") {
      return { Items: players };
    }
    if (kind === "GetCommand" && input.TableName === "boards-test") return {};
    if (kind === "GetCommand") {
      seen.gets += 1;
      const item = store[input.Key.draftId];
      if (item instanceof Error) throw item;
      return item ? { Item: structuredClone(item) } : {};
    }
    if (kind === "UpdateCommand") {
      seen.updates.push(input);
      if (onUpdate) onUpdate(store, input);
      const item = store[input.Key.draftId];
      const v = input.ExpressionAttributeValues || {};
      const cond = input.ConditionExpression || "";
      if (!item) throw conditionalCheckFailed();
      if (cond.includes("currentIndex = :expected")) {
        if (item.currentIndex !== v[":expected"]) throw conditionalCheckFailed();
      }
      if (cond.includes("attribute_not_exists(pausedAt)") && item.pausedAt) {
        throw conditionalCheckFailed();
      }
      if (cond === "currentIndex >= size(picks)" && !(item.currentIndex >= item.picks.length)) {
        throw conditionalCheckFailed();
      }
      if (cond === "attribute_exists(pausedAt)" && !item.pausedAt) {
        throw conditionalCheckFailed();
      }
      if (":p" in v) item.picks = v[":p"];
      if (":k" in v) item.picked = v[":k"];
      if (":i" in v) item.currentIndex = v[":i"];
      if (":d" in v) item.pickDeadline = v[":d"];
      if (/REMOVE clockRunning/.test(input.UpdateExpression)) delete item.clockRunning;
      if (":run" in v) item.clockRunning = v[":run"];
      return {};
    }
    return {};
  });
  return seen;
}

/** Every deadline the run wrote, in order. */
function deadlinesWritten(seen) {
  return seen.updates
    .filter((u) => u.ExpressionAttributeValues && ":d" in u.ExpressionAttributeValues)
    .map((u) => u.ExpressionAttributeValues[":d"]);
}

test("the run asks the index for exactly the drafts that are due", async () => {
  const store = {};
  const seen = installDdb({ store, due: [] });
  const before = Date.now();
  await handler();
  assert.equal(seen.queries.length, 1);
  const q = seen.queries[0];
  assert.equal(q.IndexName, "byClock");
  // `<` and not `<=` or `>`: an ascending range read of overdue drafts. A `>`
  // here would return every draft that is NOT due and pick for none of them,
  // and no other test in this file would notice.
  assert.equal(q.KeyConditionExpression, "clockRunning = :run AND pickDeadline < :now");
  assert.equal(q.ExpressionAttributeValues[":run"], "1");
  assert.ok(q.ExpressionAttributeValues[":now"] >= before);
  // Without a Limit one run could pull the whole index into a 60s Lambda.
  assert.equal(q.Limit, 25);
});

test("a long-overdue draft is drained, not advanced once", async () => {
  const store = { d1: dueDraft("d1", 3, 600000) };
  installDdb({ store, due: ["d1"] });
  const out = await handler();
  assert.equal(out.picks, 3);
  assert.equal(out.advanced, 1);
  assert.equal(store.d1.currentIndex, 3);
  // The write that completed the draft took it out of the index for good.
  assert.equal(store.d1.clockRunning, undefined);
});

test("catch-up consumes the missed slots: one pick per elapsed minute", async () => {
  // 2.5 minutes overdue, so three picks: the first two land on deadlines
  // still in the past, the third lands 30s in the future and the drain stops.
  const overdueBy = 150000;
  const store = { d1: dueDraft("d1", 8, overdueBy) };
  const t0 = store.d1.pickDeadline;
  const seen = installDdb({ store, due: ["d1"] });

  const out = await handler();

  assert.equal(out.picks, 3);
  // The exact regression proof. Under the old behaviour every pick wrote
  // `Date.now() + PICK_MS` -- always in the future -- so the loop made ONE
  // pick and exited, and these three walking values could not occur.
  assert.deepEqual(deadlinesWritten(seen), [t0 + PICK_MS, t0 + 2 * PICK_MS, t0 + 3 * PICK_MS]);
  assert.ok(store.d1.pickDeadline > Date.now(), "the drain stops at the present, not before it");
  assert.equal(store.d1.currentIndex, 3);
  // Not finished, so it stays in the index for the rest of its picks.
  assert.equal(store.d1.clockRunning, "1");
});

test("the pool is loaded once per drain, not once per pick", async () => {
  const store = { d1: dueDraft("d1", 4, 600000) };
  let poolReads = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    const input = cmd.input;
    const kind = cmd.constructor.name;
    if (kind === "QueryCommand" && input.IndexName === "byClock") {
      return { Items: [{ draftId: "d1" }] };
    }
    if (kind === "QueryCommand" && input.TableName === "players-test") {
      poolReads += 1;
      return { Items: POOL };
    }
    if (kind === "GetCommand") return { Item: structuredClone(store.d1) };
    if (kind === "UpdateCommand") {
      const v = cmd.input.ExpressionAttributeValues || {};
      store.d1.currentIndex = v[":i"];
      store.d1.picked = v[":k"];
      store.d1.picks = v[":p"];
      store.d1.pickDeadline = v[":d"];
      return {};
    }
    return {};
  });
  const out = await handler();
  assert.equal(out.picks, 4);
  assert.equal(poolReads, 1, "~3,900 rows re-read and re-sorted per pick is most of the run");
});

test("a draft whose deadline is now in the future is left alone, and stays indexed", async () => {
  const store = { d1: dueDraft("d1", 3, -30000) };
  const seen = installDdb({ store, due: ["d1"] });
  const out = await handler();
  assert.equal(out.picks, 0);
  assert.equal(out.ineligible, 1);
  assert.equal(out.evicted, 0);
  // A deadline in the future is normal, not structural: evicting here would
  // take a live draft out of the clock permanently.
  assert.equal(seen.updates.length, 0);
  assert.equal(store.d1.clockRunning, "1");
});

test("a completed draft still in the index is evicted from it", async () => {
  const done = dueDraft("d1", 2, 600000);
  done.currentIndex = 2;
  const store = { d1: done };
  const seen = installDdb({ store, due: ["d1"] });
  const out = await handler();
  assert.equal(out.picks, 0);
  assert.equal(out.evicted, 1);
  assert.equal(store.d1.clockRunning, undefined);
  const upd = seen.updates[0];
  assert.match(upd.UpdateExpression, /REMOVE clockRunning/);
  // Conditional, so a draft that changed under us is not un-indexed by a
  // stale read.
  assert.equal(upd.ConditionExpression, "currentIndex >= size(picks)");
});

test("a paused draft still in the index is evicted from it", async () => {
  const paused = dueDraft("d1", 2, 600000);
  paused.pausedAt = Date.now() - 1000;
  const store = { d1: paused };
  const seen = installDdb({ store, due: ["d1"] });
  const out = await handler();
  assert.equal(out.evicted, 1);
  assert.equal(store.d1.clockRunning, undefined);
  assert.equal(seen.updates[0].ConditionExpression, "attribute_exists(pausedAt)");
});

test("an eviction whose condition fails leaves the draft indexed", async () => {
  const done = dueDraft("d1", 2, 600000);
  done.currentIndex = 2;
  const store = { d1: done };
  const seen = installDdb({
    store,
    due: ["d1"],
    // Somebody added a round between the read and the eviction: the draft is
    // no longer complete, and un-indexing it would strand its clock.
    onUpdate: (s) => { s.d1.picks = [...s.d1.picks, { overall: 3, round: 2, team: 1 }]; },
  });
  const out = await handler();
  assert.equal(out.evicted, 0);
  assert.equal(out.ineligible, 1);
  assert.equal(store.d1.clockRunning, "1");
  assert.equal(seen.updates.length, 1);
});

test("an exhausted player pool is counted, never evicted", async () => {
  const store = { d1: dueDraft("d1", 2, 600000) };
  const seen = installDdb({ store, due: ["d1"], players: [] });
  const out = await handler();
  assert.equal(out.picks, 0);
  assert.equal(out.emptyPool, 1);
  assert.equal(out.evicted, 0);
  // Recoverable: evict and this draft is never enforced again once the
  // players table is fixed.
  assert.equal(seen.updates.length, 0);
  assert.equal(store.d1.clockRunning, "1");
});

test("losing a race to a human ends that draft's turn, not the run", { timeout: 5000 }, async () => {
  const store = { d1: dueDraft("d1", 4, 600000), d2: dueDraft("d2", 1, 600000) };
  const seen = installDdb({
    store,
    due: ["d1", "d2"],
    // A person's pick lands between our read and our write, exactly once.
    onUpdate: (s, input) => {
      if (input.Key.draftId === "d1" && s.d1.currentIndex === 0) s.d1.currentIndex = 1;
    },
  });
  const out = await handler();
  assert.equal(out.raced, 1);
  assert.equal(out.evicted, 0, "a lost race is transient; the draft must stay indexed");
  // d2 was still attempted, and finished.
  assert.equal(out.picks, 1);
  assert.equal(out.advanced, 1);
  assert.equal(store.d2.currentIndex, 1);
  assert.ok(seen.updates.some((u) => u.Key.draftId === "d2"));
});

test("a pick that races a pause is reported as paused, not as a lost race", async () => {
  const store = { d1: dueDraft("d1", 4, 600000) };
  const seen = installDdb({
    store,
    due: ["d1"],
    onUpdate: (s) => { if (!s.d1.pausedAt) s.d1.pausedAt = Date.now(); },
  });
  const out = await handler();
  assert.equal(out.picks, 0);
  assert.equal(out.raced, 0);
  // Paused is structural, so the draft leaves the index -- the second update
  // is the eviction.
  assert.equal(out.evicted, 1);
  assert.equal(store.d1.currentIndex, 0, "no pick may land on a paused draft");
  assert.equal(store.d1.clockRunning, undefined);
  assert.equal(seen.updates.length, 2);
});

test("a draft that throws does not abort the run", async () => {
  const store = { boom: new Error("table on fire"), d2: dueDraft("d2", 1, 600000) };
  installDdb({ store, due: ["boom", "d2"] });
  const out = await handler();
  assert.equal(out.failed, 1);
  assert.equal(out.picks, 1);
  assert.equal(out.advanced, 1);
});

test("picks already made are still counted when the drain then throws", async () => {
  const store = { d1: dueDraft("d1", 4, 600000) };
  let updates = 0;
  installDdb({
    store,
    due: ["d1"],
    onUpdate: () => {
      updates += 1;
      if (updates === 3) throw new Error("table on fire");
    },
  });
  const out = await handler();
  assert.equal(out.failed, 1);
  assert.equal(out.picks, 2, "two picks were made and stored before the failure");
  assert.equal(out.advanced, 1);
});

test("a draft item with no picks list is skipped, not a TypeError", async () => {
  const store = { d1: { draftId: "d1", currentIndex: 0, pickDeadline: Date.now() - 1000 } };
  const seen = installDdb({ store, due: ["d1"] });
  const out = await handler();
  assert.equal(out.failed, 0, "d.picks.length on such an item throws, and is then retried forever");
  assert.equal(out.ineligible, 1);
  assert.equal(seen.updates.length, 0);
});

test("a draft with picks but no currentIndex is malformed, not a crash", async () => {
  // `(d.currentIndex ?? 0) >= d.picks.length` treats a missing currentIndex
  // as 0 and calls this draft not-yet-complete, so it sails on toward
  // autoPickAndAdvance -- which indexes with the raw, unnormalized
  // `d.currentIndex` and throws "Cannot set properties of undefined". A
  // draft in this shape must be classified malformed and left alone, the
  // same as one with no picks array at all, matching
  // scripts/backfillClockRunning.js treating this shape as a real
  // possibility rather than corruption.
  const store = {
    d1: {
      draftId: "d1",
      sport: "nfl",
      format: "standard",
      picks: [{ overall: 1, round: 1, team: 1 }, { overall: 2, round: 1, team: 2 }],
      pickDeadline: Date.now() - 1000,
      clockRunning: "1",
    },
  };
  const seen = installDdb({ store, due: ["d1"] });
  const out = await handler();
  assert.equal(out.failed, 0, "a currentIndex-less draft must not throw");
  assert.equal(out.picks, 0);
  assert.equal(out.ineligible, 1);
  assert.equal(out.evicted, 0, "malformed is not structural; the draft stays indexed for a fix");
  assert.equal(seen.updates.length, 0);
  assert.equal(store.d1.clockRunning, "1");
});

test("the wall-clock budget stops new drafts being started", async () => {
  const store = { d1: dueDraft("d1", 1, 600000), d2: dueDraft("d2", 1, 600000) };
  installDdb({ store, due: ["d1", "d2"] });
  let started = false;
  const context = {
    getRemainingTimeInMillis: () => {
      if (!started) { started = true; return 60000; }
      return store.d1.currentIndex > 0 ? 1000 : 60000;
    },
  };
  const out = await handler({}, context);
  assert.equal(out.advanced, 1);
  // Two units of left-over work this tick, not one: d2 never started (the
  // outer loop's own budget check), and d1's own drain also reported
  // "budget" on the iteration right after its pick -- the loop rechecks
  // budget before it rereads the draft to notice it finished, so from the
  // run's point of view d1's drain was cut short too, even though the next
  // tick will find it complete.
  assert.equal(out.deferred, 2);
  assert.equal(store.d2.currentIndex, 0);
});

test("the drain budget stops mid-draft, not just between drafts", { timeout: 5000 }, async () => {
  // Long overdue with picks to spare: a drain with no budget check keeps
  // going until the draft is finished.
  const store = { d1: dueDraft("d1", 5, 600000) };
  installDdb({ store, due: ["d1"] });
  const context = { getRemainingTimeInMillis: () => (store.d1.currentIndex === 0 ? 60000 : 1000) };
  const out = await handler({}, context);
  assert.equal(out.picks, 1);
  assert.equal(out.advanced, 1);
  assert.equal(store.d1.currentIndex, 1);
  // A drain that made a pick and then ran out of budget is still truncated
  // work, not a clean stop -- `deferred` is the number an operator reads to
  // know whether a run left anything behind, and it must say so here even
  // though `picks` is nonzero.
  assert.equal(out.deferred, 1, "a budget-truncated drain must count as deferred even after picking");
});

test("a budget-truncated drain counts as deferred no matter how many picks it made first", { timeout: 5000 }, async () => {
  const store = { d1: dueDraft("d1", 5, 600000) };
  installDdb({ store, due: ["d1"] });
  const context = { getRemainingTimeInMillis: () => (store.d1.currentIndex < 2 ? 60000 : 1000) };
  const out = await handler({}, context);
  assert.equal(out.picks, 2);
  assert.equal(out.advanced, 1);
  assert.equal(out.deferred, 1);
});
