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

class RaceLost extends Error {
  constructor(currentIndex, version) {
    super("Somebody just picked");
    this.name = "RaceLost";
    this.currentIndex = currentIndex;
    this.version = version;
  }
}

async function advanceDraft({ ddb, table, draftId, draft, expectedIndex }) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { draftId },
        UpdateExpression:
          "SET picks = :p, picked = :k, currentIndex = :i, version = if_not_exists(version, :z) + :one",
        ConditionExpression: "currentIndex = :expected",
        ExpressionAttributeValues: {
          ":p": draft.picks, ":k": draft.picked, ":i": draft.currentIndex,
          ":z": 0, ":one": 1, ":expected": expectedIndex,
        },
      })
    );
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
    // Read back so the caller can tell the browser where the draft actually
    // is, rather than leaving it to guess and poll.
    const now = await ddb.send(new GetCommand({ TableName: table, Key: { draftId } }));
    throw new RaceLost(now.Item?.currentIndex ?? null, now.Item?.version ?? null);
  }
}

module.exports = { advanceDraft, RaceLost };
