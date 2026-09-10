// backend/src/scripts/backfillClockRunning.js
//
// One-off: put every existing draft into the clock index. Drafts written
// before Phase 3 have no `clockRunning` attribute, and the index is sparse,
// so without this the scheduled clock would never see any of them -- while
// looking, from every log and every test, as though it worked.
//
// Refuses to write anything without --confirm, so a curious run is a dry run.
//
// Lives under src/ for the same reason purge-unowned.js does: the AWS SDK is
// vendored at backend/src/node_modules.
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const TABLE = "perfectpick-drafts";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

/**
 * A draft belongs in the clock index when its clock should be running: it
 * has picks left and nobody has paused it. Finished and paused drafts are
 * deliberately left out -- the same rule advance.js and /pause apply.
 */
function shouldRun(d) {
  if (!Array.isArray(d?.picks)) return false;
  if ((d.currentIndex ?? 0) >= d.picks.length) return false;
  if (d.pausedAt) return false;
  return true;
}

/**
 * `byClock` is a composite-key index: HASH clockRunning, RANGE pickDeadline.
 * DynamoDB only projects an item into a composite index when BOTH key
 * attributes are present on the item. This script only ever sets
 * `clockRunning` -- it must never invent a `pickDeadline` -- so a draft that
 * qualifies by `shouldRun` but has no usable deadline would be written,
 * counted as written, and still never appear in the index. That is exactly
 * the silent failure this script exists to prevent, so it gets its own
 * bucket instead of being folded into "to write".
 */
function hasUsableDeadline(d) {
  return typeof d?.pickDeadline === "number" && Number.isFinite(d.pickDeadline);
}

/** Print up to `cap` ids under a label; note how many were left out. */
function printIds(label, ids, cap = 50) {
  console.log(`${label} (${ids.length}):`);
  if (ids.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const id of ids.slice(0, cap)) console.log(`  ${id}`);
  if (ids.length > cap) {
    console.log(`  ... and ${ids.length - cap} more (showing first ${cap} of ${ids.length})`);
  }
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  let cursor;
  let scanned = 0, already = 0, skipped = 0;
  const toWrite = [];
  const noDeadline = [];

  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey: cursor })
    );
    for (const d of page.Items || []) {
      scanned += 1;
      if (d.clockRunning === "1") { already += 1; continue; }
      if (!shouldRun(d)) { skipped += 1; continue; }
      if (!hasUsableDeadline(d)) { noDeadline.push(d.draftId); continue; }
      toWrite.push(d.draftId);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  console.log(
    `scanned ${scanned}, already indexed ${already}, not running ${skipped}, ` +
      `to write ${toWrite.length}, no usable deadline ${noDeadline.length}`
  );

  // Loud and separate: a clean "wrote N" next to this would still be a silent
  // failure for these drafts specifically, so they get their own headline
  // and their ids, not just a folded-in count. An empty bucket is reported
  // just as explicitly -- that's the expected case, and the operator should
  // be able to see it at a glance rather than infer it from an absent line.
  if (noDeadline.length > 0) {
    console.log(
      `\n!! ${noDeadline.length} draft(s) qualify for the clock but have no usable ` +
        `pickDeadline (missing, or not a number).`
    );
    console.log(
      "!! byClock is a composite-key index (clockRunning + pickDeadline); DynamoDB " +
        "only projects an item into it when BOTH keys are present. This script does " +
        "not invent a pickDeadline, so these drafts CANNOT be indexed by this run --"
    );
    console.log(
      "!! the scheduler will not see them. They need a real pickDeadline before " +
        "they can be added to the clock index."
    );
    for (const draftId of noDeadline) console.log(`     ${draftId}`);
  } else {
    console.log(
      "\nNo drafts with a missing/invalid pickDeadline -- every qualifying draft can be indexed."
    );
  }

  console.log("");
  printIds("drafts that would be written to the index", toWrite);

  if (!confirm) {
    console.log("\ndry run. re-run with --confirm to write.");
    return;
  }

  let written = 0, changed = 0;
  const conditionFailed = [];
  for (const draftId of toWrite) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { draftId },
          UpdateExpression: "SET clockRunning = :run",
          // Only add the draft back to the index if it is still eligible
          // right now: not paused, and picks remain. A draft that was
          // paused or finished between the scan above and this write fails
          // this condition -- that's the expected, correct outcome (the
          // draft changed under us), not an error, so it's counted and
          // skipped rather than aborting the run.
          // The attribute_not_exists(currentIndex) arm matches shouldRun's
          // ?? 0 normalization, so a draft with missing currentIndex is
          // treated the same way in both.
          ConditionExpression:
            "attribute_not_exists(pausedAt) AND (attribute_not_exists(currentIndex) OR currentIndex < size(picks))",
          ExpressionAttributeValues: { ":run": "1" },
        })
      );
      written += 1;
    } catch (e) {
      if (e?.name === "ConditionalCheckFailedException") {
        changed += 1;
        conditionFailed.push(draftId);
        continue;
      }
      throw e;
    }
  }
  console.log(`wrote ${written}, skipped ${changed} (changed since the scan)`);
  if (conditionFailed.length > 0) {
    printIds("drafts whose condition failed", conditionFailed);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
