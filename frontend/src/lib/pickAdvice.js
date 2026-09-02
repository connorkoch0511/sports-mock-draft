import { fitRoster } from "./draftAnalysis.js";
import { orderByBoard } from "./boardOrder.js";
import { picksForSlot } from "./snake.js";

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

  const byId = new Map(ranked.map((r) => [String(r.player.id), r.reasons]));
  // The best score among players who can actually be used. Everyone stays in
  // `ranked` and keeps his reasons; only the recommendation is gated. A pool
  // in which literally everyone is out recommends nobody rather than
  // recommending someone who cannot play.
  const top = ranked.find((r) => !isOut(r.player)) ?? null;

  return {
    recommendation: top ? { player: top.player, reasons: top.reasons } : null,
    ranked,
    reasonsFor(playerId) {
      if (playerId == null) return [];
      return byId.get(String(playerId)) || [];
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
};

// --- weights -------------------------------------------------------------
// All calibrated against the base, where one spot on the board costs 1.

const VALUE_PER_PICK = 0.25; // a 12-pick fall is worth three spots
const VALUE_CAP = 6;

const NEED_DEDICATED = 4;
const NEED_FLEX = 2;

// By how many STARTABLE players at the position are likely to survive until
// the user's next pick: 0, 1, 2. Beyond two survivors a position is not
// scarce, it is just a position. startableAtEachPosition() defines who counts
// -- a raw count of everyone left at a position is meaningless when the pool
// carries 891 running backs, only ~30 of whom anyone would ever start.
const SCARCITY = [5, 3.5, 2];

const TIER_CLIFF_PER_TIER = 3;
const TIER_CLIFF_CAP = 6;

// `out: true` means the player cannot be used at all, and is a gate rather
// than a number: see isOut(). The weights still rank and explain him, they
// just are not what keeps him off the recommendation. Questionable is a
// judgement the user should make, so it costs about a spot and a half.
const AVAILABILITY = {
  IR: { weight: -25, out: true, text: () => "On injured reserve." },
  PUP: { weight: -18, out: true, text: () => "On the PUP list." },
  OUT: { weight: -12, out: true, text: () => "Ruled out." },
  SUS: { weight: -10, out: true, text: () => "Serving a suspension." },
  NA: { weight: -8, out: true, text: () => "Listed as not active." },
  DOUBTFUL: { weight: -6, text: (p) => `Doubtful${bodyPart(p)}.` },
  QUESTIONABLE: {
    weight: -1.5,
    text: (p) => `Questionable${bodyPart(p)} -- a call worth making yourself.`,
  },
  COV: { weight: -1.5, text: () => "On the COVID list." },
};
const UNKNOWN_STATUS_WEIGHT = -1;

/** Can this player be recommended at all? A designation the table does not
 *  know is never treated as disqualifying -- we do not invent a diagnosis. */
function isOut(player) {
  const raw = player?.injuryStatus;
  if (typeof raw !== "string" || raw.trim() === "") return false;
  return AVAILABILITY[raw.trim().toUpperCase()]?.out === true;
}

const DEEP_DEPTH_CHART = 3; // 0 is the TOP of the chart, not a missing value
const DEPTH_PER_STEP = -1.5;
const DEPTH_CAP = -4;

const NO_PRODUCTION = -2;

// Touches: carries plus targets. A quarterback's volume is almost all
// dropbacks, so counting only carries and targets made passing invisible --
// 3 QBs earned an opportunity reason against 49 RB and 40 WR on live data.
// Pass attempts are counted for him instead, on their own scale, because 460
// attempts and 460 carries are not the same season.
const OPPORTUNITY_STEPS = [
  [280, 4],
  [200, 3],
  [140, 2],
  [90, 1],
];
const PASSING_OPPORTUNITY_STEPS = [
  [600, 4],
  [500, 3],
  [400, 2],
  [250, 1],
];
const SNAP_SHARE_STEPS = [
  [0.8, 3],
  [0.65, 2],
  [0.5, 1],
];
const RED_ZONE_STEPS = [
  [15, 2],
  [8, 1],
];
const FINISH_STEPS = [
  [5, 3],
  [12, 2],
  [24, 1],
];

// --- context -------------------------------------------------------------

/**
 * Everything the factors need, computed once. Returns null when there is
 * nothing to advise on: a malformed or completed draft, or an empty pool.
 * None of those are errors the caller should have to catch.
 */
function buildContext({ players, draft, boardRows, myTeam }) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return null;

  const teams = positiveInt(draft.teams);
  const rounds = positiveInt(draft.rounds);
  if (!teams || !rounds) return null;

  if (draft.picks != null && !Array.isArray(draft.picks)) return null;
  const picks = (Array.isArray(draft.picks) ? draft.picks : []).filter(
    (p) => p && typeof p === "object"
  );
  const made = picks.filter((p) => p.player);

  if (draft.completed === true) return null;
  if (picks.length > 0 && made.length >= picks.length) return null;

  const pool = Array.isArray(players) ? players.filter((p) => p && p.id != null) : [];
  if (pool.length === 0) return null;

  const taken = new Set();
  for (const id of Array.isArray(draft.picked) ? draft.picked : []) taken.add(String(id));
  for (const p of picks) if (p.playerId != null) taken.add(String(p.playerId));

  const available = pool.filter((p) => !taken.has(String(p.id)));
  if (available.length === 0) return null;

  const currentOverall = currentOverallOf(draft, picks, made);

  // The user's slot. Out of range (or absent) costs the reasons that depend
  // on knowing whose roster this is, not the advice itself.
  const requested = Number(myTeam ?? draft.userTeam);
  const mySlot =
    Number.isInteger(requested) && requested >= 1 && requested <= teams ? requested : null;

  const myTurns = mySlot ? picksForSlot(mySlot, teams, rounds) : [];
  const nextOverall = myTurns.find((n) => n > currentOverall) ?? null;
  // No next turn means nothing can run out before it. Scarcity is measured
  // against the user's next pick, never against the end of the draft.
  const gap = nextOverall === null ? 0 : nextOverall - currentOverall;

  // Base order: the board when one is driving the draft, else consensus rank.
  // Sorting by rank first makes the consensus path independent of whatever
  // order the API happened to return.
  const consensus = available
    .map((player, index) => ({ player, index }))
    .sort((a, b) => compareRank(a.player, b.player) || a.index - b.index)
    .map((x) => x.player);
  const hasBoard = Array.isArray(boardRows) && boardRows.length > 0;
  const ordered = hasBoard ? orderByBoard(consensus, boardRows) : consensus;

  // `index === 0 ? 0` keeps the top of the board off negative zero, which
  // survives arithmetic and would surface as "-0" downstream.
  //
  // Frozen: a factor is given the entry, and freezing is what makes "the
  // reasons ARE the scoring factors" a property of the code rather than a
  // convention. `entry.base += 3` inside a factor throws here instead of
  // silently moving the ranking with nothing to show for it.
  const entries = ordered.map((player, index) =>
    Object.freeze({
      player,
      index,
      base: index === 0 ? 0 : -index,
    })
  );

  const rosterSlots = Array.isArray(draft.rosterSlots) ? draft.rosterSlots : [];
  const myMade = mySlot ? made.filter((p) => Number(p.team) === mySlot) : [];

  // Board order per position, which three separate questions are asked of.
  const byPosition = new Map();
  for (const entry of entries) {
    const pos = entry.player.position;
    if (!pos) continue;
    if (!byPosition.has(pos)) byPosition.set(pos, []);
    byPosition.get(pos).push(entry);
  }

  // 1. The next available player at each position, for the tier cliff.
  const nextAtPosition = new Map();
  // 2. Whether a player is genuinely the last at his position in his tier.
  //    Tier is not monotonic with rank in the live payload, so "the next one
  //    is worse" and "he is the last of these" are different claims and only
  //    the second is the one the reason makes.
  const lastInTier = new Set();
  // 3. How many of the players this league could START at the position are
  //    still expected to be on the board at the user's next pick.
  const { windows, startable } = startableAtEachPosition(pool, rosterSlots, teams);
  const survivors = new Map();

  for (const [pos, list] of byPosition) {
    const tiersBelow = new Set();
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (i + 1 < list.length) nextAtPosition.set(entry.index, list[i + 1]);
      const tier = entry.player.tier;
      if (Number.isFinite(tier)) {
        if (!tiersBelow.has(tier)) lastInTier.add(entry.index);
        tiersBelow.add(tier);
      }
    }
    const ids = startable.get(pos);
    survivors.set(
      pos,
      ids ? list.filter((e) => e.index >= gap && ids.has(String(e.player.id))).length : 0
    );
  }

  // How many turns the user has left, this one included. Roster need is
  // pressing relative to this and to nothing else: an open slot with picks to
  // spare is the same kind of non-reason as an open bench spot.
  const turnsLeft = myTurns.filter((n) => n >= currentOverall).length;
  const rosterNow = fitRoster(myMade, rosterSlots);
  const openStarters = rosterNow.unfilled.filter(isStartingSlot).length;

  return {
    pool: entries,
    windows,
    startable,
    lastInTier,
    turnsLeft,
    openStarters,
    currentOverall,
    nextOverall,
    gap,
    mySlot,
    rosterSlots,
    myMade,
    // The shape of the user's roster right now. Each candidate is fitted on
    // top of it with the same fitRoster, so roster need can never drift from
    // how a roster actually fills.
    rosterNow,
    nextAtPosition,
    survivors,
  };
}

/**
 * Who this league could actually START at each position, fixed at the top of
 * the draft by consensus rank -- the only population in which "how many are
 * left?" means anything.
 *
 * The available pool carries 891 running backs and 1,670 receivers, so a raw
 * count of who survives until your next pick is in the hundreds at every
 * position and can never be scarce: the factor fired zero times across a
 * complete 179-pick draft on live data. What a drafter is afraid of is
 * running out of players he would START. Twelve teams starting two running
 * backs and sharing a flex have room for about 28 of them, and the 29th is a
 * bench body whose survival tells you nothing.
 *
 * The set is drawn from the WHOLE pool, drafted players included, so it
 * shrinks as the good ones go instead of quietly refilling from below with
 * whoever is left. That is what makes late-round scarcity real: three
 * startable tight ends left and a long wait until your next pick is a
 * different situation from three hundred tight ends being technically
 * available.
 *
 * The window is `teams x (dedicated slots at the position + its share of the
 * flex slots)`, floored at one starter per team so a league that names no
 * roster at all still has a meaningful window. The flex share is split evenly
 * across the flex-eligible positions in the pool -- which position a given
 * flex ends up holding is exactly the thing nobody knows in advance.
 *
 * Slot classification is asked of fitRoster rather than kept as a second copy
 * of the rules: a slot that will accept a player of no recognisable position
 * is bench capacity, and anything else is a starting slot.
 */
function startableAtEachPosition(pool, rosterSlots, teams) {
  const byPosition = new Map();
  for (const player of pool) {
    const pos = player.position;
    if (!pos) continue;
    if (!byPosition.has(pos)) byPosition.set(pos, []);
    byPosition.get(pos).push(player);
  }

  const everySlot = fitRoster([], rosterSlots).unfilled; // nothing filled: all of them
  const dedicated = new Map();
  let flexSlots = 0;
  for (const label of everySlot) {
    if (label === "FLEX") flexSlots += 1;
    else if (isStartingSlot(label)) dedicated.set(label, (dedicated.get(label) || 0) + 1);
  }

  const flexEligible = [...byPosition.keys()].filter(isFlexEligible);
  const flexShare = flexEligible.length > 0 ? flexSlots / flexEligible.length : 0;

  const windows = new Map();
  const startable = new Map();
  for (const [pos, list] of byPosition) {
    const perTeam = (dedicated.get(pos) || 0) + (isFlexEligible(pos) ? flexShare : 0);
    const size = Math.min(Math.ceil(Math.max(perTeam, 1) * teams), list.length);
    windows.set(pos, size);
    startable.set(
      pos,
      new Set(
        list
          .slice()
          .sort(compareRank)
          .slice(0, size)
          .map((p) => String(p.id))
      )
    );
  }
  return { windows, startable };
}

// A position no real payload uses, for probing what a slot will accept.
const NOT_A_POSITION = "\u0000";
const startingSlotCache = new Map();
const flexEligibleCache = new Map();

/** A bench slot takes anybody, which is why filling one is not a reason. */
function isStartingSlot(label) {
  if (!startingSlotCache.has(label)) {
    const spare = fitRoster([{ player: { position: NOT_A_POSITION } }], [label]);
    startingSlotCache.set(label, spare.unfilled.length > 0);
  }
  return startingSlotCache.get(label);
}

function isFlexEligible(position) {
  if (!flexEligibleCache.has(position)) {
    const fit = fitRoster([{ player: { position } }], ["FLEX"]);
    flexEligibleCache.set(position, fit.unfilled.length === 0);
  }
  return flexEligibleCache.get(position);
}

function currentOverallOf(draft, picks, made) {
  const at = draft.currentIndex;
  if (Number.isInteger(at) && picks[at] && Number.isFinite(picks[at].overall)) {
    return picks[at].overall;
  }
  const pending = picks.find((p) => !p.player);
  if (pending && Number.isFinite(pending.overall)) return pending.overall;
  return made.length + 1;
}

// --- factors -------------------------------------------------------------
//
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

function bodyPart(player) {
  const part = player.injuryBodyPart;
  return typeof part === "string" && part.trim() !== "" ? ` with a ${part.toLowerCase()}` : "";
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

const FACTORS = [
  valueFactor,
  needFactor,
  scarcityFactor,
  tierCliffFactor,
  availabilityFactor,
  depthChartFactor,
  productionFactors,
];

// --- small helpers -------------------------------------------------------

function step(value, steps, matches) {
  for (const [at, weight] of steps) if (matches(value, at)) return weight;
  return 0;
}

function finite(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function positiveInt(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;
}

/** Consensus rank ascending, unranked last. Two unranked players tie. */
function compareRank(a, b) {
  const ar = finite(a?.rank);
  const br = finite(b?.rank);
  if (ar === null && br === null) return 0;
  if (ar === null) return 1;
  if (br === null) return -1;
  return ar - br;
}

function round1(n) {
  // Weights are sums and products of one-decimal ADPs; bare arithmetic drifts
  // into 3.6000000000000005 and makes every reason look computed by accident.
  return Math.round(n * 10) / 10;
}

function clamp(n, low, high) {
  return Math.min(high, Math.max(low, n));
}
