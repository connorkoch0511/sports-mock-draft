// Removing rows the run did not rewrite.

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { chunk, sleep } = require("./normalize");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// The sync only ever Put its players, so rows for anyone Sleeper stopped
// reporting stayed forever. Measured before this was written: the table held
// 3,876 rows against 815 written, and all 3,061 extras were retired players or
// free agents on no NFL roster -- zero were rostered. Waiver-wire depth is not
// at risk here, because the sync's filter is `status === "active"` AND has a
// team; it never consults ADP or rank, so third-stringers are kept.
//
// Anything not rewritten by THIS run is stale, which `updatedAt` already
// records -- no schema change needed.
const MIN_EXPECTED_PLAYERS = 500;

// This job runs unattended, so a Sleeper hiccup returning a short list must
// never be allowed to empty the table. Below the floor we skip pruning
// entirely and keep the rows: partial data beats no data, and a sync that
// wrote good players but declined to tidy up has still done its job.
async function pruneStale({ table, sport, runStartedAt, wrote }) {
  if (wrote < MIN_EXPECTED_PLAYERS) {
    console.warn(
      `[sync] prune SKIPPED: wrote ${wrote} < floor ${MIN_EXPECTED_PLAYERS}; ` +
        `keeping all existing rows`
    );
    return { pruned: 0, skipped: true };
  }

  const stale = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "#s = :sport",
        ExpressionAttributeNames: { "#s": "sport", "#u": "updatedAt" },
        ExpressionAttributeValues: { ":sport": sport },
        ProjectionExpression: "playerId, #u",
        ExclusiveStartKey,
      })
    );
    for (const item of res.Items || []) {
      // Negated so a missing or non-numeric updatedAt (NaN, which compares
      // false against everything) is treated as stale rather than current.
      if (!(Number(item.updatedAt) >= runStartedAt)) stale.push(item.playerId);
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  let pruned = 0;
  for (const b of chunk(stale, 25)) {
    let req = {
      RequestItems: {
        [table]: b.map((playerId) => ({
          DeleteRequest: { Key: { sport, playerId } },
        })),
      },
    };

    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await ddb.send(new BatchWriteCommand(req));
      const unprocessed = resp.UnprocessedItems?.[table] || [];

      if (attempt === 0) pruned += b.length;
      if (!unprocessed.length) break;

      req = { RequestItems: { [table]: unprocessed } };
      await sleep(100 * Math.pow(2, attempt));
    }
  }

  return { pruned, skipped: false };
}



module.exports = { pruneStale, MIN_EXPECTED_PLAYERS };
