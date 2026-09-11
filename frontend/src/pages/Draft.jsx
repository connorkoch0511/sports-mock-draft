import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { pushState, subscribe } from "../lib/push";
import { usePageTitle } from "../lib/usePageTitle";
import { useAuth } from "../lib/authContext.js";
import { fetchMyBoards } from "../lib/me";
import { boardOptions, boardIdFromValue } from "../lib/seatBoard";
import { Pill } from "../components/draft/Pill";
import { BigBoardPanel } from "../components/draft/BigBoardPanel";
import { DraftBoardPanel } from "../components/draft/DraftBoardPanel";
import { RosterPanel } from "../components/draft/RosterPanel";
import { skewFrom, remainingSeconds, expireDelayMs, formatCountdown } from "../lib/clock";

// Display fallback only. The server owns the clock; this is what the page
// shows for a draft written before pickDeadline existed.
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
  const { sub } = useAuth();
  const [draft, setDraft] = useState(null);
  const [players, setPlayers] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [boardRows, setBoardRows] = useState(null);
  const [boardFailed, setBoardFailed] = useState(false);
  const [boardMeta, setBoardMeta] = useState(null);
  // Read once at mount: pushState() is cheap (no network) and this control
  // only ever changes in response to this browser's own click below, never
  // from anything the draft's polling could bring back.
  const [notifyState, setNotifyState] = useState(() => pushState());

  // Timer + pause
  // Pause is the draft's state, not this browser's. A pause that stopped only
  // one person's clock would be worse than none: everyone else keeps ticking,
  // and the person who paused gets auto-picked while they think. Declared
  // this early (rather than beside `deadline` below, which is equally
  // server-derived) because the autopick effect further down reads it inside
  // a dependency array, which evaluates at the point that line runs -- a
  // `const` declared later in the same render would still be in its temporal
  // dead zone there.
  const paused = draft?.pausedAt != null;
  const [secondsLeft, setSecondsLeft] = useState(PICK_SECONDS);
  const tickRef = useRef(null);
  // How far ahead the server's clock is of this browser's. Measured fresh on
  // every full load; see src/lib/clock.js for why this matters.
  const skewRef = useRef(0);


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
      // Corrected against the server's own clock, not assumed to be zero --
      // see src/lib/clock.js for what a laptop running fast would do without
      // this.
      skewRef.current = skewFrom(d.now);
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

  const [myBoards, setMyBoards] = useState([]);
  useEffect(() => {
    let alive = true;
    fetchMyBoards()
      .then((bs) => { if (alive) setMyBoards(bs); })
      // Losing this costs the picker, not the draft. Never surface it as a
      // draft error.
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Distinct from `load`: a poll only needs the draft's current state, not a
  // fresh player pool (which never changes once a draft has started), and
  // updates state only when `version` has actually moved -- otherwise an
  // identical response landing three seconds later would re-render for
  // nothing every single tick.
  const refresh = async () => {
    try {
      const d = await apiGet(`/drafts/${draftId}`);
      // Every poll response carries a fresh server `now`, same as `load()`'s
      // own read -- recalibrating here too is nearly free and keeps a
      // long-running draft page's countdown accurate against clock drift,
      // not just the value measured once at mount.
      skewRef.current = skewFrom(d.now);
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

  // Any seated human may stop or restart the clock -- no owner-only check,
  // deliberately: these are people who were sent an invite link. Resume
  // preserves the remaining time server-side (see backend/src/drafts.js),
  // so `load()` afterward is what picks up the extended deadline rather
  // than a fresh minute.
  const togglePause = async () => {
    setBusy(true);
    try {
      await apiPost(`/drafts/${draftId}/pause`, { paused: !paused });
      await load();
    } catch (e) {
      setErr(mutationErrorMessage(e, "Could not pause the draft"));
    } finally {
      setBusy(false);
    }
  };

  const setSeatBoard = async (value) => {
    try {
      await apiPost(`/drafts/${draftId}/seat-board`, { boardId: boardIdFromValue(value) });
      await load();
    } catch (e) {
      setErr(mutationErrorMessage(e, "Could not change your board"));
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

  const expire = async () => {
    try {
      await apiPost(`/drafts/${draftId}/expire`, {});
      await load();
    } catch (e) {
      // 409 is the ordinary outcome for everyone who lost the race, and for a
      // clock that turned out not to have expired. Re-read rather than
      // reporting it -- the board is the answer.
      if (e.status === 409) {
        await load();
        return;
      }
      setErr(mutationErrorMessage(e, "Could not advance the clock"));
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
  const completed = draft?.completed ?? false;
  // The deadline the server is enforcing. Comes straight off `draft` --
  // never computed locally -- because the server is the only party allowed
  // to decide it. (`paused` is the same kind of value, declared above.)
  const deadline = draft?.pickDeadline ?? null;
  // Same reason as the hoists above: the tick effect's closure needs this
  // draft field, and pulling it out as a local here is what lets that
  // effect's dependency array name it honestly instead of suppressing the
  // lint rule that would otherwise flag the missing `draft`.
  const fallbackSeconds = draft?.pickSeconds ?? PICK_SECONDS;

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

  // Ticks for EVERYONE now, not just whoever's turn it is -- a shared draft
  // has no browser that is "the" authority on time any more, the server is,
  // and every seated browser independently watching the same deadline is
  // what lets the expire effect below fire even when the team on the clock's
  // own browser is closed. There is no reset-on-turn effect any more either:
  // the deadline already changed when the draft advanced (the server sends a
  // fresh one with every pick), so there is nothing left for the client to
  // reset.
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);

    if (!hasDraft || completed || paused) {
      setSecondsLeft(0);
      return undefined;
    }

    const tick = () =>
      setSecondsLeft(remainingSeconds(deadline, skewRef.current) ?? fallbackSeconds);
    tick();
    tickRef.current = setInterval(tick, 1000);

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [hasDraft, deadline, completed, paused, fallbackSeconds]);

  // The clock, enforced. Whoever's browser notices zero first calls
  // /expire -- not /auto-pick, which keeps its own meaning (the manual
  // button, and the bot-on-clock effect above). Staggered by seat so twelve
  // browsers noticing the same second don't all race the same request; the
  // losers get a harmless 409 and re-read, which is exactly what a clock
  // that turned out not to have expired yet also looks like.
  //
  // Scheduled directly off `deadline`, deliberately NOT off the `secondsLeft`
  // display state above: the two effects run in the same commit whenever the
  // draft object changes, so `secondsLeft` here would still be the PREVIOUS
  // render's value -- stale by definition, since the tick effect's own
  // setSecondsLeft call hasn't been applied to a render yet. On first load
  // that stale value is the initial 0 the state started life as, which read
  // as "already expired" and fired /expire against a deadline a full minute
  // out. Recomputing the remaining time fresh from `deadline` and the
  // skew here sidesteps that render ordering entirely.
  useEffect(() => {
    if (!hasDraft || paused || busy || completed) return undefined;
    if (deadline == null) return undefined;

    const seatIndex = seats.findIndex((s) => s?.team === myTeam);
    const msLeft = deadline - (Date.now() + skewRef.current);
    const t = setTimeout(expire, Math.max(0, msLeft) + expireDelayMs(seatIndex));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDraft, deadline, paused, busy, completed]);

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
  // pausedBy is the raw sub of whoever paused it -- there is no name to show
  // (the client is never handed one for another seat, see GET's own
  // comment), but "somebody who isn't you" is still worth saying so the
  // person looking at a frozen clock doesn't wonder if their own browser is
  // broken.
  const pausedByOther = paused && draft.pausedBy != null && draft.pausedBy !== sub;

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
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 px-3 py-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/60 px-3 py-1 text-xs text-zinc-300">
                <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_20px_rgba(34,211,238,0.5)]" />
                Live Draft
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 items-center justify-start lg:justify-end">
              <button
                onClick={togglePause}
                disabled={busy}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
              >
                {paused ? "Resume" : "Pause"}
              </button>

              {/* A visible "Auto-pick from" label plus a select sized to its
                  widest option (a board name) was wide enough to tip this
                  row onto an extra flex-wrap line at the 1280px-wide
                  viewport the suite actually runs at (playwright.config.js's
                  top-level 1440x900 is overridden by the chromium project's
                  devices["Desktop Chrome"]). That extra line shrank
                  BigBoardPanel below what scroll-big-board's min-h-[160px]
                  floor needs, pushing the panel's own bottom border off the
                  visible page. This row's baseline margin at 1280px turned
                  out to be only ~26px even before this control existed --
                  nowhere near enough for a functional select no matter how
                  narrow -- so closing the gap took two things: no visible
                  text label on the select itself (the accessible name comes
                  from aria-label, with a hover title carrying the same
                  text), and a hard cap+truncate on its width so a long board
                  name can't widen it past a couple of characters. The
                  reclaimed row/gap spacing above is the same order of
                  magnitude and applies to every item in this row, not just
                  this control. */}
              <select
                data-testid="seat-board"
                aria-label="Auto-pick from"
                title="Auto-pick from"
                className="max-w-[3rem] truncate rounded-lg border border-zinc-700 bg-zinc-900 px-1 py-1 text-xs text-zinc-200"
                value={draft.yourBoardId ?? ""}
                onChange={(e) => setSeatBoard(e.target.value)}
                disabled={busy || draft.completed}
              >
                {boardOptions(myBoards, draft.yourBoardId).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>

              {pausedByOther && (
                <span data-testid="paused-by" className="text-xs text-zinc-400">
                  Paused by someone else
                </span>
              )}

              {draft.completed ? (
                <Pill>✅ Completed</Pill>
              ) : paused ? (
                // Checked ahead of isMyTurn: a paused draft has nobody
                // actually "on the clock" -- everyone is stopped, including
                // whoever's turn it nominally is -- so the countdown itself
                // must not render while paused, for anyone.
                <Pill>⏸ Paused</Pill>
              ) : isMyTurn ? (
                // Pill itself doesn't forward props, so the id this test
                // keys off of goes on a wrapper instead of changing it. The
                // clock now runs (and is shown) for everyone, shared draft or
                // not -- the server is the one enforcing it either way.
                <span data-testid="pick-countdown">
                  <Pill>⏱ {formatCountdown(secondsLeft)}</Pill>
                </span>
              ) : onClockIsBot ? (
                <Pill>Auto-picking other teams…</Pill>
              ) : (
                // Somebody else's human turn, in a shared draft.
                // "Auto-picking other teams…" would be a lie here, since the
                // team waited on is a person, not a bot.
                <span data-testid="status-pill">
                  <Pill>{`Waiting on Team ${currentTeamOnClock}`}</Pill>
                </span>
              )}

              <button
                onClick={autoPick}
                disabled={paused || busy || draft.completed || !autoPickAllowed}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                title="Auto-pick for whichever team is on the clock"
              >
                Auto Pick
              </button>

              {humans > 1 ? null : (
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

              {notifyState !== "unsupported" && (
                // Same reasoning as seat-board's title/aria-label-carries-
                // the-real-text trick just above: "Notifications blocked" is
                // 21 characters, and this row is already tight enough that
                // Chromium's headless quirk of reporting Notification.
                // permission as "denied" by default (confirmed against this
                // very suite -- grantPermissions does not change the
                // synchronous getter, only what requestPermission() resolves
                // to) renders that widest label on every draft-page test
                // unless it is kept short. The full sentence still reaches
                // anyone who needs it, via the accessible name and the hover
                // title.
                <button
                  type="button"
                  data-testid="notify-toggle"
                  disabled={notifyState === "denied"}
                  onClick={async () => {
                    // subscribe() can reject -- a failing POST, a malformed
                    // VAPID key breaking atob(), a registration that never
                    // activates -- and with no catch here that becomes an
                    // unhandled rejection: setNotifyState never runs, and the
                    // button silently keeps reading "Notify" forever. Land on
                    // an explicit failure state instead, and let the click
                    // retry.
                    try {
                      setNotifyState(await subscribe());
                    } catch {
                      setNotifyState("error");
                    }
                  }}
                  aria-label={
                    notifyState === "granted"
                      ? "Notifications on"
                      : notifyState === "denied"
                        ? "Notifications blocked"
                        : notifyState === "error"
                          ? "Notifications failed, tap to try again"
                          : "Notify me for your turn"
                  }
                  title={
                    notifyState === "granted"
                      ? "Notifications on"
                      : notifyState === "denied"
                        ? "Notifications blocked"
                        : notifyState === "error"
                          ? "Notifications failed, tap to try again"
                          : "Notify me for your turn"
                  }
                  className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600 disabled:opacity-50"
                >
                  {notifyState === "granted"
                    ? "On"
                    : notifyState === "denied"
                      ? "Blocked"
                      : notifyState === "error"
                        ? "Retry"
                        : "Notify"}
                </button>
              )}

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