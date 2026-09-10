export const MOCK_PLAYERS = [
  // p1 is the only pool player carrying season totals, and every number is
  // the sum of MOCK_GAME_LOG below. The drill-down renders the advice panel
  // and the game log together, so a statless p1 produced a page that called
  // the number-one player a rookie directly above a table of his games --
  // which is what the committed screenshot showed. The rest of the pool
  // stays statless on purpose, so tests that need that shape still have it.
  { id: "p1",  name: "Christian McCaffrey", position: "RB",  team: "SF",  rank: 1,  adp: 1.2,  tier: 1,
    statsSeason: 2025,
    stats: { gp: 3, rush_att: 44, rush_yd: 247, rush_td: 3, rec_tgt: 11, rec: 9,
             rec_yd: 80, rec_td: 1, off_snp: 117, tm_off_snp: 186, pts_ppr: 67.7 } },
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

export const INVITE_TOKEN = "test-invite-token-xyz";

export function makeDraftState({
  currentIndex = 0,
  completedPicks = [],
  boardId = null,
  format = "standard",
  userTeam = 1,
  // Every real GET /drafts/{draftId} carries an inviteToken -- the copy-invite
  // button on the draft page reads it straight off this state. A fixture that
  // never set it is exactly how that button went untested for as long as it
  // did: every mock served `undefined`, the button still rendered a link, and
  // nobody noticed it read "?t=undefined".
  inviteToken = INVITE_TOKEN,
  // The real GET /drafts/{draftId} always carries a `seats` list -- one
  // human (the creator) and a bot in every other team -- and the page reads
  // it to decide whose turn is a bot's to take. Defaulting it here the same
  // way backend/src/lib/owner.js's buildSeats does means a plain solo-draft
  // test gets that behavior for free, instead of only working because a
  // test happened to set `seats` by hand. A scenario that wants a second
  // human on the clock (or any other arrangement) passes its own `seats`.
  seats = Array.from({ length: 12 }, (_, i) => {
    const team = i + 1;
    return team === userTeam
      ? { team, sub: "me", kind: "human" }
      : { team, sub: null, kind: "bot" };
  }),
  // Every real GET carries these now. pickDeadline defaults a full minute out
  // so existing tests render a running clock that never reaches zero -- a
  // fixture that expired mid-test would have the page firing /expire into
  // whatever else that test was asserting.
  pickDeadline = Date.now() + 60000,
  pausedAt = null,
  pausedBy = null,
  yourBoardId = null,
} = {}) {
  const picks = buildSnakePicks(12, 15);
  for (const { idx, player } of completedPicks) {
    picks[idx].playerId = player.id;
    picks[idx].player = player;
  }
  const state = {
    draftId: DRAFT_ID,
    sport: "nfl",
    format,
    boardId,
    year: 2025,
    teams: 12,
    rounds: 15,
    userTeam,
    // Derived per caller on the real endpoint (seatOf(d, sub)?.team); for a
    // fixture representing the creator's own view, that's just their team.
    yourTeam: userTeam,
    seats,
    inviteToken,
    picked: completedPicks.map(({ player }) => player.id),
    currentIndex,
    picks,
    pickDeadline,
    pausedAt,
    pausedBy,
    yourBoardId,
    // The page measures clock skew against this. A fixture omitting it would
    // silently exercise the zero-skew path only.
    now: Date.now(),
  };
  // currentRound/currentPick/currentTeam/completed are DERIVED from
  // currentIndex, not independent facts -- a real GET always returns them in
  // agreement. A plain copied value here would go stale the moment a test
  // mutates `state.currentIndex` afterward to simulate the draft advancing
  // (a natural way to move a scenario's clock forward), silently reproducing
  // exactly the "static double that never advances" failure mode this fixture
  // exists to avoid. Getters keep them truthful to whatever currentIndex is
  // at read time instead.
  Object.defineProperty(state, "currentRound", {
    enumerable: true,
    get() { return (picks[state.currentIndex] || null)?.round ?? 15; },
  });
  Object.defineProperty(state, "currentPick", {
    enumerable: true,
    get() {
      const current = picks[state.currentIndex] || null;
      return current ? (current.overall % 12) || 12 : 12;
    },
  });
  Object.defineProperty(state, "currentTeam", {
    enumerable: true,
    get() { return (picks[state.currentIndex] || null)?.team ?? null; },
  });
  Object.defineProperty(state, "completed", {
    enumerable: true,
    get() { return state.currentIndex >= picks.length; },
  });
  return state;
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

// The exact top-level shape backend/src/drafts.js's GET /drafts/{draftId}
// returns (see the pinned "GET /drafts/{id} found returns the full draft
// object" test on the backend). Serving `draftState` verbatim -- as this
// mock used to -- let a test invent a field the real endpoint never sends
// (that is exactly how `seats` went unnoticed for as long as it did: a test
// set it, the mock echoed it, and the suite stayed green while production
// never returned it at all). Routing every response through this projection
// means only fields the real contract actually carries can reach a test, and
// a `seats` entry is reduced the same way the server reduces it -- to `team`
// and `kind`, dropping `sub` -- so a test cannot exercise a shape the client
// will never actually receive.
function toDraftResponse(state) {
  return {
    draftId: state.draftId,
    sport: state.sport,
    format: state.format,
    year: state.year,
    teams: state.teams,
    rounds: state.rounds,
    userTeam: state.userTeam,
    yourTeam: state.yourTeam,
    seats: (state.seats ?? []).map((s) => ({ team: s.team, kind: s.kind })),
    rosterSlots: state.rosterSlots,
    boardId: state.boardId,
    // The board that would actually drive the caller's auto-pick, already
    // resolved -- see backend/src/drafts.js's own GET handler.
    yourBoardId: state.yourBoardId ?? null,
    inviteToken: state.inviteToken,
    picked: state.picked,
    version: state.version,
    pickDeadline: state.pickDeadline ?? null,
    pausedAt: state.pausedAt ?? null,
    pausedBy: state.pausedBy ?? null,
    // The page corrects for clock skew against this. A projection that
    // dropped it would silently exercise the zero-skew path only.
    now: state.now ?? Date.now(),
    currentIndex: state.currentIndex,
    currentRound: state.currentRound,
    currentPick: state.currentPick,
    currentTeam: state.currentTeam,
    completed: state.completed,
    picks: state.picks,
  };
}

// The stateful POST /pause handler, hand-copied often enough (mockDraftApis
// below, plus three specs that build their draft route by hand instead of
// borrowing mockDraftApis) that a drifted copy was only a matter of time.
// Pausing stamps pausedAt/pausedBy; resuming clears both and -- as the real
// endpoint does -- hands out a fresh pickDeadline, since a resumed draft
// gets a full turn again rather than picking up mid-countdown.
//
// `by` defaults to "user-me": the same default `sub` signIn() writes into
// the signed-in session (see auth.js), so a test that signs in with the
// default identity and pauses through this route sees a SELF-pause, not a
// mismatched one that renders "Paused by someone else" to the person who
// just clicked Pause. A test exercising someone else's pause passes a
// different `by`, or (as "a draft somebody else paused shows as paused
// here" does) sets pausedBy directly on the fixture instead of pausing
// through this route at all.
export function pauseRoute(state, { by = "user-me" } = {}) {
  return async (r) => {
    const { paused } = JSON.parse(r.request().postData() || "{}");
    state.pausedAt = paused ? Date.now() : null;
    state.pausedBy = paused ? by : null;
    if (!paused) state.pickDeadline = Date.now() + 60000;
    return r.fulfill({
      json: { ok: true, pausedAt: state.pausedAt, pausedBy: state.pausedBy, pickDeadline: state.pickDeadline },
    });
  };
}

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
      await route.fulfill({ json: toDraftResponse(draftState) });
    }
  });

  // Pause is server state as of Phase 2. The GET route above must serve the
  // draft as it is NOW, so mutate the object the GET closes over rather than
  // answering ok and forgetting.
  page.route(`${API_BASE}/drafts/${DRAFT_ID}/pause`, pauseRoute(draftState));

  page.route(`${API_BASE}/drafts/${DRAFT_ID}/expire`, (r) =>
    r.fulfill({ status: 409, json: { error: "Clock has not expired" } })
  );
}
