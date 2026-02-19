const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const table = process.env.PLAYERS_TABLE;

  const qs = event.queryStringParameters || {};
  const sport = (qs.sport || "nfl").toLowerCase();

  const res = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "#s = :sport",
      ExpressionAttributeNames: { "#s": "sport" },
      ExpressionAttributeValues: { ":sport": sport },
    })
  );

  // Normalize output shape for frontend
  const players = (res.Items || [])
    .map((p) => ({
      id: p.id || p.playerId,      // canonical id
      playerId: p.playerId,
      name: p.name,
      position: p.position,
      team: p.team,
      status: p.status,
      updatedAt: p.updatedAt,
      // Optional fields if you later add them:
      rank: p.rank?.[format] ?? null,
      adp: p.adp?.[format] ?? null,
      tier: p.tier?.[format] ?? null,
    }))
    // Optional: stable sort (name); you can later add rank/adp sorting when you have it
    .sort((a, b) => (a.rank ?? 999999) - (b.rank ?? 999999));

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({ sport, count: players.length, players }),
  };
};