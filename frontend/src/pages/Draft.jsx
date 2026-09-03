import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { orderByBoard } from "../lib/boardOrder";
import { useRememberDraft } from "../lib/useRememberDraft";
import { adviseOnPick, NO_ADVICE } from "../lib/pickAdvice";

const PICK_SECONDS = 60;

function Pill({ children }) {
  return (
    <span className="rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1 text-xs text-zinc-200">
      {children}
    </span>
  );
}

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
 * The reasons behind a player, drawbacks included.
 *
 * A negative weight is shown as a negative, not hidden and not softened: the
 * engine recommends players in spite of their drawbacks and says so, and a
 * card that only ever shows the good news is not worth reading.
 */
function ReasonList({ reasons, emptyText = SCORED_NOTHING }) {
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

/**
 * Two different facts, and they must not share a sentence. The first is a
 * result -- the engine weighed this player and nothing moved him. The second
 * is the absence of a result: on a completed draft (or before a draft loads)
 * the engine does not run at all, and saying he "moves neither way" would
 * claim an evaluation that never happened.
 */
const SCORED_NOTHING = "Nothing about this player moves him either way.";
const NOT_EVALUATED = "No pick is on the clock, so nobody has been evaluated.";

const ADVICE_BASIS = "Weighed from draft strategy and last season's production. Not a projection.";

export default function Draft() {
  const { draftId } = useParams();
  const [draft, setDraft] = useState(null);
  const [players, setPlayers] = useState([]);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState("");
  const [page, setPage] = useState(0);
  const [draftPage, setDraftPage] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [boardRows, setBoardRows] = useState(null);
  const [boardFailed, setBoardFailed] = useState(false);
  const [boardMeta, setBoardMeta] = useState(null);
  const [whyId, setWhyId] = useState(null);

  // Timer + pause
  const [paused, setPaused] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(PICK_SECONDS);
  const tickRef = useRef(null);

  const myTeam = draft?.userTeam || 1;
  const isMyTurn = draft?.currentTeam === myTeam;

  const load = async () => {
    setErr("");
    try {
      const d = await apiGet(`/drafts/${draftId}`);
      const p = await apiGet(
        `/players?sport=${d.sport || "nfl"}&format=${encodeURIComponent(d.format || "standard")}`
      );
      setDraft(d);
      setPlayers(p.players || []);
    } catch (e) {
      setErr(e.message || "Failed to load");
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  // Fetch the board exactly once per draft (keyed on the boardId string, not
  // the draft object), so refetching draft state after each pick does not
  // re-fetch the (heavy) board endpoint. Attaching a board to an in-progress
  // draft is out of scope, so boardId cannot change during a draft's lifetime.
  useEffect(() => {
    const boardId = draft?.boardId;

    if (!boardId) {
      // Clear any board state from a previously loaded draft, so navigating
      // from a board-backed draft to a plain one does not keep the old order.
      setBoardRows(null);
      setBoardFailed(false);
      setBoardMeta(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const b = await apiGet(`/boards/${boardId}`);
        if (cancelled) return;
        setBoardRows(b.rows || []);
        setBoardFailed(false);
        setBoardMeta({ name: b.name, format: b.format });
      } catch {
        if (cancelled) return;
        // A board can be deleted after a draft was started from it. The
        // draft stays fully playable; only the Big Board's ORDER falls
        // back to consensus.
        setBoardRows(null);
        setBoardFailed(true);
        setBoardMeta(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draft?.boardId]);

  usePageTitle(draft ? `Draft ${draftId}` : "Draft");
  useRememberDraft(draft);

  const PAGE_SIZE = 25;

  const filtered = useMemo(() => {
    if (!draft) return [];
    const q = query.trim().toLowerCase();
    return orderByBoard(players, boardRows)
      .filter((p) => !draft.picked?.includes(p.id))
      .filter((p) => (pos ? p.position === pos : true))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true));
  }, [players, boardRows, draft, query, pos]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pagedPlayers = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  useEffect(() => { setPage(0); }, [query, pos]);

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

  const playersById = useMemo(() => {
    const m = new Map();
    for (const p of players) m.set(p.id, p);
    return m;
  }, [players]);

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

  const currentPickLabel = draft
    ? `R${draft.currentRound} P${draft.currentPick} • Team ${draft.currentTeam}`
    : "";

  const makePick = async (playerId) => {
    setBusy(true);
    setErr("");
    try {
      await apiPost(`/drafts/${draftId}/pick`, { playerId });
      await load();
    } catch (e) {
      setErr(e.message || "Pick failed");
    } finally {
      setBusy(false);
    }
  };

  const autoPick = async () => {
    setBusy(true);
    setErr("");
    try {
      await apiPost(`/drafts/${draftId}/auto-pick`, {});
      await load();
    } catch (e) {
      setErr(e.message || "Auto-pick failed");
    } finally {
      setBusy(false);
    }
  };

  const simToEnd = async () => {
    setBusy(true);
    setErr("");
    try {
      await apiPost(`/drafts/${draftId}/sim-to-end`, {});
      await load();
    } catch (e) {
      setErr(e.message || "Sim failed");
    } finally {
      setBusy(false);
    }
  };

  // ----- Timer + Autopick behavior -----

  // Reset timer on new pick / when it becomes the user's team's turn
  useEffect(() => {
    if (!draft) return;
    if (draft.completed) {
      setSecondsLeft(0);
      return;
    }
    // Only meaningful for the user's team
    if (isMyTurn) setSecondsLeft(PICK_SECONDS);
  }, [draft?.draftId, draft?.currentIndex, draft?.currentTeam, draft?.completed, isMyTurn]);

  // Autopick for teams 2..N immediately (while not paused)
  useEffect(() => {
    if (!draft) return;
    if (paused) return;
    if (busy) return;
    if (draft.completed) return;

    if (!isMyTurn) {
      autoPick();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.currentTeam, draft?.currentIndex, draft?.completed, paused, busy, isMyTurn]);

  // Run countdown only when the user's team is on the clock
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);

    if (!draft) return;
    if (paused) return;
    if (busy) return;
    if (draft.completed) return;
    if (!isMyTurn) return;

    tickRef.current = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [draft?.currentTeam, draft?.completed, paused, busy, isMyTurn]);

  // If the user's team runs out of time, autopick for the user's team
  useEffect(() => {
    if (!draft) return;
    if (paused) return;
    if (busy) return;
    if (draft.completed) return;

    if (isMyTurn && secondsLeft === 0) {
      autoPick();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, draft?.currentTeam, draft?.completed, paused, busy, isMyTurn]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  if (err) return <div className="p-6 text-red-200">{err}</div>;
  if (!draft) return <div className="p-6 text-zinc-300">Loading…</div>;

  const canManualPick = !paused && !busy && !draft.completed && isMyTurn;

  return (
    <div className="relative min-h-full xl:h-full w-full overflow-x-hidden">
      {/* Background (same feel as Home) */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1000px_500px_at_20%_10%,rgba(34,211,238,0.14),transparent_60%),radial-gradient(900px_500px_at_80%_20%,rgba(59,130,246,0.12),transparent_55%),radial-gradient(700px_500px_at_50%_85%,rgba(168,85,247,0.10),transparent_55%)]" />
        <div className="absolute inset-0 opacity-[0.10] [background-image:linear-gradient(to_right,rgba(255,255,255,0.10)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.10)_1px,transparent_1px)] [background-size:64px_64px]" />
      </div>

      {/* Content */}
      <div className="relative mx-auto max-w-7xl px-6 py-6 min-h-full xl:h-full flex flex-col gap-4">
        {/* Top bar */}
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/60 px-3 py-1 text-xs text-zinc-300">
                <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_20px_rgba(34,211,238,0.5)]" />
                Live Draft
              </div>
            </div>

            <div className="flex flex-wrap gap-2 items-center justify-start lg:justify-end">
              <button
                onClick={() => setPaused((p) => !p)}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600"
              >
                {paused ? "Resume" : "Pause"}
              </button>

              {isMyTurn && !draft.completed ? (
                <Pill>⏱ {secondsLeft}s</Pill>
              ) : draft.completed ? (
                <Pill>✅ Completed</Pill>
              ) : (
                <Pill>Auto-picking other teams…</Pill>
              )}

              <button
                onClick={autoPick}
                disabled={paused || busy || draft.completed}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                title="Auto-pick for whichever team is on the clock"
              >
                Auto Pick
              </button>

              <button
                onClick={simToEnd}
                disabled={paused || busy || draft.completed}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
              >
                Sim to End
              </button>

              {draft.completed ? (
                <Link
                  to={`/draft/${draftId}/results`}
                  className="rounded-2xl bg-emerald-400 px-4 py-2 text-xs font-semibold text-black hover:bg-emerald-300"
                >
                  View Results →
                </Link>
              ) : null}

              <Pill>Draft: {draftId}</Pill>
              <Pill>{currentPickLabel}</Pill>
              <Pill>
                {draft.teams} teams • {draft.rounds} rounds
              </Pill>
            </div>
          </div>
        </div>

        {/* 3-column app layout */}
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[420px_minmax(0,1fr)_360px] flex-1 min-h-0 min-w-0">
          {/* Big Board */}
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

          {/* Draft Board */}
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

          {/* Team Rosters (sticky right rail) */}
          <div data-testid="panel-rosters" className="min-h-0 min-w-0 flex flex-col rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] lg:col-span-2 xl:col-span-1">
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
        </div>
      </div>
    </div>
  );
}