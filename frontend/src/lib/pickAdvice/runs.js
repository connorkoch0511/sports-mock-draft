import { RUN_WINDOW, RUN_MIN_COUNT, RUN_MULTIPLE } from "./weights.js";
import { compareRank, finite } from "./helpers.js";

/**
 * Positions being drafted faster than the board predicted, at the moment the
 * window's picks began -- not faster than what happens to remain now.
 *
 * The COUNT is over every pick in the window, because the sentence it feeds
 * ("4 of the last 8 picks by other teams were RBs") has to be true of the
 * Draft Board a user can count. A reason a user can disprove by counting is
 * worse than no reason.
 *
 * The EXPECTED rate is the position mix of the RECONSTRUCTED board's best K
 * players, where K is however many picks (by any seat) happened since the
 * window began. Reading the CURRENT board instead is the trap: the window's
 * own picks already removed those players from it, so a position taken
 * heavily is now scarce or absent at the top of what remains, its expected
 * share collapses toward zero, and any observed share at all looks like a
 * departure -- the factor firing on its own aftermath. Putting the taken
 * players back before ranking is what makes "expected" mean what the board
 * actually offered, not what it has left.
 *
 * That reconstruction only works while the board has an opinion. Once the
 * ranked pool runs thin, `compareRank` treats every unranked player as tied,
 * and `Array.prototype.sort`'s stability then means the sort order for that
 * tied block is just `[...available, ...takenSince]`'s insertion order --
 * `takenSince` sorts entirely below `available`, contributes nothing to
 * `bestK`, and the reconstruction quietly degenerates back into reading the
 * live board. So if fewer than K players in the reconstructed board carry a
 * finite rank, a trustworthy top-K cannot be formed and the factor stays
 * silent rather than firing on a board it cannot actually rank.
 *
 * Returns a Map holding ONLY positions that cleared the test. A position that
 * is not running is absent rather than present-with-a-false-flag, so a caller
 * cannot accidentally read a non-run as a run.
 */
export function detectRuns({ made, mySlot, available }) {
  const runs = new Map();
  if (!Array.isArray(made) || !Array.isArray(available)) return runs;

  // A run is evidence about what OTHER drafters are doing. Counting your own
  // picks makes a feedback loop: take backs in back-to-back rounds (normal at
  // a turn) and the engine cites your own picks as proof backs are flying,
  // then recommends a third.
  const others =
    mySlot == null ? made : made.filter((p) => Number(p?.team) !== mySlot);
  const window = others.slice(-RUN_WINDOW);
  if (window.length === 0) return runs;

  const counts = new Map();
  for (const p of window) {
    const position = p?.player?.position;
    if (!position) continue;
    counts.set(position, (counts.get(position) || 0) + 1);
  }

  // THE BOARD AS IT STOOD WHEN THESE PICKS BEGAN -- not as it stands now.
  //
  // Reading the current board makes the factor fire on its own aftermath:
  // the window's picks already removed those players, so a position that was
  // taken heavily is now absent from the top of what remains, its expected
  // share collapses toward zero, and any observed share at all beats it.
  //
  // So the picks go back on the board before the comparison. `takenSince`
  // counts picks by ANY seat, including the user's own, while `window` counts
  // only other teams' -- deliberate, because both sides are shares and the
  // board lost those players regardless of who took them.
  // `others` is a reference-filter of `made`, so every element of `window`
  // (drawn from `others`) is a reference already in `made` -- `indexOf` here
  // cannot miss and this fallback is unreachable today. If that ever changed,
  // slicing from 0 would make K the entire draft and bestK the top ~100 of
  // the board -- a silently wrong baseline. Declining to speak is the safe
  // direction for a fallback that should never run.
  const windowStartIdx = made.indexOf(window[0]);
  if (windowStartIdx === -1) return runs;
  const takenSince = made
    .slice(windowStartIdx)
    .map((p) => p?.player)
    .filter(Boolean);
  const K = takenSince.length;

  const boardThen = [...available, ...takenSince].sort(compareRank);

  // The board has no opinion where it cannot rank the players involved. Once
  // fewer than K entries carry a finite rank, `compareRank`'s tie-everything-
  // unranked behaviour makes `bestK` a literal read of the live board (see
  // the module comment above) -- a departure from a board with no opinion is
  // not meaningful, so decline to speak rather than fire on it.
  const rankedCount = boardThen.filter((p) => finite(p?.rank) !== null).length;
  if (rankedCount < K) return runs;

  const bestK = boardThen.slice(0, K);

  const expectedCounts = new Map();
  for (const player of bestK) {
    const position = player?.position;
    if (!position) continue;
    expectedCounts.set(position, (expectedCounts.get(position) || 0) + 1);
  }

  for (const [position, count] of counts) {
    if (count < RUN_MIN_COUNT) continue;

    // A position the board never offered cannot be departed from by taking
    // it -- but it is exactly what a genuine run looks like, so it fires
    // rather than being skipped. Expected 0 with a real observed share is the
    // strongest possible departure.
    const expected = (expectedCounts.get(position) || 0) / K;
    const observed = count / window.length;
    if (observed >= expected * RUN_MULTIPLE) {
      runs.set(position, { count, window: window.length });
    }
  }

  return runs;
}
