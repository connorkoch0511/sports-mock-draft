import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { useAuth } from "../lib/authContext.js";
import { mustSignIn } from "../lib/authGate.js";
import { usePageTitle } from "../lib/usePageTitle";
import { useRememberDraft } from "../lib/useRememberDraft";
import { Pill } from "../components/draft/Pill";
import { BigBoardPanel } from "../components/draft/BigBoardPanel";
import { DraftBoardPanel } from "../components/draft/DraftBoardPanel";
import { RosterPanel } from "../components/draft/RosterPanel";

const PICK_SECONDS = 60;

// A 401 means "sign in first"; a 404 from a mutation on a draft this page
// just fetched (GET /drafts/{id} is public) means the caller is signed in
// but does not own it -- not that the draft is gone. The client already
// knows it exists, since the page is showing it.
function mutationErrorMessage(e, fallback) {
  if (e.status === 401) return "Sign in to make changes";
  if (e.status === 404) return "This draft isn't yours to edit";
  return e.message || fallback;
}

export default function Draft() {
  const { draftId } = useParams();
  const [draft, setDraft] = useState(null);
  const [players, setPlayers] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [boardRows, setBoardRows] = useState(null);
  const [boardFailed, setBoardFailed] = useState(false);
  const [boardMeta, setBoardMeta] = useState(null);

  // Timer + pause
  const [paused, setPaused] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(PICK_SECONDS);
  const tickRef = useRef(null);

  const { configured, signedIn, signIn } = useAuth();
  const needsSignIn = mustSignIn({ configured, signedIn });

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

  const playersById = useMemo(() => {
    const m = new Map();
    for (const p of players) m.set(p.id, p);
    return m;
  }, [players]);

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
      setErr(mutationErrorMessage(e, "Pick failed"));
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
      setErr(mutationErrorMessage(e, "Auto-pick failed"));
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
      setErr(mutationErrorMessage(e, "Sim failed"));
    } finally {
      setBusy(false);
    }
  };

  // ----- Timer + Autopick behavior -----

  // The timer effects below depend on the draft's FIELDS, never the draft
  // object: `load()` returns a fresh object after every pick, so depending on
  // the object itself would reset the clock on each of the eleven auto-picks
  // between your turns. Pulled out as locals so the effect bodies never touch
  // `draft` either, which is what lets the dependency arrays be honest instead
  // of suppressed.
  const hasDraft = draft != null;
  const draftKey = draft?.draftId;
  const currentIndex = draft?.currentIndex;
  const currentTeam = draft?.currentTeam;
  const completed = draft?.completed ?? false;


  // Reset timer on new pick / when it becomes the user's team's turn
  useEffect(() => {
    if (!hasDraft) return;
    if (completed) {
      setSecondsLeft(0);
      return;
    }
    // Only meaningful for the user's team
    if (isMyTurn) setSecondsLeft(PICK_SECONDS);
  }, [hasDraft, draftKey, currentIndex, currentTeam, completed, isMyTurn]);

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

    if (!hasDraft) return;
    if (paused) return;
    if (busy) return;
    if (completed) return;
    if (!isMyTurn) return;

    tickRef.current = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [hasDraft, currentTeam, completed, paused, busy, isMyTurn]);

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

  const canManualPick = !paused && !busy && !draft.completed && isMyTurn && !needsSignIn;

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

        {needsSignIn && (
          <div
            data-testid="signin-required"
            className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-cyan-800/40 bg-cyan-950/20 px-4 py-3 text-sm text-cyan-200"
          >
            <span>Sign in to make picks. Nothing you draft will save until you do.</span>
            <button
              type="button"
              onClick={signIn}
              data-testid="signin-required-button"
              className="rounded-2xl border border-cyan-800/60 bg-cyan-950/40 px-3 py-1.5 text-xs text-cyan-200 hover:border-cyan-600"
            >
              Sign in
            </button>
          </div>
        )}

        {/* 3-column app layout */}
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[420px_minmax(0,1fr)_360px] flex-1 min-h-0 min-w-0">
            <BigBoardPanel
              draft={draft}
              players={players}
              boardRows={boardRows}
              boardMeta={boardMeta}
              boardFailed={boardFailed}
              myTeam={myTeam}
              isMyTurn={isMyTurn}
              paused={paused}
              needsSignIn={needsSignIn}
              canManualPick={canManualPick}
              makePick={makePick}
            />

            <DraftBoardPanel draft={draft} playersById={playersById} />

            <RosterPanel draft={draft} />
        </div>
      </div>
    </div>
  );
}