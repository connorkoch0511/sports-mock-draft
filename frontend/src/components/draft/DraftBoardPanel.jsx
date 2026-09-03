import { useState } from "react";

const PAGE_SIZE = 25;

/**
 * The pick-by-pick board. Owns its pagination: the page shown here is
 * unrelated to the Big Board's page, and keeping them in one component was
 * the only reason they ever shared a parent.
 */
export function DraftBoardPanel({ draft, playersById }) {
  const [draftPage, setDraftPage] = useState(0);

  return (
      <div data-testid="panel-draft-board" className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] min-h-0 min-w-0 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Draft Board</h2>
          <div className="text-xs text-zinc-400">Snake draft</div>
        </div>

        {/* Draft board pagination controls */}
        {(() => {
          const totalDraftPages = Math.max(1, Math.ceil(draft.picks.length / PAGE_SIZE));
          return (
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <div className="flex gap-1">
                <button
                  onClick={() => setDraftPage(0)}
                  disabled={draftPage === 0}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-2 py-1 hover:border-zinc-600 disabled:opacity-30"
                >«</button>
                <button
                  onClick={() => setDraftPage((p) => Math.max(0, p - 1))}
                  disabled={draftPage === 0}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-2 py-1 hover:border-zinc-600 disabled:opacity-30"
                >‹</button>
              </div>
              <span>{draftPage + 1} / {totalDraftPages} · {draft.picks.length} picks</span>
              <div className="flex gap-1">
                <button
                  onClick={() => setDraftPage((p) => Math.min(totalDraftPages - 1, p + 1))}
                  disabled={draftPage >= totalDraftPages - 1}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-2 py-1 hover:border-zinc-600 disabled:opacity-30"
                >›</button>
                <button
                  onClick={() => setDraftPage(totalDraftPages - 1)}
                  disabled={draftPage >= totalDraftPages - 1}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-2 py-1 hover:border-zinc-600 disabled:opacity-30"
                >»</button>
              </div>
            </div>
          );
        })()}

        {/* Table (horizontal scroll only) */}
        <div data-testid="scroll-draft-board" className="flex-1 min-h-0 overflow-auto rounded-2xl border border-zinc-900">
          <table className="w-full text-sm min-w-[620px] md:min-w-[760px]">
            <thead className="bg-black/70 sticky top-0 z-10">
              <tr className="text-left">
                <th className="px-3 py-2 text-zinc-400 w-20">Pick</th>
                <th className="px-3 py-2 text-zinc-400 w-28">Team</th>
                <th className="px-3 py-2 text-zinc-400">Player</th>
              </tr>
            </thead>
            <tbody>
              {draft.picks.slice(draftPage * PAGE_SIZE, (draftPage + 1) * PAGE_SIZE).map((pk, idx) => {
                const absoluteIdx = draftPage * PAGE_SIZE + idx;
                const isNow = absoluteIdx === draft.currentIndex && !draft.completed;
                const pl = pk.player || (pk.playerId ? playersById.get(pk.playerId) : null);

                return (
                  <tr
                    key={pk.overall}
                    className={["border-t border-zinc-900", isNow ? "bg-cyan-300/10" : ""].join(" ")}
                  >
                    <td className="px-3 py-2 text-zinc-200 tabular-nums">#{pk.overall}</td>
                    <td className="px-3 py-2 text-zinc-200">T{pk.team}</td>
                    <td className="px-3 py-2 min-w-0">
                      {pl ? (
                        <span className="text-zinc-200 block truncate">
                          {pl.name} <span className="text-zinc-500">({pl.position})</span>
                        </span>
                      ) : isNow ? (
                        <span className="text-cyan-200">On the clock</span>
                      ) : pk.playerId ? (
                        <span className="text-zinc-500">{pk.playerId}</span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
  );
}
