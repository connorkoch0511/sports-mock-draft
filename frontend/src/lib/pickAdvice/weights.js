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


// A position going faster than the board predicts is an argument for taking
// one before they are gone. Only a DEPARTURE from the expected rate counts:
// rounds 1-3 are running-back heavy by nature, and a factor that fires on
// every early pick moves scores for something that is not news.
//
// These five numbers were MEASURED against real drafts, not reasoned out.
// scripts/audit-runs.js fetches the live player pool, plays complete
// 12-team/15-round snake drafts in which every seat autopicks by consensus
// rank, and asks adviseOnPick for advice at all 180 picks from each of the 12
// seats in turn. Run 2026-09-15 against the live pool of 889 players, 118 of
// them carrying a consensus rank:
//
//   RUN_MIN_COUNT 3, as first written   29.4% of 2,160 picks came back with a
//                                       run reason -- including more than 90%
//                                       of every pick in rounds 2, 3 and 4. A
//                                       signal that is on almost continuously
//                                       for a quarter of a draft is
//                                       decoration, not information.
//   RUN_MIN_COUNT 5, what is below      12.5% of 2,160 picks, 9.9% of them
//                                       reaching the recommendation itself,
//                                       and 13.1% over a further 6,480 picks
//                                       in drafts where the seats reach. It
//                                       speaks in rounds 1-4 and is silent
//                                       after round 5, which is when the
//                                       startable board it measures is gone.
//
// Twenty of its sentences were then checked by hand against the raw pick list
// printed beside each: all twenty true, the user's own picks correctly absent
// from the window, and the count named matching the window printed.
//
// Why the MINIMUM moved and the multiple did not. RUN_MULTIPLE turned out to
// be the weaker lever by a long way -- taking it from 1.75 to 3 only brought
// 29.4% down to 23.3% -- because the expected rate is a share of the
// REMAINING startable board, and that board drains. Once most startable backs
// are gone RB is a few percent of what is left, and almost any observed share
// clears a multiple of it; pushing the multiple high enough to matter would
// have made a run undetectable in round 1, when a position is at its full
// share of the board and a run is most worth hearing about. The count does
// not have that defect: 3 of 8 is 37.5%, and RB and WR together are about
// 70% of every early pick, so "3 of the last 8 were RBs" describes an
// ordinary board rather than a run. 5 of 8 does not.
//
// The 3 and 4 entries in RUN_WEIGHT are unreachable while the minimum is 5,
// and are kept rather than deleted: they are the ramp this factor would use
// again if the minimum ever came back down, and it is the audit above -- not
// a fresh guess -- that would have to move it. Re-run it before touching any
// of these five.
export const RUN_WINDOW = 8; // picks by OTHER teams to look back over
export const RUN_MIN_COUNT = 5; // measured: 3 of 8 is the ordinary board, not a run
export const RUN_MULTIPLE = 1.75; // how far observed must exceed expected
export const RUN_WEIGHT = { 3: 1.5, 4: 2.5, 5: 3.5 };
export const RUN_WEIGHT_MAX_COUNT = 5; // counts above this take the 5 weight
