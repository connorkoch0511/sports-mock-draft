// Average draft position from Fantasy Football Calculator, and the lookup
// maps that join it onto Sleeper's players.

const { FETCH_TIMEOUT_MS } = require("./http");
const { ALLOWED, normName, normTeam, toAppPos } = require("./normalize");

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

module.exports = { fetchFfcAdp, buildFfcMap };
