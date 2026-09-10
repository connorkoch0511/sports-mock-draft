// Moving a draft forward, safely.
//
// Every pick-advancing write does a read and then a write, and between those
// two somebody else may have picked. The condition here is what stops the
// second write landing on top of the first -- without it the loser's pick is
// silently overwritten and the player who was drafted simply is not, with no
// error anywhere. Written once rather than three times because three copies
// of a concurrency guard drift, and drift here reintroduces exactly the bug
// this exists to prevent.

const { UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

// The one definition of how long a pick may take. The browser renders a
// countdown but decides nothing; this is the number the server enforces.
const PICK_SECONDS = 60;
const PICK_MS = PICK_SECONDS * 1000;

class RaceLost extends Error {
  constructor(currentIndex, version) {
    super("Somebody just picked");
    this.name = "RaceLost";
    this.currentIndex = currentIndex;
    this.version = version;
  }
}

async function advanceDraft({ ddb, table, draftId, draft, expectedIndex, now = Date.now() }) {
  // Written here rather than by the callers, and inside the SAME conditional
  // write that moves currentIndex, so the two can never disagree. A separate
  // update would leave a window in which the deadline belongs to a pick that
  // has already been made -- and the loser of a race would arm a clock for
  // somebody else's turn.
  const deadline = now + PICK_MS;
  // The index entry rides inside this same conditional write, for the same
  // reason the deadline does: a separate update would leave a window where
  // the index says a draft is due and the draft says somebody already picked.
  const complete = draft.currentIndex >= draft.picks.length;
  const base =
    "SET picks = :p, picked = :k, currentIndex = :i, pickDeadline = :d, version = if_not_exists(version, :z) + :one";
  const values = {
    ":p": draft.picks, ":k": draft.picked, ":i": draft.currentIndex,
    ":d": deadline,
    ":z": 0, ":one": 1, ":expected": expectedIndex,
  };
  let expression;
  if (complete) {
    // A finished draft leaves the index for good; nothing will ever put it
    // back, which is what makes the index sparse rather than ever-growing.
    expression = `${base} REMOVE clockRunning`;
  } else {
    expression = `${base}, clockRunning = :run`;
    // Declared only on this branch. An unused value is a ValidationException.
    values[":run"] = "1";
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { draftId },
        UpdateExpression: expression,
        ConditionExpression: "currentIndex = :expected",
        ExpressionAttributeValues: values,
      })
    );
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
    const now2 = await ddb.send(new GetCommand({ TableName: table, Key: { draftId } }));
    throw new RaceLost(now2.Item?.currentIndex ?? null, now2.Item?.version ?? null);
  }
  return deadline;
}

module.exports = { advanceDraft, RaceLost, PICK_SECONDS, PICK_MS };
