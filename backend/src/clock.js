// backend/src/clock.js
//
// The caller Phase 2 shaped POST /expire for. A browser asks the server to
// check its clock; this asks the same question on a schedule, so a draft with
// nobody watching still moves.
//
// It does NOT call the HTTP route. There is no signed request and no service
// credential -- it runs the same rule in-process, from lib/autoPick, so the
// two callers cannot drift.
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const autoPick = require("./lib/autoPick");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// At most this many drafts per run. Anything not reached is still in the
// index and comes back a minute later, so deferring costs nothing.
const DRAFTS_PER_RUN = 25;
// Stop starting new drafts with less than this left of the Lambda's budget.
const RESERVE_MS = 10000;

async function handler(_event, context) {
  const draftsTable = process.env.DRAFTS_TABLE;
  const playersTable = process.env.PLAYERS_TABLE;
  const boardsTable = process.env.BOARDS_TABLE;
  const now = Date.now();

  const q = await ddb.send(
    new QueryCommand({
      TableName: draftsTable,
      IndexName: "byClock",
      KeyConditionExpression: "clockRunning = :run AND pickDeadline < :now",
      ExpressionAttributeValues: { ":run": "1", ":now": now },
      Limit: DRAFTS_PER_RUN,
    })
  );
  const due = (q.Items || []).map((i) => i.draftId);

  // Absent in tests and in a local run; a real invocation always has it.
  const remaining = () =>
    typeof context?.getRemainingTimeInMillis === "function"
      ? context.getRemainingTimeInMillis()
      : Number.POSITIVE_INFINITY;

  // Split, rather than one `skipped`, so the log can answer the question that
  // actually matters at 3am: is a draft poisoned, or is the clock simply
  // finding nothing to do? `raced` and `ineligible` are the system working;
  // `failed` and `emptyPool` repeating on every run are not.
  const out = {
    due: due.length,
    advanced: 0,
    picks: 0,
    raced: 0,
    ineligible: 0,
    evicted: 0,
    emptyPool: 0,
    failed: 0,
    deferred: 0,
  };

  for (const draftId of due) {
    if (remaining() < RESERVE_MS) {
      // Not an error: the next tick picks these up, and a half-finished
      // drain is exactly as valid a state as any other.
      out.deferred += 1;
      continue;
    }
    // Held outside the try so picks already made are still counted when the
    // drain throws afterwards. Reporting a run that made four picks and then
    // died as "0 picks" is a lie about the only number anyone reads.
    const tally = { picks: 0 };
    try {
      const reason = await drainDraft({
        draftId, draftsTable, playersTable, boardsTable, remaining, tally,
      });
      if (tally.picks === 0) await countStall({ out, reason, draftId, draftsTable });
    } catch (e) {
      // One draft's failure costs that draft its tick, never the other
      // twenty-four theirs.
      out.failed += 1;
      console.error(`clock: draft ${draftId} failed:`, e?.message || e);
    } finally {
      out.picks += tally.picks;
      if (tally.picks > 0) out.advanced += 1;
    }
  }

  console.log(JSON.stringify({ msg: "clock run", ...out }));
  return out;
}

/**
 * A drain that made no picks: count it, and where the reason is structural,
 * take the draft out of the index.
 *
 * The index is read ascending by `pickDeadline` with a limit, so a draft that
 * can never advance is returned FIRST, on every run, forever. Twenty-five of
 * those and the clock silently stops for everybody else -- the whole run is
 * spent re-reading drafts it cannot move. Self-healing is the only thing that
 * stops that, and it is why this write exists despite the plan's rule that
 * `clockRunning` is only ever written inside a write that already happens.
 *
 * Structural (evict): completed, paused. Neither can ever become due again
 * without a write that re-indexes the draft anyway -- resume sets
 * `clockRunning` itself.
 *
 * Transient (leave indexed): a lost race, a deadline that is simply still in
 * the future, a draft read as missing. All normal, all resolve themselves.
 *
 * An exhausted player pool is NOT structural either, even though it repeats:
 * it is recoverable, and evicting would mean the draft is never enforced
 * again once the pool is fixed. Counted and logged distinctly instead.
 */
async function countStall({ out, reason, draftId, draftsTable }) {
  if (reason === "completed" || reason === "paused") {
    const gone = await evictFromIndex({ draftsTable, draftId, reason });
    if (gone) {
      out.evicted += 1;
      console.log(`clock: draft ${draftId} left the index (${reason})`);
    } else {
      // The condition failed, so the draft is no longer in the state we read
      // -- it changed under us. Leave it indexed; the next run re-reads it.
      out.ineligible += 1;
    }
    return;
  }
  if (reason === "empty") {
    out.emptyPool += 1;
    console.error(
      `clock: draft ${draftId} has no eligible player left to pick; it stays in the index`
    );
    return;
  }
  if (reason === "race") {
    out.raced += 1;
    return;
  }
  if (reason === "budget") {
    out.deferred += 1;
    return;
  }
  if (reason === "malformed") {
    out.ineligible += 1;
    console.error(`clock: draft ${draftId} has no picks array`);
    return;
  }
  out.ineligible += 1;
}

/**
 * Remove `clockRunning`, but only if the draft really is in the state that
 * justified it. Conditional for the usual reason: between the read that said
 * "completed" and this write, somebody may have resumed or the item may have
 * changed, and un-indexing a draft whose clock should be running is exactly
 * the bug the index exists to prevent.
 *
 * A condition failure is not an error -- it means the draft moved on -- so it
 * returns false rather than throwing. The item is never created by this: both
 * conditions are false for a missing item, so a REMOVE can never resurrect a
 * deleted draft.
 */
async function evictFromIndex({ draftsTable, draftId, reason }) {
  const ConditionExpression =
    reason === "completed" ? "currentIndex >= size(picks)" : "attribute_exists(pausedAt)";
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: draftsTable,
        Key: { draftId },
        UpdateExpression: "REMOVE clockRunning",
        ConditionExpression,
      })
    );
    return true;
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/**
 * Pick for one draft until its deadline is in the future or it is finished.
 * Increments `tally.picks` as it goes and returns why it stopped.
 *
 * The drain is what separates this from POST /expire, which deliberately
 * takes exactly one pick however late it is. A browser catching up would
 * burst on a draft somebody is watching; the drafts reached here are by
 * definition ones nobody is watching, and the alternative is a zombie draft
 * needing one scheduler run per remaining pick.
 *
 * What makes the loop actually terminate is the deadline base. Each pick
 * counts a minute forward from the draft's PREVIOUS deadline, not from now,
 * so a draft forty minutes overdue burns forty one-minute slots and stops
 * when its deadline reaches the present. Passing no base -- the browser
 * behaviour -- would write `now + 60s` every time, which is always in the
 * future, and the loop would make exactly one pick and exit.
 */
async function drainDraft({ draftId, draftsTable, playersTable, boardsTable, remaining, tally }) {
  // Loaded at most once per drain and reused across its picks, the way
  // sim-to-end already does it: the pool is ~3,900 rows to read and sort, and
  // now that this really loops, doing that per pick is most of the run.
  let pool = null;
  for (;;) {
    // The outer loop's budget stops a new draft starting; this stops one
    // draft's drain from overrunning the timeout on its own. The draft keeps
    // its index entry, so the next run continues where this one stopped.
    if (remaining() < RESERVE_MS) return "budget";

    const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
    const d = res.Item;
    if (!d) return "missing";
    // An item with no picks list is not a draft this code can reason about.
    // Guarded rather than dereferenced, matching shouldRun in
    // scripts/backfillClockRunning.js: `d.picks.length` on such an item is a
    // TypeError, and a TypeError here is retried every minute forever.
    if (!Array.isArray(d.picks)) return "malformed";
    if ((d.currentIndex ?? 0) >= d.picks.length) return "completed";
    if (d.pausedAt) return "paused";
    // Strictly greater, the same rule /expire applies: a deadline exactly
    // reached has not passed yet.
    if (!(d.pickDeadline != null && Date.now() > d.pickDeadline)) return "future";

    if (!pool) {
      const sport = (d.sport || "nfl").toLowerCase();
      const format = (d.format || "standard").toLowerCase();
      pool = await autoPick.loadPlayersForSport({ ddb, table: playersTable, sport, format });
    }

    const r = await autoPick.autoPickAndAdvance({
      ddb, d, draftId, playersTable, draftsTable, boardsTable,
      pool,
      // The catch-up rule: this pick consumes the slot that already expired.
      deadlineBase: d.pickDeadline,
    });
    // A person picked, or paused, while we were working. They are right and
    // we are stale; stop touching this draft and let the next run re-read it.
    if (!r.ok) return r.code === "empty" ? "empty" : r.code === "paused" ? "paused" : "race";
    tally.picks += 1;
  }
}

module.exports = { handler };
