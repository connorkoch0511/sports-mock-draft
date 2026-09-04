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
const { json, responder } = require("./lib/http");
const { reconcile } = require("./lib/reconcile");
const { subOf, canMutate, ANON } = require("./lib/owner");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ALLOWED_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const FORMATS = new Set(["standard", "half-ppr", "ppr"]);

const DEFAULT_SEASON = 2026;
const MIN_SEASON = 1990;
const MAX_SEASON = 2100;

// 5000 entries x 64 chars caps the stored order at ~330KB including JSON
// overhead, which stays under DynamoDB's 400KB per-item limit.
const MAX_ORDER_ENTRIES = 5000;
const MAX_PLAYER_ID_LENGTH = 64;

// Parses the request body as JSON, returning {} for an absent body and
// `undefined` for anything that isn't a JSON object — malformed text, but also
// a body of literal "null", an array, or a bare string, all of which parse
// successfully yet would throw on property access further down. Callers turn
// that single `undefined` into one clean 400 rather than letting a SyntaxError
// or TypeError fall through to the generic 500 handler.
function parseJsonBody(event) {
  if (!event.body) return {};
  try {
    const parsed = JSON.parse(event.body);
    const isObject =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    return isObject ? parsed : undefined;
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
  const json = responder(event);
  const boardsTable = process.env.BOARDS_TABLE;
  const playersTable = process.env.PLAYERS_TABLE;

  const method = event.requestContext?.http?.method;
  const boardId = event.pathParameters?.boardId;

  if (method === "OPTIONS") return json(200, {});

  // Read once. The authorizer has already verified the token by the time this
  // runs; an absent sub means the route was reached without one, which is a
  // 401 rather than a crash.
  const sub = subOf(event);

  // A resource owned by somebody else answers exactly like one that does not
  // exist. A 403 would confirm the id is real.
  const notFound = () => json(404, { error: "Board not found" });
  const needsAuth = () => json(401, { error: "Sign in required" });

  try {
    if (method === "POST" && !boardId) {
      if (!sub) return needsAuth();
      const body = parseJsonBody(event);
      if (body === undefined) return json(400, { error: "Invalid JSON body" });

      const format = String(body.format || "standard").toLowerCase();
      if (!FORMATS.has(format)) return json(400, { error: "Invalid format" });

      const name = String(body.name || "My Board").slice(0, 80);
      const sport = String(body.sport || "nfl").toLowerCase();

      // Guard before the PutCommand: NaN and Infinity are not valid DynamoDB
      // numbers, so an unchecked season would surface as a 500 from the SDK
      // rather than a 400 from us.
      const season = Number(body.season || DEFAULT_SEASON);
      if (!Number.isInteger(season) || season < MIN_SEASON || season > MAX_SEASON) {
        return json(400, {
          error: `season must be an integer between ${MIN_SEASON} and ${MAX_SEASON}`,
        });
      }

      const item = {
        boardId: randomUUID(),
        ownerId: sub,
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
      if (!res.Item) return notFound();

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
      if (!sub) return needsAuth();
      const body = parseJsonBody(event);
      if (body === undefined) return json(400, { error: "Invalid JSON body" });

      if (!Array.isArray(body.order)) {
        return json(400, { error: "order must be an array" });
      }
      if (body.order.length > MAX_ORDER_ENTRIES) {
        return json(400, { error: `order exceeds ${MAX_ORDER_ENTRIES} entries` });
      }

      const expectedVersion = Number(body.version);
      if (!Number.isInteger(expectedVersion)) {
        return json(400, { error: "version must be an integer" });
      }

      const order = body.order.map(String);

      // Bound each entry as well as the count. Real player ids are Sleeper's,
      // ~4 characters; without a per-entry cap, MAX_ORDER_ENTRIES long strings
      // could push the item past DynamoDB's 400KB limit and fail as a 500.
      if (order.some((id) => id.length > MAX_PLAYER_ID_LENGTH)) {
        return json(400, {
          error: `playerId exceeds ${MAX_PLAYER_ID_LENGTH} characters`,
        });
      }

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
            ConditionExpression:
              "attribute_exists(boardId) AND version = :expected AND ownerId = :me AND ownerId <> :anon",
            ExpressionAttributeNames: { "#o": "order" },
            ExpressionAttributeValues: {
              ":order": order,
              ":now": Date.now(),
              ":next": expectedVersion + 1,
              ":expected": expectedVersion,
              ":me": sub,
              ":anon": ANON,
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
          if (!current.Item) return notFound();
          // Not yours -- including a legacy board nobody has claimed. Same
          // answer as a board that isn't there, deliberately.
          if (!canMutate(current.Item, sub)) return notFound();
          return json(409, {
            error: "Board changed since you loaded it",
            currentVersion: current.Item.version,
          });
        }
        throw e;
      }
    }

    if (method === "DELETE" && boardId) {
      if (!sub) return needsAuth();
      try {
        await ddb.send(
          new DeleteCommand({
            TableName: boardsTable,
            Key: { boardId },
            // The second clause keeps this condition from drifting away from
            // canMutate, which refuses the legacy "anon" owner for every
            // caller. Without it a caller whose sub were literally "anon"
            // could delete every unclaimed board.
            ConditionExpression: "ownerId = :me AND ownerId <> :anon",
            ExpressionAttributeValues: { ":me": sub, ":anon": ANON },
          })
        );
        return json(200, { ok: true });
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") return notFound();
        throw e;
      }
    }

    return json(404, { error: "Not found" });
  } catch (e) {
    return json(500, { error: e.message || "Server error" });
  }
};
