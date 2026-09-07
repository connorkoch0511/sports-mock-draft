// Average draft position from Yahoo's public read-only fantasy API, and the
// lookup maps that join it onto Sleeper's players.
//
// The endpoint needs no authentication -- verified 7 Sep 2026. This is NOT the
// OAuth fantasy API; it is the public game-level draft analysis feed.

const { FETCH_TIMEOUT_MS } = require("./http");
const { normName, normTeam, toAppPos, sleep } = require("./normalize");
const { newAdpMaps, putAdp } = require("./adpMap");

const BASE = "https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/game/nfl/players";

/**
 * Yahoo nests a player as an array of mixed objects and objects keyed by
 * numeric strings. Walking it and collecting every scalar is far more robust
 * than indexing a path that shifts whenever they add a field.
 */
function flattenYahooPlayer(node) {
  const flat = {};
  const walk = (x) => {
    if (Array.isArray(x)) {
      for (const y of x) walk(y);
    } else if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) {
        if (v && typeof v === "object") walk(v);
        else if (flat[k] === undefined) flat[k] = v;
      }
    }
  };
  walk(node);
  return flat;
}

async function fetchYahooPage({ start, count }) {
  const url =
    `${BASE};position=ALL;start=${start};count=${count};sort=rank_season;out=draft_analysis?format=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Yahoo ADP fetch failed: ${r.status}`);
  const j = await r.json();

  const game = j?.fantasy_content?.game;
  const block = Array.isArray(game)
    ? game.find((part) => part && typeof part === "object" && part.players)
    : null;
  const players = block?.players;
  if (!players) return [];

  const n = Number(players.count) || 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const rec = players[String(i)]?.player;
    if (rec) out.push(flattenYahooPlayer(rec));
  }
  return out;
}

async function fetchYahooAdp({ count, pages }) {
  const all = [];
  for (let page = 0; page < pages; page++) {
    all.push(...(await fetchYahooPage({ start: page * count, count })));
    // Spaced like the FFC loop, so three quick calls do not look like a scrape.
    if (page < pages - 1) await sleep(250);
  }
  return all;
}

function buildYahooMap(players) {
  const maps = newAdpMaps();

  for (const p of players) {
    putAdp(maps, {
      pos: toAppPos(p.display_position),
      team: normTeam(p.editorial_team_abbr),
      nameKey: normName(p.full),
      // Yahoo sends ADP as a string, and "-" for a player nobody drafted --
      // Number("-") is NaN, which putAdp drops.
      adp: Number(p?.average_pick),
    });
  }

  return maps;
}

module.exports = { fetchYahooAdp, buildYahooMap, flattenYahooPlayer };
