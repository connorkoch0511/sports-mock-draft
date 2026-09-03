const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  BatchWriteCommand,
} = require("@aws-sdk/lib-dynamodb");

const { FETCH_TIMEOUT_MS } = require("./sync/http");
const {
  ALLOWED,
  FORMATS,
  chunk,
  sleep,
  normName,
  normTeam,
  toAppPos,
  isSleeperDefense,
  normalizeSleeperPlayer,
  pickAvailability,
} = require("./sync/normalize");
const { fetchFfcAdp, buildFfcMap } = require("./sync/adp");
const {
  STATS_FIELDS,
  fetchSeasonStats,
  pickStats,
  hasPlayedGames,
  resolveStatsSeason,
  mergeStats,
} = require("./sync/stats");
const { pruneStale, MIN_EXPECTED_PLAYERS } = require("./sync/prune");
const {
  SEASON_WEEKS,
  WEEK_FIELDS,
  fetchWeekStats,
  isPlayerId,
  pickWeek,
  mergeGameLogs,
} = require("./sync/gameLogs");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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

// SAM invokes syncPlayers.handler, so it must remain exported. The rest are
// re-exported from their modules so the existing tests keep one import site.
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
