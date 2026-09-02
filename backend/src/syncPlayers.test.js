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
