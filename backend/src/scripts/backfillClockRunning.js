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

async function main() {
  const confirm = process.argv.includes("--confirm");
  let cursor;
  let scanned = 0, already = 0, skipped = 0, toWrite = [];

  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey: cursor })
    );
    for (const d of page.Items || []) {
      scanned += 1;
      if (d.clockRunning === "1") { already += 1; continue; }
      if (!shouldRun(d)) { skipped += 1; continue; }
      toWrite.push(d.draftId);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  console.log(`scanned ${scanned}, already indexed ${already}, not running ${skipped}, to write ${toWrite.length}`);
  if (!confirm) {
    console.log("dry run. re-run with --confirm to write.");
    return;
  }

  let written = 0;
  for (const draftId of toWrite) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { draftId },
        UpdateExpression: "SET clockRunning = :run",
        // Never resurrect a draft that finished or paused between the scan
        // above and this write.
        ConditionExpression: "attribute_exists(draftId)",
        ExpressionAttributeValues: { ":run": "1" },
      })
    );
    written += 1;
  }
  console.log(`wrote ${written}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
