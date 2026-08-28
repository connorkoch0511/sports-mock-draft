/** Overall pick numbers for a slot in a snake draft. */
export function picksForSlot(slot, teams, rounds) {
  const picks = [];
  for (let round = 1; round <= rounds; round++) {
    const indexInRound = round % 2 === 1 ? slot : teams - slot + 1;
    picks.push((round - 1) * teams + indexInRound);
  }
  return picks;
}

/** Largest number of picks between consecutive turns. */
export function largestGap(picks) {
  let max = 0;
  for (let i = 1; i < picks.length; i++) {
    max = Math.max(max, picks[i] - picks[i - 1]);
  }
  return max;
}
