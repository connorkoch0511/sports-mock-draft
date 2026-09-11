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

// The other way the condition below can fail: the draft is paused. Told apart
// from RaceLost so a caller does not report "Somebody just picked" when the
// truth is that somebody hit pause.
class DraftPaused extends Error {
  constructor(currentIndex, version) {
    super("Draft is paused");
    this.name = "DraftPaused";
    this.currentIndex = currentIndex;
    this.version = version;
  }
}

/**
 * @param {number} [now] - wall clock, injectable for tests.
 * @param {number} [deadlineBase] - what the new deadline counts forward FROM.
 *   Absent (the browser paths -- /pick, /auto-pick, /expire, sim-to-end) it
 *   is `now`, so a pick always gets a full minute. The scheduler's catch-up
 *   drain passes the draft's CURRENT deadline instead, so a draft forty
 *   minutes overdue burns forty one-minute slots and its deadline walks
 *   forward to the present rather than being reset to now+60s on every pick
 *   -- which would make the drain loop terminate after exactly one pick,
 *   since the deadline it just wrote is always in the future.
 */
async function advanceDraft({
  ddb, table, draftId, draft, expectedIndex, now = Date.now(), deadlineBase,
}) {
  // Written here rather than by the callers, and inside the SAME conditional
  // write that moves currentIndex, so the two can never disagree. A separate
  // update would leave a window in which the deadline belongs to a pick that
  // has already been made -- and the loser of a race would arm a clock for
  // somebody else's turn.
  // Read from the draft, not the module constant: every caller already
  // passes the whole draft, so this hands /pick, /auto-pick, /expire,
  // sim-to-end and the scheduled clock the per-draft length without any of
  // them changing. A draft written before pick lengths existed has no field,
  // and 60 is exactly what it has always had -- which is why this feature
  // needs no backfill.
  const seconds = draft.pickSeconds ?? PICK_SECONDS;
  const deadline = (deadlineBase ?? now) + seconds * 1000;
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
        // Two guarantees in one expression. `currentIndex = :expected` is the
        // concurrency guard: it stops a second pick landing on top of a first.
        // `attribute_not_exists(pausedAt)` is the pause guard: pausing does
        // not move currentIndex, so without it a pick racing a pause succeeds
        // -- and, because this same write sets clockRunning, puts the paused
        // draft straight back into the clock index it was just removed from.
        ConditionExpression: "currentIndex = :expected AND attribute_not_exists(pausedAt)",
        ExpressionAttributeValues: values,
      })
    );
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
    const now2 = await ddb.send(new GetCommand({ TableName: table, Key: { draftId } }));
    const at = now2.Item?.currentIndex ?? null;
    const version = now2.Item?.version ?? null;
    // The re-read tells the two failures apart. A moved currentIndex is a
    // lost race whatever else is true -- somebody's pick is already stored,
    // and that is the more useful thing to say. Only when the index is still
    // where we left it is a present `pausedAt` the reason we failed.
    if (at === expectedIndex && now2.Item?.pausedAt) throw new DraftPaused(at, version);
    throw new RaceLost(at, version);
  }
  return deadline;
}

module.exports = { advanceDraft, RaceLost, DraftPaused, PICK_SECONDS, PICK_MS };
