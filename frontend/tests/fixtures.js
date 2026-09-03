export const MOCK_PLAYERS = [
  { id: "p1",  name: "Christian McCaffrey", position: "RB",  team: "SF",  rank: 1,  adp: 1.2,  tier: 1 },
  { id: "p2",  name: "Justin Jefferson",    position: "WR",  team: "MIN", rank: 2,  adp: 2.1,  tier: 1 },
  { id: "p3",  name: "CeeDee Lamb",         position: "WR",  team: "DAL", rank: 3,  adp: 3.0,  tier: 1 },
  { id: "p4",  name: "Tyreek Hill",         position: "WR",  team: "MIA", rank: 4,  adp: 4.3,  tier: 1 },
  { id: "p5",  name: "Ja'Marr Chase",       position: "WR",  team: "CIN", rank: 5,  adp: 5.1,  tier: 1 },
  { id: "p6",  name: "Bijan Robinson",      position: "RB",  team: "ATL", rank: 6,  adp: 6.2,  tier: 2 },
  { id: "p7",  name: "Saquon Barkley",      position: "RB",  team: "PHI", rank: 7,  adp: 7.0,  tier: 2 },
  { id: "p8",  name: "Davante Adams",       position: "WR",  team: "LV",  rank: 8,  adp: 8.4,  tier: 2 },
  { id: "p9",  name: "Stefon Diggs",        position: "WR",  team: "BUF", rank: 9,  adp: 9.1,  tier: 2 },
  { id: "p10", name: "Travis Kelce",        position: "TE",  team: "KC",  rank: 10, adp: 10.5, tier: 2 },
  { id: "p11", name: "Amon-Ra St. Brown",   position: "WR",  team: "DET", rank: 11, adp: 11.2, tier: 2 },
  { id: "p12", name: "Tony Pollard",        position: "RB",  team: "TEN", rank: 12, adp: 12.0, tier: 3 },
  { id: "p13", name: "Josh Allen",          position: "QB",  team: "BUF", rank: 13, adp: 13.1, tier: 1 },
  { id: "p14", name: "Lamar Jackson",       position: "QB",  team: "BAL", rank: 14, adp: 14.5, tier: 1 },
  { id: "p15", name: "Deebo Samuel",        position: "WR",  team: "SF",  rank: 15, adp: 15.3, tier: 3 },
  { id: "p16", name: "Austin Ekeler",       position: "RB",  team: "LAC", rank: 16, adp: 16.0, tier: 3 },
  { id: "p17", name: "Derrick Henry",       position: "RB",  team: "TEN", rank: 17, adp: 17.2, tier: 3 },
  { id: "p18", name: "Mark Andrews",        position: "TE",  team: "BAL", rank: 18, adp: 18.0, tier: 2 },
  { id: "p19", name: "Patrick Mahomes",     position: "QB",  team: "KC",  rank: 19, adp: 19.5, tier: 2 },
  { id: "p20", name: "Keenan Allen",        position: "WR",  team: "CHI", rank: 20, adp: 20.1, tier: 3 },
  { id: "p21", name: "DK Metcalf",          position: "WR",  team: "SEA", rank: 21, adp: 21.3, tier: 3 },
  { id: "p22", name: "Jalen Hurts",         position: "QB",  team: "PHI", rank: 22, adp: 22.0, tier: 2 },
  { id: "p23", name: "Najee Harris",        position: "RB",  team: "PIT", rank: 23, adp: 23.4, tier: 3 },
  { id: "p24", name: "Tyler Higbee",        position: "TE",  team: "LAR", rank: 24, adp: 24.1, tier: 3 },
  { id: "p25", name: "Brandon Aiyuk",       position: "WR",  team: "SF",  rank: 25, adp: 25.0, tier: 3 },
  { id: "p26", name: "Chris Boswell",       position: "K",   team: "PIT", rank: 26, adp: 120.0, tier: 1 },
  { id: "p27", name: "Evan McPherson",      position: "K",   team: "CIN", rank: 27, adp: 122.0, tier: 1 },
  { id: "p28", name: "San Francisco 49ers", position: "DEF", team: "SF",  rank: 28, adp: 110.0, tier: 1 },
  { id: "p29", name: "Dallas Cowboys",      position: "DEF", team: "DAL", rank: 29, adp: 112.0, tier: 1 },
  { id: "p30", name: "Tee Higgins",         position: "WR",  team: "CIN", rank: 30, adp: 30.0, tier: 4 },
];

function buildSnakePicks(teams, rounds) {
  const picks = [];
  let overall = 1;
  for (let r = 1; r <= rounds; r++) {
    const forward = r % 2 === 1;
    const order = forward
      ? Array.from({ length: teams }, (_, i) => i + 1)
      : Array.from({ length: teams }, (_, i) => teams - i);
    for (const team of order) {
      picks.push({ overall, round: r, team, playerId: null, player: null });
      overall++;
    }
  }
  return picks;
}

export const DRAFT_ID = "test-draft-abc123";

export function makeDraftState({
  currentIndex = 0,
  completedPicks = [],
  boardId = null,
  format = "standard",
} = {}) {
  const picks = buildSnakePicks(12, 15);
  for (const { idx, player } of completedPicks) {
    picks[idx].playerId = player.id;
    picks[idx].player = player;
  }
  const current = picks[currentIndex] || null;
  return {
    draftId: DRAFT_ID,
    sport: "nfl",
    format,
    boardId,
    year: 2025,
    teams: 12,
    rounds: 15,
    userTeam: 1,
    picked: completedPicks.map(({ player }) => player.id),
    currentIndex,
    currentRound: current?.round ?? 15,
    currentPick: current ? (current.overall % 12) || 12 : 12,
    currentTeam: current?.team ?? null,
    completed: currentIndex >= picks.length,
    picks,
  };
}

export function makeCompletedDraft() {
  const picks = buildSnakePicks(4, 3);
  MOCK_PLAYERS.slice(0, 12).forEach((player, i) => {
    picks[i].playerId = player.id;
    // Production stores the full seven-field snapshot taken at draft time.
    picks[i].player = {
      id: player.id,
      name: player.name,
      position: player.position,
      team: player.team,
      rank: player.rank,
      adp: player.adp,
      tier: player.tier,
    };
  });
  return {
    draftId: DRAFT_ID,
    sport: "nfl",
    format: "standard",
    year: 2025,
    teams: 4,
    rounds: 3,
    userTeam: 1,
    rosterSlots: ["QB", "RB", "RB", "WR", "WR", "TE", "K", "DEF"],
    picked: MOCK_PLAYERS.slice(0, 12).map((p) => p.id),
    currentIndex: 12,
    currentRound: 3,
    currentPick: 4,
    currentTeam: null,
    completed: true,
    picks,
  };
}

export const BOARD_ID = "test-board-xyz789";

export function makeBoardState({ order = null, added = 0, removed = 0 } = {}) {
  const source = order
    ? order.map((id) => MOCK_PLAYERS.find((p) => p.id === id))
    : MOCK_PLAYERS.slice(0, 10);

  return {
    boardId: BOARD_ID,
    name: "My PPR Board",
    sport: "nfl",
    format: "ppr",
    season: 2026,
    version: 1,
    changelog: { added, removed },
    rows: source.map((p, i) => ({
      playerId: p.id,
      name: p.name,
      position: p.position,
      team: p.team,
      myRank: i + 1,
      consensusRank: p.rank,
      delta: p.rank - (i + 1),
      isNew: false,
    })),
  };
}

export const API_BASE = "http://localhost:9999";

// Routes the two endpoints the draft page loads: the player pool and the
// draft itself. Shared because several specs need an identical mock; a
// drifted copy in one file would make its tests silently disagree with
// the others about what the page is rendering.
// A game log with a real gap in it. Week 3 is missing on purpose: a player
// who missed a week must render as "did not play", never as a row of zeroes,
// and a fixture with every week present could not tell the two apart.
export const MOCK_GAME_LOG = [
  { wk: 1, rush_att: 14, rush_yd: 82, rush_td: 1, rec_tgt: 5, rec: 4, rec_yd: 31,
    off_snp: 40, tm_off_snp: 62, pts_ppr: 21.3 },
  { wk: 2, rush_att: 9, rush_yd: 25, rec_tgt: 2, rec: 1, rec_yd: 4,
    off_snp: 22, tm_off_snp: 61, pts_ppr: 4.9 },
  { wk: 4, rush_att: 21, rush_yd: 140, rush_td: 2, rec_tgt: 4, rec: 4, rec_yd: 45, rec_td: 1,
    off_snp: 55, tm_off_snp: 63, pts_ppr: 41.5 },
];

export function mockDraftApis(page, draftState) {
  page.route(`${API_BASE}/players*`, async (route) => {
    await route.fulfill({ json: { players: MOCK_PLAYERS } });
  });

  // Registered after the list route and therefore matched first: Playwright
  // tries handlers in reverse order, and `/players*` would otherwise swallow
  // `/players/p1` and hand the drill-down the whole pool.
  page.route(`${API_BASE}/players/*`, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const base = MOCK_PLAYERS.find((p) => p.id === id);
    if (!base) return route.fulfill({ status: 404, json: { error: "Player not found" } });
    await route.fulfill({
      json: { player: { ...base, gameLog: MOCK_GAME_LOG, gameLogSeason: 2025, gameLogThrough: 18 } },
    });
  });
  page.route(`${API_BASE}/drafts/${DRAFT_ID}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: draftState });
    }
  });
}
