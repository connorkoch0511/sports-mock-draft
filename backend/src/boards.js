const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");
const { json } = require("./lib/http");
const { reconcile } = require("./lib/reconcile");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ALLOWED_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const FORMATS = new Set(["standard", "half-ppr", "ppr"]);

async function loadPool(playersTable, sport, format) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: playersTable,
      KeyConditionExpression: "#s = :sport",
      ExpressionAttributeNames: { "#s": "sport" },
      ExpressionAttributeValues: { ":sport": sport },
    })
  );

  return (res.Items || [])
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
      const body = event.body ? JSON.parse(event.body) : {};

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

    return json(404, { error: "Not found" });
  } catch (e) {
    return json(500, { error: e.message || "Server error" });
  }
};
