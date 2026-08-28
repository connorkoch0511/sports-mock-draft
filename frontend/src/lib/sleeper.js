// Sleeper's read API needs no authentication and sends
// access-control-allow-origin: *, so the browser calls it directly. There is no
// backend proxy and no stored credential of any kind.
const BASE = "https://api.sleeper.app/v1";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper request failed (${res.status})`);
  return res.json();
}

/** Resolve a username to a Sleeper user. Throws if no such user exists. */
export async function fetchUser(username) {
  const name = String(username || "").trim();
  if (!name) throw new Error("Enter a Sleeper username");
  const user = await getJson(`${BASE}/user/${encodeURIComponent(name)}`);
  if (!user || !user.user_id) throw new Error(`No Sleeper user named "${name}"`);
  return user;
}

/** All of a user's NFL leagues for a season. */
export async function fetchLeagues(userId, season) {
  const leagues = await getJson(`${BASE}/user/${userId}/leagues/nfl/${season}`);
  return Array.isArray(leagues) ? leagues : [];
}

/** A league's draft, or null when none exists yet. */
export async function fetchLeagueDraft(leagueId) {
  const drafts = await getJson(`${BASE}/league/${leagueId}/drafts`);
  if (!Array.isArray(drafts) || drafts.length === 0) return null;
  return getJson(`${BASE}/draft/${drafts[0].draft_id}`);
}

/**
 * Map a league and its draft onto New Draft form values.
 * Pure — no network — so it is unit-tested against real league shapes.
 */
export function toDraftConfig(league, draft, userId) {
  const rosterSlots = Array.isArray(league?.roster_positions)
    ? league.roster_positions
    : [];

  // Scoring collapses to the three formats our ADP data actually has.
  const rec = league?.scoring_settings?.rec;
  const format = rec >= 1 ? "ppr" : rec === 0.5 ? "half-ppr" : "standard";

  // Rounds come from the DRAFT. league.settings.draft_rounds is a different
  // number entirely — it reads 3 for a 16-round draft.
  const rounds = Number(draft?.settings?.rounds) || rosterSlots.length || 15;

  const teams =
    Number(league?.total_rosters) || Number(draft?.settings?.teams) || 12;

  const slot = Number(draft?.draft_order?.[userId]);
  const userTeam =
    Number.isInteger(slot) && slot >= 1 && slot <= teams ? slot : 1;

  return {
    teams,
    rounds,
    format,
    rosterSlots,
    userTeam,
    leagueName: league?.name || "League",
  };
}
