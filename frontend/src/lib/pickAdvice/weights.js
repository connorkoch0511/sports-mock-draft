import { bodyPart } from "./helpers.js";

// Every weight the engine can apply, in one place.
//
// All calibrated against the base, where one spot on the board costs 1, so a
// reason worth "+3" is worth three places. Changing a number here changes the
// rankings; changing it without re-reading the factor that uses it is how the
// scarcity model went dead against real data once already.


export const VALUE_PER_PICK = 0.25; // a 12-pick fall is worth three spots
export const VALUE_CAP = 6;

export const NEED_DEDICATED = 4;
export const NEED_FLEX = 2;

// By how many STARTABLE players at the position are likely to survive until
// the user's next pick: 0, 1, 2. Beyond two survivors a position is not
// scarce, it is just a position. startableAtEachPosition() defines who counts
// -- a raw count of everyone left at a position is meaningless when the pool
// carries 891 running backs, only ~30 of whom anyone would ever start.
export const SCARCITY = [5, 3.5, 2];

export const TIER_CLIFF_PER_TIER = 3;
export const TIER_CLIFF_CAP = 6;

// `out: true` means the player cannot be used at all, and is a gate rather
// than a number: see isOut(). The weights still rank and explain him, they
// just are not what keeps him off the recommendation. Questionable is a
// judgement the user should make, so it costs about a spot and a half.
export const AVAILABILITY = {
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
export const UNKNOWN_STATUS_WEIGHT = -1;

/** Can this player be recommended at all? A designation the table does not
 *  know is never treated as disqualifying -- we do not invent a diagnosis. */
export function isOut(player) {
  const raw = player?.injuryStatus;
  if (typeof raw !== "string" || raw.trim() === "") return false;
  return AVAILABILITY[raw.trim().toUpperCase()]?.out === true;
}

export const DEEP_DEPTH_CHART = 3; // 0 is the TOP of the chart, not a missing value
export const DEPTH_PER_STEP = -1.5;
export const DEPTH_CAP = -4;

export const NO_PRODUCTION = -2;

// Touches: carries plus targets. A quarterback's volume is almost all
// dropbacks, so counting only carries and targets made passing invisible --
// 3 QBs earned an opportunity reason against 49 RB and 40 WR on live data.
// Pass attempts are counted for him instead, on their own scale, because 460
// attempts and 460 carries are not the same season.
export const OPPORTUNITY_STEPS = [
  [280, 4],
  [200, 3],
  [140, 2],
  [90, 1],
];
export const PASSING_OPPORTUNITY_STEPS = [
  [600, 4],
  [500, 3],
  [400, 2],
  [250, 1],
];
export const SNAP_SHARE_STEPS = [
  [0.8, 3],
  [0.65, 2],
  [0.5, 1],
];
export const RED_ZONE_STEPS = [
  [15, 2],
  [8, 1],
];
export const FINISH_STEPS = [
  [5, 3],
  [12, 2],
  [24, 1],
];


// A run is a DEPARTURE FROM THE BOARD, not a position going fast. Expected is
// the position mix of the best players on the board as of when the window's
// picks were made -- reconstructed, never read live. See runs.js.
//
// These five numbers were MEASURED, not reasoned out, and the previous set
// proves why that matters: they passed 277 unit tests while the factor was
// measurably inverted. scripts/audit-runs.js fetches the live pool, plays
// complete 12-team/15-round drafts, and asks adviseOnPick at all 180 picks
// from each of the 12 seats. Run 2026-09-15 against 889 players, 118 ranked.
//
// THE ACCEPTANCE CHECK, and the reason this baseline is trustworthy where the
// last one was not: in scenario A every seat autopicks by consensus, so the
// picks ARE board order and there is nothing to depart from.
//
//   scenario A (2,160 picks)      0.0%   <- predicted, and observed
//   scenario B (6,480 picks)      0.5%   seats reaching within the top 6
//
// The old baseline scored 12.5% on scenario A. A model that fires when
// nobody has deviated is measuring the board's shape, not the drafters.
//
// SENSITIVITY. 0.5% is below the 2-15% band, so the obvious worry is a factor
// too deaf to be worth having. It is not: firing tracks how far seats
// actually stray, and then plateaus rather than running away.
//
// Reproduce with: node scripts/audit-runs.js --reach=N --samples=3 (N in
// 6, 12, 20, 30), reading "produced a run reason" under SCENARIO B. Run
// 2026-09-15 against the same 889-player, 118-ranked pool as above:
//
//   reach  6 -> 0.5%  (33/6480)     reach 20 -> 2.1%  (136/6480)
//   reach 12 -> 3.0%  (194/6480)    reach 30 -> 2.4%  (154/6480)
//
// A sixfold response from 6 to 12, and still only 2.4% at 30. It stays quiet
// unless something happened, which is the entire point. 0.5% at reach 6 is
// the SIMULATION barely departing, not the model failing to notice.
//
// The distribution is the other half, and it is what the old model got wrong
// while its headline looked fine. Old: 61% of round 2, 69% of round 4, ZERO
// from round 5 on, RB and WR only, every run 5-of-8 so the weight never
// varied. Now: spread across rounds 1, 4, 5, 7, 8 and 10; WR 21, QB 9, TE 2,
// RB 1 -- it can finally see quarterback and tight end runs -- and run sizes
// of 3, 4 and 5, so RUN_WEIGHT's 3 and 4 entries are reachable and the factor
// has a gradient again.
//
// Twenty sentences were checked by hand against the raw pick list printed
// beside each: all twenty true, own picks correctly absent from the window,
// and a partial window correctly saying "of the last 5" rather than 8.
//
// THE HONEST LIMIT. Only 118 of 889 players carry a rank, and they are gone
// by round 11 (the audit prints ranked-remaining per round). detectRuns
// declines to speak once fewer than K ranked players remain, because
// compareRank ties every unranked pair and the reconstruction would silently
// degenerate into a live board read -- the exact inversion this replaced.
// So rounds 11-15 are structurally silent. That is a true statement about the
// data, not a constant to tune. Re-run the audit before touching any of these.
export const RUN_WINDOW = 8; // picks by OTHER teams to look back over
export const RUN_MIN_COUNT = 3; // measured: 3 of 8 is the ordinary board, not a run
export const RUN_MULTIPLE = 1.75; // how far observed must exceed expected
export const RUN_WEIGHT = { 3: 1.5, 4: 2.5, 5: 3.5 };
export const RUN_WEIGHT_MAX_COUNT = 5; // counts above this take the 5 weight
