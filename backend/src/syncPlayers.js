const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, BatchWriteCommand } = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ALLOWED = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const FORMATS = ["standard", "half-ppr", "ppr"];

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

function toAppPos(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "DST") return "DEF";
  return p;
}

function isSleeperDefense(p) {
  const pos = toAppPos(p.position);
  const fantasyPos = Array.isArray(p.fantasy_positions) ? p.fantasy_positions.map(toAppPos) : [];
  // Sleeper commonly uses: position="DEF" or "DST", fantasy_positions includes "DEF"
  return pos === "DEF" || fantasyPos.includes("DEF");
}

function normalizeSleeperPlayer(p, playerId) {
  const team = p.team ? String(p.team).toUpperCase() : "";

  // --- DEF / DST special case (do NOT require status=active) ---
  if (isSleeperDefense(p)) {
    if (!team) return null;

    const name =
      p.full_name ||
      p.search_full_name ||
      p.last_name || // sometimes used
      `${team} Defense`;

    return {
      sport: "nfl",
      id: String(playerId),
      playerId: String(playerId),

      name,
      nameKey: normName(name),

      position: "DEF",
      team,

      status: p.status ?? "team",
      updatedAt: Date.now(),

      // multi-format containers
      adp: {},
      rank: {},
      tier: {},
    };
  }

  // --- Everyone else: keep strict active filter ---
  const status = String(p.status || "").toLowerCase();
  if (status !== "active") return null;

  const fantasyPositions = Array.isArray(p.fantasy_positions) ? p.fantasy_positions.map(toAppPos) : [];
  const fantasyPos = fantasyPositions.find((x) => ALLOWED.has(x)) || null;
  if (!fantasyPos) return null;
  if (!team) return null;

  const name =
    p.full_name ||
    [p.first_name, p.last_name].filter(Boolean).join(" ").trim() ||
    p.search_full_name ||
    "";

  if (!name) return null;

  return {
    sport: "nfl",
    id: String(playerId),
    playerId: String(playerId),

    name,
    nameKey: normName(name),

    position: fantasyPos,
    team,

    status: p.status,
    updatedAt: Date.now(),

    // multi-format containers
    adp: {},
    rank: {},
    tier: {},
  };
}

async function fetchFfcAdp({ format, teams, year }) {
  const url = `https://fantasyfootballcalculator.com/api/v1/adp/${encodeURIComponent(
    format
  )}?teams=${encodeURIComponent(teams)}&year=${encodeURIComponent(year)}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`FFC ADP fetch failed (${format}): ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.players) ? j.players : [];
}

function buildFfcMap(ffcPlayers) {
  const byStrict = new Map();     // pos|team|name
  const defByTeam = new Map();    // team -> adp
  const kByName = new Map();      // nameKey -> adp

  for (const p of ffcPlayers) {
    const pos = ffcPosToAppPos(p.position);
    const adp = p.adp != null ? Number(p.adp) : null;
    if (!adp || Number.isNaN(adp)) continue;

    const team = String(p.team || "").toUpperCase();
    const nameKey = normName(p.name);

    if (pos === "DEF" && team) {
      const prev = defByTeam.get(team);
      if (prev == null || adp < prev) defByTeam.set(team, adp);
      continue;
    }

    if (pos === "K" && nameKey) {
      const prev = kByName.get(nameKey);
      if (prev == null || adp < prev) kByName.set(nameKey, adp);
      // still allow strict too
    }

    if (!ALLOWED.has(pos)) continue;
    const key = `${pos}|${team}|${nameKey}`;
    const prev = byStrict.get(key);
    if (prev == null || adp < prev) byStrict.set(key, adp);
  }

  return { byStrict, defByTeam, kByName };
}

exports.handler = async () => {
  const table = process.env.PLAYERS_TABLE;

  const ADP_TEAMS = Number(process.env.ADP_TEAMS || 12);
  const ADP_YEAR = Number(process.env.ADP_YEAR || 2025);

  // 1) Sleeper dump
  const sleeperUrl = "https://api.sleeper.app/v1/players/nfl";
  const sr = await fetch(sleeperUrl);
  if (!sr.ok) throw new Error(`Sleeper fetch failed: ${sr.status}`);
  const sleeperData = await sr.json();

  const basePlayers = Object.entries(sleeperData)
    .map(([playerId, p]) => normalizeSleeperPlayer(p, playerId))
    .filter(Boolean);

  // 2) Fetch FFC ADP for all formats
  const ffcByFormat = {};
  for (const fmt of FORMATS) {
    const ffcPlayers = await fetchFfcAdp({ format: fmt, teams: ADP_TEAMS, year: ADP_YEAR });
    ffcByFormat[fmt] = buildFfcMap(ffcPlayers);
    await sleep(250);
  }

  // 3) Merge ADP into Sleeper list for all formats
  for (const pl of basePlayers) {
    const team = String(pl.team || "").toUpperCase();
    const nameKey = pl.nameKey;
    const strictKey = `${pl.position}|${team}|${nameKey}`;

    for (const fmt of FORMATS) {
        const maps = ffcByFormat[fmt];
        let adp = maps.byStrict.get(strictKey);

        if (adp == null && pl.position === "DEF") {
        adp = maps.defByTeam.get(team);
        }

        if (adp == null && pl.position === "K") {
        adp = maps.kByName.get(nameKey);
        }

        if (adp != null) pl.adp[fmt] = adp;
    }
  }

  // 4) rank + tier per format
  const countsByFormat = {};
  for (const fmt of FORMATS) {
    const list = basePlayers
      .filter((p) => p.adp?.[fmt] != null)
      .sort((a, b) => Number(a.adp[fmt]) - Number(b.adp[fmt]));

    countsByFormat[fmt] = list.length;

    for (let i = 0; i < list.length; i++) {
      list[i].rank[fmt] = i + 1;
      list[i].tier[fmt] = Math.max(1, Math.ceil(list[i].adp[fmt] / ADP_TEAMS));
    }
  }

  // 5) Batch write with retry
  const batches = chunk(basePlayers, 25);
  let wrote = 0;

  for (const b of batches) {
    let req = {
      RequestItems: {
        [table]: b.map((Item) => ({ PutRequest: { Item } })),
      },
    };

    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await ddb.send(new BatchWriteCommand(req));
      const unprocessed = resp.UnprocessedItems?.[table] || [];

      if (attempt === 0) wrote += b.length;
      if (!unprocessed.length) break;

      req = { RequestItems: { [table]: unprocessed } };
      await sleep(100 * Math.pow(2, attempt));
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      sport: "nfl",
      total: basePlayers.length,
      wrote,
      adpTeams: ADP_TEAMS,
      adpYear: ADP_YEAR,
      withAdp: countsByFormat,
      formats: FORMATS,
    }),
  };
};