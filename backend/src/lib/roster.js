// Slot labels that name a single position outright.
const DEDICATED = ["QB", "RB", "WR", "TE", "K", "DEF"];

// A FLEX slot accepts exactly these.
const FLEX_ELIGIBLE = ["RB", "WR", "TE"];

// Reproduces the roster the bots implicitly assumed before rosterSlots existed:
// QB 1, RB 2, WR 2, TE 1, K 1, DEF 1. Used for drafts stored without the field.
const DEFAULT_ROSTER = ["QB", "RB", "RB", "WR", "WR", "TE", "K", "DEF"];

/**
 * Turn a flat Sleeper roster_positions array into counts.
 * Unrecognised labels (SUPER_FLEX, TAXI, IDP slots) count as bench and are
 * reported, so an unfamiliar league degrades to something sane.
 */
function parseRosterSlots(slots) {
  const starters = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  let flex = 0;
  let bench = 0;
  const unknown = [];

  for (const raw of slots || []) {
    const slot = String(raw).toUpperCase();
    if (DEDICATED.includes(slot)) starters[slot] += 1;
    else if (slot === "FLEX") flex += 1;
    else if (slot === "BN") bench += 1;
    else {
      bench += 1;
      unknown.push(slot);
    }
  }

  return { starters, flex, bench, unknown };
}

// How many FLEX slots are already occupied by surplus RB/WR/TE.
function flexFilled(counts, roster) {
  return FLEX_ELIGIBLE.reduce(
    (n, pos) =>
      n + Math.max(0, (counts[pos] || 0) - (roster.starters[pos] || 0)),
    0
  );
}

/**
 * How badly a team needs one more player at `position`.
 *
 * Dedicated starters come first. Only once those are full does FLEX reopen
 * demand for RB/WR/TE. When every starter slot is accounted for the need is
 * zero, which is what makes bench picks fall through to best-available.
 */
function rosterNeed(counts, position, roster) {
  const dedicatedMissing = Math.max(
    0,
    (roster.starters[position] || 0) - (counts[position] || 0)
  );
  if (dedicatedMissing > 0) return dedicatedMissing;
  if (!FLEX_ELIGIBLE.includes(position)) return 0;
  return Math.max(0, roster.flex - flexFilled(counts, roster));
}

/**
 * True while the team should still be drafting non-K/DEF value instead of
 * locking in its kicker/defense.
 *
 * Gates on how many picks the team has left, not on whether its other
 * starters are filled: K and DEF still carry a nonzero `rosterNeed` (and its
 * +500 score bonus) the instant their own slot opens, which is enough to
 * beat any realistic rank gap. Filling every other starter slot doesn't
 * change that, so gating on "other starters full" let K/DEF get drafted as
 * early as pick 9 in a 16-round league (and identically in a 33-round one).
 *
 * Instead, block while `picksRemaining > kDefSlotsNeeded + 1`, where
 * `kDefSlotsNeeded` is the team's still-unfilled K and DEF starter slots.
 * That leaves just enough of the team's final picks free to fill K/DEF and
 * scales with the draft's length: a 16-round draft takes K/DEF in roughly
 * its last two or three picks, a 33-round draft around picks 31-32, a
 * 15-round legacy draft around 13-14.
 */
function kDefBlocked(counts, roster, picksRemaining) {
  const kDefSlotsNeeded =
    Math.max(0, (roster.starters.K || 0) - (counts.K || 0)) +
    Math.max(0, (roster.starters.DEF || 0) - (counts.DEF || 0));
  return picksRemaining > kDefSlotsNeeded + 1;
}

module.exports = {
  DEFAULT_ROSTER,
  FLEX_ELIGIBLE,
  parseRosterSlots,
  rosterNeed,
  kDefBlocked,
};
