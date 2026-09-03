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

