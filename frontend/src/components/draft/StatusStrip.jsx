// What is true right now, and the one control you reach for in a hurry. The
// clock cannot be a tap away, which is why every draft app pins it.
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
          className="rounded-xl border border-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:opacity-50"
        >
          {paused ? "Resume" : "Pause"}
        </button>
      )}
      <button
        type="button"
        data-testid="open-controls"
        onClick={onOpenSheet}
        aria-label="Draft controls"
        className="rounded-xl border border-zinc-800 px-3 py-1.5 text-xs text-zinc-200"
      >
        ⋯
      </button>
    </div>
  );
}
