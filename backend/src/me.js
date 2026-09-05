// backend/src/me.js
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { responder } = require("./lib/http");
const { subOf } = require("./lib/owner");

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
      const items = await queryByOwner(process.env.DRAFTS_TABLE, sub);
      return json(200, {
        drafts: items.sort(byNewest).map((d) => ({
          id: d.draftId,
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
