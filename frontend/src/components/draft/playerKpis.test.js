import test from "node:test";
import assert from "node:assert";
import { computeKpis } from "./playerKpis.js";

test("divides the format's own points by games played", () => {
  const d = { stats: { gp: 10, pts_ppr: 150, pts_half_ppr: 120, pts_std: 90 } };
  assert.equal(computeKpis(d, "ppr").fptsPerGame, 15);
  assert.equal(computeKpis(d, "half-ppr").fptsPerGame, 12);
  assert.equal(computeKpis(d, "standard").fptsPerGame, 9);
});

// The feed publishes a positional rank for PPR and nothing else. Showing it
// under another format would be relabelling, which is the one thing the ADP
// columns refuse to do.
// The app's format vocabulary is FORMATS = ["standard", "half-ppr", "ppr"]
// (backend/src/sync/normalize.js) and <option value="half-ppr"> in NewDraft.
// A table keyed on "half" never matches, so a half-PPR drafter silently got
// STANDARD points under an FPTS/GAME label -- a wrong number, which is worse
// than an em dash. The original test asserted "half" and passed, because it
// invented a format string the application never produces.
test("uses half-PPR points for a half-PPR league", () => {
  const d = { stats: { gp: 10, pts_ppr: 150, pts_half_ppr: 120, pts_std: 90 } };
  assert.equal(computeKpis(d, "half-ppr").fptsPerGame, 12);
});

// And an unrecognised format must not quietly substitute another scoring
// system. Nothing is the honest answer when we do not know what to divide.
test("an unknown format yields nothing rather than a wrong number", () => {
  const d = { stats: { gp: 10, pts_ppr: 150, pts_half_ppr: 120, pts_std: 90 } };
  assert.equal(computeKpis(d, "half").fptsPerGame, null);
  assert.equal(computeKpis(d, "superflex").fptsPerGame, null);
});

test("offers a positional rank only in PPR", () => {
  const d = { stats: { gp: 10, pts_ppr: 150, pos_rank_ppr: 4 } };
  assert.equal(computeKpis(d, "ppr").posRank, 4);
  assert.equal(computeKpis(d, "half").posRank, null);
  assert.equal(computeKpis(d, "standard").posRank, null);
});

test("reads snap share as a share, not a count", () => {
  const k = computeKpis({ stats: { gp: 4, off_snp: 120, tm_off_snp: 400 } }, "ppr");
  assert.ok(Math.abs(k.snapShare - 0.3) < 1e-9);
});

// Latu's case: fifteen games, nothing in any of them. Zero is an answer and
// null is not -- they must not collapse into the same em dash.
test("keeps a real zero distinct from no data", () => {
  const played = computeKpis({ stats: { gp: 15, pts_ppr: 0, off_snp: 40, tm_off_snp: 500 } }, "ppr");
  assert.equal(played.fptsPerGame, 0);
  assert.ok(Math.abs(played.snapShare - 0.08) < 1e-9);

  const nothing = computeKpis({}, "ppr");
  assert.equal(nothing.fptsPerGame, null);
  assert.equal(nothing.snapShare, null);
});

test("never divides by zero games", () => {
  assert.equal(computeKpis({ stats: { gp: 0, pts_ppr: 0 } }, "ppr").fptsPerGame, null);
});
