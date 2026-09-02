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
    const reasons = [];
    for (const factor of FACTORS) {
      const produced = factor(entry, ctx);
      if (!produced) continue;
      if (Array.isArray(produced)) reasons.push(...produced);
      else reasons.push(produced);
    }
    return {
      player: entry.player,
      base: entry.base,
      score: reasons.reduce((sum, r) => sum + r.weight, entry.base),
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
  const top = ranked[0];

  return {
    recommendation: top ? { player: top.player, reasons: top.reasons } : null,
    ranked,
    reasonsFor(playerId) {
      if (playerId == null) return [];
      return byId.get(String(playerId)) || [];
    },
  };
}

const NO_ADVICE = {
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

const SCARCITY = [5, 3.5, 2]; // by how many at the position survive: 0, 1, 2

const TIER_CLIFF_PER_TIER = 3;
const TIER_CLIFF_CAP = 6;

// IR is disqualifying. Questionable is a judgement the user should make, so
// it costs about a spot and a half and no more.
const AVAILABILITY = {
  IR: { weight: -25, text: () => "On injured reserve." },
  PUP: { weight: -18, text: () => "On the PUP list." },
  OUT: { weight: -12, text: () => "Ruled out." },
  SUS: { weight: -10, text: () => "Serving a suspension." },
  NA: { weight: -8, text: () => "Listed as not active." },
  DOUBTFUL: { weight: -6, text: (p) => `Doubtful${bodyPart(p)}.` },
  QUESTIONABLE: {
    weight: -1.5,
    text: (p) => `Questionable${bodyPart(p)} -- a call worth making yourself.`,
  },
  COV: { weight: -1.5, text: () => "On the COVID list." },
};
const UNKNOWN_STATUS_WEIGHT = -1;

const DEEP_DEPTH_CHART = 3; // 0 is the TOP of the chart, not a missing value
const DEPTH_PER_STEP = -1.5;
const DEPTH_CAP = -4;

const NO_PRODUCTION = -2;

const OPPORTUNITY_STEPS = [
  [280, 4],
  [200, 3],
  [140, 2],
  [90, 1],
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
  const entries = ordered.map((player, index) => ({
    player,
    index,
    base: index === 0 ? 0 : -index,
  }));

  // The next available player at each position, for the tier cliff, and how
  // many at each position sit beyond the presumed-gone window, for scarcity.
  const nextAtPosition = new Map();
  const survivors = new Map();
  const lastSeen = new Map();
  for (const entry of entries) {
    const pos = entry.player.position;
    if (!pos) continue;
    const previous = lastSeen.get(pos);
    if (previous) nextAtPosition.set(previous.index, entry);
    lastSeen.set(pos, entry);
    if (entry.index >= gap) survivors.set(pos, (survivors.get(pos) || 0) + 1);
  }

  const rosterSlots = Array.isArray(draft.rosterSlots) ? draft.rosterSlots : [];
  const myMade = mySlot ? made.filter((p) => Number(p.team) === mySlot) : [];

  return {
    pool: entries,
    currentOverall,
    nextOverall,
    gap,
    mySlot,
    rosterSlots,
    myMade,
    // The shape of the user's roster right now. Each candidate is fitted on
    // top of it with the same fitRoster, so roster need can never drift from
    // how a roster actually fills.
    rosterNow: fitRoster(myMade, rosterSlots),
    nextAtPosition,
    survivors,
  };
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

function needFactor(entry, ctx) {
  if (!ctx.mySlot) return null;
  const position = entry.player.position;
  if (!position) return null;

  // Fit the roster again with this player added and see which slot stopped
  // being unfilled. Reusing fitRoster rather than re-deriving the slot rules
  // means FLEX eligibility and bench spillover cannot drift out of step.
  const after = fitRoster([...ctx.myMade, { player: entry.player }], ctx.rosterSlots);
  const slot = slotClosedBy(ctx.rosterNow.unfilled, after.unfilled);
  if (!slot) return null;

  if (slot === position) {
    return { kind: "need", weight: NEED_DEDICATED, text: `Fills your open ${position} slot.` };
  }
  if (slot === "FLEX") {
    return {
      kind: "need",
      weight: NEED_FLEX,
      text: `Fills your open FLEX slot as a ${position}.`,
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

  const left = ctx.survivors.get(position) || 0;
  const weight = SCARCITY[left] ?? 0;
  if (weight === 0) return null;

  const when = `your next pick at ${ctx.nextOverall}, ${ctx.gap} picks away`;
  return {
    kind: "scarcity",
    weight,
    text:
      left === 0
        ? `No other ${position} is likely to last until ${when}.`
        : `Only ${left} other ${position}${left === 1 ? " is" : "s are"} likely to last until ${when}.`,
  };
}

function tierCliffFactor(entry, ctx) {
  const tier = entry.player.tier;
  if (!Number.isFinite(tier)) return null;

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

  const targets = finite(stats.rec_tgt);
  const carries = finite(stats.rush_att);
  if (targets !== null || carries !== null) {
    const opportunities = (targets || 0) + (carries || 0);
    const weight = step(opportunities, OPPORTUNITY_STEPS, (v, at) => v >= at);
    if (weight) {
      const parts = [];
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
