const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, BatchWriteCommand } = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ALLOWED = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizePlayer(p, playerId) {
  const status = String(p.status || "").toLowerCase();
  const positions = Array.isArray(p.fantasy_positions) ? p.fantasy_positions : [];
  const fantasyPos = positions.find((x) => ALLOWED.has(x)) || null;

  // filters
  if (status !== "active") return null;
  if (!p.team) return null;
  if (!fantasyPos) return null;

  const name =
    p.full_name ||
    [p.first_name, p.last_name].filter(Boolean).join(" ").trim();

  if (!name) return null;

  // IMPORTANT: make "id" the canonical identifier for the frontend + drafts
  const id = String(playerId);

  return {
    sport: "nfl",
    playerId: id, // keep for clarity
    id,           // canonical id
    name,
    position: fantasyPos,
    team: p.team,
    status: p.status,
    updatedAt: Date.now(),
  };
}

exports.handler = async () => {
  const table = process.env.PLAYERS_TABLE;
  const sport = "nfl";

  const url = "https://api.sleeper.app/v1/players/nfl";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sleeper fetch failed: ${r.status}`);
  const data = await r.json(); // object keyed by player_id

  const players = Object.entries(data)
    .map(([playerId, p]) => normalizePlayer(p, playerId))
    .filter(Boolean);

  // BatchWrite: 25 max per request; also handle unprocessed items
  const batches = chunk(players, 25);

  let inserted = 0;

  for (const b of batches) {
    let requestItems = {
      [table]: b.map((Item) => ({ PutRequest: { Item } })),
    };

    while (true) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: requestItems }));
      inserted += b.length;

      const unprocessed = res.UnprocessedItems && res.UnprocessedItems[table];
      if (!unprocessed || unprocessed.length === 0) break;

      requestItems = { [table]: unprocessed };
      await new Promise((r) => setTimeout(r, 200)); // small backoff
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, sport, inserted: players.length }),
  };
};