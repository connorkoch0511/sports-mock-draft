import { RUN_WINDOW, RUN_MIN_COUNT, RUN_MULTIPLE } from "./weights.js";
import { compareRank } from "./helpers.js";

/**
 * Positions being drafted faster than the board predicted, at the moment the
 * window's picks began -- not faster than what happens to remain now.
 *
 * Two populations, deliberately different, and conflating them is the whole
 * trap this module exists to avoid:
 *
 *   - The COUNT is over every pick in the window, because the sentence it
 *     feeds ("4 of the last 8 picks by other teams were RBs") has to be true
 *     of the Draft Board a user can count. A reason a user can disprove by
 *     counting is worse than no reason.
 *
 *   - The EXPECTED rate is the position mix of the RECONSTRUCTED board's best
 *     K players, where K is however many picks (by any seat) happened since
 *     the window began. Reading the CURRENT board instead is the trap: the
 *     window's own picks already removed those players from it, so a
 *     position taken heavily is now scarce or absent at the top of what
 *     remains, its expected share collapses toward zero, and any observed
 *     share at all looks like a departure -- the factor firing on its own
 *     aftermath. Putting the taken players back before ranking is what makes
 *     "expected" mean what the board actually offered, not what it has left.
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
  const windowStartIdx = made.indexOf(window[0]);
  const takenSince = made
    .slice(windowStartIdx === -1 ? 0 : windowStartIdx)
    .map((p) => p?.player)
    .filter(Boolean);
  const K = takenSince.length;
  if (K === 0) return runs;

  const boardThen = [...available, ...takenSince].sort(compareRank);
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
