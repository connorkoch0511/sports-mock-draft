/**
 * The queue: who you're taking next, in order, drawn from your own seat's
 * private list. Nothing here decides what's IN the queue -- BigBoardPanel's
 * queue-add button does that -- this panel only renders it and lets you
 * take somebody back off.
 */
export function QueuePanel({ queue, playersById, picked, onRemove }) {
  // Filtered on read. A queued player somebody drafted is gone from here the
  // moment the pick lands -- no write, no race, and nothing struck through:
  // an entry you cannot pick is noise in a list whose whole job is what you
  // are going to pick next. Where the run happened is legible on the Draft
  // Board, which exists for that; this list stays nothing but signal.
  const live = queue.filter((id) => !picked.has(id));

  return (
    <div
      data-testid="panel-queue"
      className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] min-h-0 min-w-0 flex flex-col"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Queue</h2>
        <div className="text-xs text-zinc-400">{live.length} queued</div>
      </div>

      <div data-testid="scroll-queue" className="mt-3 flex-1 min-h-0 overflow-auto space-y-2 pr-1">
        {live.length === 0 ? (
          // The point of this panel: an empty queue is a normal, common state
          // (most drafts, most of the time) and a blank box in that state
          // reads as broken rather than "nothing queued yet".
          <p data-testid="queue-empty" className="text-sm text-zinc-500">
            Nothing queued. Add players from the Big Board and the clock will
            draft from this list first if it ever has to pick for you.
          </p>
        ) : (
          live.map((id, i) => {
            const p = playersById.get(id);
            // The player pool loads separately from the draft itself
            // (Draft.jsx's load()); a queue entry racing ahead of it is not
            // an error, just a row with nothing to render yet.
            if (!p) return null;
            return (
              <div
                key={id}
                data-testid="queue-row"
                className="flex items-center justify-between gap-2 rounded-2xl border border-zinc-900 bg-black/60 p-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-xs text-zinc-500 tabular-nums">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="text-xs text-zinc-400">
                      {p.position} · {p.team}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="queue-remove"
                  aria-label={`Remove ${p.name} from your queue`}
                  title={`Remove ${p.name} from your queue`}
                  onClick={() => onRemove(id)}
                  className="shrink-0 rounded-full border border-zinc-800 bg-zinc-950/70 px-2.5 py-1 text-[11px] text-zinc-300 hover:border-zinc-600"
                >
                  Remove
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
