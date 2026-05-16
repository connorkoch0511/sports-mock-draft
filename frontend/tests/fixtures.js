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

export function makeDraftState({ currentIndex = 0, completedPicks = [] } = {}) {
  const picks = buildSnakePicks(12, 15);
  for (const { idx, player } of completedPicks) {
    picks[idx].playerId = player.id;
    picks[idx].player = player;
  }
  const current = picks[currentIndex] || null;
  return {
    draftId: DRAFT_ID,
    sport: "nfl",
    format: "standard",
    year: 2025,
    teams: 12,
    rounds: 15,
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
    picks[i].player = { id: player.id, name: player.name, position: player.position, team: player.team };
  });
  return {
    draftId: DRAFT_ID,
    sport: "nfl",
    format: "standard",
    year: 2025,
    teams: 4,
    rounds: 3,
    picked: MOCK_PLAYERS.slice(0, 12).map((p) => p.id),
    currentIndex: 12,
    currentRound: 3,
    currentPick: 4,
    currentTeam: null,
    completed: true,
    picks,
  };
}
