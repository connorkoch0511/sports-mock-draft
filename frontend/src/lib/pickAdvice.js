import { buildContext } from "./pickAdvice/context.js";
import { FACTORS } from "./pickAdvice/factors.js";
import { isOut } from "./pickAdvice/weights.js";
import { round1 } from "./pickAdvice/helpers.js";


/**
 * Recommend a pick and explain why.
 *
 * THE REASONS ARE THE SCORING FACTORS. There is no separate "explanation"
 * pass: a factor either returns a reason carrying the exact weight it
 * contributed, or it returns nothing at all. The score is then literally
 *
 *     score = base + every returned reason's weight
 *
 * so a contribution cannot exist without a reason (nothing else is ever added
 * to the score) and a reason cannot exist without a contribution (its weight
 * is the thing being summed). What is left to enforce is that no factor emits
 * a weight of zero -- a reason that did not move the ranking is decoration,
 * and decoration erodes trust in the reasons that are real. Factors return
 * `null` instead; the engine deliberately does NOT filter zero-weight reasons
 * out, so that a decorative one shows up in the invariant test rather than
 * being quietly swallowed.
 *
 * The other half of that commitment has to be enforced structurally, not by
 * good behaviour: a factor is handed a FROZEN entry and the base is snapshot
 * before the loop runs, so a factor cannot move a player's score by any route
 * other than returning a reason. Mutating `entry.base` throws (this module is
 * ESM, so it is strict mode) instead of silently reordering the board while
 * `score === base + sum(weights)` still appears to hold.
 *
 * Being unavailable is not a penalty, it is a disqualification. A player who
 * is out -- IR, PUP, ruled out, suspended, not active -- is never the
 * recommendation, whatever he scores. That is a gate rather than a large
 * negative weight, because a weight only has to outrun whatever the positive
 * factors currently add up to, and that ceiling moves every time a weight is
 * tuned. He stays in `ranked` and keeps his reasons, so the user can still
 * ask why the engine is steering around him.
 *
 * Pure: no fetching, no React, no display formatting. Everything comes from
 * the pool, the draft object, and the user's board.
 *
 * The base is the starting point, not a reason. It comes from the user's own
 * board when one is driving the draft (that is their ranking, and the Big
 * Board on the draft page is already ordered by it) and from consensus rank
 * otherwise. One step down the board costs 1 point, so every weight below
 * reads as "worth this many spots".
 *
 * The sign convention for value is `overall - adp`: positive means the player
 * FELL to you, negative means you REACHED. It is the same convention
 * draftAnalysis.js uses, and getting it backwards inverts every verdict.
 */
export function adviseOnPick({ players, draft, boardRows, myTeam } = {}) {
  const ctx = buildContext({ players, draft, boardRows, myTeam });
  if (!ctx) return NO_ADVICE;

  const ranked = ctx.pool.map((entry) => {
    // Snapshot before any factor runs. Both the reported base and the score
    // are reconstructed from this, so a factor that reached into the entry
    // could not move the ranking without also moving the reported base and
    // hiding itself inside the invariant. (Entries are frozen too; this is
    // the belt to that pair of braces.)
    const base = entry.base;

    const reasons = [];
    for (const factor of FACTORS) {
      const produced = factor(entry, ctx);
      if (!produced) continue;
      if (Array.isArray(produced)) reasons.push(...produced);
      else reasons.push(produced);
    }
    return {
      player: entry.player,
      base,
      // round1 for the same reason the weights are rounded: a sum of
      // one-decimal weights drifts into 3.6999999999999993, and a score that
      // reads as computed by accident undermines the reasons beside it.
      score: round1(reasons.reduce((sum, r) => sum + r.weight, base)),
      reasons,
    };
  });

  // Best score first. Ties break toward the higher base -- the player the
  // board already had ahead -- and then by id, so the order never depends on
  // the engine's sort stability.
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.base - a.base ||
      String(a.player.id).localeCompare(String(b.player.id))
  );

  const byId = new Map(ranked.map((r) => [String(r.player.id), r]));
  // The best score among players who can actually be used. Everyone stays in
  // `ranked` and keeps his reasons; only the recommendation is gated. A pool
  // in which literally everyone is out recommends nobody rather than
  // recommending someone who cannot play.
  const top = ranked.find((r) => !isOut(r.player)) ?? null;

  return {
    recommendation: top
      ? { player: top.player, reasons: top.reasons, base: top.base, score: top.score }
      : null,
    ranked,
    reasonsFor(playerId) {
      if (playerId == null) return [];
      return byId.get(String(playerId))?.reasons || [];
    },
    /**
     * Where this player started before any reason moved him, as a 1-based
     * position in the board order -- base is its negation.
     *
     * Exposed so a card can show the arithmetic completely. Without it the
     * weights on screen do not add up to the ranking, and a reader comparing
     * two players cannot tell why the one with weaker reasons came out ahead.
     * Null for a player the engine never scored.
     */
    startingPointFor(playerId) {
      if (playerId == null) return null;
      const entry = byId.get(String(playerId));
      return entry ? { base: entry.base, position: 1 - entry.base, score: entry.score } : null;
    },
  };
}

/**
 * What the engine returns when there is nothing to advise on -- no draft, a
 * completed one, an empty pool. Exported so a caller that already knows the
 * engine has nothing to say can skip running it and still hold a result of
 * the same shape. An empty `ranked` is what tells a caller the engine never
 * scored anybody, as opposed to scoring somebody and finding nothing.
 */
export const NO_ADVICE = {
  recommendation: null,
  ranked: [],
  reasonsFor: () => [],
  startingPointFor: () => null,
};

