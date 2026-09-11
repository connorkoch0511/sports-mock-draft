const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { advanceDraft, PICK_MS } = require("./advance");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

test.afterEach(() => mock.restoreAll());

test("advancing an unfinished draft keeps it in the clock index", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1 };
  await advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0 });
  assert.match(input.UpdateExpression, /clockRunning = :run/);
  assert.equal(input.ExpressionAttributeValues[":run"], "1");
});

test("the write that completes a draft removes it from the clock index", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }], picked: [], currentIndex: 1 };
  await advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0 });
  assert.match(input.UpdateExpression, /REMOVE clockRunning/);
  // An UpdateExpression that never sets :run must not declare it: DynamoDB
  // rejects unused ExpressionAttributeValues with a ValidationException, and
  // that failure would only ever appear on the last pick of a draft.
  assert.equal(input.ExpressionAttributeValues[":run"], undefined);
});

test("a pick with no deadline base gets a full minute from now", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1 };
  const deadline = await advanceDraft({
    ddb, table: "t", draftId: "d1", draft, expectedIndex: 0, now: 1000,
  });
  // The browser paths -- /pick, /auto-pick, /expire, sim-to-end -- pass no
  // base and must be untouched by the scheduler's catch-up rule.
  assert.equal(deadline, 1000 + PICK_MS);
  assert.equal(input.ExpressionAttributeValues[":d"], 1000 + PICK_MS);
});

test("a catch-up pick counts forward from the previous deadline, not from now", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1 };
  // Forty minutes overdue. The new deadline is one slot past the OLD one, so
  // the scheduler's drain walks forward and terminates; `now + PICK_MS` would
  // put it in the future on every pick and the drain would stop after one.
  const wasDue = 1000;
  const deadline = await advanceDraft({
    ddb, table: "t", draftId: "d1", draft, expectedIndex: 0,
    now: wasDue + 40 * 60 * 1000,
    deadlineBase: wasDue,
  });
  assert.equal(deadline, wasDue + PICK_MS);
  assert.equal(input.ExpressionAttributeValues[":d"], wasDue + PICK_MS);
});

test("no pick may land on a paused draft", async () => {
  let condition = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.ConditionExpression) {
      condition = cmd.input.ConditionExpression;
      const e = new Error("The conditional request failed");
      e.name = "ConditionalCheckFailedException";
      throw e;
    }
    // The re-read that tells the two failures apart: the index has not
    // moved, so the reason we failed is the pause.
    return { Item: { currentIndex: 0, version: 7, pausedAt: 123 } };
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1 };
  await assert.rejects(
    () => advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0 }),
    (e) => {
      assert.equal(e.name, "DraftPaused");
      assert.equal(e.message, "Draft is paused");
      assert.equal(e.currentIndex, 0);
      assert.equal(e.version, 7);
      return true;
    }
  );
  // Pausing does not move currentIndex, so the concurrency guard alone lets a
  // pick race a pause -- and this same write would then set clockRunning and
  // put the paused draft back into the clock index.
  assert.match(condition, /attribute_not_exists\(pausedAt\)/);
});

test("a moved index is still reported as a lost race, paused or not", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.ConditionExpression) {
      const e = new Error("The conditional request failed");
      e.name = "ConditionalCheckFailedException";
      throw e;
    }
    // Somebody's pick is already stored AND the draft has since been paused.
    // The stored pick is the more useful thing to tell the caller.
    return { Item: { currentIndex: 4, version: 9, pausedAt: 123 } };
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1 };
  await assert.rejects(
    () => advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0 }),
    (e) => {
      assert.equal(e.name, "RaceLost");
      assert.equal(e.message, "Somebody just picked");
      assert.equal(e.currentIndex, 4);
      return true;
    }
  );
});

test("the deadline honours the draft's own pick length", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1, pickSeconds: 30 };
  const now = 1_000_000;
  await advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0, now });
  assert.equal(input.ExpressionAttributeValues[":d"], now + 30_000);
});

test("a draft written before pick lengths existed still gets sixty seconds", async () => {
  // The entire migration story: no backfill, because an absent field has a
  // correct meaning. If this passes without the fallback, it tests nothing.
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1 };
  const now = 1_000_000;
  await advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0, now });
  assert.equal(input.ExpressionAttributeValues[":d"], now + 60_000);
});

test("catch-up advances in the draft's own slot length", async () => {
  // What the scheduler's drain relies on: each catch-up pick consumes one
  // slot of missed time, and a slot is this draft's length, not 60s.
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1, pickSeconds: 30 };
  const base = 500_000;
  await advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0, deadlineBase: base });
  assert.equal(input.ExpressionAttributeValues[":d"], base + 30_000);
});
