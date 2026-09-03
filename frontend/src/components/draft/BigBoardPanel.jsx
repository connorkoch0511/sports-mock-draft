import { useMemo, useState } from "react";
import { orderByBoard } from "../../lib/boardOrder";
import { adviseOnPick, NO_ADVICE } from "../../lib/pickAdvice";
import { ReasonList, SCORED_NOTHING, NOT_EVALUATED, ADVICE_BASIS } from "./ReasonList";
import { Pill } from "./Pill";

const PAGE_SIZE = 25;

/**
 * The Big Board: who is left, in what order, and who to take.
 *
 * Search, position filter, pagination, the open why-panel and the advice
 * memo all live here rather than on the page. They are this panel's state --
 * nothing outside it reads them -- and hoisting them made the page own
 * twenty-five bindings it never used.
 */
export function BigBoardPanel({
  draft,
  players,
  boardRows,
  boardMeta,
  boardFailed,
  myTeam,
  isMyTurn,
  paused,
  canManualPick,
  makePick,
}) {
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState("");
  const [page, setPage] = useState(0);
  const [whyId, setWhyId] = useState(null);

  const filtered = useMemo(() => {
    if (!draft) return [];
    const q = query.trim().toLowerCase();
    return orderByBoard(players, boardRows)
      .filter((p) => !draft.picked?.includes(p.id))
      .filter((p) => (pos ? p.position === pos : true))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true));
  }, [players, boardRows, draft, query, pos]);

  // Filtering puts you back on the first page: page 4 of the old result set
  // means nothing against the new one, and staying there shows an empty list.
  //
  // Adjusted during render rather than in an effect. React re-runs the
  // component before committing, so the stale page never reaches the screen,
  // where an effect would paint it first and correct it after. The linter
  // flags the effect form -- and only started once this panel was small
  // enough for the rule to analyze; in the 743-line page it was silently
  // skipped.
  const [lastFilter, setLastFilter] = useState({ query, pos });
  if (lastFilter.query !== query || lastFilter.pos !== pos) {
    setLastFilter({ query, pos });
    setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pagedPlayers = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Advice is computed once per pick, never per keystroke. `filtered` re-runs
  // on every character typed into the search box; the engine walks the whole
  // pool (~54ms on production data), and it must see that whole pool -- its
  // scarcity model derives the startable window from it, so handing it a
  // pre-filtered list silently refills that window and the scarcity reasons
  // stop firing. So: the full `players`, and deps that only move when the
  // draft itself does.
  //
  // And only when somebody is going to read it. The card is for the user's
  // own turn, and a why panel is either open or it is not; the app auto-picks
  // the other eleven teams, so this skips the engine on eleven of every
  // twelve picks rather than scoring the whole pool for a card nobody sees.
  const adviceWanted = isMyTurn || whyId != null;
  const advice = useMemo(
    () => (adviceWanted ? adviseOnPick({ players, draft, boardRows, myTeam }) : NO_ADVICE),
    [adviceWanted, players, draft, boardRows, myTeam]
  );
  const recommendation = advice.recommendation;
  // An empty `ranked` means the engine never ran, which is a different thing
  // from it running and finding nothing to say about a player.
  const playersWereEvaluated = advice.ranked.length > 0;

  return (
      <div data-testid="panel-big-board" className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 space-y-3 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] min-h-0 min-w-0 flex flex-col">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Big Board</h2>
          <div className="text-xs text-zinc-400">
            {draft.completed
              ? "Draft completed"
              : paused
              ? "Paused"
              : isMyTurn
              ? `You are on the clock (Team ${myTeam})`
              : "Auto-picking other teams"}
          </div>
        </div>

        {boardMeta && boardRows?.length > 0 && (
          <div data-testid="board-active-note" className="rounded-2xl border border-cyan-900/50 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-200">
            Drafting off <span className="font-medium">{boardMeta.name}</span>
          </div>
        )}

        {boardMeta && boardRows?.length > 0 && boardMeta.format !== draft.format && (
          <div data-testid="draft-board-format-note" className="rounded-2xl border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            This board is ranked for {boardMeta.format.toUpperCase()} — this draft is {draft.format.toUpperCase()}.
            Players are placed by rank, but the board's order reflects {boardMeta.format.toUpperCase()} scoring.
          </div>
        )}

        {boardFailed && (
          <div data-testid="board-load-note" className="rounded-2xl border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            Your board could not be loaded — showing consensus order.
          </div>
        )}

        {/*
          Only on the user's own clock. The engine weighs value and
          scarcity against the USER's next pick, so on somebody else's
          turn the card would be advising a decision that is not being
          made, with the numbers taken from the wrong pick.

          Not filtered, though: the card is not a row. It sits above the
          search box in its own container, so hiding it on a keystroke
          yanks the input out from under the caret -- and filtering to a
          position is how you ask "who should I take at RB?", which is
          the worst possible moment to delete the answer. It prints the
          position and team, so it is never pointing at nothing.
        */}
        {isMyTurn && recommendation ? (
          <div
            data-testid="advice-card"
            className="rounded-2xl border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 space-y-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
                Suggested pick
              </span>
              <span className="text-[11px] text-zinc-400">
                {recommendation.player.position} · {recommendation.player.team}
              </span>
            </div>
            <div className="text-sm font-semibold text-zinc-100">
              {recommendation.player.name}
            </div>
            <ReasonList reasons={recommendation.reasons} />
            <p className="text-[11px] leading-snug text-zinc-500">{ADVICE_BASIS}</p>
          </div>
        ) : null}

        <div className="flex gap-2">
          <input
            className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-cyan-300/60 focus:shadow-[0_0_0_4px_rgba(34,211,238,0.10)]"
            placeholder="Search player…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-sky-300/60 focus:shadow-[0_0_0_4px_rgba(59,130,246,0.10)]"
            value={pos}
            onChange={(e) => setPos(e.target.value)}
          >
            <option value="">All</option>
            <option value="QB">QB</option>
            <option value="RB">RB</option>
            <option value="WR">WR</option>
            <option value="TE">TE</option>
            <option value="K">K</option>
            <option value="DEF">DEF</option>
          </select>
        </div>

        {/* Pagination controls */}
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <div className="flex gap-1">
            <button
              onClick={() => setPage(0)}
              disabled={page === 0}
              className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-2 py-1 hover:border-zinc-600 disabled:opacity-30"
            >
              «
            </button>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-2 py-1 hover:border-zinc-600 disabled:opacity-30"
            >
              ‹
            </button>
          </div>
          <span>{page + 1} / {totalPages} · {filtered.length} players</span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-2 py-1 hover:border-zinc-600 disabled:opacity-30"
            >
              ›
            </button>
            <button
              onClick={() => setPage(totalPages - 1)}
              disabled={page >= totalPages - 1}
              className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-2 py-1 hover:border-zinc-600 disabled:opacity-30"
            >
              »
            </button>
          </div>
        </div>

        <div data-testid="scroll-big-board" className="flex-1 min-h-0 overflow-auto space-y-2 pr-1">
          {pagedPlayers.map((p) => (
            // The row is a container now, not a button: a <button> cannot
            // nest inside a <button>, and the row needs a second control.
            // The draft button is untouched -- same disabled, same
            // onClick, same title, same contents -- and the why control is
            // overlaid on it rather than placed beside it, so the row
            // still looks and measures exactly as it did.
            <div key={p.id} data-testid="big-board-row">
              <div className="relative">
                <button
                  disabled={!canManualPick}
                  onClick={() => makePick(p.id)}
                  className="w-full text-left rounded-2xl border border-zinc-900 bg-black/60 p-3 hover:border-zinc-700 disabled:opacity-50"
                  title={
                    canManualPick
                      ? `Click to draft for Team ${myTeam}`
                      : draft.completed
                      ? "Draft completed"
                      : paused
                      ? "Paused"
                      : `You can only draft when Team ${myTeam} is on the clock`
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">
                      {p.myRank != null
                        ? `${p.myRank}. `
                        : p.rank != null
                        ? `${p.rank}. `
                        : ""}
                      {p.name}
                    </div>
                    <div className="text-xs text-zinc-400">
                      {p.adp != null ? `ADP ${p.adp}` : "ADP —"}
                      {p.delta != null && p.delta !== 0 ? (
                        <span className={p.delta > 0 ? "ml-1 text-emerald-400" : "ml-1 text-rose-400"}>
                          {p.delta > 0 ? `+${p.delta}` : p.delta}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-1 flex gap-2 text-xs text-zinc-300 flex-wrap">
                    <Pill>{p.position}</Pill>
                    <Pill>{p.team}</Pill>
                    {p.tier != null ? <Pill>Tier {p.tier}</Pill> : null}
                  </div>
                </button>

                <button
                  type="button"
                  data-testid="why-player"
                  aria-label={`Why ${p.name}?`}
                  aria-expanded={whyId === p.id}
                  onClick={() => setWhyId((cur) => (cur === p.id ? null : p.id))}
                  title={`Why ${p.name} is here — reading never drafts anybody`}
                  className="absolute bottom-2 right-2 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] font-normal text-zinc-400 hover:text-cyan-200"
                >
                  Why?
                </button>
              </div>

              {whyId === p.id ? (
                <div
                  data-testid="why-panel"
                  className="mt-2 rounded-2xl border border-cyan-900/50 bg-cyan-950/20 px-3 py-2 space-y-2"
                >
                  <div className="text-xs font-medium text-cyan-100">Why {p.name} is here</div>
                  <ReasonList
                    reasons={advice.reasonsFor(p.id)}
                    emptyText={playersWereEvaluated ? SCORED_NOTHING : NOT_EVALUATED}
                  />
                  <p className="text-[11px] leading-snug text-zinc-500">{ADVICE_BASIS}</p>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
  );
}
