import test from "node:test";
import assert from "node:assert";
import { adviseOnPick } from "./pickAdvice.js";

// ---------------------------------------------------------------------------
// Fixtures
//
// A ranked player from GET /players carries id/name/position/team/rank/adp/
// tier and nothing else guaranteed. `stats`, `statsSeason`, `injuryStatus`,
// `injuryBodyPart` and `depthChartOrder` are all optional, so the helper adds
// only what a test asks for -- never a manufactured empty stats object.
// ---------------------------------------------------------------------------

function player(id, extra = {}) {
  return {
    id: String(id),
    name: `Player ${id}`,
    position: "RB",
    team: "SF",
    rank: null,
    adp: null,
    tier: null,
    ...extra,
  };
}

/** The overall pick order of a snake draft, teams x rounds, nobody picked. */
function snakePicks(teams, rounds) {
  const out = [];
  let overall = 1;
  for (let round = 1; round <= rounds; round++) {
    for (let i = 1; i <= teams; i++) {
      const team = round % 2 === 1 ? i : teams - i + 1;
      out.push({ overall: overall++, round, team, playerId: null, player: null });
    }
  }
  return out;
}

/**
 * A draft in the shape GET /drafts/{id} returns: the full pick list with the
 * first `made.length` entries filled, in overall order. Which team owns each
 * made pick comes from the snake, exactly as it does live.
 */
function makeDraft({
  teams = 2,
  rounds = 2,
  userTeam = 1,
  rosterSlots = [],
  made = [],
  ...rest
} = {}) {
  const picks = snakePicks(teams, rounds);
  made.forEach((p, i) => {
    picks[i].playerId = p.id;
    picks[i].player = p;
  });
  return {
    draftId: "d1",
    sport: "nfl",
    format: "ppr",
    teams,
    rounds,
    userTeam,
    rosterSlots,
    boardId: null,
    picked: made.map((p) => p.id),
    currentIndex: made.length,
    currentTeam: picks[made.length]?.team ?? null,
    completed: made.length >= picks.length,
    picks,
    ...rest,
  };
}

function filler(i, position = "QB") {
  return player(`fill${i}`, { position, rank: 500 + i });
}
function fillers(n, position = "QB") {
  return Array.from({ length: n }, (_, i) => filler(i, position));
}

function kinds(reasons) {
  return reasons.map((r) => r.kind);
}

/**
 * A deterministic pool that exercises every branch: ranked and unranked,
 * with and without stats, every injury status seen live, depth-chart 0
 * through 4, and ADPs on both sides of the pick.
 */
function generatedPool(n = 36) {
  let seed = 20260827;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const positions = ["QB", "RB", "WR", "TE", "K", "DEF"];
  const statuses = [null, null, "IR", "Questionable", "PUP", "Sus", "NA", "COV"];

  const pool = [];
  for (let i = 0; i < n; i++) {
    const ranked = rand() < 0.9;
    const p = player(`g${i}`, {
      position: positions[Math.floor(rand() * positions.length)],
      team: "DET",
      rank: ranked ? i + 1 : null,
      adp: ranked ? Math.max(0.5, Math.round((i + 1 + (rand() * 24 - 12)) * 10) / 10) : null,
      tier: ranked ? Math.ceil((i + 1) / 8) : null,
    });

    const status = statuses[Math.floor(rand() * statuses.length)];
    if (status) {
      p.injuryStatus = status;
      if (status === "Questionable" && rand() < 0.5) p.injuryBodyPart = "Hamstring";
    }
    if (rand() < 0.75) p.depthChartOrder = Math.floor(rand() * 5);
    if (ranked && rand() < 0.8) {
      p.statsSeason = 2025;
      p.stats = {
        gp: 17,
        rec_tgt: Math.floor(rand() * 170),
        rush_att: Math.floor(rand() * 290),
        off_snp: Math.floor(rand() * 1000),
        tm_off_snp: 1000,
        rec_rz_tgt: Math.floor(rand() * 20),
        pos_rank_ppr: Math.floor(rand() * 80) + 1,
        pts_ppr: Math.round(rand() * 3000) / 10,
      };
    }
    pool.push(p);
  }
  return pool;
}

function generatedAdvice() {
  const players = generatedPool();
  // Slot 1 of 12 on the clock at pick 1, not up again until 24: far enough
  // away that positions genuinely run out before the user's next turn.
  const draft = makeDraft({
    teams: 12,
    rounds: 15,
    userTeam: 1,
    rosterSlots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN"],
    made: [],
  });
  return { players, draft, out: adviseOnPick({ players, draft, boardRows: null, myTeam: 1 }) };
}

// ---------------------------------------------------------------------------
// The invariant: the reasons ARE the scoring factors.
// ---------------------------------------------------------------------------

test("invariant: every reason carries a non-zero weight, across a generated pool", () => {
  const { out } = generatedAdvice();

  assert.ok(out.ranked.length > 30, "the generated pool must actually be scored");

  let reasonCount = 0;
  for (const entry of out.ranked) {
    for (const r of entry.reasons) {
      reasonCount++;
      assert.ok(
        typeof r.weight === "number" && Number.isFinite(r.weight) && r.weight !== 0,
        `${entry.player.id}: reason "${r.kind}" (${r.text}) carries weight ${r.weight}; ` +
          "a reason that did not move the ranking is decoration"
      );
      assert.ok(typeof r.kind === "string" && r.kind.length > 0);
      assert.ok(typeof r.text === "string" && r.text.length > 0);
    }
  }
  assert.ok(reasonCount > 60, `only ${reasonCount} reasons produced; the pool is not exercising the factors`);
});

test("invariant: a player's score is exactly the base plus the sum of his reasons' weights", () => {
  const { out } = generatedAdvice();

  for (const entry of out.ranked) {
    const rebuilt = entry.reasons.reduce((sum, r) => sum + r.weight, entry.base);
    assert.strictEqual(
      entry.score,
      rebuilt,
      `${entry.player.id}: score ${entry.score} != base ${entry.base} + reasons ${rebuilt - entry.base}; ` +
        "a contribution with no reason is an unexplained ranking"
    );
  }
});

test("invariant: the generated pool exercises every factor at least once", () => {
  const { out } = generatedAdvice();
  const seen = new Set();
  for (const entry of out.ranked) for (const r of entry.reasons) seen.add(r.kind);

  for (const kind of [
    "value",
    "need",
    "scarcity",
    "tier-cliff",
    "availability",
    "depth-chart",
    "opportunity",
    "snap-share",
    "red-zone",
    "finish",
    "no-production",
  ]) {
    assert.ok(seen.has(kind), `no "${kind}" reason ever fired -- a factor that never fires is dead weight`);
  }
});

test("invariant: reasonsFor returns exactly the reasons the ranking used", () => {
  const { out } = generatedAdvice();

  for (const entry of out.ranked.slice(0, 12)) {
    assert.deepStrictEqual(out.reasonsFor(entry.player.id), entry.reasons);
  }
  assert.deepStrictEqual(out.recommendation.reasons, out.ranked[0].reasons);
  assert.strictEqual(out.recommendation.player.id, out.ranked[0].player.id);
});

// ---------------------------------------------------------------------------
// Value: overall - adp. Positive means he FELL to you.
// ---------------------------------------------------------------------------

test("a player who fell past his ADP earns a value reason with a positive weight", () => {
  const p = player("a", { rank: 1, adp: 5.5 });
  const draft = makeDraft({ teams: 2, rounds: 12, made: fillers(19) });
  const out = adviseOnPick({ players: [p], draft, boardRows: null, myTeam: 1 });

  const value = out.reasonsFor("a").find((r) => r.kind === "value");
  assert.ok(value, "a player 14.5 picks past his ADP must earn a value reason");
  assert.ok(value.weight > 0, `expected a positive weight, got ${value.weight}`);
  assert.match(value.text, /5\.5/);
});

test("a player taken ahead of his ADP earns a value reason with a negative weight", () => {
  const p = player("a", { rank: 1, adp: 25.5 });
  const draft = makeDraft({ teams: 2, rounds: 12, made: [] });
  const out = adviseOnPick({ players: [p], draft, boardRows: null, myTeam: 1 });

  const value = out.reasonsFor("a").find((r) => r.kind === "value");
  assert.ok(value, "reaching 24.5 picks ahead of ADP must be said out loud");
  assert.ok(value.weight < 0, `expected a negative weight, got ${value.weight}`);
});

test("a player with no ADP earns no value reason at all", () => {
  const p = player("a", { rank: 1, adp: null });
  const draft = makeDraft({ teams: 2, rounds: 12, made: fillers(19) });
  const out = adviseOnPick({ players: [p], draft, boardRows: null, myTeam: 1 });

  assert.ok(!kinds(out.reasonsFor("a")).includes("value"));
});

// ---------------------------------------------------------------------------
// Roster need, via fitRoster.
// ---------------------------------------------------------------------------

test("a player filling an unfilled roster slot earns a need reason; one whose slot is full does not", () => {
  const mine = player("mine", { position: "RB", rank: 1 });
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, rosterSlots: ["RB", "WR"], made: [mine] });
  const wr = player("wr", { position: "WR", rank: 2 });
  const rb = player("rb", { position: "RB", rank: 3 });
  const out = adviseOnPick({ players: [wr, rb], draft, boardRows: null, myTeam: 1 });

  const need = out.reasonsFor("wr").find((r) => r.kind === "need");
  assert.ok(need, "the open WR slot must be a reason to take a WR");
  assert.ok(need.weight > 0);
  assert.match(need.text, /WR/);

  assert.ok(
    !kinds(out.reasonsFor("rb")).includes("need"),
    "the RB slot is already filled -- a need reason here would be decoration"
  );
});

test("a FLEX-eligible player fills an open FLEX slot; an ineligible one does not", () => {
  const mine = player("mine", { position: "RB", rank: 1 });
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, rosterSlots: ["RB", "FLEX"], made: [mine] });
  const wr = player("wr", { position: "WR", rank: 2 });
  const qb = player("qb", { position: "QB", rank: 3 });
  const out = adviseOnPick({ players: [wr, qb], draft, boardRows: null, myTeam: 1 });

  const need = out.reasonsFor("wr").find((r) => r.kind === "need");
  assert.ok(need, "a WR is FLEX-eligible and the FLEX is open");
  assert.match(need.text, /FLEX/);

  assert.ok(
    !kinds(out.reasonsFor("qb")).includes("need"),
    "a QB cannot fill a FLEX slot"
  );
});

test("a player who only lands on the bench earns no need reason", () => {
  const mine = player("mine", { position: "RB", rank: 1 });
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, rosterSlots: ["RB", "BN"], made: [mine] });
  const wr = player("wr", { position: "WR", rank: 2 });
  const out = adviseOnPick({ players: [wr], draft, boardRows: null, myTeam: 1 });

  assert.ok(
    !kinds(out.reasonsFor("wr")).includes("need"),
    "bench capacity is not a roster need"
  );
});

// ---------------------------------------------------------------------------
// Scarcity, measured against the user's NEXT pick.
// ---------------------------------------------------------------------------

function scarcityPool() {
  // Five QBs and one TE at the top, then a deep run of RBs, then one more TE
  // far down the board. QB empties completely inside 23 picks; TE leaves one
  // survivor; RB never runs thin.
  const out = [];
  for (let i = 1; i <= 5; i++) out.push(player(`qb${i}`, { position: "QB", rank: i, tier: 1 }));
  out.push(player("teEarly", { position: "TE", rank: 6, tier: 1 }));
  for (let i = 0; i < 40; i++) out.push(player(`rb${i}`, { position: "RB", rank: 7 + i, tier: 1 }));
  out.push(player("teLate", { position: "TE", rank: 60, tier: 1 }));
  return out;
}

test("scarcity is measured against the user's next pick, not the end of the draft", () => {
  const players = scarcityPool();

  // Slot 1 of 12 picks at 1 and then not again until 24: 23 picks away.
  const early = makeDraft({ teams: 12, rounds: 15, userTeam: 1, made: [] });
  const far = adviseOnPick({ players, draft: early, boardRows: null, myTeam: 1 });
  const scarce = far.reasonsFor("qb1").find((r) => r.kind === "scarcity");
  assert.ok(scarce, "with 23 picks until your next turn, two QBs at the top are scarce");
  assert.ok(scarce.weight > 0);
  assert.match(scarce.text, /24/, "the reason must name the pick it is measured against");

  // Slot 12 of 12 picks at 12 and again at 13: one pick away.
  const turn = makeDraft({ teams: 12, rounds: 15, userTeam: 12, made: fillers(11, "TE") });
  const near = adviseOnPick({ players, draft: turn, boardRows: null, myTeam: 12 });
  assert.ok(
    !kinds(near.reasonsFor("qb1")).includes("scarcity"),
    "back-to-back picks leave nothing time to become scarce"
  );
});

test("a player deep in the pool is not called scarce -- he will still be there", () => {
  const players = scarcityPool();
  const draft = makeDraft({ teams: 12, rounds: 15, userTeam: 1, made: [] });
  const out = adviseOnPick({ players, draft, boardRows: null, myTeam: 1 });

  assert.ok(
    kinds(out.reasonsFor("teEarly")).includes("scarcity"),
    "the early TE runs out before pick 24"
  );
  assert.ok(
    !kinds(out.reasonsFor("teLate")).includes("scarcity"),
    "the late TE is himself the survivor -- there is no urgency to take him now"
  );
  assert.ok(
    !kinds(out.reasonsFor("rb0")).includes("scarcity"),
    "RB is 40 deep; nothing about it is scarce"
  );
});

// ---------------------------------------------------------------------------
// Tier cliff.
// ---------------------------------------------------------------------------

test("a tier cliff is reported only when the next available player at that position is in a worse tier", () => {
  const players = [
    player("a", { position: "RB", rank: 1, tier: 1 }),
    player("b", { position: "RB", rank: 2, tier: 1 }),
    player("c", { position: "RB", rank: 3, tier: 3 }),
  ];
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [] });
  const out = adviseOnPick({ players, draft, boardRows: null, myTeam: 1 });

  const cliff = out.reasonsFor("b").find((r) => r.kind === "tier-cliff");
  assert.ok(cliff, "b is the last tier-1 RB; the next RB is tier 3");
  assert.ok(cliff.weight > 0);
  assert.match(cliff.text, /tier 1/);
  assert.match(cliff.text, /tier 3/);

  assert.ok(
    !kinds(out.reasonsFor("a")).includes("tier-cliff"),
    "a is followed by another tier-1 RB -- no cliff"
  );
  assert.ok(
    !kinds(out.reasonsFor("c")).includes("tier-cliff"),
    "c has nobody behind him at RB -- there is no next tier to fall to"
  );
});

// ---------------------------------------------------------------------------
// Availability.
// ---------------------------------------------------------------------------

test("a player on IR is penalised hard enough not to be recommended over a healthy comparable", () => {
  const players = [
    player("hurt", { position: "RB", rank: 1, tier: 1, injuryStatus: "IR" }),
    player("healthy", { position: "RB", rank: 2, tier: 1 }),
  ];
  for (let i = 0; i < 20; i++) players.push(player(`rb${i}`, { position: "RB", rank: 3 + i, tier: 1 }));

  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [] });
  const out = adviseOnPick({ players, draft, boardRows: null, myTeam: 1 });

  assert.strictEqual(out.recommendation.player.id, "healthy");
  const hit = out.reasonsFor("hurt").find((r) => r.kind === "availability");
  assert.ok(hit && hit.weight < 0);
  assert.match(hit.text, /injured reserve/i);
});

test("Questionable is a soft penalty and names the body part when it is known", () => {
  const players = [
    player("q", { position: "RB", rank: 1, tier: 1, injuryStatus: "Questionable", injuryBodyPart: "Hamstring" }),
    player("blank", { position: "RB", rank: 2, tier: 1, injuryStatus: "Questionable" }),
  ];
  for (let i = 0; i < 20; i++) players.push(player(`rb${i}`, { position: "RB", rank: 3 + i, tier: 1 }));

  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [] });
  const out = adviseOnPick({ players, draft, boardRows: null, myTeam: 1 });

  const hit = out.reasonsFor("q").find((r) => r.kind === "availability");
  assert.ok(hit, "a Questionable tag is a judgement the user should get to make");
  assert.ok(hit.weight < 0 && hit.weight > -5, `Questionable must stay soft, got ${hit.weight}`);
  assert.match(hit.text, /hamstring/i);

  const blank = out.reasonsFor("blank").find((r) => r.kind === "availability");
  assert.ok(blank && !/hamstring/i.test(blank.text), "no body part known, none invented");

  assert.strictEqual(
    out.recommendation.player.id,
    "q",
    "a soft penalty must not knock the top player off the board"
  );
});

test("depthChartOrder 0 is the top of the depth chart, not a missing value", () => {
  const players = [
    player("top", { position: "RB", rank: 1, depthChartOrder: 0 }),
    player("second", { position: "RB", rank: 2, depthChartOrder: 1 }),
    player("buried", { position: "RB", rank: 3, depthChartOrder: 4 }),
    player("unknown", { position: "RB", rank: 4 }),
  ];
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [] });
  const out = adviseOnPick({ players, draft, boardRows: null, myTeam: 1 });

  assert.ok(!kinds(out.reasonsFor("top")).includes("depth-chart"), "0 is first on the chart");
  assert.ok(!kinds(out.reasonsFor("second")).includes("depth-chart"));
  assert.ok(!kinds(out.reasonsFor("unknown")).includes("depth-chart"), "no depth data, no claim");

  const deep = out.reasonsFor("buried").find((r) => r.kind === "depth-chart");
  assert.ok(deep, "fourth on the depth chart is worth saying");
  assert.ok(deep.weight < 0 && deep.weight > -6, `a mild penalty, got ${deep.weight}`);
});

// ---------------------------------------------------------------------------
// Production -- last season's history, never a forecast.
// ---------------------------------------------------------------------------

test("high target volume on a high snap share earns production reasons; low volume does not", () => {
  const big = player("big", {
    position: "WR",
    team: "DET",
    rank: 1,
    statsSeason: 2025,
    stats: { gp: 17, rec_tgt: 148, rush_att: 2, off_snp: 900, tm_off_snp: 1000, rec_rz_tgt: 16, pos_rank_ppr: 4 },
  });
  const small = player("small", {
    position: "WR",
    team: "DET",
    rank: 2,
    statsSeason: 2025,
    stats: { gp: 17, rec_tgt: 18, rush_att: 1, off_snp: 180, tm_off_snp: 1000, rec_rz_tgt: 1, pos_rank_ppr: 84 },
  });
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [] });
  const out = adviseOnPick({ players: [big, small], draft, boardRows: null, myTeam: 1 });

  const bigKinds = kinds(out.reasonsFor("big"));
  for (const kind of ["opportunity", "snap-share", "red-zone", "finish"]) {
    assert.ok(bigKinds.includes(kind), `expected a "${kind}" reason for a 148-target, 90%-snap season`);
  }

  const smallKinds = kinds(out.reasonsFor("small"));
  for (const kind of ["opportunity", "snap-share", "red-zone", "finish"]) {
    assert.ok(!smallKinds.includes(kind), `an 18-target season must not earn a "${kind}" reason`);
  }
});

test("every stat-derived reason carries its season, because this is history and not a forecast", () => {
  const big = player("big", {
    position: "WR",
    team: "DET",
    rank: 1,
    statsSeason: 2025,
    stats: { gp: 17, rec_tgt: 148, rush_att: 2, off_snp: 900, tm_off_snp: 1000, rec_rz_tgt: 16, pos_rank_ppr: 4 },
  });
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [] });
  const out = adviseOnPick({ players: [big], draft, boardRows: null, myTeam: 1 });

  const stat = out.reasonsFor("big").filter((r) =>
    ["opportunity", "snap-share", "red-zone", "finish"].includes(r.kind)
  );
  assert.ok(stat.length >= 3);
  for (const r of stat) {
    assert.match(r.text, /2025/, `"${r.text}" reads as a projection without its season`);
  }
});

test("a ranked player with no stats earns an explicit no-prior-production reason", () => {
  const rookie = player("rookie", { position: "RB", rank: 12, adp: 14.5, tier: 2 });
  const undrafted = player("undrafted", { position: "RB", rank: null });
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [] });
  const out = adviseOnPick({ players: [rookie, undrafted], draft, boardRows: null, myTeam: 1 });

  const gap = out.reasonsFor("rookie").find((r) => r.kind === "no-production");
  assert.ok(gap, "35 of 269 ranked players carry no stats; that is a signal, not silence");
  assert.ok(gap.weight < 0);

  assert.ok(
    !kinds(out.reasonsFor("undrafted")).includes("no-production"),
    "an unranked player carries no stats by design and is not indicted for it"
  );
});

// ---------------------------------------------------------------------------
// The base: the board when one is driving the draft, else consensus rank.
// ---------------------------------------------------------------------------

test("with a board present, board order drives the base; without one, consensus rank does", () => {
  const players = [
    player("a", { position: "RB", rank: 1 }),
    player("b", { position: "WR", rank: 2 }),
    player("c", { position: "TE", rank: 3 }),
  ];
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [] });

  const boardRows = [
    { playerId: "c", myRank: 1, delta: 2 },
    { playerId: "a", myRank: 2, delta: -1 },
  ];
  const withBoard = adviseOnPick({ players, draft, boardRows, myTeam: 1 });
  assert.strictEqual(withBoard.recommendation.player.id, "c", "the board is the user's own ranking");
  assert.strictEqual(withBoard.ranked[0].base, 0);
  assert.ok(withBoard.ranked[0].base > withBoard.ranked[1].base);

  const withoutBoard = adviseOnPick({ players, draft, boardRows: null, myTeam: 1 });
  assert.strictEqual(withoutBoard.recommendation.player.id, "a", "consensus rank is the fallback");

  assert.ok(
    !kinds(withBoard.reasonsFor("c")).some((k) => k === "base"),
    "the starting point is not itself a reason"
  );
});

// ---------------------------------------------------------------------------
// Degenerate input.
// ---------------------------------------------------------------------------

test("an empty pool returns no recommendation rather than throwing", () => {
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [] });
  const out = adviseOnPick({ players: [], draft, boardRows: null, myTeam: 1 });
  assert.strictEqual(out.recommendation, null);
  assert.deepStrictEqual(out.reasonsFor("anything"), []);
});

test("a pool in which everyone is already drafted returns no recommendation", () => {
  const taken = player("taken", { rank: 1 });
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [taken] });
  const out = adviseOnPick({ players: [taken], draft, boardRows: null, myTeam: 1 });
  assert.strictEqual(out.recommendation, null);
});

test("a completed draft returns no recommendation", () => {
  const players = [player("a", { rank: 1 })];
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [] });
  draft.completed = true;
  assert.strictEqual(adviseOnPick({ players, draft, boardRows: null, myTeam: 1 }).recommendation, null);

  const full = makeDraft({ teams: 1, rounds: 1, userTeam: 1, made: [player("z", { rank: 9 })] });
  assert.strictEqual(adviseOnPick({ players, draft: full, boardRows: null, myTeam: 1 }).recommendation, null);
});

test("a malformed draft returns no recommendation rather than throwing", () => {
  const players = [player("a", { rank: 1, adp: 2.5 })];
  const bad = [
    undefined,
    null,
    {},
    { teams: "twelve", rounds: 15, picks: [] },
    { teams: 12, rounds: 0, picks: [] },
    { teams: 12, rounds: 15, picks: "not an array" },
    [],
  ];
  for (const draft of bad) {
    const out = adviseOnPick({ players, draft, boardRows: null, myTeam: 1 });
    assert.strictEqual(out.recommendation, null, `draft ${JSON.stringify(draft)} should yield no advice`);
    assert.deepStrictEqual(out.reasonsFor("a"), []);
  }
});

test("adviseOnPick called with nothing at all does not throw", () => {
  const out = adviseOnPick();
  assert.strictEqual(out.recommendation, null);
  assert.deepStrictEqual(out.reasonsFor("a"), []);
});

test("reasonsFor an unknown id returns an empty array", () => {
  const players = [player("a", { rank: 1, adp: 2.5 })];
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, made: [] });
  const out = adviseOnPick({ players, draft, boardRows: null, myTeam: 1 });

  assert.deepStrictEqual(out.reasonsFor("nobody"), []);
  assert.deepStrictEqual(out.reasonsFor(null), []);
  assert.deepStrictEqual(out.reasonsFor(undefined), []);
  assert.ok(out.reasonsFor("a").length > 0, "a known id still resolves");
});

test("an out-of-range myTeam still advises, minus the reasons that need a roster", () => {
  const players = [player("a", { rank: 1, adp: 2.5 }), player("b", { rank: 2, adp: 30 })];
  const draft = makeDraft({ teams: 2, rounds: 2, userTeam: 1, rosterSlots: ["RB", "WR"], made: [] });
  const out = adviseOnPick({ players, draft, boardRows: null, myTeam: 99 });

  assert.ok(out.recommendation, "an unknown team is not a reason to say nothing");
  assert.ok(!kinds(out.reasonsFor("a")).includes("need"));
  assert.ok(!kinds(out.reasonsFor("a")).includes("scarcity"));
});
