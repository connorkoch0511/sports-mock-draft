import { useEffect, useMemo, useState } from "react";
import { orderByBoard } from "../../lib/boardOrder";
import { adpTrio, PLATFORM_WIDE_NOTE } from "../../lib/adpSources";
import { adviseOnPick, NO_ADVICE } from "../../lib/pickAdvice";
import { ReasonList, ADVICE_BASIS } from "./ReasonList";
import { PlayerModal } from "./PlayerModal";
import { StartingPoint } from "./StartingPoint";
import { Pill } from "./Pill";

const PAGE_SIZE = 25;

/**
 * How much of a scrolling element is still below the fold, and how many
 * advice reasons that hides.
 *
 * The suggested-pick card yields height and scrolls when the panel is short,
 * which is the right behaviour -- but under macOS overlay scrollbars a
 * scrolled-away reason has no scrollbar to advertise it. Measured at
 * 1280x720: the card showed 74px of 268, hiding 72% of itself and ALL FOUR
 * reasons, behind a 2px scroll track that is invisible until you already
 * know to look. The advice was there and unadvertised, which is the same as
 * not being there.
 *
 * Returns the element setter so the caller can attach it as a ref.
 */
function useHiddenBelow() {
  const [el, setEl] = useState(null);
  const [hidden, setHidden] = useState({ px: 0, reasons: 0 });

  useEffect(() => {
    if (!el) return undefined;
    const measure = () => {
      const px = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (px <= 4) return setHidden((h) => (h.px === 0 ? h : { px: 0, reasons: 0 }));
      const bottom = el.getBoundingClientRect().bottom;
      const reasons = [...el.querySelectorAll('[data-testid="advice-reason"]')].filter(
        (r) => r.getBoundingClientRect().bottom > bottom + 1
      ).length;
      setHidden((h) => (h.px === px && h.reasons === reasons ? h : { px, reasons }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // The box can stay the same size while its CONTENT reflows taller -- a
    // reason wrapping onto another line as the panel narrows is exactly the
    // case that hides advice -- so every child is observed too, not just the
    // box.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [el]);

  return [setEl, hidden, el];
}

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
  queuePlayer,
}) {
  const [adviceRef, adviceHidden, adviceEl] = useHiddenBelow();
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState("");
  const [page, setPage] = useState(0);
  const [openPlayerId, setOpenPlayerId] = useState(null);
  const [adpSort, setAdpSort] = useState("ours");

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
  // Changing the sort has the same problem -- the player on page 4 moves
  // somewhere else entirely -- so it resets the page the same way.
  //
  // Adjusted during render rather than in an effect. React re-runs the
  // component before committing, so the stale page never reaches the screen,
  // where an effect would paint it first and correct it after. The linter
  // flags the effect form -- and only started once this panel was small
  // enough for the rule to analyze; in the 743-line page it was silently
  // skipped.
  const [lastFilter, setLastFilter] = useState({ query, pos, adpSort });
  if (lastFilter.query !== query || lastFilter.pos !== pos || lastFilter.adpSort !== adpSort) {
    setLastFilter({ query, pos, adpSort });
    setPage(0);
  }

  // Resolved from the whole pool rather than the visible page. Typing in the
  // search box while the dialog is open must not yank it shut.
  const openPlayer = openPlayerId != null
    ? players.find((x) => x.id === openPlayerId) ?? null
    : null;

  // Between filtering and paging, deliberately. `pagedPlayers` is one page of
  // 50, so sorting that would only shuffle the page you happen to be on and
  // look broken the moment you turned it. `advice` below does NOT read
  // `filtered` -- it is handed the full `players` pool, because scarcity is
  // about the whole draft's remaining players, not this panel's search/filter
  // state. The only thing below that still reads `filtered` is the player
  // counter (`filtered.length`).
  const sorted = useMemo(() => {
    if (adpSort === "ours") return filtered;
    return [...filtered].sort(
      (a, b) =>
        // A player the chosen source has no number for sorts last, the same
        // way the existing rank sort pushes nulls to the bottom.
        (a.adpBySource?.[adpSort] ?? Number.POSITIVE_INFINITY) -
        (b.adpBySource?.[adpSort] ?? Number.POSITIVE_INFINITY)
    );
  }, [filtered, adpSort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pagedPlayers = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Advice is computed once per pick, never per keystroke. `filtered` re-runs
  // on every character typed into the search box; the engine walks the whole
  // pool (~54ms on production data), and it must see that whole pool -- its
  // scarcity model derives the startable window from it, so handing it a
  // pre-filtered list silently refills that window and the scarcity reasons
  // stop firing. So: the full `players`, and deps that only move when the
  // draft itself does.
  //
  // And only when somebody is going to read it. The card is for the user's
  // own turn, and the drill-down is either open or it is not; the app auto-picks
  // the other eleven teams, so this skips the engine on eleven of every
  // twelve picks rather than scoring the whole pool for a card nobody sees.
  const adviceWanted = isMyTurn || openPlayerId != null;
  const advice = useMemo(
    () => (adviceWanted ? adviseOnPick({ players, draft, boardRows, myTeam }) : NO_ADVICE),
    [adviceWanted, players, draft, boardRows, myTeam]
  );
  const recommendation = advice.recommendation;
  // An empty `ranked` means the engine never ran, which is a different thing
  // from it running and finding nothing to say about a player.
  const playersWereEvaluated = advice.ranked.length > 0;

  // Same distinction the page's own status pill draws: "auto-picking" is
  // only true when the team on the clock is a bot. In a shared draft it is
  // another person, and saying otherwise here would be the identical lie
  // this panel's header used to tell everywhere, just in a second place.
  const seats = draft?.seats ?? [];
  const shared = seats.filter((s) => s?.kind === "human").length > 1;
  // Derived from picks + currentIndex rather than trusted off draft.currentTeam
  // on its own, for the same reason the page itself does this: the two only
  // ever disagree when something upstream handed this panel a stale copy.
  const currentTeamOnClock = draft?.picks?.[draft?.currentIndex]?.team ?? draft?.currentTeam ?? null;

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
              : shared
              ? `Waiting on Team ${currentTeamOnClock}`
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

        {boardMeta && boardRows?.length === 0 && (
          <div data-testid="board-empty-note" className="rounded-2xl border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            <span className="font-medium">{boardMeta.name}</span> has no players on it
            yet — showing consensus order.
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
        {/* A flex child defaults to min-height:auto, so this card once refused
            to shrink and pushed the player list past the panel's bottom edge,
            where it painted over the queue strip (744295a). min-h-0 fixed that
            by letting the card yield without limit -- and yielding without
            limit is what this floor replaces.

            min-h-[4.5rem], not min-h-0: the card's inner scroller already
            absorbs every pixel of shrink, so min-h-0 let the SHELL collapse
            too. Measured at 1280 and 1512 (identical geometry -- width does
            not enter into it): the card was handed 18px against 73px of
            shell content at both 640 and 660, clipping the suggested-pick
            line 16px through its own glyphs. 4.5rem is that shell content --
            name line, cue, padding -- and nothing more, so the card can still
            give up everything below it. In rem beside rem contents, per the
            note on the `tall` variant in index.css.

            What the floor costs, measured, with the queue panel on screen:
            nothing at 700 and up (0px of spill at 700, 720, 800, 900). Below
            that it spends 40px at 660 and 60px at 640, which paints past the
            panel's own bottom edge and is not clipped there -- the panel lets
            content paint past its border on purpose, for the reason spelled
            out in the next paragraph. It lands in dead space rather than on
            anything: the queue panel starts 16px lower at every height and
            the two boxes were verified not to intersect at 640, 660, 700, 720
            or 800. A readable answer beats 40px of paint in a gap, and the
            player list keeps its own 160px floor throughout either way.

            Two honest limits remain. The card yields by height, not by width,
            so how much it gives up depends on both: at 1024 wide the reasons
            wrap taller and the card hides about 38% of itself even at 900
            tall, which is not the "only below 900" story it would be nice to
            tell. And a scrolled-away reason has no scrollbar under macOS
            overlay scrollbars -- which is what the cue below is for; it was
            verified to still count honestly after the name line moved out of
            the scroller (6 hidden of 6 at 640-740, 5 of 5 at 800, 2 of 2 at
            900).

            NOT clipped at the panel: overflow-hidden here was measured at
            1024x650 to cut reachable player-row buttons from five to three
            while leaving the 27px of spill exactly as it was -- it hid the
            controls inside the overflow without preventing the overflow. The
            panel deliberately lets content paint past its rounded border
            instead; see the note on scroll-big-board's min-h floor below,
            which made that same trade first. */}
        {isMyTurn && recommendation ? (
          <div
            data-testid="advice-card"
            className="rounded-2xl border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 min-h-[4.5rem] flex flex-col overflow-hidden"
          >
            {/* Label and name on ONE line, not two. When the panel is
                short this card is the first thing to give up height -- at
                1280x720 it gets about 74px -- and with the name on a second
                row that 74px bought the word "Suggested pick" and the top
                half of the answer, cut through the middle of the glyphs.

                OUTSIDE the scroller, and shrink-0, which is the whole point.
                Inside it this line was the first thing the squeeze ate: the
                scroller's own overflow-auto clipped it 11px at a 700px
                viewport and 24px at 660, leaving "Suggested pick" and the top
                of the answer sliced through the glyphs while the cue below
                went on advertising six reasons nobody could reach. Scrollable
                back into view is not the same as shown. The shell holds what
                the card exists to say; the scroller holds elaboration. */}
            <div
              data-testid="advice-name"
              className="mb-2 shrink-0 flex items-baseline justify-between gap-2"
            >
              <div className="min-w-0">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
                  Suggested pick
                </span>{" "}
                <span className="text-sm font-semibold text-zinc-100">
                  {recommendation.player.name}
                </span>
              </div>
              <span className="shrink-0 text-[11px] text-zinc-400">
                {recommendation.player.position} · {recommendation.player.team}
              </span>
            </div>

            {/* The shell above does not scroll; this does. Keeping them
                separate is what lets the cue below sit UNDER the content
                rather than on top of it -- as a sticky footer inside the
                scroller it covered the player's name, which at a 74px card
                height is most of the card and the single line the whole
                panel exists to show. */}
            <div
              ref={adviceRef}
              data-testid="advice-scroll"
              className="min-h-0 overflow-auto space-y-2"
            >
              <StartingPoint
                startingPoint={{
                  base: recommendation.base,
                  position: 1 - recommendation.base,
                  score: recommendation.score,
                }}
                onBoard={boardRows?.length > 0}
              />
              <ReasonList reasons={recommendation.reasons} />
              <p className="text-[11px] leading-snug text-zinc-500">{ADVICE_BASIS}</p>

            </div>

            {/* The cue the overlay scrollbar does not give. It names the
                count, because "there is more" and "you cannot see three of
                the four reasons" are different facts and only the second
                tells you whether to bother. Clicking scrolls rather than
                expanding: the card is short because the panel is short, and
                growing it back is exactly what pushed the player list off the
                screen in the first place. */}
            {adviceHidden.px > 0 && (
              <button
                type="button"
                data-testid="advice-more"
                onClick={() =>
                  adviceEl?.scrollBy({
                    top: Math.max(40, adviceEl.clientHeight * 0.8),
                    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                      ? "auto"
                      : "smooth",
                  })
                }
                className="mt-1 shrink-0 self-end rounded-full border border-emerald-700/70 bg-emerald-950 px-2 py-0.5 text-[10px] font-medium text-emerald-200 hover:border-emerald-500"
              >
                {adviceHidden.reasons > 0
                  ? `${adviceHidden.reasons} more ${adviceHidden.reasons === 1 ? "reason" : "reasons"} ↓`
                  : "More ↓"}
              </button>
            )}
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
            data-testid="position-filter"
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
          {/*
            Beside the other filters, in the same row, rather than a row of
            its own -- this panel's height is fixed by the three-column page
            layout, and one more full-width row above a flex-1 list pushed
            the list's height to zero instead of shrinking the fixed rows
            around it.
          */}
          <select
            data-testid="adp-sort"
            value={adpSort}
            onChange={(e) => setAdpSort(e.target.value)}
            title="Sort by"
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-sky-300/60 focus:shadow-[0_0_0_4px_rgba(59,130,246,0.10)]"
          >
            <option value="ours">our rank</option>
            <option value="espn">ESPN ADP</option>
            <option value="yahoo">Yahoo ADP</option>
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

        {/*
          min-h-[160px] rather than min-h-0: this panel already runs tight
          against the fixed three-column layout (see the comment on the
          adp-sort select above), and the header bar above it can wrap onto
          an extra line depending on its own content (e.g. an incomplete
          solo draft shows Sim to End, a long invite/draft id, etc.). Without
          a floor here, that extra header line steals just enough height to
          collapse this list to a sliver of a few pixels or zero -- not merely
          a cosmetic squeeze, but every row's Draft button becoming
          unclickable, since overflow:auto clips an absolutely-positioned
          child the instant the scrollable box's own height reaches zero. A
          fixed minimum keeps the list (and therefore every pick) always
          reachable; the rare cost is a few pixels of this panel's content
          extending past its own rounded border when the header is at its
          tallest, which is a small visual wart next to a dead Draft button.
        */}
        <div data-testid="scroll-big-board" className="flex-1 min-h-[160px] overflow-auto space-y-2 pr-1">
          {/*
            Visible small print, not just the per-row `title` on "adp-trio"
            below -- a title is mouse-only (unreachable by keyboard or screen
            reader) and here it sits on a span nested inside an already-titled
            row button, which makes it doubly unreachable. This is the one
            place a person can actually find the caveat.

            Inside the scrollable list, not a sibling of it -- a sibling row
            here is exactly the mistake the adp-sort comment above already
            warns about: this panel's height is fixed by the three-column
            page layout, so a new full-width row above `flex-1` shrinks the
            list's own height instead of shrinking around it, and at this
            panel's actual size that squeezed the row list down to a sliver,
            making every row underneath unclickable. As the first scrollable
            item it costs nothing from the fixed layout budget.
          */}
          <p data-testid="adp-source-note" className="text-xs text-zinc-500">
            {PLATFORM_WIDE_NOTE}
          </p>

          {pagedPlayers.map((p) => (
            // The row opens the player; the Draft button drafts him. Reading
            // is the safe default and committing is deliberate -- a whole-row
            // click that instantly and irreversibly drafted somebody made the
            // destructive action the easiest one to hit by accident, and left
            // no way to look a player up at all.
            //
            // A <button> cannot nest inside a <button>, so the row is a
            // container with the Draft control overlaid rather than nested.
            <div key={p.id} data-testid="big-board-row" className="relative">
              <button
                type="button"
                data-testid="open-player"
                onClick={() => setOpenPlayerId(p.id)}
                title={`${p.name} — stats and reasons. Reading never drafts anybody.`}
                className="w-full text-left rounded-2xl border border-zinc-900 bg-black/60 p-3 pb-9 hover:border-zinc-700"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">
                    {/*
                      myRank and rank are ordinals over different populations
                      -- your board only covers players ranked in ITS format,
                      the pool covers the draft's. Rendered as bare numbers
                      they can repeat on adjacent rows, reading as one broken
                      sequence. The marker says which scale you are reading.
                    */}
                    {p.myRank != null ? (
                      <span
                        data-testid="rank-mine"
                        title={`Your board has him at ${p.myRank}`}
                        className="mr-1 text-cyan-300 tabular-nums"
                      >
                        ★{p.myRank}
                      </span>
                    ) : p.rank != null ? (
                      <span
                        data-testid="rank-consensus"
                        title={`Consensus rank ${p.rank}`}
                        className="mr-1 font-normal text-zinc-500 tabular-nums"
                      >
                        {p.rank}
                      </span>
                    ) : null}
                    {p.name}
                  </div>
                  <div className="text-xs text-zinc-400">
                    {/*
                      All three inline rather than one number: the point of the
                      feature is seeing where the sources disagree, and a
                      player one service likes a round earlier than another is
                      only visible if both are on screen at once.
                    */}
                    <span data-testid="adp-trio" title={PLATFORM_WIDE_NOTE}>
                      {adpTrio(p.adp, p.adpBySource).map((s, i) => (
                        <span key={s.key}>
                          {i > 0 ? <span className="mx-1 text-zinc-600">·</span> : null}
                          <span className="text-zinc-500">{s.label} </span>
                          <span className="tabular-nums">{s.text}</span>
                        </span>
                      ))}
                    </span>
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

              {/*
                Bottom-left, mirroring Draft's bottom-right -- the two are
                not mutually exclusive (queueing somebody does not draft
                him, and drafting somebody else drops him off your queue
                for free via QueuePanel's own read-time filter). Never
                disabled: the server dedupes an id already in the list, so
                clicking a player twice is a harmless no-op write rather
                than a state this button needs to track.
              */}
              <button
                type="button"
                data-testid="queue-add"
                aria-label={`Queue ${p.name}`}
                title={`Add ${p.name} to your queue`}
                onClick={() => queuePlayer(p.id)}
                className="absolute bottom-2 left-2 rounded-full border border-cyan-900/60 bg-cyan-950/40 px-2.5 py-1 text-[11px] font-medium text-cyan-300 hover:border-cyan-600 hover:text-cyan-200"
              >
                Queue
              </button>

              <button
                type="button"
                data-testid="draft-player"
                aria-label={`Draft ${p.name}`}
                disabled={!canManualPick}
                onClick={() => makePick(p.id)}
                title={
                  canManualPick
                    ? `Draft ${p.name} for Team ${myTeam}`
                    : draft.completed
                    ? "Draft completed"
                    : paused
                    ? "Paused"
                    : `You can only draft when Team ${myTeam} is on the clock`
                }
                className="absolute bottom-2 right-2 rounded-full border border-emerald-800/70 bg-emerald-950/50 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:border-emerald-600 hover:text-emerald-200 disabled:opacity-40 disabled:hover:border-emerald-800/70"
              >
                Draft
              </button>
            </div>
          ))}
        </div>

        {openPlayer ? (
          <PlayerModal
            // Keyed on the player, so opening a different one remounts with
            // clean state instead of the previous player's log lingering
            // while the new fetch is in flight.
            key={openPlayer.id}
            player={openPlayer}
            format={draft.format}
            reasons={advice.reasonsFor(openPlayer.id)}
            startingPoint={advice.startingPointFor(openPlayer.id)}
            onBoard={boardRows?.length > 0}
            playersWereEvaluated={playersWereEvaluated}
            onClose={() => setOpenPlayerId(null)}
          />
        ) : null}
      </div>
  );
}
