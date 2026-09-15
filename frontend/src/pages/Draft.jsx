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
import { QueuePanel } from "../components/draft/QueuePanel";
import TabBar from "../components/draft/TabBar";
import StatusStrip from "../components/draft/StatusStrip";
import ControlSheet from "../components/draft/ControlSheet";
import { useIsPhone } from "../lib/useIsPhone";
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
  const [tab, setTab] = useState("board");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [boardRows, setBoardRows] = useState(null);
  const [boardFailed, setBoardFailed] = useState(false);
  const [boardMeta, setBoardMeta] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const isPhone = useIsPhone();
  // Widening past lg unmounts the sheet but keeps this state, so narrowing back
  // would re-open it unbidden. `tab` surviving is wanted; this is not.
  useEffect(() => {
    if (!isPhone) setSheetOpen(false);
  }, [isPhone]);
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

  // A Set purely so QueuePanel's read-time filter (`!picked.has(id)`) is
  // O(1) per row instead of an `.includes` scan repeated for every queued
  // player on every render.
  const picked = useMemo(() => new Set(draft?.picked ?? []), [draft?.picked]);
  // Never stored as its own state -- draft.yourQueue already IS the
  // server's answer after every load(), and duplicating it here would be a
  // second place for the two to disagree the moment a poll lands mid-edit.
  const queue = draft?.yourQueue ?? [];

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

  // Both queue mutations send the WHOLE array, matching the endpoint's own
  // contract (see backend/src/drafts.js's POST /queue comment): reordering
  // or trimming is then one write with no partial-order race, never a
  // patch this page would have to merge against whatever the server
  // already had. `queue` above is read fresh off `draft` each call, so an
  // add right after a remove (or vice versa) always starts from what the
  // last load() actually saw rather than a value captured in a stale
  // closure.
  const addToQueue = async (playerId) => {
    try {
      await apiPost(`/drafts/${draftId}/queue`, { queue: [...queue, playerId] });
      await load();
    } catch (e) {
      setErr(mutationErrorMessage(e, "Could not update your queue"));
    }
  };

  const removeFromQueue = async (playerId) => {
    try {
      await apiPost(`/drafts/${draftId}/queue`, { queue: queue.filter((id) => id !== playerId) });
      await load();
    } catch (e) {
      setErr(mutationErrorMessage(e, "Could not update your queue"));
    }
  };

  // A drop is one write, same contract as add/remove above, but it updates
  // `draft` in place first rather than waiting on a round trip through
  // load(): the row just got dragged to a specific spot, and a network delay
  // before the list reflects that would show it snapping back to where it
  // started for as long as the request takes. On failure, load() is still
  // the recovery -- it replaces the optimistic guess with whatever the
  // server actually has.
  const reorderQueue = async (nextQueue) => {
    setDraft((d) => (d ? { ...d, yourQueue: nextQueue } : d));
    try {
      await apiPost(`/drafts/${draftId}/queue`, { queue: nextQueue });
    } catch (e) {
      setErr(mutationErrorMessage(e, "Could not update your queue"));
      await load();
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

  // `xl:contents` makes the wrapper vanish from the box tree at desktop, so the
  // panels stay direct grid children of the real grid, so each one occupies a
  // track of its own. Below lg the wrapper is the visibility switch -- display:none,
  // which preserves scrollTop (measured), where visibility/absolute does not.
  // The active wrapper is a COLUMN flex container: with flex-row, width is the
  // main axis and an unstretched panel sizes to its own content (measured:
  // 171px inside a 334px band) -- flex-col makes width the cross axis, where
  // stretch (the default align-items) does the right thing, same as it
  // already does for height. The panel itself still needs to claim the
  // column's main axis (height), which [&>*]:flex-1 does without reaching
  // into the panel's own className. As a grid item the wrapper's default
  // min-width is min-content (not 0), so without max-xl:min-w-0 it refuses
  // to shrink below the draft board table's min-w-[620px] and inflates past
  // the viewport instead of letting that table scroll horizontally inside
  // its own already-overflow-auto panel (measured: 656px wrapper in a 390px
  // viewport).
  const pane = (id) =>
    `xl:contents ${
      tab === id
        ? "max-xl:flex max-xl:flex-col max-xl:min-h-0 max-xl:min-w-0 max-xl:flex-1 max-xl:[&>*]:flex-1"
        : "max-xl:hidden"
    }`;

  // The pill ternary in the desktop header answers the same question across
  // five branches; the strip needs one string, in the same order of
  // precedence: finished, then stopped, then yours, then whose.
  const statusLabel = completed
    ? "✅ Completed"
    : paused
      ? "⏸ Paused"
      : isMyTurn
        ? `⏱ ${formatCountdown(secondsLeft)} · your pick`
        : onClockIsBot
          ? "Auto-picking…"
          : `Waiting on Team ${currentTeamOnClock}`;

  return (
    <div className="relative min-h-full max-xl:h-full xl:h-full w-full overflow-x-hidden">
      {/* Background (same feel as Home) */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1000px_500px_at_20%_10%,rgba(34,211,238,0.14),transparent_60%),radial-gradient(900px_500px_at_80%_20%,rgba(59,130,246,0.12),transparent_55%),radial-gradient(700px_500px_at_50%_85%,rgba(168,85,247,0.10),transparent_55%)]" />
        <div className="absolute inset-0 opacity-[0.10] [background-image:linear-gradient(to_right,rgba(255,255,255,0.10)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.10)_1px,transparent_1px)] [background-size:64px_64px]" />
      </div>

      {/* Content */}
      {/*
          3xl (1600px) widens the container and nothing else. It used to buy a
          fourth column, which was the wrong thing to buy: the Draft Board's
          table wants 620px, and at 1280 four fixed columns left it EIGHTY.
          The fourth column is gone and the queue is a full-width strip, so
          all this breakpoint still does is give the same three tracks more
          room -- 1280 of usable width below it, 1536 above. Worth being
          precise about: the track RATIOS hold at every width from lg up, but
          their pixel widths still step here. One layout, two container sizes.
        */}
      <div className="relative mx-auto max-w-7xl 3xl:max-w-[1600px] px-6 py-6 min-h-full max-xl:h-full max-xl:px-3 max-xl:py-3 xl:h-full flex flex-col gap-4">
        {err && (
          <div data-testid="draft-error" className="rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-200">
            {err}
          </div>
        )}

        {/* ONE desktop layout, not four.

            This page used to have four: tabs below lg, two columns to xl,
            three to 3xl, four above -- and this branch broke two of them. The
            bands were the bug, not any one breakpoint: each is a separate
            configuration somebody has to verify and nobody does.

            So above lg there is a single shape at every width. Three
            proportional tracks rather than fixed pixels, so nothing has to be
            re-budgeted when a column is added; the queue spans all three on a
            second, auto-height row, which keeps it visible on a 1280 laptop
            instead of only above 1600. The height is bound wherever this
            layout applies, and the wrapped-row-halves-every-panel failure
            cannot recur because there is no breakpoint at which the row count
            changes.

            Below lg it is tabbed, via `pane`. Two bands, both verified. */}
        {/* Absent on a phone, not merely hidden -- the same rule the strip
            follows at desktop, applied in the other direction. A display:none
            element still matches locators, so a header left in the phone DOM
            would duplicate every value the strip shows. The max-xl:hidden
            stays as belt-and-braces. */}
        {!isPhone && (
        <div data-testid="desktop-header" className="max-xl:hidden rounded-3xl border border-zinc-800/70 bg-zinc-950/60 px-3 py-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
          <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-center gap-3">
              {/* Same rule as the controls opposite: a finished draft is not
                  live, and a glowing "Live Draft" beside "✅ Completed" is the
                  badge asserting a state that is terminally false. */}
              {!completed && (
                <div className="hidden sm:flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/60 px-3 py-1 text-xs text-zinc-300">
                  <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_20px_rgba(34,211,238,0.5)]" />
                  Live Draft
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5 items-center justify-start xl:justify-end">
              {!completed && (
                <button
                  onClick={togglePause}
                  disabled={busy}
                  className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                >
                  {paused ? "Resume" : "Pause"}
                </button>
              )}

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
              {!completed && (
                <select
                  data-testid="seat-board"
                  aria-label="Auto-pick from"
                  title="Auto-pick from"
                  className="max-w-[3rem] truncate rounded-lg border border-zinc-700 bg-zinc-900 px-1 py-1 text-xs text-zinc-200"
                  value={draft.yourBoardId ?? ""}
                  onChange={(e) => setSeatBoard(e.target.value)}
                  disabled={busy}
                >
                  {boardOptions(myBoards, draft.yourBoardId).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}

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

              {!completed && (
                <button
                  onClick={autoPick}
                  disabled={paused || busy || !autoPickAllowed}
                  className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                  title="Auto-pick for whichever team is on the clock"
                >
                  Auto Pick
                </button>
              )}

              {humans > 1 || completed ? null : (
                // Simulating the rest of a draft other people are sitting in
                // takes their picks away from them; the server refuses this
                // with 409 once a second human is seated, so the button is
                // simply not offered rather than inviting a request that can
                // only fail.
                <button
                  onClick={simToEnd}
                  disabled={paused || busy}
                  className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                >
                  Sim to End
                </button>
              )}

              {!completed && (
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
              )}

              {notifyState !== "unsupported" && !completed && (
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
              {!completed && (
                <span data-testid="current-pick">
                  <Pill>{currentPickLabel}</Pill>
                </span>
              )}
              <Pill>
                {draft.teams} teams • {draft.rounds} rounds
              </Pill>
            </div>
          </div>
        </div>
        )}

        {isPhone && (
          <StatusStrip
            statusLabel={statusLabel}
            myTeam={myTeam}
            paused={paused}
            busy={busy}
            completed={completed}
            isMyTurn={isMyTurn}
            onTogglePause={togglePause}
            onOpenSheet={() => setSheetOpen(true)}
            onTap={() => setTab("board")}
            resultsHref={`/draft/${draftId}/results`}
          />
        )}

        {isPhone && (
        <ControlSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
          {/* The same five controls the desktop header carries. They are
              rendered a second time rather than moved, so each presentation
              stays simple; the state and handlers behind them are shared. */}
          {!completed && (
            // Unlike the desktop header's copy, the sheet has room for a
            // visible label rather than relying solely on aria-label/title.
            <label className="flex flex-col gap-1 w-full rounded-xl border border-zinc-800 px-3 py-3 text-sm text-zinc-200 text-left disabled:opacity-50">
              <span className="text-xs text-zinc-400">Auto-pick from</span>
              <select
                data-testid="seat-board"
                aria-label="Auto-pick from"
                title="Auto-pick from"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-200"
                value={draft.yourBoardId ?? ""}
                onChange={(e) => setSeatBoard(e.target.value)}
                disabled={busy}
              >
                {boardOptions(myBoards, draft.yourBoardId).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
          )}

          {!completed && (
            <button
              onClick={autoPick}
              disabled={paused || busy || !autoPickAllowed}
              className="w-full rounded-xl border border-zinc-800 px-3 py-3 text-sm text-zinc-200 text-left disabled:opacity-50"
              title="Auto-pick for whichever team is on the clock"
            >
              Auto Pick
            </button>
          )}

          {humans > 1 || completed ? null : (
            <button
              onClick={simToEnd}
              disabled={paused || busy}
              className="w-full rounded-xl border border-zinc-800 px-3 py-3 text-sm text-zinc-200 text-left disabled:opacity-50"
            >
              Sim to End
            </button>
          )}

          {!completed && (
            <button
              type="button"
              data-testid="copy-invite"
              onClick={() =>
                navigator.clipboard.writeText(
                  `${window.location.origin}/draft/${draftId}/join?t=${draft.inviteToken}`
                )
              }
              className="w-full rounded-xl border border-zinc-800 px-3 py-3 text-sm text-zinc-200 text-left disabled:opacity-50"
            >
              Copy invite link
            </button>
          )}

          {notifyState !== "unsupported" && !completed && (
            <button
              type="button"
              data-testid="notify-toggle"
              disabled={notifyState === "denied"}
              onClick={async () => {
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
              className="w-full rounded-xl border border-zinc-800 px-3 py-3 text-sm text-zinc-200 text-left disabled:opacity-50"
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
        </ControlSheet>
        )}

        {/* Three tracks and two rows, at every width from lg up: Big Board,
            Draft Board, Rosters across row one, and the queue spanning all
            three on an auto-height row beneath them. Below lg this is tabbed
            instead, via `pane` -- which uses xl:contents, so the wrapper has
            no box and any grid placement has to live on the panel itself
            (that is why the queue's col-span sits in QueuePanel, not here).
            There is no width at which the track or row count changes, which
            is the property that keeps the wrapped-row failure from
            recurring. */}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1.5fr)_minmax(0,1fr)] xl:grid-rows-[minmax(0,1fr)_auto] flex-1 min-h-0 min-w-0">
            <div className={pane("board")}>
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
                queuePlayer={addToQueue}
              />
            </div>

            <div className={pane("draft")}>
              <DraftBoardPanel draft={draft} playersById={playersById} />
            </div>

            <div className={pane("rosters")}>
              <RosterPanel draft={draft} />
            </div>

            <div className={pane("queue")}>
              <QueuePanel
                queue={queue}
                playersById={playersById}
                picked={picked}
                onRemove={removeFromQueue}
                onReorder={reorderQueue}
              />
            </div>
        </div>

        {isPhone && <TabBar active={tab} onChange={setTab} />}
      </div>
    </div>
  );
}