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

  mergeStats(players, stats, 2025);

  assert.deepStrictEqual(players[0].stats, { gp: 17, rec_tgt: 100 });
  assert.strictEqual(players[0].statsSeason, 2025);
});

test("mergeStats leaves a player with no stats entirely untouched", () => {
  const { mergeStats } = require("./syncPlayers");
  const players = [{ id: "2", name: "B" }];

  mergeStats(players, { "1": { gp: 17 } }, 2025);

  assert.ok(!("stats" in players[0]), "no empty stats object");
  assert.ok(!("statsSeason" in players[0]), "and no dangling season");
});

test("mergeStats does not disturb existing fields", () => {
  const { mergeStats } = require("./syncPlayers");
  const players = [{ id: "1", name: "A", adp: { ppr: 5 }, rank: { ppr: 3 } }];

  mergeStats(players, { "1": { gp: 17 } }, 2025);

  assert.deepStrictEqual(players[0].adp, { ppr: 5 });
  assert.deepStrictEqual(players[0].rank, { ppr: 3 });
  assert.strictEqual(players[0].name, "A");
});
