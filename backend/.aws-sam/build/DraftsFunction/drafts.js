const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");
const { PLAYERS } = require("./data/players");
const PLAYER_MAP = Object.fromEntries(PLAYERS.map((p) => [p.id, p]));

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function buildSnakeOrder(teams, rounds) {
  const picks = [];
  let overall = 1;
  for (let r = 1; r <= rounds; r++) {
    const forward = r % 2 === 1;
    const teamOrder = forward
      ? Array.from({ length: teams }, (_, i) => i + 1)
      : Array.from({ length: teams }, (_, i) => teams - i);

    for (const team of teamOrder) {
      picks.push({ overall, round: r, team, playerId: null });
      overall++;
    }
  }
  return picks;
}

exports.handler = async (event) => {
  const table = process.env.DRAFTS_TABLE;
  const method = event.requestContext?.http?.method;
  const path = event.rawPath || "";
  const draftId = event.pathParameters?.draftId;

  try {
    // POST /drafts
    if (method === "POST" && path === "/drafts") {
      const body = event.body ? JSON.parse(event.body) : {};
      const teams = Math.max(2, Math.min(32, Number(body.teams || 12)));
      const rounds = Math.max(1, Math.min(30, Number(body.rounds || 15)));

      const id = uuidv4();
      const picks = buildSnakeOrder(teams, rounds);

      const item = {
        draftId: id,
        teams,
        rounds,
        picks,
        picked: [],
        currentIndex: 0,
        createdAt: Date.now(),
        version: 1,
      };

      await ddb.send(new PutCommand({ TableName: table, Item: item }));

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ draftId: id }),
      };
    }

    // GET /drafts/{draftId}
    if (method === "GET" && draftId) {
      const res = await ddb.send(new GetCommand({ TableName: table, Key: { draftId } }));
      if (!res.Item) return { statusCode: 404, body: JSON.stringify({ error: "Draft not found" }) };

      const d = res.Item;
      const current = d.picks[d.currentIndex] || null;

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          draftId: d.draftId,
          teams: d.teams,
          rounds: d.rounds,
          picked: d.picked || [],
          currentRound: current?.round || d.rounds,
          currentPick: current ? (current.overall % (d.teams || 1)) || d.teams : d.teams,
          currentTeam: current?.team || null,
          completed: d.currentIndex >= d.picks.length,
          picks: d.picks.map((p) => ({
            overall: p.overall,
            team: p.team,
            player: p.playerId ? (PLAYER_MAP[p.playerId] || { id: p.playerId, name: p.playerId, position: "—" }) : null,
          })),
        }),
      };
    }

    // POST /drafts/{draftId}/pick
    if (method === "POST" && draftId && path.endsWith("/pick")) {
      const body = event.body ? JSON.parse(event.body) : {};
      const playerId = String(body.playerId || "").trim();
      if (!playerId) return { statusCode: 400, body: JSON.stringify({ error: "Missing playerId" }) };

      const res = await ddb.send(new GetCommand({ TableName: table, Key: { draftId } }));
      if (!res.Item) return { statusCode: 404, body: JSON.stringify({ error: "Draft not found" }) };

      const d = res.Item;
      if ((d.picked || []).includes(playerId)) {
        return { statusCode: 409, body: JSON.stringify({ error: "Player already picked" }) };
      }
      if (d.currentIndex >= d.picks.length) {
        return { statusCode: 409, body: JSON.stringify({ error: "Draft already completed" }) };
      }

      d.picks[d.currentIndex].playerId = playerId;
      d.picked = [playerId, ...(d.picked || [])];
      d.currentIndex = d.currentIndex + 1;

      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { draftId },
          UpdateExpression: "SET picks = :p, picked = :k, currentIndex = :i, version = if_not_exists(version, :z) + :one",
          ExpressionAttributeValues: {
            ":p": d.picks,
            ":k": d.picked,
            ":i": d.currentIndex,
            ":z": 0,
            ":one": 1,
          },
        })
      );

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ ok: true }),
      };
    }

    return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || "Server error" }) };
  }
};