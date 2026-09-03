// Season totals: fetching them, curating which fields are kept, and joining
// them onto players.

const { FETCH_TIMEOUT_MS } = require("./http");

async function fetchSeasonStats(season) {
  const url = `https://api.sleeper.app/v1/stats/nfl/regular/${season}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Sleeper stats fetch failed (${season}): ${r.status}`);
  return r.json();
}

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

module.exports = {
  STATS_FIELDS,
  fetchSeasonStats,
  pickStats,
  hasPlayedGames,
  resolveStatsSeason,
  mergeStats,
};
