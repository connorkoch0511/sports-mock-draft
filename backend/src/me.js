// backend/src/me.js
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, BatchGetCommand } = require("@aws-sdk/lib-dynamodb");
const { responder } = require("./lib/http");
const { subOf } = require("./lib/owner");
const { listDraftIds } = require("./lib/members");

// Mirrors sync/normalize.js's identical helper; not imported from there
// because these two Lambdas are otherwise unrelated and shouldn't share a
// dependency edge just to save four lines.
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// A page of the index is 1MB; nobody has that many drafts, but paging costs
// four lines and a surprise here would silently truncate somebody's list.
async function queryByOwner(TableName, sub) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName,
        IndexName: "byOwner",
        KeyConditionExpression: "ownerId = :me",
        ExpressionAttributeValues: { ":me": sub },
        ExclusiveStartKey,
      })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const byNewest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);

exports.handler = async (event) => {
  const json = responder(event);
  const method = event.requestContext?.http?.method;
  const path = event.rawPath || event.requestContext?.http?.path || "";

  if (method === "OPTIONS") return json(200, {});

  const sub = subOf(event);
  if (!sub) return json(401, { error: "Sign in required" });

  try {
    if (method === "GET" && path.endsWith("/me/drafts")) {
      const draftsTable = process.env.DRAFTS_TABLE;
      // Membership, not ownership: this lists every draft the caller is
      // seated in, including ones somebody else created and they joined.
      const ids = await listDraftIds(ddb, process.env.DRAFT_MEMBERS_TABLE, sub);
      // A membership row can outlive the draft it names -- deleting a draft
      // does not clean them up, and the seat is the truth anyway. Missing ids
      // are skipped rather than rendered as broken rows.
      const items = [];
      for (const group of chunk(ids, 100)) {
        if (group.length === 0) continue;
        let keys = group.map((draftId) => ({ draftId }));
        // DynamoDB may return fewer items than asked for under load, handing
        // back the rest as UnprocessedKeys. Without this they simply vanish
        // from somebody's list, silently. Bounded rather than a loop: a list
        // missing a few drafts is a bad day, but a listing that never returns
        // is a worse one.
        for (let attempt = 0; attempt < 3 && keys.length > 0; attempt++) {
          const res = await ddb.send(
            new BatchGetCommand({ RequestItems: { [draftsTable]: { Keys: keys } } })
          );
          items.push(...(res.Responses?.[draftsTable] || []));
          keys = res.UnprocessedKeys?.[draftsTable]?.Keys || [];
        }
        if (keys.length > 0) {
          console.error(`${keys.length} draft(s) unprocessed after retries; returning partial list`);
        }
      }
      const drafts = items.sort(byNewest);
      return json(200, {
        drafts: drafts.map((d) => ({
          id: d.draftId,
          draftId: d.draftId,
          teams: d.teams,
          rounds: d.rounds,
          format: d.format,
          userTeam: d.userTeam,
          boardId: d.boardId ?? null,
          // Derived rather than stored: picks is deliberately not projected
          // onto the index, and teams x rounds is the same number.
          completed: (d.currentIndex ?? 0) >= (d.teams || 0) * (d.rounds || 0),
          createdAt: d.createdAt ?? null,
        })),
      });
    }

    if (method === "GET" && path.endsWith("/me/boards")) {
      const items = await queryByOwner(process.env.BOARDS_TABLE, sub);
      return json(200, {
        boards: items
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .map((b) => ({
            id: b.boardId,
            name: b.name,
            format: b.format,
            season: b.season,
            updatedAt: b.updatedAt ?? null,
          })),
      });
    }

    return json(404, { error: "Not found" });
  } catch (e) {
    return json(500, { error: e.message || "Server error" });
  }
};
