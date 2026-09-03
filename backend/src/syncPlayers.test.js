const test = require("node:test");
const assert = require("node:assert");
const {
  handler,
  STATS_FIELDS,
  pickStats,
  hasPlayedGames,
  resolveStatsSeason,
} = require("./syncPlayers");

test("pickStats keeps the curated fields", () => {
  const out = pickStats({
    gp: 17,
    rec_tgt: 129,
    rec_yd: 924,
    off_snp: 932,
    tm_off_snp: 1123,
    pts_ppr: 416.6,
  });

  assert.strictEqual(out.gp, 17);
  assert.strictEqual(out.rec_tgt, 129);
  assert.strictEqual(out.off_snp, 932);
  assert.strictEqual(out.tm_off_snp, 1123);
  assert.strictEqual(out.pts_ppr, 416.6);
});

test("pickStats omits a field the source does not have, rather than zeroing it", () => {
  // A receiver with no carries and a receiver whose carries went unreported are
  // different things. Storing 0 asserts the first.
  const out = pickStats({ gp: 17, rec_tgt: 129 });

  assert.ok(!("rush_att" in out), "absent fields must not appear at all");
  assert.strictEqual(out.rush_att, undefined);
});

test("pickStats drops fields outside the curated set", () => {
  const out = pickStats({ gp: 17, opp_off_yd: 5000, penalty_yd: 300, blk_kick_ret_td: 1 });

  assert.deepStrictEqual(Object.keys(out), ["gp"]);
});

test("pickStats returns null when nothing curated survives", () => {
  assert.strictEqual(pickStats({ opp_off_yd: 5000 }), null);
  assert.strictEqual(pickStats({}), null);
  assert.strictEqual(pickStats(null), null);
});

test("STATS_FIELDS covers the signals the feature was built for", () => {
  for (const f of ["gp", "pts_ppr", "rec_tgt", "off_snp", "tm_off_snp", "rec_rz_tgt"]) {
    assert.ok(STATS_FIELDS.includes(f), `${f} must be curated`);
  }
});

test("hasPlayedGames is false when nobody has played", () => {
  assert.strictEqual(hasPlayedGames({ "1": { gp: 0 }, "2": { gp: 0 } }), false);
  assert.strictEqual(hasPlayedGames({}), false);
  assert.strictEqual(hasPlayedGames(null), false);
});

test("hasPlayedGames is true as soon as one player has played", () => {
  assert.strictEqual(hasPlayedGames({ "1": { gp: 0 }, "2": { gp: 3 } }), true);
});

test("resolveStatsSeason uses the requested season when it has games", () => {
  const seasons = { 2025: { "1": { gp: 17 } } };
  return resolveStatsSeason(2025, async (y) => seasons[y] || {}).then((r) => {
    assert.strictEqual(r.season, 2025);
    assert.strictEqual(r.stats["1"].gp, 17);
  });
});

test("resolveStatsSeason falls back a season when the requested one has not started", () => {
  // Every September the new season exists as an endpoint but holds nothing.
  // A hardcoded year would silently serve an empty table.
  const seasons = { 2026: { "1": { gp: 0 } }, 2025: { "1": { gp: 17 } } };
  return resolveStatsSeason(2026, async (y) => seasons[y] || {}).then((r) => {
    assert.strictEqual(r.season, 2025, "should fall back to the completed season");
    assert.strictEqual(r.stats["1"].gp, 17);
  });
});

test("resolveStatsSeason reports the season it actually used", () => {
  const seasons = { 2026: {}, 2025: { "1": { gp: 17 } } };
  return resolveStatsSeason(2026, async (y) => seasons[y] || {}).then((r) => {
    assert.strictEqual(r.season, 2025);
  });
});

test("the Lambda entry point is still exported", () => {
  // template.yaml invokes this as syncPlayers.handler. Adding test exports by
  // assigning a fresh object to module.exports would drop it, silently break
  // the nightly sync that rewrites the entire players table, and leave every
  // other test in this file passing. This is the one assertion that notices.
  assert.strictEqual(typeof handler, "function");
});

// mergeStats is pure, so these need no fetch or DynamoDB stubbing. The
// handler's resilience -- that a stats failure cannot fail the sync -- is
// verified directly in Step 6 rather than through a mocked global fetch,
// which would test the mock more than the code.
test("mergeStats attaches curated stats to matching players", () => {
  const { mergeStats } = require("./syncPlayers");
  const players = [{ id: "1", name: "A" }, { id: "2", name: "B" }];
  const stats = { "1": { gp: 17, rec_tgt: 100, opp_off_yd: 9 } };

  const matched = mergeStats(players, stats, 2025);

  assert.deepStrictEqual(players[0].stats, { gp: 17, rec_tgt: 100 });
  assert.strictEqual(players[0].statsSeason, 2025);
  assert.strictEqual(matched, 1, "should report exactly one player matched");
});

test("mergeStats leaves a player with no stats entirely untouched", () => {
  const { mergeStats } = require("./syncPlayers");
  const players = [{ id: "2", name: "B" }];

  const matched = mergeStats(players, { "1": { gp: 17 } }, 2025);

  assert.ok(!("stats" in players[0]), "no empty stats object");
  assert.ok(!("statsSeason" in players[0]), "and no dangling season");
  assert.strictEqual(matched, 0, "no player in the feed matches the roster, so nothing matched");
});

test("mergeStats does not disturb existing fields", () => {
  const { mergeStats } = require("./syncPlayers");
  const players = [{ id: "1", name: "A", adp: { ppr: 5 }, rank: { ppr: 3 } }];

  const matched = mergeStats(players, { "1": { gp: 17 } }, 2025);

  assert.deepStrictEqual(players[0].adp, { ppr: 5 });
  assert.deepStrictEqual(players[0].rank, { ppr: 3 });
  assert.strictEqual(players[0].name, "A");
  assert.strictEqual(matched, 1);
});

test("mergeStats' matched count reflects players who actually curated, not the roster size", () => {
  const { mergeStats } = require("./syncPlayers");
  const players = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];
  // "2" played but recorded nothing curated (pos_rank_ppr alone, no gp>0) --
  // should not count. "3" is absent from the feed entirely. Only "1" and "4"
  // should be counted as matched.
  const stats = {
    "1": { gp: 10, rec_yd: 400 },
    "2": { pos_rank_ppr: 12 },
    "4": { gp: 3, rush_yd: 50 },
  };

  const matched = mergeStats(players, stats, 2025);

  assert.strictEqual(matched, 2, "matched must count exactly the players that received a stats object");
});

test("pickStats returns null for a player with pos_rank_ppr but gp=0 or missing", () => {
  // This is the exact case Sleeper emits for a player who never played: a
  // derived rank field with no games played backing it up.
  assert.strictEqual(pickStats({ pos_rank_ppr: 667 }), null);
  assert.strictEqual(pickStats({ gp: 0, pos_rank_ppr: 667 }), null);
});

test("pickStats returns stats once gp > 0, even with only one other curated field", () => {
  const out = pickStats({ gp: 1, pos_rank_ppr: 667 });
  assert.deepStrictEqual(out, { gp: 1, pos_rank_ppr: 667 });
});

const { pickAvailability } = require("./syncPlayers");

test("pickAvailability keeps an injury status and body part", () => {
  const out = pickAvailability({ injury_status: "Questionable", injury_body_part: "Hamstring" });
  assert.strictEqual(out.injuryStatus, "Questionable");
  assert.strictEqual(out.injuryBodyPart, "Hamstring");
});

test("pickAvailability keeps a depth chart order", () => {
  assert.strictEqual(pickAvailability({ depth_chart_order: 2 }).depthChartOrder, 2);
});

test("pickAvailability omits what the source does not have", () => {
  const out = pickAvailability({ injury_status: "IR" });
  assert.ok(!("injuryBodyPart" in out));
  assert.ok(!("depthChartOrder" in out));
});

test("pickAvailability returns null for a healthy player with no depth entry", () => {
  // The overwhelming majority. Returning {} would add a key to ~2,200 items
  // for no information.
  assert.strictEqual(pickAvailability({}), null);
  assert.strictEqual(pickAvailability(null), null);
});

test("pickAvailability ignores practice_participation", () => {
  // Measured empty for every injured player in the live blob.
  const out = pickAvailability({ practice_participation: "Limited" });
  assert.strictEqual(out, null);
});

// --- stale row pruning -------------------------------------------------

const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { pruneStale, MIN_EXPECTED_PLAYERS } = require("./syncPlayers");

// Drives pruneStale against a fake table. Returns the delete keys actually
// issued so tests can assert on WHICH rows went, not merely how many.
function fakeDdb(t, rows, { queryThrows = false } = {}) {
  const deleted = [];
  t.mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    const name = cmd.constructor.name;
    if (name === "QueryCommand") {
      if (queryThrows) throw new Error("query blew up");
      return { Items: rows };
    }
    if (name === "BatchWriteCommand") {
      const table = Object.keys(cmd.input.RequestItems)[0];
      for (const r of cmd.input.RequestItems[table]) {
        if (r.DeleteRequest) deleted.push(r.DeleteRequest.Key);
      }
      return { UnprocessedItems: {} };
    }
    throw new Error(`unexpected command ${name}`);
  });
  return deleted;
}

test("pruneStale deletes only rows this run did not rewrite", async (t) => {
  const NOW = 1_000_000;
  const deleted = fakeDdb(t, [
    { playerId: "fresh1", updatedAt: NOW },
    { playerId: "fresh2", updatedAt: NOW + 5 },
    { playerId: "retired", updatedAt: NOW - 86_400_000 },
    { playerId: "freeagent", updatedAt: NOW - 1 },
  ]);

  const res = await pruneStale({
    table: "t",
    sport: "nfl",
    runStartedAt: NOW,
    wrote: 815,
  });

  assert.strictEqual(res.skipped, false);
  assert.strictEqual(res.pruned, 2);
  assert.deepStrictEqual(
    deleted.map((k) => k.playerId).sort(),
    ["freeagent", "retired"]
  );
  // The key must carry BOTH halves of the composite key, or the delete is a
  // no-op against a table partitioned on sport.
  assert.ok(deleted.every((k) => k.sport === "nfl"));
});

test("pruneStale treats a row with no updatedAt as stale", async (t) => {
  const NOW = 1_000_000;
  const deleted = fakeDdb(t, [
    { playerId: "current", updatedAt: NOW },
    { playerId: "ancient" },
  ]);

  await pruneStale({ table: "t", sport: "nfl", runStartedAt: NOW, wrote: 600 });

  assert.deepStrictEqual(deleted.map((k) => k.playerId), ["ancient"]);
});

// The safety valve. An untested valve is decoration -- this is the assertion
// that stands between a Sleeper hiccup and an emptied table.
test("pruneStale deletes NOTHING when the run wrote implausibly few players", async (t) => {
  const NOW = 1_000_000;
  const deleted = fakeDdb(t, [
    { playerId: "a", updatedAt: NOW - 999 },
    { playerId: "b", updatedAt: NOW - 999 },
    { playerId: "c", updatedAt: NOW - 999 },
  ]);

  const res = await pruneStale({
    table: "t",
    sport: "nfl",
    runStartedAt: NOW,
    wrote: MIN_EXPECTED_PLAYERS - 1,
  });

  assert.strictEqual(res.skipped, true);
  assert.strictEqual(res.pruned, 0);
  assert.deepStrictEqual(deleted, [], "a short run must delete nothing at all");
});

test("pruneStale prunes at exactly the floor", async (t) => {
  const NOW = 1_000_000;
  const deleted = fakeDdb(t, [{ playerId: "old", updatedAt: NOW - 1 }]);

  const res = await pruneStale({
    table: "t",
    sport: "nfl",
    runStartedAt: NOW,
    wrote: MIN_EXPECTED_PLAYERS,
  });

  assert.strictEqual(res.skipped, false);
  assert.deepStrictEqual(deleted.map((k) => k.playerId), ["old"]);
});

test("pruneStale pages through a truncated Query rather than pruning one page", async (t) => {
  const NOW = 1_000_000;
  const deleted = [];
  let call = 0;
  t.mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.constructor.name === "QueryCommand") {
      call += 1;
      if (call === 1) {
        return {
          Items: [{ playerId: "page1", updatedAt: NOW - 1 }],
          LastEvaluatedKey: { sport: "nfl", playerId: "page1" },
        };
      }
      return { Items: [{ playerId: "page2", updatedAt: NOW - 1 }] };
    }
    const table = Object.keys(cmd.input.RequestItems)[0];
    for (const r of cmd.input.RequestItems[table]) deleted.push(r.DeleteRequest.Key);
    return { UnprocessedItems: {} };
  });

  await pruneStale({ table: "t", sport: "nfl", runStartedAt: NOW, wrote: 815 });

  assert.strictEqual(call, 2, "must follow LastEvaluatedKey");
  assert.deepStrictEqual(deleted.map((k) => k.playerId).sort(), ["page1", "page2"]);
});

test("pruneStale retries DynamoDB's unprocessed deletes", async (t) => {
  const NOW = 1_000_000;
  const seen = [];
  let writes = 0;
  t.mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.constructor.name === "QueryCommand") {
      return { Items: [{ playerId: "x", updatedAt: NOW - 1 }] };
    }
    writes += 1;
    const table = Object.keys(cmd.input.RequestItems)[0];
    const reqs = cmd.input.RequestItems[table];
    seen.push(reqs.length);
    if (writes === 1) return { UnprocessedItems: { [table]: reqs } };
    return { UnprocessedItems: {} };
  });

  const res = await pruneStale({
    table: "t",
    sport: "nfl",
    runStartedAt: NOW,
    wrote: 815,
  });

  assert.strictEqual(writes, 2, "an unprocessed delete must be resent");
  // Counted once on the first attempt, so a retry does not double-count.
  assert.strictEqual(res.pruned, 1);
});

// --- who belongs in the pool ------------------------------------------

const { normalizeSleeperPlayer } = require("./syncPlayers");

function sleeperPlayer(over = {}) {
  return {
    first_name: "Isiah",
    last_name: "Pacheco",
    position: "RB",
    fantasy_positions: ["RB"],
    team: "DET",
    status: "Active",
    ...over,
  };
}

// The regression that reached production: an "active"-only filter dropped 88
// rostered players, 6 of them carrying a live FFC ADP. Sleeper marks a player
// on IR "Inactive" while they stay rostered and stay drafted.
test("a rostered player on injured reserve is kept", () => {
  const out = normalizeSleeperPlayer(
    sleeperPlayer({ status: "Inactive", injury_status: "IR" }),
    "4034"
  );
  assert.ok(out, "an Inactive player with a team must survive normalization");
  assert.strictEqual(out.team, "DET");
  assert.strictEqual(out.position, "RB");
});

test("a practice squad player on a roster is kept", () => {
  const out = normalizeSleeperPlayer(sleeperPlayer({ status: "Practice Squad" }), "999");
  assert.ok(out);
});

// The other half of the rule. Sleeper still flags long-retired players
// "Active" with no team; those are what pruning is meant to remove.
test("a player on no NFL team is dropped whatever their status says", () => {
  assert.strictEqual(
    normalizeSleeperPlayer(sleeperPlayer({ status: "Active", team: null }), "1"),
    null
  );
  assert.strictEqual(
    normalizeSleeperPlayer(sleeperPlayer({ status: "Inactive", team: "" }), "2"),
    null
  );
});

test("a rostered player at a non-fantasy position is dropped", () => {
  assert.strictEqual(
    normalizeSleeperPlayer(
      sleeperPlayer({ position: "OL", fantasy_positions: ["OL"] }),
      "3"
    ),
    null
  );
});

// --- weekly game logs --------------------------------------------------

const {
  WEEK_FIELDS, SEASON_WEEKS, isPlayerId, pickWeek, mergeGameLogs,
} = require("./syncPlayers");

test("pickWeek keeps a real week", () => {
  // Brock Bowers, week 9 2025, from the live feed.
  const out = pickWeek(
    { gp: 1, rec: 12, rec_tgt: 13, rec_yd: 127, rec_td: 3, rec_rz_tgt: 5,
      rush_att: 1, rush_yd: 6, off_snp: 52, tm_off_snp: 64, pts_ppr: 43.3 },
    9
  );
  assert.strictEqual(out.wk, 9);
  assert.strictEqual(out.rec_tgt, 13);
  assert.strictEqual(out.rec_td, 3);
  assert.strictEqual(out.off_snp, 52);
  assert.strictEqual(out.pts_ppr, 43.3);
});

// The interception defect. `int` is a DEFENSIVE stat -- interceptions caught
// -- and appears on zero players in a real week. A fixture carrying both is
// the only thing that fails when the wrong one is curated.
test("a quarterback's interceptions come from pass_int, never int", () => {
  const out = pickWeek({ gp: 1, pass_att: 50, pass_yd: 342, pass_td: 1, pass_int: 3, int: 99 }, 9);
  assert.strictEqual(out.pass_int, 3);
  assert.ok(!("int" in out), "the defensive `int` must not be stored");
  assert.ok(!WEEK_FIELDS.includes("int"), "`int` must not be a curated field");
  assert.ok(WEEK_FIELDS.includes("pass_int"));
});

// Two kinds of absence, and a single rule covering both is what would be
// written by mistake -- so both directions are asserted.
test("a week the player did not play is a gap, not a row of zeroes", () => {
  assert.strictEqual(pickWeek({ gp: 0, pts_ppr: 0 }, 3), null);
  assert.strictEqual(pickWeek({}, 3), null);
  assert.strictEqual(pickWeek(null, 3), null);
  assert.strictEqual(pickWeek(undefined, 3), null);
});

test("a week he played but recorded nothing is a row, with the fields absent", () => {
  const out = pickWeek({ gp: 1, off_snp: 12, tm_off_snp: 60 }, 4);
  assert.ok(out, "he played, so the week exists");
  assert.strictEqual(out.wk, 4);
  assert.ok(!("rec_td" in out), "absent fields stay absent; the UI renders 0");
  assert.strictEqual(out.off_snp, 12);
});

test("non-numeric junk is not stored as a stat", () => {
  const out = pickWeek({ gp: 1, rec_yd: "127", rec_tgt: null, rec_td: NaN, rec: 5 }, 1);
  assert.strictEqual(out.rec, 5);
  for (const bad of ["rec_yd", "rec_tgt", "rec_td"]) {
    assert.ok(!(bad in out), `${bad} must not be stored`);
  }
});

test("isPlayerId accepts numeric ids and rejects team aggregates", () => {
  assert.strictEqual(isPlayerId("4034"), true);
  assert.strictEqual(isPlayerId("TEAM_CHI"), false);
  assert.strictEqual(isPlayerId("TEAM_BUF"), false);
  assert.strictEqual(isPlayerId(""), false);
  assert.strictEqual(isPlayerId(undefined), false);
});

// The defect most likely to ship silently: TEAM_CHI's pts_ppr is the whole
// offence's and outscores every human in the feed.
test("a team aggregate is never merged onto a player", async () => {
  const players = [{ id: "4034", name: "Isiah Pacheco" }, { id: "TEAM_CHI", name: "not a player" }];
  const week = { 1: { "4034": { gp: 1, rec: 2, pts_ppr: 9.9 },
                      TEAM_CHI: { gp: 1, rec: 22, pts_ppr: 154.58 } } };
  const res = await mergeGameLogs(players, 2025, async (_s, w) => week[w] || {});

  assert.deepStrictEqual(players[0].gameLog, [{ wk: 1, rec: 2, pts_ppr: 9.9 }]);
  assert.strictEqual(players[1].gameLog, undefined, "TEAM_CHI must get no game log");
  assert.strictEqual(res.playersWithLog, 1);
});

test("mergeGameLogs builds an ascending log across the season", async () => {
  const players = [{ id: "7", name: "A player" }];
  const res = await mergeGameLogs(players, 2025, async (_s, w) => {
    if (w === 1) return { 7: { gp: 1, rec: 1 } };
    if (w === 5) return { 7: { gp: 1, rec: 5 } };
    if (w === 3) return { 7: { gp: 0 } };            // did not play
    return {};
  });

  assert.deepStrictEqual(players[0].gameLog.map((r) => r.wk), [1, 5]);
  assert.strictEqual(players[0].gameLogSeason, 2025);
  assert.strictEqual(res.weeksLoaded, SEASON_WEEKS);
  assert.ok(!players[0].gameLog.some((r) => r.wk === 3), "week 3 must be a gap");
});

test("a week that fails to fetch is skipped, not fatal", async () => {
  const players = [{ id: "7" }];
  const res = await mergeGameLogs(players, 2025, async (_s, w) => {
    if (w === 2) throw new Error("upstream 500");
    return { 7: { gp: 1, rec: w } };
  });

  assert.strictEqual(res.weeksLoaded, SEASON_WEEKS - 1);
  assert.strictEqual(players[0].gameLog.length, SEASON_WEEKS - 1);
  assert.ok(!players[0].gameLog.some((r) => r.wk === 2));
});

test("a player who never played gets no gameLog key at all", async () => {
  const players = [{ id: "7" }];
  await mergeGameLogs(players, 2025, async () => ({ 7: { gp: 0 } }));
  assert.strictEqual(players[0].gameLog, undefined);
  assert.strictEqual(players[0].gameLogSeason, undefined);
});

// Mid-season, weeks 12-18 have not been played. Rendering them as "did not
// play" would accuse the player of missing games nobody has played.
test("gameLogThrough marks how far the season had got", async () => {
  const players = [{ id: "7" }];
  const res = await mergeGameLogs(players, 2025, async (_s, w) =>
    w <= 5 ? { 7: { gp: 1, rec: w } } : {}
  );

  assert.strictEqual(res.lastWeekWithData, 5);
  assert.strictEqual(players[0].gameLogThrough, 5);
});

test("a week is counted as played even when nobody in our pool appeared", async () => {
  // Week 6 has football in it, just not for this player. The season still got
  // that far, so his week 6 is a genuine absence rather than an unplayed week.
  const players = [{ id: "7" }];
  const res = await mergeGameLogs(players, 2025, async (_s, w) => {
    if (w <= 5) return { 7: { gp: 1, rec: w } };
    if (w === 6) return { 999: { gp: 1, rec: 3 } };
    return {};
  });

  assert.strictEqual(res.lastWeekWithData, 6);
  assert.strictEqual(players[0].gameLogThrough, 6);
  assert.strictEqual(players[0].gameLog.length, 5);
});

test("a rookie's experience is recorded so an empty log can be explained", () => {
  const rookie = normalizeSleeperPlayer(sleeperPlayer({ years_exp: 0 }), "1");
  assert.strictEqual(rookie.yearsExp, 0, "0 is a real value, not a missing one");

  const vet = normalizeSleeperPlayer(sleeperPlayer({ years_exp: 7 }), "2");
  assert.strictEqual(vet.yearsExp, 7);

  // 32 rostered players carry no value; omitted rather than guessed at 0,
  // which would call every one of them a rookie.
  const unknown = normalizeSleeperPlayer(sleeperPlayer({ years_exp: null }), "3");
  assert.ok(!("yearsExp" in unknown));
});

// --- ADP joining --------------------------------------------------------
//
// buildFfcMap had no test when the sync was split, so a missing import inside
// it passed every check here and only surfaced on a real invocation. These
// cover the three lookup paths it builds.

const { buildFfcMap } = require("./sync/adp");

const ffc = (name, position, team, adp) => ({ name, position, team, adp });

test("buildFfcMap keys skill players on position, team and name", () => {
  const maps = buildFfcMap([ffc("Jahmyr Gibbs", "RB", "DET", 1.5)]);
  assert.strictEqual(maps.byStrict.get("RB|DET|jahmyr gibbs"), 1.5);
});

test("buildFfcMap keys defences by team, since their names never agree", () => {
  const maps = buildFfcMap([ffc("Baltimore Ravens", "DEF", "BAL", 110.2)]);
  assert.strictEqual(maps.defByTeam.get("BAL"), 110.2);
});

test("buildFfcMap keys kickers by name, because they change teams", () => {
  const maps = buildFfcMap([ffc("Justin Tucker", "K", "BAL", 140.0)]);
  assert.ok(maps.kByName.size > 0, "a kicker must land in the by-name map");
});

test("buildFfcMap keeps the earliest ADP when a player appears twice", () => {
  const maps = buildFfcMap([
    ffc("Jahmyr Gibbs", "RB", "DET", 4.9),
    ffc("Jahmyr Gibbs", "RB", "DET", 1.5),
  ]);
  assert.strictEqual(maps.byStrict.get("RB|DET|jahmyr gibbs"), 1.5);
});

test("buildFfcMap ignores an entry with no usable ADP", () => {
  const maps = buildFfcMap([
    ffc("Nobody", "RB", "DET", null),
    ffc("Nobody Two", "RB", "DET", "abc"),
  ]);
  assert.strictEqual(maps.byStrict.size, 0);
});
