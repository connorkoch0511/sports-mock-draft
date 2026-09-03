// Week-by-week game logs.

const { FETCH_TIMEOUT_MS } = require("./http");

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

module.exports = {
  SEASON_WEEKS,
  WEEK_FIELDS,
  fetchWeekStats,
  isPlayerId,
  pickWeek,
  mergeGameLogs,
};
