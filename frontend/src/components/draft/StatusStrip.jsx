// What is true right now, and the one control you reach for in a hurry. The
// clock cannot be a tap away, which is why every draft app pins it.
import { Link } from "react-router-dom";

export default function StatusStrip({
  statusLabel,
  myTeam,
  paused,
  busy,
  completed,
  isMyTurn,
  onTogglePause,
  onOpenSheet,
  onTap,
  resultsHref,
}) {
  return (
    <div
      data-testid="status-strip"
      data-your-turn={isMyTurn ? "true" : "false"}
      // Sticky for the same reason the tab bar is: it carries the clock and
      // whose turn it is, which is the one thing that must stay on screen
      // while you scroll a long list during a timed pick.
      //
      // The `before` layer is what makes sticky legible. Both tints below are
      // translucent -- the your-turn one is 10% -- which was invisible back
      // when this strip never overlapped anything, and became player rows
      // ghosting straight through it the moment the page was allowed to
      // scroll under it. An opaque pane behind the tint keeps both states
      // looking exactly as designed and composites them over the page colour
      // instead of over whatever happens to be scrolling past.
      // `flex-wrap` is the row's escape valve, and it has to exist.
      //
      // Measured at a 24px root: the strip is 306px wide and its contents want
      // 361 (clock 162, Team N 56, Pause 87, ⋯ 56). Something must give. With
      // no valve and `whitespace-nowrap` on the clock, what gave was the
      // clock's own box -- 33px wide holding 162px of text, painted straight
      // over Team 1 and the Pause button. Boxes stayed tidy, so a
      // rect-intersection test could not see it; only scrollWidth could.
      //
      // Wrapping breaks BETWEEN elements while nowrap keeps the clock whole,
      // so at a large font the strip becomes two legible rows instead of one
      // illegible one. At 16px the contents need 251 of 334px and nothing
      // wraps at all, so this is invisible at the default font.
      className={`relative xl:hidden sticky top-0 z-20 shrink-0 flex flex-wrap items-center gap-2 rounded-2xl border px-3 py-1 before:absolute before:inset-0 before:-z-10 before:rounded-2xl before:bg-zinc-950 ${
        isMyTurn
          ? "border-cyan-300/60 bg-cyan-300/10"
          : "border-zinc-800/70 bg-zinc-950/80"
      }`}
    >
      {/*
        `whitespace-nowrap` is load-bearing, not tidiness. `statusLabel` is one
        composed string -- "⏱ 60s · your pick" -- and this is a flex row where
        Team N, Pause and ⋯ all hold their width while the label had no shrink
        discipline. So the label was the only thing that could give, and it gave
        completely: measured at a 24px root it was 46px wide and 150px tall,
        broken onto three lines with the separator stranded alone on the middle
        one, inside a strip 176px deep.

        The rule is the one the advice card already settled: the line that says
        what matters survives the squeeze, and everything else is elaboration.
        Here that line is the clock and whose turn it is.
      */}
      {/*
        `min-h-[44px]` is a fixed pixel floor, deliberately, and it is the one
        measurement here that does NOT scale with the reader's font. Everything
        else in this strip carries text and grows with it; a touch target
        carries a thumb, and a thumb is the same size whatever font somebody
        picks. A scaling 2.75rem version was tried and demanded 66px controls at
        a 24px root, where 50px already exceeds any finger -- height spent on a
        page with 0px of slack, for nothing.

        This control was the worst offender and appears on no list: 20px tall at
        the default font, and it is the tap target the README calls the shortest
        way back to the board.
      */}
      <button
        type="button"
        data-testid="strip-status"
        onClick={onTap}
        className={`min-h-[44px] min-w-0 flex items-center text-left text-sm whitespace-nowrap ${isMyTurn ? "text-cyan-200 font-semibold" : "text-zinc-100"}`}
      >
        {statusLabel}
      </button>
      {/*
        Not hidden at large fonts, though it was tried. The idea was that Team N
        should be the first thing to go when the row runs out of width -- it is
        the only element here already duplicated directly below, in the Big
        Board panel header ("You are on the clock (Team 1)").

        Two mechanisms failed. A container query on the strip compiled
        correctly, reported `container-type: inline-size`, and matched at no
        threshold at all -- an injected probe found no matching width anywhere
        between 100 and 700px. A `rem`-based media query then failed the other
        way: media-query lengths resolve against the document's initial font
        size, so the query cannot see that the reader enlarged their text,
        which is the only condition it was meant to detect.

        `whitespace-nowrap` alone fixes the defect that mattered -- the clock
        used to break onto three lines -- so the hiding was dropped rather than
        pursued further. Written up on the status page's accepted list.
      */}
      <span className="ml-auto text-xs text-zinc-400 whitespace-nowrap">Team {myTeam}</span>
      {!completed && (
        <button
          type="button"
          onClick={onTogglePause}
          disabled={busy}
          className="min-h-[44px] rounded-xl border border-zinc-800 px-3 py-2 text-xs text-zinc-200 disabled:opacity-50"
        >
          {paused ? "Resume" : "Pause"}
        </button>
      )}
      {completed ? (
        // Every control in the sheet is gated on !completed, so ⋯ would open a
        // sheet holding nothing but its grab handle. The same rule the
        // completed-draft header follows: do not offer what cannot act. What a
        // finished draft needs instead is the way out, which until now existed
        // only in the desktop header -- a phone user who finished a draft had
        // to leave via My Drafts and come back in.
        <Link
          to={resultsHref}
          data-testid="strip-results"
          className="rounded-xl bg-emerald-400 px-3 py-2 text-xs font-semibold text-black"
        >
          View Results →
        </Link>
      ) : (
        <button
          type="button"
          data-testid="open-controls"
          onClick={onOpenSheet}
          aria-label="Draft controls"
          className="min-h-[44px] rounded-xl border border-zinc-800 px-3 py-2 text-xs text-zinc-200"
        >
          ⋯
        </button>
      )}
    </div>
  );
}
