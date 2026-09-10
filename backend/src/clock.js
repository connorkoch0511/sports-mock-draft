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
const { DynamoDBDocumentClient, QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
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

  const out = { due: due.length, advanced: 0, picks: 0, skipped: 0, deferred: 0 };
  let first = true;

  for (const draftId of due) {
    if (!first && remaining() < RESERVE_MS) {
      // Not an error: the next tick picks these up, and a half-finished
      // drain is exactly as valid a state as any other.
      out.deferred += 1;
      continue;
    }
    first = false;
    try {
      const picks = await drainDraft({ draftId, draftsTable, playersTable, boardsTable });
      if (picks > 0) out.advanced += 1;
      out.picks += picks;
      if (picks === 0) out.skipped += 1;
    } catch (e) {
      // One draft's failure costs that draft its tick, never the other
      // twenty-four theirs.
      out.skipped += 1;
      console.error(`clock: draft ${draftId} failed:`, e?.message || e);
    }
  }

  console.log(JSON.stringify({ msg: "clock run", ...out }));
  return out;
}

/**
 * Pick for one draft until its deadline is in the future or it is finished.
 *
 * The drain is what separates this from POST /expire, which deliberately
 * takes exactly one pick however late it is. A browser catching up would
 * burst on a draft somebody is watching; the drafts reached here are by
 * definition ones nobody is watching, and the alternative is a zombie draft
 * needing one scheduler run per remaining pick.
 */
async function drainDraft({ draftId, draftsTable, playersTable, boardsTable }) {
  let picks = 0;
  for (;;) {
    const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
    const d = res.Item;
    if (!d) return picks;
    if (d.currentIndex >= d.picks.length) return picks;
    if (d.pausedAt) return picks;
    // Strictly greater, the same rule /expire applies: a deadline exactly
    // reached has not passed yet.
    if (!(d.pickDeadline != null && Date.now() > d.pickDeadline)) return picks;

    const r = await autoPick.autoPickAndAdvance({
      ddb, d, draftId, playersTable, draftsTable, boardsTable,
    });
    // A person picked while we were working. They are right and we are
    // stale; stop touching this draft and let the next run re-read it.
    if (!r.ok) return picks;
    picks += 1;
  }
}

module.exports = { handler };
