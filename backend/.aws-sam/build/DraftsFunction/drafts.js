const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ALLOWED_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

async function loadPlayersForSport(table, sport) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "#s = :sport",
      ExpressionAttributeNames: { "#s": "sport" },
      ExpressionAttributeValues: { ":sport": sport },
    })
  );

  const players = (res.Items || [])
    .filter((p) => p && ALLOWED_POS.has(p.position))
    .map((p) => ({
      id: p.id || p.playerId,
      name: p.name,
      position: p.position,
      team: p.team,
    }));

  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  return { players, byId };
}

function getRosterCounts(draft, teamNum, playerById) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const pk of draft.picks) {
    if (pk.team !== teamNum || !pk.playerId) continue;
    const pl = playerById[pk.playerId];
    if (!pl) continue;
    if (counts[pl.position] !== undefined) counts[pl.position] += 1;
  }
  return counts;
}

// Targets by end of draft (you can tune later)
function needScore(counts, pos, round) {
  const target = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 };

  // early-round strategy: prioritize RB/WR more; push K/DEF late
  const earlyBoost =
    round <= 6
      ? { RB: 2, WR: 2, QB: 0.7, TE: 0.7, K: 0.1, DEF: 0.1 }
      : { RB: 1, WR: 1, QB: 1, TE: 1, K: 1, DEF: 1 };

  const missing = Math.max(0, (target[pos] || 0) - (counts[pos] || 0));
  return missing * (earlyBoost[pos] || 1);
}

function pickBestForTeam(draft, teamNum, players) {
  const pickedSet = new Set(draft.picked || []);
  const currentPick = draft.picks[draft.currentIndex];
  const round = currentPick?.round || 1;

  // roster counts for needs
  // NOTE: we’ll compute counts in handler with playerById and pass in
  // (to keep this pure), so we’ll attach counts to draft temporarily if needed
  const counts = draft.__counts;

  let best = null;
  let bestScore = -Infinity;

  for (const p of players) {
    if (!p?.id) continue;
    if (pickedSet.has(p.id)) continue;

    // With Sleeper endpoint we don't have rank/adp. We'll use needs heavily and a small stable tie-break.
    const nScore = needScore(counts, p.position, round) * 100;

    // tie-break: prefer non-K/DEF early even if needs are equal
    const positionPenalty =
      round <= 6 && (p.position === "K" || p.position === "DEF") ? -50 : 0;

    // simple deterministic tie-break: name length + charcode
    const tiebreak = (p.name || "").length;

    const score = nScore + positionPenalty + tiebreak;

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
  const draftsTable = process.env.DRAFTS_TABLE;
  const playersTable = process.env.PLAYERS_TABLE; // ADD this env var in template (see below)

  const method = event.requestContext?.http?.method;
  const path = event.rawPath || event.requestContext?.http?.path || event.path || "";
  const draftId = event.pathParameters?.draftId;

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
        sport: (body.sport || "nfl").toLowerCase(),
        teams,
        rounds,
        picks,
        picked: [],
        currentIndex: 0,
        createdAt: Date.now(),
        version: 1,
      };

      await ddb.send(new PutCommand({ TableName: draftsTable, Item: item }));

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ draftId: id }),
      };
    }

    // GET /drafts/{draftId}
    if (method === "GET" && draftId) {
      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item) return { statusCode: 404, body: JSON.stringify({ error: "Draft not found" }) };

      const d = res.Item;
      const current = d.picks[d.currentIndex] || null;

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          draftId: d.draftId,
          sport: d.sport || "nfl",
          teams: d.teams,
          rounds: d.rounds,
          picked: d.picked || [],
          currentIndex: d.currentIndex,
          currentRound: current?.round || d.rounds,
          currentPick: current ? (current.overall % (d.teams || 1)) || d.teams : d.teams,
          currentTeam: current?.team || null,
          completed: d.currentIndex >= d.picks.length,
          picks: (d.picks || []).map((p) => ({
            overall: p.overall,
            round: p.round,
            team: p.team,
            playerId: p.playerId || null,
          })),
        }),
      };
    }

    // POST /drafts/{draftId}/pick
    if (method === "POST" && draftId && path.endsWith("/pick")) {
      const body = event.body ? JSON.parse(event.body) : {};
      const playerId = String(body.playerId || "").trim();
      if (!playerId) return { statusCode: 400, body: JSON.stringify({ error: "Missing playerId" }) };

      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item) return { statusCode: 404, body: JSON.stringify({ error: "Draft not found" }) };

      const d = res.Item;
      if ((d.picked || []).includes(playerId)) return { statusCode: 409, body: JSON.stringify({ error: "Player already picked" }) };
      if (d.currentIndex >= d.picks.length) return { statusCode: 409, body: JSON.stringify({ error: "Draft already completed" }) };

      d.picks[d.currentIndex].playerId = playerId;
      d.picked = [playerId, ...(d.picked || [])];
      d.currentIndex = d.currentIndex + 1;

      await ddb.send(
        new UpdateCommand({
          TableName: draftsTable,
          Key: { draftId },
          UpdateExpression: "SET picks = :p, picked = :k, currentIndex = :i, version = if_not_exists(version, :z) + :one",
          ExpressionAttributeValues: { ":p": d.picks, ":k": d.picked, ":i": d.currentIndex, ":z": 0, ":one": 1 },
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
      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item) return { statusCode: 404, body: JSON.stringify({ error: "Draft not found" }) };

      const d = res.Item;
      if (d.currentIndex >= d.picks.length) return { statusCode: 409, body: JSON.stringify({ error: "Draft already completed" }) };

      const sport = (d.sport || "nfl").toLowerCase();
      const { players, byId } = await loadPlayersForSport(playersTable, sport);

      const teamNum = d.picks[d.currentIndex]?.team;
      d.__counts = getRosterCounts(d, teamNum, byId);

      const best = pickBestForTeam(d, teamNum, players);
      if (!best) return { statusCode: 409, body: JSON.stringify({ error: "No players left" }) };

      d.picks[d.currentIndex].playerId = best.id;
      d.picked = [best.id, ...(d.picked || [])];
      d.currentIndex = d.currentIndex + 1;

      await ddb.send(
        new UpdateCommand({
          TableName: draftsTable,
          Key: { draftId },
          UpdateExpression: "SET picks = :p, picked = :k, currentIndex = :i, version = if_not_exists(version, :z) + :one",
          ExpressionAttributeValues: { ":p": d.picks, ":k": d.picked, ":i": d.currentIndex, ":z": 0, ":one": 1 },
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
      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item) return { statusCode: 404, body: JSON.stringify({ error: "Draft not found" }) };

      const d = res.Item;
      const sport = (d.sport || "nfl").toLowerCase();
      const { players, byId } = await loadPlayersForSport(playersTable, sport);

      while (d.currentIndex < d.picks.length) {
        const teamNum = d.picks[d.currentIndex]?.team;
        d.__counts = getRosterCounts(d, teamNum, byId);

        const best = pickBestForTeam(d, teamNum, players);
        if (!best) break;

        d.picks[d.currentIndex].playerId = best.id;
        d.picked = [best.id, ...(d.picked || [])];
        d.currentIndex += 1;
      }

      await ddb.send(
        new UpdateCommand({
          TableName: draftsTable,
          Key: { draftId },
          UpdateExpression: "SET picks = :p, picked = :k, currentIndex = :i, version = if_not_exists(version, :z) + :one",
          ExpressionAttributeValues: { ":p": d.picks, ":k": d.picked, ":i": d.currentIndex, ":z": 0, ":one": 1 },
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