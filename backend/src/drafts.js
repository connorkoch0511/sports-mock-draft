const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");
const { PLAYERS } = require("./players");
const PLAYER_MAP = Object.fromEntries(PLAYERS.map((p) => [p.id, p]));

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function getRosterCounts(draft, teamNum) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const pk of draft.picks) {
    if (pk.team !== teamNum || !pk.playerId) continue;
    const pl = PLAYER_MAP[pk.playerId];
    if (!pl) continue;
    if (counts[pl.position] !== undefined) counts[pl.position] += 1;
  }
  return counts;
}

// Simple “needs” targets for fantasy-style roster building
function needScore(counts, pos, round) {
  // targets by end of draft (rough default)
  const target = { QB: 1, RB: 2, WR: 2, TE: 1 };

  // early-round strategy: prioritize RB/WR more
  const earlyBoost = round <= 3 ? { RB: 2, WR: 2, QB: 0.5, TE: 0.5 } : { RB: 1, WR: 1, QB: 1, TE: 1 };

  const missing = Math.max(0, (target[pos] || 0) - (counts[pos] || 0));
  return missing * (earlyBoost[pos] || 1);
}

function pickBestForTeam(draft, teamNum) {
  const pickedSet = new Set(draft.picked || []);
  const currentPick = draft.picks[draft.currentIndex];
  const round = currentPick?.round || 1;

  const counts = getRosterCounts(draft, teamNum);

  // Score each available player: higher is better
  let best = null;
  let bestScore = -Infinity;

  for (const p of PLAYERS) {
    if (pickedSet.has(p.id)) continue;

    // base score from rank (lower rank = better)
    const rankScore = 1000 - (p.rank || 999);

    // need score (bigger if team needs that position)
    const nScore = needScore(counts, p.position, round) * 100;

    // small tier bonus (lower tier number = better)
    const tierBonus = p.tier ? (10 - p.tier) * 5 : 0;

    const score = rankScore + nScore + tierBonus;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return best;
}

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
  const path =
    event.rawPath ||
    event.requestContext?.http?.path ||
    event.path ||
    "";
  const draftId = event.pathParameters?.draftId;

  console.log("method", method, "path", path, "draftId", draftId);
  console.log("env DRAFTS_TABLE", process.env.DRAFTS_TABLE);

  try {
    // POST /drafts
    if (method === "POST" && path === "/drafts") {
      const body = event.body ? JSON.parse(event.body) : {};
      const teams = Math.max(2, Math.min(32, Number(body.teams || 12)));
      const rounds = Math.max(1, Math.min(30, Number(body.rounds || 15)));

      const id = randomUUID();
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
            round: p.round,
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

    // POST /drafts/{draftId}/auto-pick
    if (method === "POST" && draftId && path.endsWith("/auto-pick")) {
      const res = await ddb.send(new GetCommand({ TableName: table, Key: { draftId } }));
      if (!res.Item) return { statusCode: 404, body: JSON.stringify({ error: "Draft not found" }) };

      const d = res.Item;

      if (d.currentIndex >= d.picks.length) {
        return { statusCode: 409, body: JSON.stringify({ error: "Draft already completed" }) };
      }

      const teamNum = d.picks[d.currentIndex]?.team;
      const best = pickBestForTeam(d, teamNum);
      if (!best) return { statusCode: 409, body: JSON.stringify({ error: "No players left" }) };

      d.picks[d.currentIndex].playerId = best.id;
      d.picked = [best.id, ...(d.picked || [])];
      d.currentIndex = d.currentIndex + 1;

      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { draftId },
          UpdateExpression:
            "SET picks = :p, picked = :k, currentIndex = :i, version = if_not_exists(version, :z) + :one",
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
        body: JSON.stringify({ ok: true, picked: best }),
      };
    }

    // POST /drafts/{draftId}/sim-to-end
    if (method === "POST" && draftId && path.endsWith("/sim-to-end")) {
      const res = await ddb.send(new GetCommand({ TableName: table, Key: { draftId } }));
      if (!res.Item) return { statusCode: 404, body: JSON.stringify({ error: "Draft not found" }) };

      const d = res.Item;

      while (d.currentIndex < d.picks.length) {
        const teamNum = d.picks[d.currentIndex]?.team;
        const best = pickBestForTeam(d, teamNum);
        if (!best) break;

        d.picks[d.currentIndex].playerId = best.id;
        d.picked = [best.id, ...(d.picked || [])];
        d.currentIndex += 1;
      }

      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { draftId },
          UpdateExpression:
            "SET picks = :p, picked = :k, currentIndex = :i, version = if_not_exists(version, :z) + :one",
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
        body: JSON.stringify({ ok: true, completed: d.currentIndex >= d.picks.length }),
      };
    }

    return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };

  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || "Server error" }) };
  }
};