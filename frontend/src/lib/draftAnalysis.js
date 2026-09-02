import { largestGap } from "./snake.js";

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

  return {
    scoreable,
    teams,
    you: yours
      ? {
          team: yours.team,
          rank: teams.indexOf(yours) + 1,
          valueCaptured: yours.valueCaptured,
          tierCounts: yours.tierCounts,
          bestPick: extreme(yours.picks, "max"),
          biggestReach: extreme(yours.picks, "min"),
          rosterShape: shape(yours.picks, rosterSlots),
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

function shape(picks, rosterSlots) {
  const need = {};
  for (const slot of rosterSlots) need[slot] = (need[slot] || 0) + 1;

  const have = {};
  for (const p of picks) {
    const pos = p.player?.position;
    if (pos) have[pos] = (have[pos] || 0) + 1;
  }

  const filled = [];
  const unfilled = [];
  for (const [pos, count] of Object.entries(need)) {
    const got = have[pos] || 0;
    for (let i = 0; i < Math.min(got, count); i++) filled.push(pos);
    for (let i = got; i < count; i++) unfilled.push(pos);
  }

  const extra = [];
  for (const [pos, count] of Object.entries(have)) {
    const room = need[pos] || 0;
    if (count > room) extra.push({ position: pos, count: count - room });
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
