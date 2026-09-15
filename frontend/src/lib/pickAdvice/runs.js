import { RUN_WINDOW, RUN_MIN_COUNT, RUN_MULTIPLE } from "./weights.js";

/**
 * Positions being drafted faster than the remaining startable board predicts.
 *
 * Two populations, deliberately different, and conflating them is the whole
 * trap this module exists to avoid:
 *
 *   - The COUNT is over every pick in the window, startable or not, because
 *     the sentence it feeds ("4 of the last 8 picks by other teams were RBs")
 *     has to be true of the Draft Board a user can count. A reason a user can
 *     disprove by counting is worse than no reason.
 *
 *   - The EXPECTED rate is over `startable` only. Asking what share of the
 *     whole remaining board is running backs gets an answer dominated by the
 *     ~891 nobody would ever start, and nothing would ever look like a
 *     departure from it. This is the same mistake that made scarcityFactor
 *     fire zero times on live data.
 *
 * Returns a Map holding ONLY positions that cleared the test. A position that
 * is not running is absent rather than present-with-a-false-flag, so a caller
 * cannot accidentally read a non-run as a run.
 */
export function detectRuns({ made, mySlot, available, startable }) {
  const runs = new Map();
  if (!Array.isArray(made) || !Array.isArray(available) || !startable) return runs;

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

  // How much of the startable board each position still represents.
  let totalStartableLeft = 0;
  const startableLeft = new Map();
  for (const [position, ids] of startable) {
    let n = 0;
    for (const player of available) {
      if (ids.has(String(player.id))) n += 1;
    }
    startableLeft.set(position, n);
    totalStartableLeft += n;
  }
  if (totalStartableLeft === 0) return runs;

  for (const [position, count] of counts) {
    if (count < RUN_MIN_COUNT) continue;

    const left = startableLeft.get(position) || 0;
    // Nobody left worth hurrying for. An expected share of zero would make
    // every observed share infinitely above it, which is not a signal.
    if (left === 0) continue;

    const expected = left / totalStartableLeft;
    const observed = count / window.length;
    if (observed >= expected * RUN_MULTIPLE) {
      runs.set(position, { count, window: window.length });
    }
  }

  return runs;
}
