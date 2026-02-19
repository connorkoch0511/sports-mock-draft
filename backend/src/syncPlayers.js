const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, BatchWriteCommand } = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ALLOWED = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Normalize names so Sleeper + FFC match more often
function normName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normPos(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "DST") return "DEF";
  return p;
}

function normalizeSleeperPlayer(p, playerId) {
  const status = String(p.status || "").toLowerCase();
  if (status !== "active") return null;

  const positions = Array.isArray(p.fantasy_positions) ? p.fantasy_positions : [];
  // Sleeper usually uses "DEF" for team defense in fantasy_positions
  const fantasyPos = positions.find((x) => ALLOWED.has(x)) || null;
  if (!fantasyPos) return null;

  // Team is required (for DEF this will be the NFL team abbrev)
  if (!p.team) return null;

  const name =
    p.full_name ||
    [p.first_name, p.last_name].filter(Boolean).join(" ").trim() ||
    p.search_full_name ||
    "";

  if (!name) return null;

  return {
    sport: "nfl",
    // Canonical id used by frontend + drafts
    id: String(playerId),
    playerId: String(playerId),

    name,
    nameKey: normName(name),

    position: fantasyPos,
    team: p.team,

    status: p.status,
    updatedAt: Date.now(),

    // filled later
    adp: null,
    rank: null,
    tier: null,
  };
}

function ffcPosToAppPos(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "DST") return "DEF";
  return p;
}

exports.handler = async () => {
  const table = process.env.PLAYERS_TABLE;
  const sport = "nfl";

  const ADP_TEAMS = Number(process.env.ADP_TEAMS || 12);
  const ADP_YEAR = Number(process.env.ADP_YEAR || 2025);
  const ADP_FORMAT = process.env.ADP_FORMAT || "standard"; // standard | ppr | half-ppr (if you use those)

  // 1) Sleeper dump
  const sleeperUrl = "https://api.sleeper.app/v1/players/nfl";
  const sr = await fetch(sleeperUrl);
  if (!sr.ok) throw new Error(`Sleeper fetch failed: ${sr.status}`);
  const sleeperData = await sr.json(); // object keyed by sleeper player_id

  const basePlayers = Object.entries(sleeperData)
    .map(([playerId, p]) => normalizeSleeperPlayer(p, playerId))
    .filter(Boolean);

  // 2) FFC ADP
  const adpUrl = `https://fantasyfootballcalculator.com/api/v1/adp/${encodeURIComponent(
    ADP_FORMAT
  )}?teams=${encodeURIComponent(ADP_TEAMS)}&year=${encodeURIComponent(ADP_YEAR)}`;

  const ar = await fetch(adpUrl);
  if (!ar.ok) throw new Error(`FFC ADP fetch failed: ${ar.status}`);
  const adpJson = await ar.json();

  const ffcPlayers = Array.isArray(adpJson.players) ? adpJson.players : [];
  const ffcKeyToAdp = new Map();
  for (const p of ffcPlayers) {
    const pos = ffcPosToAppPos(p.position);
    if (!ALLOWED.has(pos)) continue;

    const key = `${pos}|${p.team}|${normName(p.name)}`;
    // if duplicates exist, keep the best (lowest) adp
    const prev = ffcKeyToAdp.get(key);
    if (prev == null || (p.adp != null && p.adp < prev)) ffcKeyToAdp.set(key, p.adp);
  }

  // 3) merge ADP into Sleeper list
  for (const pl of basePlayers) {
    const key = `${pl.position}|${pl.team}|${pl.nameKey}`;
    const adp = ffcKeyToAdp.get(key);
    if (adp != null) pl.adp = Number(adp);
  }

  // 4) rank + tier from ADP
  const withAdp = basePlayers.filter((p) => p.adp != null).sort((a, b) => a.adp - b.adp);
  for (let i = 0; i < withAdp.length; i++) {
    withAdp[i].rank = i + 1;
    // Simple tiering: tier = draft round based on ADP (teams per round)
    withAdp[i].tier = Math.max(1, Math.ceil(withAdp[i].adp / ADP_TEAMS));
  }

  // Players without ADP keep rank/tier null — but now it’ll be FAR fewer. :contentReference[oaicite:1]{index=1}

  // 5) batch write w/ retry on UnprocessedItems
  const batches = chunk(basePlayers, 25);
  let inserted = 0;

  for (const b of batches) {
    let req = {
      RequestItems: {
        [table]: b.map((Item) => ({ PutRequest: { Item } })),
      },
    };

    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await ddb.send(new BatchWriteCommand(req));
      const unprocessed = resp.UnprocessedItems?.[table] || [];
      inserted += (attempt === 0 ? b.length : 0);

      if (!unprocessed.length) break;

      req = { RequestItems: { [table]: unprocessed } };
      await sleep(100 * Math.pow(2, attempt));
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      sport,
      total: basePlayers.length,
      withAdp: withAdp.length,
      inserted,
      adpTeams: ADP_TEAMS,
      adpYear: ADP_YEAR,
      adpFormat: ADP_FORMAT,
    }),
  };
};