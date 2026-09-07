// Average draft position from ESPN's public fantasy read API, and the lookup
// maps that join it onto Sleeper's players.
//
// The endpoint needs no authentication of any kind -- verified 7 Sep 2026.

const { FETCH_TIMEOUT_MS } = require("./http");
const { normName, normTeam } = require("./normalize");
const { newAdpMaps, putAdp } = require("./adpMap");

// ESPN sends numeric ids and NO string abbreviation anywhere in the payload,
// so these tables are not a convenience -- nothing joins without them. Derived
// by cross-referencing 300 ESPN players against Sleeper by name; every team id
// resolved with no ambiguity. Ids 31 and 32 are unused by ESPN.
const ESPN_POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF" };

const ESPN_TEAM = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR",
  15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI",
  22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS",
  29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

async function fetchEspnAdp({ year, limit }) {
  // sortDraftRanks orders the response so `limit` takes the players people
  // actually draft rather than an arbitrary slice.
  const filter = JSON.stringify({
    players: { limit, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "PPR" } },
  });

  const url =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${encodeURIComponent(year)}` +
    `/segments/0/leaguedefaults/3?view=kona_player_info`;

  const r = await fetch(url, {
    headers: { "x-fantasy-filter": filter },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`ESPN ADP fetch failed: ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.players) ? j.players : [];
}

function buildEspnMap(rows) {
  const maps = newAdpMaps();

  for (const row of rows) {
    const p = row?.player;
    if (!p) continue;

    const adp = p.ownership?.averageDraftPosition != null
      ? Number(p.ownership.averageDraftPosition)
      : null;

    const pos = ESPN_POS[p.defaultPositionId];
    const rawTeam = ESPN_TEAM[p.proTeamId];
    // An id we do not recognise is dropped rather than keyed on something
    // invented -- a bogus key would sit in the map forever matching nobody.
    if (!pos || !rawTeam) continue;

    putAdp(maps, {
      pos,
      team: normTeam(rawTeam),
      nameKey: normName(p.fullName),
      adp,
    });
  }

  return maps;
}

module.exports = { fetchEspnAdp, buildEspnMap, ESPN_POS, ESPN_TEAM };
