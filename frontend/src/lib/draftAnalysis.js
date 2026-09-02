import { largestGap } from "./snake.js";

// Mirrors backend/src/lib/roster.js -- keep these two lists in step with it.
// The frontend is ESM and the backend is CommonJS, so the constants are
// duplicated here rather than imported across that boundary.
//
// DEDICATED_POSITIONS: slot labels that name a single position outright.
const DEDICATED_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
// FLEX_ELIGIBLE_POSITIONS: the only positions a FLEX slot accepts.
const FLEX_ELIGIBLE_POSITIONS = ["RB", "WR", "TE"];

/**
 * Analyse a completed or in-progress draft.
 *
 * Everything here comes from the draft object itself: each pick carries a
 * player snapshot taken at draft time (`rank`, `adp`, `tier`), and the draft
 * carries its own `rosterSlots`. Nothing is fetched.
 *
 * The sign convention is `overall - adp`, so a player who FELL to you scores
 * positive and one you REACHED for scores negative. ADP 5.5 taken at pick 1
 * is -4.5; taken at pick 20 it is +14.5. Getting this backwards inverts every
 * verdict the page renders.
 *
 * Only about 270 players carry an ADP at all, so a pick spent on an unranked
 * player has nothing to compare against. Those are excluded and counted, never
 * scored as zero -- zero would read as a fair-value pick and quietly drag every
 * total toward the middle.
 */
export function analyzeDraft(draft) {
  const teamCount = Number(draft?.teams) || 0;
  const userTeam = draft?.userTeam ?? null;
  const rosterSlots = Array.isArray(draft?.rosterSlots) ? draft.rosterSlots : [];
  const made = (Array.isArray(draft?.picks) ? draft.picks : []).filter(
    (p) => p && p.player
  );

  const scoreable = {
    with: made.filter((p) => typeof p.player.adp === "number").length,
    without: made.filter((p) => typeof p.player.adp !== "number").length,
  };

  const teams = [];
  for (let t = 1; t <= teamCount; t++) {
    const mine = made.filter((p) => p.team === t);
    teams.push({
      team: t,
      picks: mine,
      valueCaptured: round1(
        mine.reduce((sum, p) => sum + (delta(p) ?? 0), 0)
      ),
      tierCounts: countTiers(mine),
    });
  }

  // Best value first. Ties break by team number so the order never depends on
  // the engine's sort stability.
  teams.sort((a, b) => b.valueCaptured - a.valueCaptured || a.team - b.team);

  const yours = teams.find((t) => t.team === userTeam) || null;

  // A rank is only meaningful when every team has had the same number of
  // picks. Mid-draft, a team yet to pick scores 0 and sorts above anyone
  // negative, so an unstarted draft would read "1 of 12".
  // ...and only once somebody has actually picked: with zero picks every team
  // ties at 0, which is equal but says nothing.
  const counts = teams.map((t) => t.picks.length);
  const comparable =
    counts.length > 0 && counts[0] > 0 && counts.every((c) => c === counts[0]);

  return {
    scoreable,
    comparable,
    teams,
    you: yours
      ? {
          team: yours.team,
          rank: teams.indexOf(yours) + 1,
          valueCaptured: yours.valueCaptured,
          tierCounts: yours.tierCounts,
          bestPick: extreme(yours.picks, "max"),
          biggestReach: extreme(yours.picks, "min"),
          rosterShape: fitRoster(yours.picks, rosterSlots),
          longestWait: wait(yours.picks, made),
        }
      : emptyYou(),
  };
}

function delta(p) {
  const adp = p?.player?.adp;
  return typeof adp === "number" ? round1(p.overall - adp) : null;
}

function round1(n) {
  // Values are sums of one-decimal ADPs, so bare addition drifts into
  // 10.000000000000002. One decimal is all the precision ADP has anyway.
  return Math.round(n * 10) / 10;
}

function countTiers(picks) {
  const out = {};
  for (const p of picks) {
    const t = p.player?.tier;
    if (t == null) continue;
    out[t] = (out[t] || 0) + 1;
  }
  return out;
}

function extreme(picks, which) {
  const scored = picks
    .map((p) => ({ player: p.player, overall: p.overall, delta: delta(p) }))
    .filter((x) => x.delta !== null);
  if (scored.length === 0) return null;

  return scored.reduce((best, x) =>
    which === "max"
      ? x.delta > best.delta ? x : best
      : x.delta < best.delta ? x : best
  );
}

// Fits a team's drafted players against the draft's own rosterSlots, the way
// a real roster actually fills:
//   1. Dedicated slots (QB/RB/WR/TE/K/DEF) by exact position match.
//   2. Leftover RB/WR/TE spill into FLEX slots.
//   3. Anything still left spills into bench slots -- BN, plus any
//      unrecognised label (SUPERFLEX, TAXI, IDP, ...), which are functionally
//      identical bench capacity but keep their own label for display.
// `unfilled` lists only slots still empty after all three passes, and
// `extra` lists only players who fit nowhere at all -- not players who
// legitimately landed in a flex or bench slot.
export function fitRoster(picks, rosterSlots) {
  const dedicatedNeed = {};
  const benchLabels = [];
  let flexNeed = 0;

  for (const raw of rosterSlots) {
    const label = String(raw).toUpperCase();
    if (DEDICATED_POSITIONS.includes(label)) {
      dedicatedNeed[label] = (dedicatedNeed[label] || 0) + 1;
    } else if (label === "FLEX") {
      flexNeed += 1;
    } else {
      benchLabels.push(label); // BN and anything unrecognised
    }
  }

  const have = {};
  for (const p of picks) {
    const pos = p.player?.position;
    if (pos) have[pos] = (have[pos] || 0) + 1;
  }
  const leftover = { ...have };

  const filled = [];
  const unfilled = [];

  // Pass 1: dedicated slots by exact position match.
  for (const [pos, count] of Object.entries(dedicatedNeed)) {
    const got = Math.min(leftover[pos] || 0, count);
    for (let i = 0; i < got; i++) filled.push(pos);
    for (let i = got; i < count; i++) unfilled.push(pos);
    leftover[pos] = (leftover[pos] || 0) - got;
  }

  // Pass 2: leftover RB/WR/TE spill into FLEX, consumed RB -> WR -> TE.
  // Which position a given FLEX slot happens to absorb doesn't change how
  // many end up filled, only how the remainder is attributed in `extra`.
  let flexFilled = 0;
  for (const pos of FLEX_ELIGIBLE_POSITIONS) {
    while (flexFilled < flexNeed && (leftover[pos] || 0) > 0) {
      leftover[pos] -= 1;
      flexFilled += 1;
    }
  }
  for (let i = 0; i < flexFilled; i++) filled.push("FLEX");
  for (let i = flexFilled; i < flexNeed; i++) unfilled.push("FLEX");

  // Pass 3: anything still remaining spills into bench-type slots, in the
  // order those slots appear in rosterSlots.
  const positions = Object.keys(leftover);
  for (const label of benchLabels) {
    let placed = false;
    for (const pos of positions) {
      if ((leftover[pos] || 0) > 0) {
        leftover[pos] -= 1;
        placed = true;
        break;
      }
    }
    if (placed) filled.push(label);
    else unfilled.push(label);
  }

  // Whatever's left after dedicated, FLEX, and bench all had a chance fits
  // nowhere at all.
  const extra = [];
  for (const [pos, count] of Object.entries(leftover)) {
    if (count > 0) extra.push({ position: pos, count });
  }

  return { filled, unfilled, extra };
}

function wait(picks, allMade) {
  if (picks.length < 2) return null;

  const numbers = picks.map((p) => p.overall).sort((a, b) => a - b);
  const span = largestGap(numbers);
  if (span === 0) return null;

  let from = numbers[0];
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] - numbers[i - 1] === span) {
      from = numbers[i - 1];
      break;
    }
  }
  const to = from + span;

  return {
    from,
    to,
    span,
    playersGone: allMade
      .filter((p) => p.overall > from && p.overall < to)
      .sort((a, b) => a.overall - b.overall)
      .map((p) => p.player),
  };
}

function emptyYou() {
  return {
    team: null,
    rank: null,
    valueCaptured: 0,
    tierCounts: {},
    bestPick: null,
    biggestReach: null,
    rosterShape: { filled: [], unfilled: [], extra: [] },
    longestWait: null,
  };
}
