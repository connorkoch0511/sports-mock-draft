import { useMemo } from "react";

/**
 * Team rosters, derived from the draft itself rather than passed in, because
 * nothing outside this panel needs the shape.
 */
export function RosterPanel({ draft }) {
  const rosters = useMemo(() => {
    if (!draft) return {};
    const map = {};
    for (let t = 1; t <= (draft.teams || 0); t++) map[t] = [];

    for (const pk of draft.picks || []) {
      if (pk.player) {
        map[pk.team].push({ overall: pk.overall, round: pk.round, player: pk.player });
      }
    }
    return map;
  }, [draft]);

  // No lg:col-span-2 any more. That span existed for the THREE-panel
  // lg:grid-cols-2 layout, where rosters was the odd one left over after
  // board+draft filled row one -- spanning both columns kept it from
  // sitting alone in half of row two beside an empty cell. Task 3 added a
  // fourth panel (Queue) that fills that cell on its own, so the span is
  // not just unneeded now but actively wrong: it pushes Queue to a THIRD
  // row by itself instead of the two rows of two this layout is meant to be
  // (verified: with the span left in, Queue measured 486px wide, alone, at
  // y=4619 while rosters spanned 988px full-width at y=3461 -- three rows,
  // not two). Removing it is the one-line fix; xl:col-span-1 stays because
  // at xl the grid is three explicitly-sized tracks, four at 3xl and every panel
  // occupies exactly one of them regardless.
  return (
      <div data-testid="panel-rosters" className="min-h-0 min-w-0 flex flex-col rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] xl:col-span-1">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Team Rosters</h2>
          <div className="text-xs text-zinc-400">Live</div>
        </div>

        <div data-testid="scroll-rosters" className="mt-3 flex-1 min-h-0 overflow-auto space-y-3 pr-1">
          {Array.from({ length: draft.teams }, (_, i) => i + 1).map((teamNum) => (
            <div key={teamNum} className="rounded-2xl border border-zinc-900 bg-black/60 p-3">
              <div className="flex items-center justify-between">
                <div className="font-medium">Team {teamNum}</div>
                <div className="text-xs text-zinc-500">{rosters[teamNum]?.length || 0} picks</div>
              </div>

              <div className="mt-2 space-y-2">
                {(rosters[teamNum] || []).length ? (
                  rosters[teamNum].map((r) => (
                    <div key={r.overall} className="text-sm text-zinc-200 flex items-center justify-between">
                      <span className="text-zinc-500">#{r.overall}</span>
                      <span className="mx-2 flex-1 truncate">{r.player.name}</span>
                      <span className="text-zinc-500">{r.player.position}</span>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-zinc-600">No picks yet</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
  );
}
