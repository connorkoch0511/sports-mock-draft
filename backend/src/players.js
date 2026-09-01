const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { responder } = require("./lib/http");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const table = process.env.PLAYERS_TABLE;

  const json = responder(event);
  const method = event.requestContext?.http?.method;

  if (method === "OPTIONS") return json(200, {});

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
      name: p.name,
      position: p.position,
      team: p.team,
      rank: p.rank?.[format] ?? null,
      adp: p.adp?.[format] ?? null,
      tier: p.tier?.[format] ?? null,
    }))
    .sort((a, b) => (a.rank ?? 999999) - (b.rank ?? 999999));

  return json(200, { sport, format, count: players.length, players });
};
