/**
 * A weight as the reader should see it: signed, one decimal at most, and
 * never a bare "-0". Weights arrive as the score contribution that produced
 * the reason, and sums of one-decimal numbers drift, so this rounds rather
 * than trusting the number to already be presentable. A weight that is not a
 * number at all gets a dash instead of "NaN".
 */
function formatWeight(weight) {
  const n = Number(weight);
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10 || 0; // `|| 0` also flattens -0
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}


/**
 * Two different facts, and they must not share a sentence. The first is a
 * result -- the engine weighed this player and nothing moved him. The second
 * is the absence of a result: on a completed draft (or before a draft loads)
 * the engine does not run at all, and saying he "moves neither way" would
 * claim an evaluation that never happened.
 */
export const SCORED_NOTHING = "Nothing about this player moves him either way.";
export const NOT_EVALUATED = "No pick is on the clock, so nobody has been evaluated.";

export const ADVICE_BASIS = "Weighed from draft strategy and last season's production. Not a projection.";

/**
 * The reasons behind a player, drawbacks included.
 *
 * A negative weight is shown as a negative, not hidden and not softened: the
 * engine recommends players in spite of their drawbacks and says so, and a
 * card that only ever shows the good news is not worth reading.
 */
export function ReasonList({ reasons, emptyText = SCORED_NOTHING }) {
  const list = Array.isArray(reasons) ? reasons : [];

  if (list.length === 0) {
    return <p className="text-[11px] leading-snug text-zinc-500">{emptyText}</p>;
  }

  return (
    <ul className="space-y-1">
      {list.map((r, i) => {
        const n = Number(r?.weight);
        const helps = Number.isFinite(n) && n > 0;
        return (
          <li
            key={`${r?.kind ?? "reason"}-${i}`}
            data-testid="advice-reason"
            className="flex items-start gap-2 text-[11px] leading-snug"
          >
            <span
              className={[
                "shrink-0 rounded-full border px-1.5 py-0.5 tabular-nums",
                helps
                  ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-300"
                  : "border-rose-900/60 bg-rose-950/40 text-rose-300",
              ].join(" ")}
            >
              {formatWeight(r?.weight)}
            </span>
            <span className="text-zinc-300">{String(r?.text ?? "")}</span>
          </li>
        );
      })}
    </ul>
  );
}
