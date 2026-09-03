import { formatWeight } from "./formatWeight.js";

/**
 * Where a player stood before any reason moved him.
 *
 * Shown apart from the reason list, not inside it: the engine treats the base
 * as a starting point rather than an argument, and folding it in would claim
 * his existing rank is a reason to draft him. Kept visible all the same,
 * because without it the weights on screen do not add up to the ranking and
 * two players cannot be compared from what is displayed.
 */
export function StartingPoint({ startingPoint, onBoard }) {
  if (!startingPoint) return null;
  const { base, position, score } = startingPoint;

  return (
    <div
      data-testid="starting-point"
      className="flex items-baseline justify-between gap-2 border-b border-zinc-800/70 pb-1.5 text-[11px] text-zinc-400"
    >
      <span>
        Starts {position}
        {ordinal(position)} on {onBoard ? "your board" : "the consensus board"}
        <span className="ml-1 tabular-nums text-zinc-500">({formatWeight(base)})</span>
      </span>
      {typeof score === "number" ? (
        <span className="tabular-nums text-zinc-300" data-testid="starting-point-score">
          {formatWeight(score)} total
        </span>
      ) : null}
    </div>
  );
}

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
