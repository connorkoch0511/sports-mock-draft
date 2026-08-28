const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");
const { json } = require("./lib/http");
const { reconcile } = require("./lib/reconcile");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ALLOWED_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const FORMATS = new Set(["standard", "half-ppr", "ppr"]);

// Parses the request body as JSON, returning {} for an absent body.
// Returns `undefined` (never a valid JSON.parse result) when the body is
// present but malformed, so callers can turn that into a 400 response
// instead of letting a SyntaxError fall through to the generic 500 handler.
function parseJsonBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return undefined;
  }
}

async function loadPool(playersTable, sport, format) {
  // A Query page tops out at 1MB; the players table (~3,900 items) is close
  // enough to that ceiling that a single page could silently drop players,
  // so page through ExclusiveStartKey/LastEvaluatedKey until exhausted.
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: playersTable,
        KeyConditionExpression: "#s = :sport",
        ExpressionAttributeNames: { "#s": "sport" },
        ExpressionAttributeValues: { ":sport": sport },
        ExclusiveStartKey,
      })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items
    .filter((p) => p && ALLOWED_POS.has(p.position))
    // Only ranked players belong on a big board. The table holds ~3,900 NFL
    // players; a few hundred have ADP. The rest are practice-squad depth that
    // would make the drag list unusable and show an empty delta on every row.
    .filter((p) => p.rank?.[format] != null)
    .map((p) => ({
      playerId: String(p.playerId || p.id),
      name: p.name,
      position: p.position,
      team: p.team,
      consensusRank: p.rank[format],
    }));
}

exports.handler = async (event) => {
  const boardsTable = process.env.BOARDS_TABLE;
  const playersTable = process.env.PLAYERS_TABLE;

  const method = event.requestContext?.http?.method;
  const boardId = event.pathParameters?.boardId;

  if (method === "OPTIONS") return json(200, {});

  try {
    if (method === "POST" && !boardId) {
      const body = parseJsonBody(event);
      if (body === undefined) return json(400, { error: "Invalid JSON body" });

      const format = String(body.format || "standard").toLowerCase();
      if (!FORMATS.has(format)) return json(400, { error: "Invalid format" });

      const name = String(body.name || "My Board").slice(0, 80);
      const sport = String(body.sport || "nfl").toLowerCase();
      const season = Number(body.season || 2026);

      const item = {
        boardId: randomUUID(),
        ownerId: "anon",
        name,
        sport,
        format,
        season,
        baseSource: "ffc",
        order: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
      };

      await ddb.send(new PutCommand({ TableName: boardsTable, Item: item }));
      return json(201, { boardId: item.boardId });
    }

    if (method === "GET" && boardId) {
      const res = await ddb.send(
        new GetCommand({ TableName: boardsTable, Key: { boardId } })
      );
      if (!res.Item) return json(404, { error: "Board not found" });

      const board = res.Item;
      const pool = await loadPool(playersTable, board.sport, board.format);
      const { rows, changelog } = reconcile(board.order || [], pool);

      return json(200, {
        boardId: board.boardId,
        name: board.name,
        sport: board.sport,
        format: board.format,
        season: board.season,
        version: board.version,
        rows,
        changelog,
      });
    }

    if (method === "PUT" && boardId) {
      const body = parseJsonBody(event);
      if (body === undefined) return json(400, { error: "Invalid JSON body" });

      if (!Array.isArray(body.order)) {
        return json(400, { error: "order must be an array" });
      }
      if (body.order.length > 5000) {
        return json(400, { error: "order exceeds 5000 entries" });
      }

      const expectedVersion = Number(body.version);
      if (!Number.isInteger(expectedVersion)) {
        return json(400, { error: "version must be an integer" });
      }

      const order = body.order.map(String);
      if (new Set(order).size !== order.length) {
        return json(400, { error: "order contains duplicate playerIds" });
      }

      try {
        const res = await ddb.send(
          new UpdateCommand({
            TableName: boardsTable,
            Key: { boardId },
            UpdateExpression:
              "SET #o = :order, updatedAt = :now, version = :next",
            ConditionExpression: "attribute_exists(boardId) AND version = :expected",
            ExpressionAttributeNames: { "#o": "order" },
            ExpressionAttributeValues: {
              ":order": order,
              ":now": Date.now(),
              ":next": expectedVersion + 1,
              ":expected": expectedVersion,
            },
            ReturnValues: "ALL_NEW",
          })
        );
        return json(200, { ok: true, version: res.Attributes.version });
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") {
          const current = await ddb.send(
            new GetCommand({ TableName: boardsTable, Key: { boardId } })
          );
          if (!current.Item) return json(404, { error: "Board not found" });
          return json(409, {
            error: "Board changed since you loaded it",
            currentVersion: current.Item.version,
          });
        }
        throw e;
      }
    }

    if (method === "DELETE" && boardId) {
      await ddb.send(
        new DeleteCommand({ TableName: boardsTable, Key: { boardId } })
      );
      return json(200, { ok: true });
    }

    return json(404, { error: "Not found" });
  } catch (e) {
    return json(500, { error: e.message || "Server error" });
  }
};
