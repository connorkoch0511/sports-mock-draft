import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { Pill } from "../components/draft/Pill";
import { BigBoardPanel } from "../components/draft/BigBoardPanel";
import { DraftBoardPanel } from "../components/draft/DraftBoardPanel";
import { RosterPanel } from "../components/draft/RosterPanel";

const PICK_SECONDS = 60;

// A 401 means "sign in first"; a 404 from a mutation on a draft this page
// just fetched means the caller is signed in but has no seat in it -- not
// that the draft is gone. The client already knows it exists, since the page
// is showing it, so repeating the API's deliberately vague "not found" would
// be the one place that wording misleads rather than protects.
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


  // Derived straight from currentIndex + picks, the same way the server
  // derives currentRound/currentPick/currentTeam in the first place, rather
  // than trusting those transmitted fields on their own. The two agree on
  // every real response, but polling replaces the whole draft object on a
  // three-second timer -- if anything upstream of this page ever handed it a
  // copy where currentIndex moved without those derived fields following (a
  // shallow spread of a draft object does exactly this, since it flattens
  // any getter into whatever it returned last), reading picks directly is
  // what keeps the pick counter from freezing while the clock ticks forward.
  const currentPickEntry = draft?.picks?.[draft?.currentIndex] ?? null;
  const currentTeamOnClock = currentPickEntry?.team ?? draft?.currentTeam ?? null;

  // yourTeam is derived fresh on every request from seats and is never
  // stored, so no write could ever populate it -- this fallback isn't about
  // "until the next write". It covers two real cases instead: a draft whose
  // `seats` array is missing altogether (data from before that field
  // existed, where userTeam is genuinely correct since those drafts only
  // ever had one human), and a stale membership row -- seated once, not any
  // more -- where falling back to userTeam quietly shows the CREATOR's team
  // instead of yours.
  const myTeam = draft?.yourTeam ?? draft?.userTeam ?? 1;
  const isMyTurn = currentTeamOnClock === myTeam;

  const seats = draft?.seats ?? [];
  const humans = seats.filter((s) => s?.kind === "human").length;
  // More than one person in here means the browser is no longer the authority
  // on time. Phase 2 moves the clock to the server; until then a shared draft
  // simply has no clock, because several browsers each running their own
  // would fire auto-picks at one another.
  const shared = humans > 1;
  // "Not my team" is not the same question as "is a bot", and in a shared
  // draft the difference is somebody else's pick being taken from them.
  const onClockIsBot = seats.find((s) => s?.team === currentTeamOnClock)?.kind === "bot";

  // Mirrors the server's own rule (POST /auto-pick): allowed when the seat
  // on the clock is a bot, or when the caller holds that seat -- auto-picking
  // your OWN turn is exactly what the button is for. Anything else is
  // somebody else's human turn, and clicking Auto Pick there must not even
  // reach the network, since the server now refuses it anyway.
  const autoPickAllowed = onClockIsBot || isMyTurn;

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

  // Distinct from `load`: a poll only needs the draft's current state, not a
  // fresh player pool (which never changes once a draft has started), and
  // updates state only when `version` has actually moved -- otherwise an
  // identical response landing three seconds later would re-render for
  // nothing every single tick.
  const refresh = async () => {
    try {
      const d = await apiGet(`/drafts/${draftId}`);
      setDraft((prev) => (prev && prev.version === d.version ? prev : d));
    } catch {
      // A poll failing is not worth surfacing over whatever the page is
      // already showing -- the next one, three seconds later, tries again.
    }
  };

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

  const playersById = useMemo(() => {
    const m = new Map();
    for (const p of players) m.set(p.id, p);
    return m;
  }, [players]);

  // currentPickEntry is null once the draft is complete (currentIndex runs
  // past the end of picks), so the completed draft's last-known round/pick/
  // team is what falls back to the transmitted fields here.
  const currentPickLabel = draft
    ? `R${currentPickEntry?.round ?? draft.currentRound} P${
        currentPickEntry ? (currentPickEntry.overall % (draft.teams || 1)) || draft.teams : draft.currentPick
      } • Team ${currentTeamOnClock ?? ""}`
    : "";

  const makePick = async (playerId) => {
    setBusy(true);
    setErr("");
    try {
      await apiPost(`/drafts/${draftId}/pick`, { playerId });
      await load();
    } catch (e) {
      // A refused pick (most commonly: somebody else just picked, on a
      // device you happen to share this draft with) means the page's copy
      // is already wrong the instant the request fails. Reload FIRST so the
      // board, rosters and pick log reflect what's actually true now, then
      // set the message explaining why this particular pick didn't land --
      // reversed, load()'s own setErr("") at its top would erase the very
      // message this catch is about to show.
      await load();
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
      // A failed auto-pick (e.g. the server refusing because the clock has
      // since moved to a human) must not leave `draft` as it was: the effect
      // below re-fires whenever the clock still looks like a bot's, and
      // reloading is what lets it see the clock actually moved, so it stops
      // once reality agrees the picture changed. This does NOT bound the
      // retries against a call that keeps failing for some other reason:
      // `busy` is itself one of that effect's dependencies, so toggling it
      // off re-triggers the effect regardless of whether anything else
      // changed, and a persistently failing server gets asked again with no
      // limit.
      await load();
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

  // Everyone in the draft is looking at the same row, and only the person who
  // picked knows it changed. Three seconds is a judgement: fast enough that a
  // pick feels immediate to everybody else, slow enough that twelve people is
  // twenty requests a minute each rather than hundreds.
  useEffect(() => {
    if (!draftId || completed) return undefined;

    const id = setInterval(() => {
      // A tab nobody is looking at does not need to keep asking. Without this
      // a forgotten tab polls until the browser is closed.
      if (document.visibilityState === "hidden") return;
      refresh();
    }, 3000);

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, completed]);

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

  // Autopick only for a bot's turn. "Not mine" used to be the trigger, which
  // is exactly right with one human and exactly wrong with two: it would
  // take the other person's pick the instant the clock reached them.
  useEffect(() => {
    if (!draft) return;
    if (paused) return;
    if (busy) return;
    if (draft.completed) return;

    if (onClockIsBot) {
      autoPick();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.currentTeam, draft?.currentIndex, draft?.completed, paused, busy, onClockIsBot]);

  // Run countdown only when the user's team is on the clock, and never in a
  // shared draft -- the clock is the server's job in Phase 2, and until then
  // several browsers each running their own would fire timeout auto-picks at
  // one another.
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);

    if (!hasDraft) return;
    if (shared) return;
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
  }, [hasDraft, shared, currentTeam, completed, paused, busy, isMyTurn]);

  // If the user's team runs out of time, autopick for the user's team. Same
  // reason as the countdown above: a shared draft runs no clock at all.
  useEffect(() => {
    if (!draft) return;
    if (shared) return;
    if (paused) return;
    if (busy) return;
    if (draft.completed) return;

    if (isMyTurn && secondsLeft === 0) {
      autoPick();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, draft?.currentTeam, draft?.completed, paused, busy, isMyTurn, shared]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  // `err` alone used to blank the whole page for ANY failure, including a
  // refused pick -- the one case the design explicitly promises stays on the
  // board ("Somebody just picked -- here is the board now"). The genuine
  // "never loaded at all" case is the only one that still replaces the page:
  // that's exactly when `draft` is still null. Once a draft has loaded, a
  // later error (a rejected pick, a poll hiccup) is shown as a banner over
  // the board it's about, never in place of it.
  if (!draft && err) return <div className="p-6 text-red-200">{err}</div>;
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
        {err && (
          <div data-testid="draft-error" className="rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-200">
            {err}
          </div>
        )}

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

              {shared ? (
                // No clock in a shared draft (see the effects above) -- and
                // "Auto-picking other teams…" would be a lie here, since the
                // team waited on is another human, not a bot.
                draft.completed ? (
                  <Pill>✅ Completed</Pill>
                ) : (
                  // Pill itself doesn't forward props, so the id this test
                  // keys off of goes on a wrapper instead of changing it --
                  // same pattern as the "clock" span below, and needed here
                  // because the Big Board panel's own status line can carry
                  // this identical sentence at the same time.
                  <span data-testid="status-pill">
                    <Pill>{isMyTurn ? "Your pick" : `Waiting on Team ${currentTeamOnClock}`}</Pill>
                  </span>
                )
              ) : isMyTurn && !draft.completed ? (
                // Pill itself doesn't forward props, so the id this test
                // keys off of goes on a wrapper instead of changing it.
                <span data-testid="clock">
                  <Pill>⏱ {secondsLeft}s</Pill>
                </span>
              ) : draft.completed ? (
                <Pill>✅ Completed</Pill>
              ) : (
                <Pill>Auto-picking other teams…</Pill>
              )}

              <button
                onClick={autoPick}
                disabled={paused || busy || draft.completed || !autoPickAllowed}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                title="Auto-pick for whichever team is on the clock"
              >
                Auto Pick
              </button>

              {shared ? null : (
                // Simulating the rest of a draft other people are sitting in
                // takes their picks away from them; the server refuses this
                // with 409 once a second human is seated, so the button is
                // simply not offered rather than inviting a request that can
                // only fail.
                <button
                  onClick={simToEnd}
                  disabled={paused || busy || draft.completed}
                  className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                >
                  Sim to End
                </button>
              )}

              <button
                type="button"
                data-testid="copy-invite"
                onClick={() =>
                  navigator.clipboard.writeText(
                    `${window.location.origin}/draft/${draftId}/join?t=${draft.inviteToken}`
                  )
                }
                className="rounded-2xl border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
              >
                Copy invite link
              </button>

              {draft.completed ? (
                <Link
                  to={`/draft/${draftId}/results`}
                  className="rounded-2xl bg-emerald-400 px-4 py-2 text-xs font-semibold text-black hover:bg-emerald-300"
                >
                  View Results →
                </Link>
              ) : null}

              {/* Always visible regardless of pause state or whose turn it
                  is -- the one place on the page that unambiguously answers
                  "which team is mine", for a joiner as much as the creator. */}
              <span
                data-testid="my-team"
                className="rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1 text-xs text-zinc-200"
              >
                Your Team: {myTeam}
              </span>
              <Pill>Draft: {draftId}</Pill>
              <span data-testid="current-pick">
                <Pill>{currentPickLabel}</Pill>
              </span>
              <Pill>
                {draft.teams} teams • {draft.rounds} rounds
              </Pill>
            </div>
          </div>
        </div>

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