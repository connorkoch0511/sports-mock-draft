/**
 * A weight as the reader should see it: signed, one decimal at most, and
 * never a bare "-0". Weights arrive as the score contribution that produced
 * the reason, and sums of one-decimal numbers drift, so this rounds rather
 * than trusting the number to already be presentable. A weight that is not a
 * number at all gets a dash instead of "NaN".
 */
export function formatWeight(weight) {
  const n = Number(weight);
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10 || 0; // `|| 0` also flattens -0
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}
