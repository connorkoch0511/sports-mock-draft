const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

exports.handler = async (event) => {
  const table = process.env.PLAYERS_TABLE;

  const method = event.requestContext?.http?.method;
  const headers = { "Content-Type": "application/json", ...corsHeaders() };

  if (method === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const qs = event.queryStringParameters || {};
  const sport = String(qs.sport || "nfl").toLowerCase();
  const format = String(qs.format || "standard").toLowerCase();

  const res = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "#s = :sport",
      ExpressionAttributeNames: { "#s": "sport" },
      ExpressionAttributeValues: { ":sport": sport },
    })
  );

  const players = (res.Items || [])
    .map((p) => ({
      id: p.id || p.playerId,
      playerId: p.playerId,
      name: p.name,
      position: p.position,
      team: p.team,
      status: p.status,
      updatedAt: p.updatedAt,
      rank: p.rank?.[format] ?? null,
      adp: p.adp?.[format] ?? null,
      tier: p.tier?.[format] ?? null,
    }))
    .sort((a, b) => (a.rank ?? 999999) - (b.rank ?? 999999));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ sport, format, count: players.length, players }),
  };
};