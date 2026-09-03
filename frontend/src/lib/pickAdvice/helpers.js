// Small shared helpers for the advice engine. Pure, and deliberately dull:
// every one exists because a bare expression got a case wrong somewhere.

export function step(value, steps, matches) {
  for (const [at, weight] of steps) if (matches(value, at)) return weight;
  return 0;
}

export function finite(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function positiveInt(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;
}

/** Consensus rank ascending, unranked last. Two unranked players tie. */
export function compareRank(a, b) {
  const ar = finite(a?.rank);
  const br = finite(b?.rank);
  if (ar === null && br === null) return 0;
  if (ar === null) return 1;
  if (br === null) return -1;
  return ar - br;
}

export function round1(n) {
  // Weights are sums and products of one-decimal ADPs; bare arithmetic drifts
  // into 3.6000000000000005 and makes every reason look computed by accident.
  return Math.round(n * 10) / 10;
}

export function clamp(n, low, high) {
  return Math.min(high, Math.max(low, n));
}

/**
 * " with a hamstring", or "" when the body part is unknown.
 *
 * Lives here rather than beside the factors because the AVAILABILITY table
 * builds its sentences with it, and that table is a weight, not a factor.
 */
export function bodyPart(player) {
  const part = player?.injuryBodyPart;
  return typeof part === "string" && part.trim() !== "" ? ` with a ${part.toLowerCase()}` : "";
}
