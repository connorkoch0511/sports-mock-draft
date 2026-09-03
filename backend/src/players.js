const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");
const { responder } = require("./lib/http");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));


// The full record behind the drill-down. Unlike the list projection this keeps
// the game log and the availability fields for every player, ranked or not:
// one player is being looked at deliberately, so there is no payload argument
// for hiding what is known about him.
function toDetail(p, format) {
  const out = {
    id: p.id || p.playerId,
    name: p.name,
    position: p.position,
    team: p.team,
    status: p.status ?? null,
    rank: p.rank?.[format] ?? null,
    adp: p.adp?.[format] ?? null,
    tier: p.tier?.[format] ?? null,
  };

  if (p.stats) {
    out.stats = p.stats;
    out.statsSeason = p.statsSeason ?? null;
  }
  if (Array.isArray(p.gameLog) && p.gameLog.length > 0) {
    out.gameLog = p.gameLog;
    out.gameLogSeason = p.gameLogSeason ?? null;
  }
  if (p.injuryStatus) out.injuryStatus = p.injuryStatus;
  if (p.injuryBodyPart) out.injuryBodyPart = p.injuryBodyPart;
  if (p.depthChartOrder != null) out.depthChartOrder = p.depthChartOrder;

  return out;
}

exports.handler = async (event) => {
  const table = process.env.PLAYERS_TABLE;

  const json = responder(event);
  const method = event.requestContext?.http?.method;

  if (method === "OPTIONS") return json(200, {});

  const qs = event.queryStringParameters || {};
  const sport = String(qs.sport || "nfl").toLowerCase();
  const format = String(qs.format || "standard").toLowerCase();

  // GET /players/{playerId} -- one player, in full, including the game log.
  //
  // A separate route on purpose. The list endpoint below ships the whole pool
  // and is what the draft page blocks on; folding 18 weekly rows per player
  // into it would undo the payload reduction pruning just bought. The drill-
  // down asks for one player at the moment it opens, which is the only time
  // the log is wanted.
  const playerId = event.pathParameters?.playerId;
  if (playerId) {
    const res = await ddb.send(
      new GetCommand({ TableName: table, Key: { sport, playerId: String(playerId) } })
    );
    if (!res.Item) return json(404, { error: "Player not found" });
    return json(200, { player: toDetail(res.Item, format) });
  }

  // A Query page tops out at 1MB; the players table (~3,900 items) is close
  // enough to that ceiling that a single page could silently drop players,
  // so page through ExclusiveStartKey/LastEvaluatedKey until exhausted.
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "#s = :sport",
        ExpressionAttributeNames: { "#s": "sport" },
        ExpressionAttributeValues: { ":sport": sport },
        ExclusiveStartKey,
      })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const players = items
    .map((p) => {
      const rank = p.rank?.[format] ?? null;
      const out = {
        id: p.id || p.playerId,
        name: p.name,
        position: p.position,
        team: p.team,
        rank,
        adp: p.adp?.[format] ?? null,
        tier: p.tier?.[format] ?? null,
      };

      // Stats and availability ride along only for players ranked in THIS
      // format. Measured, that is the difference between a 1.2x and a 1.7x
      // payload, and the unranked remainder is depth nobody drafts.
      if (rank != null && p.stats) {
        out.stats = p.stats;
        out.statsSeason = p.statsSeason;
      }
      if (rank != null) {
        if (p.injuryStatus) out.injuryStatus = p.injuryStatus;
        if (p.injuryBodyPart) out.injuryBodyPart = p.injuryBodyPart;
        if (p.depthChartOrder != null) out.depthChartOrder = p.depthChartOrder;
      }

      return out;
    })
    .sort((a, b) => (a.rank ?? 999999) - (b.rank ?? 999999));

  return json(200, { sport, format, count: players.length, players });
};

module.exports.toDetail = toDetail;
