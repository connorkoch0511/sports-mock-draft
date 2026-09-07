// The rules for putting an ADP into the lookup maps, in one place.
//
// Every source disagrees about field names but agrees about these rules, so
// they live here rather than once per adapter: earliest pick wins, defences
// are found by team because their names never match, and kickers get a
// name-only fallback because their team moves more often than they do.

const { ALLOWED } = require("./normalize");

function newAdpMaps() {
  return {
    byStrict: new Map(),  // pos|team|name
    defByTeam: new Map(), // team -> adp
    kByName: new Map(),   // nameKey -> adp
  };
}

function keepLowest(map, key, adp) {
  const prev = map.get(key);
  // Lowest wins: a player listed twice was drafted earliest at the lower
  // number, and that is the pick people are actually reasoning about.
  if (prev == null || adp < prev) map.set(key, adp);
}

function putAdp(maps, { pos, team, nameKey, adp }) {
  // Finite and above zero, not merely truthy. A bare `!adp || isNaN` lets two
  // values through that have no business in a draft position. Infinity is the
  // dangerous one: JSON.parse turns 1e999 into it, DynamoDB's marshall throws
  // on it, and the batch write that follows has no try/catch -- so one absurd
  // number from a third party leaves the players table half rewritten. A
  // negative is quieter but still wrong: it renders as a dash and then sorts
  // ABOVE players with real numbers.
  if (!pos || !team || !Number.isFinite(adp) || adp <= 0) return;

  if (pos === "DEF") {
    keepLowest(maps.defByTeam, team, adp);
    return;
  }

  if (pos === "K" && nameKey) keepLowest(maps.kByName, nameKey, adp);

  if (!ALLOWED.has(pos) || !nameKey) return;
  keepLowest(maps.byStrict, `${pos}|${team}|${nameKey}`, adp);
}

module.exports = { newAdpMaps, putAdp };
