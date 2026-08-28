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
 * True while any non-K/DEF starter slot is still empty, FLEX included.
 * Replaces a hardcoded `round <= 10`, which meant kickers in round 11 of a
 * 33-round draft.
 */
function kDefBlocked(counts, roster) {
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    if ((counts[pos] || 0) < (roster.starters[pos] || 0)) return true;
  }
  return flexFilled(counts, roster) < roster.flex;
}

module.exports = {
  DEFAULT_ROSTER,
  FLEX_ELIGIBLE,
  parseRosterSlots,
  rosterNeed,
  kDefBlocked,
};
