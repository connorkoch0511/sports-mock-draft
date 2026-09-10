const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { advanceDraft } = require("./advance");

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
