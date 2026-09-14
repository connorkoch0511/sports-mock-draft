// What is true right now, and the one control you reach for in a hurry. The
// clock cannot be a tap away, which is why every draft app pins it.
import { Link } from "react-router-dom";

export default function StatusStrip({
  statusLabel,
  myTeam,
  paused,
  busy,
  completed,
  isMyTurn,
  onTogglePause,
  onOpenSheet,
  onTap,
  resultsHref,
}) {
  return (
    <div
      data-testid="status-strip"
      data-your-turn={isMyTurn ? "true" : "false"}
      className={`lg:hidden shrink-0 flex items-center gap-2 rounded-2xl border px-3 py-2 backdrop-blur ${
        isMyTurn
          ? "border-cyan-300/60 bg-cyan-300/10"
          : "border-zinc-800/70 bg-zinc-950/80"
      }`}
    >
      <button
        type="button"
        data-testid="strip-status"
        onClick={onTap}
        className={`text-left text-sm ${isMyTurn ? "text-cyan-200 font-semibold" : "text-zinc-100"}`}
      >
        {statusLabel}
      </button>
      <span className="ml-auto text-xs text-zinc-400">Team {myTeam}</span>
      {!completed && (
        <button
          type="button"
          onClick={onTogglePause}
          disabled={busy}
          className="rounded-xl border border-zinc-800 px-3 py-2 text-xs text-zinc-200 disabled:opacity-50"
        >
          {paused ? "Resume" : "Pause"}
        </button>
      )}
      {completed ? (
        // Every control in the sheet is gated on !completed, so ⋯ would open a
        // sheet holding nothing but its grab handle. The same rule the
        // completed-draft header follows: do not offer what cannot act. What a
        // finished draft needs instead is the way out, which until now existed
        // only in the desktop header -- a phone user who finished a draft had
        // to leave via My Drafts and come back in.
        <Link
          to={resultsHref}
          data-testid="strip-results"
          className="rounded-xl bg-emerald-400 px-3 py-2 text-xs font-semibold text-black"
        >
          View Results →
        </Link>
      ) : (
        <button
          type="button"
          data-testid="open-controls"
          onClick={onOpenSheet}
          aria-label="Draft controls"
          className="rounded-xl border border-zinc-800 px-3 py-2 text-xs text-zinc-200"
        >
          ⋯
        </button>
      )}
    </div>
  );
}
