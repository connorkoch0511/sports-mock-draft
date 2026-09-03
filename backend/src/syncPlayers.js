const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");

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

  // --- Everyone else: on an NFL roster, whatever their status ---
  //
  // Being rostered is the test, NOT status === "active". Sleeper marks a
  // player on injured reserve "Inactive" while they stay on the roster and
  // stay drafted: measured against Sleeper's live feed, 88 rostered players
  // carry that status, among them Isiah Pacheco (DET), James Conner (ARI),
  // and Tank Dell (HOU) -- all three with a current FFC ADP inside the top
  // 165. An "active"-only filter dropped every one of them.
  //
  // This was invisible for as long as the sync never deleted anything: their
  // rows survived from an earlier sync carrying stale data. Pruning removed
  // that cover and turned a silent staleness bug into 6 missing draftable
  // players, which is how it was found.
  //
  // Distinct statuses among rostered players at fantasy positions are only
  // Active (773), Inactive (88), and Practice Squad (1) -- no retired player
  // holds a team -- so requiring a team is the whole filter.
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

    ...(pickAvailability(p) || {}),
  };
}

// Node's undici defaults headersTimeout/bodyTimeout to 300s -- far past this
// Lambda's own 60s Timeout (template.yaml) -- so a fetch with no AbortSignal
// can hang well past the point the invocation is killed. 10s leaves
// comfortable room inside the 60s budget for everything that runs around a
// given call (the other three fetches below, plus the DynamoDB batch write),
// while still being far longer than any of these endpoints take to answer
// under normal conditions. Shared by every outbound fetch in this file so a
// stall anywhere degrades to an error quickly instead of burning the whole
// invocation.
const FETCH_TIMEOUT_MS = 10_000;

async function fetchFfcAdp({ format, teams, year }) {
  const url = `https://fantasyfootballcalculator.com/api/v1/adp/${encodeURIComponent(
    format
  )}?teams=${encodeURIComponent(teams)}&year=${encodeURIComponent(year)}`;

  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`FFC ADP fetch failed (${format}): ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.players) ? j.players : [];
}

// Wrapped in the stats block's try/catch (see the handler below), so a
// timeout here is exactly the "degrade to players-without-stats" outcome
// that block's own comment promises for a Sleeper outage -- a hang is just
// another way for the fetch to fail, once it is bounded by an AbortSignal.
async function fetchSeasonStats(season) {
  const url = `https://api.sleeper.app/v1/stats/nfl/regular/${season}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
//
// Requires gp (games played) > 0 before returning anything at all. Sleeper
// emits derived fields such as pos_rank_ppr even for players who never
// suited up, and pos_rank_ppr alone used to be enough to survive curation --
// so a player who sat the whole season could ship a `stats` object whose
// only content was a rank number, asserting data that does not exist. gp is
// the same field hasPlayedGames() already keys on to answer "did anyone play
// yet", so this applies that same honest signal per player.
function pickStats(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.gp !== "number" || !Number.isFinite(raw.gp) || raw.gp <= 0) return null;

  const out = {};
  for (const f of STATS_FIELDS) {
    const v = raw[f];
    if (typeof v === "number" && Number.isFinite(v)) out[f] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Sleeper carries availability data the app has never kept. Measured on the
// live blob: injury_status is set for 474 of 2,723 players (IR 223,
// Questionable 198), depth_chart_order for 1,463. practice_participation is
// empty for every injured player, so it is deliberately not read.
//
// Sparse by nature, so this returns null rather than {} when there is nothing
// to say -- adding an empty object to ~2,200 healthy players would cost
// payload for no information.
function pickAvailability(p) {
  if (!p || typeof p !== "object") return null;

  const out = {};
  if (typeof p.injury_status === "string" && p.injury_status) {
    out.injuryStatus = p.injury_status;
  }
  if (typeof p.injury_body_part === "string" && p.injury_body_part) {
    out.injuryBodyPart = p.injury_body_part;
  }
  if (typeof p.depth_chart_order === "number" && Number.isFinite(p.depth_chart_order)) {
    out.depthChartOrder = p.depth_chart_order;
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

// Attach curated stats to the players we have. Players absent from the feed,
// and players present but with gp=0 (pickStats' guard), get no `stats` key
// at all rather than an empty or rank-only object, so the response can
// distinguish "no data" from "played but recorded nothing". That also keeps
// `matched` an honest count of players who actually played -- see the
// "check statsMatched" advice in the handler's fallback warning below.
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


// The sync only ever Put its players, so rows for anyone Sleeper stopped
// reporting stayed forever. Measured before this was written: the table held
// 3,876 rows against 815 written, and all 3,061 extras were retired players or
// free agents on no NFL roster -- zero were rostered. Waiver-wire depth is not
// at risk here, because the sync's filter is `status === "active"` AND has a
// team; it never consults ADP or rank, so third-stringers are kept.
//
// Anything not rewritten by THIS run is stale, which `updatedAt` already
// records -- no schema change needed.
const MIN_EXPECTED_PLAYERS = 500;

// This job runs unattended, so a Sleeper hiccup returning a short list must
// never be allowed to empty the table. Below the floor we skip pruning
// entirely and keep the rows: partial data beats no data, and a sync that
// wrote good players but declined to tidy up has still done its job.
async function pruneStale({ table, sport, runStartedAt, wrote }) {
  if (wrote < MIN_EXPECTED_PLAYERS) {
    console.warn(
      `[sync] prune SKIPPED: wrote ${wrote} < floor ${MIN_EXPECTED_PLAYERS}; ` +
        `keeping all existing rows`
    );
    return { pruned: 0, skipped: true };
  }

  const stale = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "#s = :sport",
        ExpressionAttributeNames: { "#s": "sport", "#u": "updatedAt" },
        ExpressionAttributeValues: { ":sport": sport },
        ProjectionExpression: "playerId, #u",
        ExclusiveStartKey,
      })
    );
    for (const item of res.Items || []) {
      // Negated so a missing or non-numeric updatedAt (NaN, which compares
      // false against everything) is treated as stale rather than current.
      if (!(Number(item.updatedAt) >= runStartedAt)) stale.push(item.playerId);
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  let pruned = 0;
  for (const b of chunk(stale, 25)) {
    let req = {
      RequestItems: {
        [table]: b.map((playerId) => ({
          DeleteRequest: { Key: { sport, playerId } },
        })),
      },
    };

    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await ddb.send(new BatchWriteCommand(req));
      const unprocessed = resp.UnprocessedItems?.[table] || [];

      if (attempt === 0) pruned += b.length;
      if (!unprocessed.length) break;

      req = { RequestItems: { [table]: unprocessed } };
      await sleep(100 * Math.pow(2, attempt));
    }
  }

  return { pruned, skipped: false };
}


// The weekly feed is the same shape as the season one, one week at a time.
// Wrapped by its caller so a week that fails leaves a gap in the log rather
// than failing the sync.
async function fetchWeekStats(season, week) {
  const url = `https://api.sleeper.app/v1/stats/nfl/regular/${season}/${week}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Sleeper week fetch failed (${season} wk${week}): ${r.status}`);
  return r.json();
}

// An NFL regular season is 18 weeks.
const SEASON_WEEKS = 18;

// What a game-log row shows. Narrower than STATS_FIELDS on purpose: a weekly
// row is read at a glance, so it carries volume, scoring and snaps and leaves
// the rate stats to the season line.
//
// `pass_int`, NOT `int`. Verified against a real week: `int` appears on zero
// players -- it is a team/defensive stat, the interceptions a defence caught.
// `pass_int` is the one a quarterback throws. Curating `int` would store
// nothing for every QB while reading perfectly sensibly.
const WEEK_FIELDS = [
  "pts_ppr", "pts_half_ppr", "pts_std",
  "rec", "rec_tgt", "rec_yd", "rec_td", "rec_rz_tgt",
  "rush_att", "rush_yd", "rush_td", "rush_rz_att",
  "pass_att", "pass_yd", "pass_td", "pass_int",
  "off_snp", "tm_off_snp",
];

// Sleeper's weekly payload mixes team aggregates in with players: of week 9's
// 2,105 entries, 56 are keyed TEAM_CHI, TEAM_BUF and so on, and their pts_ppr
// is the whole offence's -- TEAM_CHI outscores every human in the feed.
// Player ids are numeric, so this is the whole test. Without it a team's
// offence would be joined onto a player and shown as his week.
function isPlayerId(id) {
  return typeof id === "string" && /^\d+$/.test(id);
}

/**
 * One week of a player's season, or null if he did not play it.
 *
 * Two kinds of absence, and they are not the same thing:
 *
 *   - no entry, or gp of 0 -> he did not play. Returns null, and the week is
 *     simply missing from the log. A row of zeroes would assert he played and
 *     did nothing.
 *   - an entry, but a field missing -> he played and recorded none of that.
 *     The field is omitted here and the UI renders 0. Measured in week 9,
 *     `rec_td` is present on 39 players against `rec` on 200; storing only
 *     what Sleeper sends keeps the row small, and "played" is already
 *     established by the row existing at all.
 */
function pickWeek(raw, week) {
  if (!raw || typeof raw !== "object") return null;
  if (!(Number(raw.gp) > 0)) return null;

  const out = { wk: week };
  for (const f of WEEK_FIELDS) {
    const v = raw[f];
    if (typeof v === "number" && Number.isFinite(v)) out[f] = v;
  }
  return out;
}

/**
 * Attaches `gameLog` to every player who played a week in `season`.
 *
 * Weeks are fetched one at a time and folded straight into the players, so
 * only one week's payload (~500KB) is ever held at once rather than all 18.
 * A week that fails to fetch is logged and skipped: a game log with week 7
 * missing is worth more than no game log at all.
 */
async function mergeGameLogs(players, season, fetchWeek = fetchWeekStats) {
  const byId = new Map();
  for (const p of players) byId.set(p.id, p);

  let weeksLoaded = 0;
  // The highest week that actually carried player data. Mid-season the later
  // weeks have not been played, and a log that rendered them as "did not
  // play" would accuse a player of missing games nobody has played yet.
  let lastWeekWithData = 0;
  for (let week = 1; week <= SEASON_WEEKS; week++) {
    let raw;
    try {
      raw = await fetchWeek(season, week);
    } catch (e) {
      console.warn(`game log: week ${week} unavailable, skipping: ${e.message}`);
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    weeksLoaded += 1;

    let weekHadPlay = false;
    for (const [id, line] of Object.entries(raw)) {
      if (!isPlayerId(id)) continue;
      const row = pickWeek(line, week);
      if (!row) continue;
      weekHadPlay = true;
      const player = byId.get(id);
      if (!player) continue;
      (player.gameLog ||= []).push(row);
    }
    // Tracked from the feed, not from our own players: a week in which only
    // players outside our pool appeared was still a week of football.
    if (weekHadPlay) lastWeekWithData = week;
  }

  // Fetched in order, so the rows are already ascending; sorted anyway so the
  // stored shape does not depend on the loop above staying sequential.
  let playersWithLog = 0;
  for (const p of players) {
    if (p.gameLog) {
      p.gameLog.sort((a, b) => a.wk - b.wk);
      p.gameLogSeason = season;
      p.gameLogThrough = lastWeekWithData;
      playersWithLog += 1;
    }
  }

  return { weeksLoaded, playersWithLog, lastWeekWithData };
}

exports.handler = async () => {
  const table = process.env.PLAYERS_TABLE;

  // Captured before any player is normalized, so every row this run writes
  // carries an updatedAt at or after it.
  const runStartedAt = Date.now();

  const ADP_TEAMS = Number(process.env.ADP_TEAMS || 12);
  const ADP_YEAR = Number(process.env.ADP_YEAR || 2026);
  const STATS_YEAR = Number(process.env.STATS_YEAR || ADP_YEAR);

  // 1) Sleeper dump
  const sleeperUrl = "https://api.sleeper.app/v1/players/nfl";
  const sr = await fetch(sleeperUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
  let gameLogWeeks = 0;
  let gameLogPlayers = 0;
  try {
    const resolved = await resolveStatsSeason(STATS_YEAR, fetchSeasonStats);
    statsSeason = resolved.season;
    statsMatched = mergeStats(basePlayers, resolved.stats, resolved.season);

    // Same season the season-totals resolved to, so the log and the summary
    // line can never describe different years.
    const logs = await mergeGameLogs(basePlayers, resolved.season);
    gameLogWeeks = logs.weeksLoaded;
    gameLogPlayers = logs.playersWithLog;

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

  // 7) Drop rows this run did not rewrite. Deliberately after the write: a
  // failed write must never be followed by a delete. Stale rows are a
  // performance problem, not a correctness one, so a prune failure is logged
  // and swallowed rather than failing a sync that already wrote good data.
  let prune = { pruned: 0, skipped: true };
  try {
    prune = await pruneStale({ table, sport: "nfl", runStartedAt, wrote });
  } catch (e) {
    console.error(`[sync] prune failed (players were still written): ${e.message}`);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      sport: "nfl",
      total: basePlayers.length,
      wrote,
      pruned: prune.pruned,
      pruneSkipped: prune.skipped,
      adpTeams: ADP_TEAMS,
      adpYear: ADP_YEAR,
      withAdp: countsByFormat,
      formats: FORMATS,
      statsSeason,
      statsMatched,
      gameLogWeeks,
      gameLogPlayers,
    }),
  };
};

// SAM invokes syncPlayers.handler, so it must remain exported. These are added
// for testing; the handler assignment above is unchanged.
module.exports.FETCH_TIMEOUT_MS = FETCH_TIMEOUT_MS;
module.exports.fetchSeasonStats = fetchSeasonStats;
module.exports.STATS_FIELDS = STATS_FIELDS;
module.exports.pickStats = pickStats;
module.exports.hasPlayedGames = hasPlayedGames;
module.exports.resolveStatsSeason = resolveStatsSeason;
module.exports.mergeStats = mergeStats;
module.exports.pickAvailability = pickAvailability;
module.exports.pruneStale = pruneStale;
module.exports.MIN_EXPECTED_PLAYERS = MIN_EXPECTED_PLAYERS;
module.exports.normalizeSleeperPlayer = normalizeSleeperPlayer;
module.exports.WEEK_FIELDS = WEEK_FIELDS;
module.exports.SEASON_WEEKS = SEASON_WEEKS;
module.exports.isPlayerId = isPlayerId;
module.exports.pickWeek = pickWeek;
module.exports.mergeGameLogs = mergeGameLogs;
module.exports.fetchWeekStats = fetchWeekStats;
