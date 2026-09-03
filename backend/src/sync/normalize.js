// Turning Sleeper's dump into the shape this app stores.

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
    // Distinguishes a rookie with no NFL season from a veteran who missed the
    // whole year. Both have an empty game log, and saying "did not play" of a
    // rookie claims he was available and sat. Measured against the live feed:
    // 158 of the rostered fantasy pool are rookies, 32 have no value at all.
    ...(Number.isInteger(p.years_exp) ? { yearsExp: p.years_exp } : {}),
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

module.exports = {
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
};
