// The factors themselves. Each is handed a FROZEN entry and returns a reason
// or nothing -- never a score change of its own. That the reasons ARE the
// scoring is a property of this shape, not a convention.

import { fitRoster } from "../draftAnalysis.js";
import { clamp, finite, round1, step } from "./helpers.js";
import { AVAILABILITY, DEEP_DEPTH_CHART, DEPTH_CAP, DEPTH_PER_STEP, FINISH_STEPS, NEED_DEDICATED, NEED_FLEX, NO_PRODUCTION, OPPORTUNITY_STEPS, PASSING_OPPORTUNITY_STEPS, RED_ZONE_STEPS, SCARCITY, SNAP_SHARE_STEPS, TIER_CLIFF_CAP, TIER_CLIFF_PER_TIER, UNKNOWN_STATUS_WEIGHT, VALUE_CAP, VALUE_PER_PICK } from "./weights.js";

// Each returns a reason (or an array of them) carrying the weight it
// contributed, or null when it has nothing to say. Never a zero weight.

function valueFactor(entry, ctx) {
  const adp = entry.player.adp;
  if (typeof adp !== "number" || !Number.isFinite(adp)) return null;

  // overall - adp: positive means he fell to you.
  const fell = round1(ctx.currentOverall - adp);
  const weight = clamp(round1(fell * VALUE_PER_PICK), -VALUE_CAP, VALUE_CAP);
  if (weight === 0) return null; // going right where he was expected to go

  return {
    kind: "value",
    weight,
    text:
      fell > 0
        ? `Fell ${fell} picks past his ADP of ${adp}, and you are on the clock at ${ctx.currentOverall}.`
        : `A reach of ${Math.abs(fell)} picks: his ADP is ${adp} and this is pick ${ctx.currentOverall}.`,
  };
}

/**
 * Roster need, but only when it is pressing.
 *
 * "You have an open slot" is not a reason. At pick 1 of a standard draft
 * every slot is open, so every one of 3,876 candidates earned the same +4 and
 * the factor moved the ranking by exactly nothing -- the same objection this
 * module already makes to bench slots ("everyone fits a bench"), applied
 * consistently. An open slot with picks to spare is a bench slot with extra
 * steps: you will get to it.
 *
 * A need becomes real when the slack runs out -- when you have no more picks
 * than you have starting slots still to fill, so this pick has to be one of
 * them and taking anyone else costs you a starter. That is measured against
 * the user's own remaining turns, so it tightens as the draft runs and as the
 * user spends picks on depth instead of on his lineup.
 */
function needFactor(entry, ctx) {
  if (!ctx.mySlot) return null;
  const position = entry.player.position;
  if (!position) return null;

  // Slack left: more turns than open starting slots means nothing is forced.
  if (ctx.openStarters === 0 || ctx.openStarters < ctx.turnsLeft) return null;

  // Fit the roster again with this player added and see which slot stopped
  // being unfilled. Reusing fitRoster rather than re-deriving the slot rules
  // means FLEX eligibility and bench spillover cannot drift out of step.
  const after = fitRoster([...ctx.myMade, { player: entry.player }], ctx.rosterSlots);
  const slot = slotClosedBy(ctx.rosterNow.unfilled, after.unfilled);
  if (!slot) return null;

  const pressure =
    `${ctx.turnsLeft} pick${ctx.turnsLeft === 1 ? "" : "s"} left and ` +
    `${ctx.openStarters} starting slot${ctx.openStarters === 1 ? "" : "s"} still open`;

  if (slot === position) {
    return {
      kind: "need",
      weight: NEED_DEDICATED,
      text: `Fills your open ${position} slot, with ${pressure}.`,
    };
  }
  if (slot === "FLEX") {
    return {
      kind: "need",
      weight: NEED_FLEX,
      text: `Fills your open FLEX slot as a ${position}, with ${pressure}.`,
    };
  }
  // Bench capacity, or an unrecognised slot label used as bench. Real, but
  // not a reason to prefer him over anyone else -- everyone fits a bench.
  return null;
}

/** The one label present in `before` and missing from `after`, if any. */
function slotClosedBy(before, after) {
  const remaining = [...after];
  for (const label of before) {
    const at = remaining.indexOf(label);
    if (at === -1) return label;
    remaining.splice(at, 1);
  }
  return null;
}

function scarcityFactor(entry, ctx) {
  if (!ctx.nextOverall || ctx.gap <= 0) return null;
  const position = entry.player.position;
  if (!position) return null;

  // Presume the top `gap` of the board is gone by the time you pick again.
  // A player beyond that window will still be sitting there, so there is no
  // urgency about him at all.
  if (entry.index >= ctx.gap) return null;

  // Scarcity is an argument for taking a STARTER before they run out. It is
  // not an argument for taking the 400th tight end early.
  if (!ctx.startable.get(position)?.has(String(entry.player.id))) return null;

  // Survivors are counted inside the startable window, never over the whole
  // pool: 891 running backs are available and a raw count of them can never
  // be scarce, which is exactly why this factor fired zero times on live data.
  const left = ctx.survivors.get(position) || 0;
  const weight = SCARCITY[left] ?? 0;
  if (weight === 0) return null;

  const window = ctx.windows.get(position) ?? 0;
  const when = `your next pick at ${ctx.nextOverall}, ${ctx.gap} picks away`;
  const startable = `the ${window} ${position}${window === 1 ? "" : "s"} this league can start`;
  return {
    kind: "scarcity",
    weight,
    text:
      left === 0
        ? `None of ${startable} is expected to still be on the board at ${when}.`
        : `Only ${left} of ${startable} ${left === 1 ? "is" : "are"} expected to still be on the board at ${when}.`,
  };
}

/**
 * The last player at his position in his tier, with a worse tier behind him.
 *
 * Both halves are checked, because tier is not monotonic with rank in the
 * live payload and a user board can reorder a position freely. Comparing only
 * against the immediately next player made the claim "Last RB in tier 7" while
 * another tier-7 back sat further down the board -- 3 of 68 tier-cliff reasons
 * on live data were false that way. `lastInTier` scans the whole position.
 *
 * A tier that IMPROVES behind him is not a cliff. `drop <= 0` and not
 * `Math.abs(drop)`: "Last RB in tier 12; the next RB is tier 11" would be a
 * +3 for standing in front of a better player.
 */
function tierCliffFactor(entry, ctx) {
  const tier = entry.player.tier;
  if (!Number.isFinite(tier)) return null;
  if (!ctx.lastInTier.has(entry.index)) return null;

  const next = ctx.nextAtPosition.get(entry.index);
  if (!next || !Number.isFinite(next.player.tier)) return null;

  const drop = next.player.tier - tier;
  if (drop <= 0) return null;

  const position = entry.player.position;
  return {
    kind: "tier-cliff",
    weight: Math.min(TIER_CLIFF_PER_TIER * drop, TIER_CLIFF_CAP),
    text: `Last ${position} in tier ${tier}; the next ${position} on the board is tier ${next.player.tier}.`,
  };
}

function availabilityFactor(entry) {
  const raw = entry.player.injuryStatus;
  if (typeof raw !== "string" || raw.trim() === "") return null;

  const known = AVAILABILITY[raw.trim().toUpperCase()];
  if (known) {
    return { kind: "availability", weight: known.weight, text: known.text(entry.player) };
  }
  // An unrecognised designation is still a designation. Say so rather than
  // dropping it, but do not pretend to know how bad it is.
  return {
    kind: "availability",
    weight: UNKNOWN_STATUS_WEIGHT,
    text: `Carries an injury designation of "${raw}".`,
  };
}

function depthChartFactor(entry) {
  const order = entry.player.depthChartOrder;
  // 0 is legitimately the top of the chart, so this is a numeric test and
  // never a truthiness test.
  if (typeof order !== "number" || !Number.isFinite(order)) return null;
  if (order < DEEP_DEPTH_CHART) return null;

  const weight = clamp(round1(DEPTH_PER_STEP * (order - DEEP_DEPTH_CHART + 1)), DEPTH_CAP, 0);
  if (weight === 0) return null;

  return {
    kind: "depth-chart",
    weight,
    text: `Sits at #${order} on ${entry.player.team || "his team"}'s depth chart.`,
  };
}

/**
 * Last season's production. Every reason here names its season, because the
 * data is history: a reason that says "94 targets" without saying when
 * invites the reader to take it for a projection.
 *
 * A ranked player with no stats at all is a rookie or somebody who did not
 * play. The sync never manufactures a stats object for a player who never
 * took a snap, so the absence is information and gets said out loud.
 */
function productionFactors(entry) {
  const player = entry.player;
  const stats = player.stats;

  if (!stats || typeof stats !== "object") {
    if (player.rank == null) return null; // unranked players carry no stats by design
    return [
      {
        kind: "no-production",
        weight: NO_PRODUCTION,
        text: "No prior season of production on record: a rookie, or he did not play.",
      },
    ];
  }

  const when = Number.isFinite(player.statsSeason) ? `in ${player.statsSeason}` : "last season";
  const out = [];

  // How often the ball was in his hands. A player whose volume is mostly
  // dropbacks is measured on the passing scale -- counting only carries and
  // targets made a 460-attempt quarterback look like a player who barely
  // touched the ball. Deciding from the stat line rather than the position
  // label keeps a receiver's one trick-play throw out of it.
  const targets = finite(stats.rec_tgt);
  const carries = finite(stats.rush_att);
  const passes = finite(stats.pass_att);
  const touches = (targets || 0) + (carries || 0);
  const passer = passes !== null && passes > touches;

  if (targets !== null || carries !== null || passer) {
    const opportunities = passer ? passes + (carries || 0) : touches;
    const weight = step(
      opportunities,
      passer ? PASSING_OPPORTUNITY_STEPS : OPPORTUNITY_STEPS,
      (v, at) => v >= at
    );
    if (weight) {
      const parts = [];
      if (passer) parts.push(`${passes} pass attempts`);
      if (carries) parts.push(`${carries} carries`);
      if (targets) parts.push(`${targets} targets`);
      out.push({ kind: "opportunity", weight, text: `${parts.join(" and ")} ${when}.` });
    }
  }

  const snaps = finite(stats.off_snp);
  const teamSnaps = finite(stats.tm_off_snp);
  if (snaps !== null && teamSnaps !== null && teamSnaps > 0) {
    const share = snaps / teamSnaps;
    const weight = step(share, SNAP_SHARE_STEPS, (v, at) => v >= at);
    if (weight) {
      out.push({
        kind: "snap-share",
        weight,
        text: `Played ${Math.round(share * 100)}% of ${player.team || "his team"}'s offensive snaps ${when}.`,
      });
    }
  }

  const redZone = finite(stats.rec_rz_tgt);
  if (redZone !== null) {
    const weight = step(redZone, RED_ZONE_STEPS, (v, at) => v >= at);
    if (weight) {
      out.push({ kind: "red-zone", weight, text: `${redZone} red-zone targets ${when}.` });
    }
  }

  const finish = finite(stats.pos_rank_ppr);
  if (finish !== null && finish > 0) {
    const weight = step(finish, FINISH_STEPS, (v, at) => v <= at);
    if (weight) {
      out.push({
        kind: "finish",
        weight,
        text: `Finished ${player.position || "his position"}${finish} in PPR scoring ${when}.`,
      });
    }
  }

  return out.length > 0 ? out : null;
}

export const FACTORS = [
  valueFactor,
  needFactor,
  scarcityFactor,
  tierCliffFactor,
  availabilityFactor,
  depthChartFactor,
  productionFactors,
];

