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

function normTeam(t) {
  const team = String(t || "").toUpperCase().trim();

  // Canonical: prefer common 2–3 letter NFL abbreviations like Sleeper uses
  const map = {
    // Common FFC / other-source variants:
    JAC: "JAX",
    WAS: "WSH",
    WSH: "WSH",

    KAN: "KC",
    GNB: "GB",
    NOR: "NO",
    NWE: "NE",
    SFO: "SF",
    TAM: "TB",

    SD: "LAC",
    STL: "LAR",
    OAK: "LV",

    // Sometimes seen:
    ARZ: "ARI",
    CLV: "CLE",
    HST: "HOU",
  };

  return map[team] || team;
}

function toAppPos(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "DST") return "DEF";
  if (p === "PK") return "K";     // FFC kickers
  return p;
}

function isSleeperDefense(p) {
  const pos = toAppPos(p.position);
  const fantasyPos = Array.isArray(p.fantasy_positions) ? p.fantasy_positions.map(toAppPos) : [];
  // Sleeper commonly uses: position="DEF" or "DST", fantasy_positions includes "DEF"
  return pos === "DEF" || fantasyPos.includes("DEF");
}

function normalizeSleeperPlayer(p, playerId) {
  const team = p.team ? normTeam(p.team) : "";

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

async function fetchSeasonStats(season) {
  const url = `https://api.sleeper.app/v1/stats/nfl/regular/${season}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sleeper stats fetch failed (${season}): ${r.status}`);
  return r.json();
}

function buildFfcMap(ffcPlayers) {
  const byStrict = new Map();     // pos|team|name
  const defByTeam = new Map();    // team -> adp
  const kByName = new Map();      // nameKey -> adp

  for (const p of ffcPlayers) {
    const pos = toAppPos(p.position);
    const adp = p.adp != null ? Number(p.adp) : null;
    if (!adp || Number.isNaN(adp)) continue;

    const team = normTeam(p.team);
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

// The stats feed carries ~100 fields per player, most of them team, kicking or
// defensive columns irrelevant to drafting a skill player. These are the ones
// the app reasons about.
const STATS_FIELDS = [
  "gp",
  "pts_ppr", "pts_half_ppr", "pts_std", "pos_rank_ppr",
  "rec", "rec_tgt", "rec_yd", "rec_td", "rec_rz_tgt", "rec_air_yd",
  "rush_att", "rush_yd", "rush_td",
  "pass_att", "pass_yd", "pass_td", "pass_int",
  "off_snp", "tm_off_snp",
];

// Curate one player's stats. Absent fields are omitted rather than zeroed: a
// receiver with no carries and one whose carries went unreported are different
// things, and 0 asserts the first. Returns null when nothing survives, so the
// caller can skip the key entirely.
function pickStats(raw) {
  if (!raw || typeof raw !== "object") return null;

  const out = {};
  for (const f of STATS_FIELDS) {
    const v = raw[f];
    if (typeof v === "number" && Number.isFinite(v)) out[f] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Has anyone played yet? Every September the new season exists as an endpoint
// but holds nothing, so this is what stops the sync serving an empty table.
function hasPlayedGames(statsByPlayer) {
  if (!statsByPlayer || typeof statsByPlayer !== "object") return false;
  return Object.values(statsByPlayer).some(
    (s) => s && typeof s.gp === "number" && s.gp > 0
  );
}

// Take the requested season if it has real games, else the one before it. The
// fetcher is injected so the fallback can be tested without network access.
//
// The fallback is indistinguishable, from the return value alone, from an
// upstream schema change or partial outage that returns `200 {}` -- both
// silently serve last season's data. Callers must log which happened.
async function resolveStatsSeason(year, fetchSeason) {
  const primary = await fetchSeason(year);
  if (hasPlayedGames(primary)) return { season: year, stats: primary };

  const prior = await fetchSeason(year - 1);
  return { season: year - 1, stats: prior };
}

// Attach curated stats to the players we have. Players absent from the feed
// get no `stats` key at all rather than an empty object, so the response can
// distinguish "no data" from "played but recorded nothing".
function mergeStats(players, statsByPlayer, season) {
  if (!statsByPlayer) return 0;

  let matched = 0;
  for (const pl of players) {
    const curated = pickStats(statsByPlayer[pl.id]);
    if (!curated) continue;
    pl.stats = curated;
    pl.statsSeason = season;
    matched += 1;
  }
  return matched;
}

exports.handler = async () => {
  const table = process.env.PLAYERS_TABLE;

  const ADP_TEAMS = Number(process.env.ADP_TEAMS || 12);
  const ADP_YEAR = Number(process.env.ADP_YEAR || 2026);
  const STATS_YEAR = Number(process.env.STATS_YEAR || ADP_YEAR);

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
    const team = normTeam(pl.team);
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

  // 4) Season stats. Deliberately wrapped: this job rewrites the entire
  // players table unattended every day, so a Sleeper outage or a shape change
  // must degrade to players-without-stats rather than leaving every draft with
  // an empty pool.
  let statsSeason = null;
  let statsMatched = 0;
  try {
    const resolved = await resolveStatsSeason(STATS_YEAR, fetchSeasonStats);
    statsSeason = resolved.season;
    statsMatched = mergeStats(basePlayers, resolved.stats, resolved.season);

    if (resolved.season === STATS_YEAR) {
      console.log(
        `season stats: using requested season ${STATS_YEAR}, matched ${statsMatched} players`
      );
    } else {
      // hasPlayedGames() found gp=0 across the board for STATS_YEAR. Early in
      // a season that's expected -- the endpoint exists before any games are
      // played. Outside that window, the same signal (all-zero gp) is what a
      // schema change or a partial "200 {}" outage would also produce, so it
      // reads as a fallback either way. matched/0 here, or a fallback outside
      // the pre-season window, is the tell that this is the latter, not the
      // former.
      console.warn(
        `season stats: requested season ${STATS_YEAR} has no games played (gp=0 for every ` +
          `player) -- falling back to ${resolved.season}, matched ${statsMatched} players. ` +
          `Expected in the weeks before ${STATS_YEAR} kicks off; if that's not now, this may ` +
          `be an upstream schema change or outage rather than a genuine gap -- check statsMatched.`
      );
    }
  } catch (e) {
    console.error("season stats unavailable, continuing without them:", e.message);
  }

  // 5) rank + tier per format
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

  // 6) Batch write with retry
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
      statsSeason,
      statsMatched,
    }),
  };
};

// SAM invokes syncPlayers.handler, so it must remain exported. These are added
// for testing; the handler assignment above is unchanged.
module.exports.STATS_FIELDS = STATS_FIELDS;
module.exports.pickStats = pickStats;
module.exports.hasPlayedGames = hasPlayedGames;
module.exports.resolveStatsSeason = resolveStatsSeason;
module.exports.mergeStats = mergeStats;