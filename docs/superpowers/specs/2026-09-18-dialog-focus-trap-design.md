# Two dialogs that say they are modal and are not

`aria-modal="true"` is a promise that the rest of the page is inert. Two
components declare it — `ControlSheet` and `PlayerModal` — and **neither
contains focus**. Tabbing walks straight out of both, behind their own
backdrops, into controls the user cannot see.

The accepted-list entry names only the control sheet. That makes it the fifth
entry in two days to understate its own defect.

## Measured, in a real browser, both directions

Driving actual key presses rather than reading the JSX:

    CONTROL SHEET          forward: escapes after 3 presses
      1. in   seat-board            backward: escapes after 1
      2. in   copy-invite
      3. OUT  <input>            <- the Big Board's search box
      4. OUT  position-filter        behind a full-screen backdrop
      5. OUT  adp-sort

    PLAYER MODAL           forward: escapes after 3 presses
      1. in   tab-summary         backward: escapes after 1
      2. in   tab-gamelog
      3. OUT  <body>
      4. OUT  the site nav
      5. OUT  nav-toggle

**They are identical in severity.** A prior reading of the source claimed the
modal was "the worse case" — desktop as well as phone, opened from a 25-row
list. That was inference and it was wrong: the counts match exactly. What
differs is only where focus lands.

**Backward is the severe direction, and it was not predicted.** One or two
presses. Both dialogs place focus on their first focusable element on open —
the panel for the sheet, the close button for the modal — so `Shift+Tab` steps
immediately off the front. A trap that wraps only the *last* element leaves
this untouched, which is the naive implementation and would have shipped here.

*Corrected after the tests were written:* the sheet's backward escape is at
press **2**, not 1. Press 1 lands on `close-controls`, which the first
diagnostic counted as an escape because it measured against the *dialog*; under
the overlay boundary chosen here that button is **inside**, and the leak begins
at press 2 (`open-controls`, then the strip, the nav, `<body>`). The figure in
the first table above is the dialog-boundary measurement and is kept because it
is what was actually observed; this is what it means under the boundary that
shipped.

**The forward leak is worse than "focus goes somewhere odd."** Tabbing out of
the sheet reaches `open-player` and `queue-add` — so a keyboard user can open a
player, or **add one to their queue**, through a backdrop they cannot see
past. The escape is not merely disorienting; it is actionable.

**Where focus lands is worse than the counts suggest.** The sheet leaks into the
Big Board's search input and its two filter selects. The modal leaks to `<body>`
and then the site navigation. Backward, the modal reaches `scroll-rosters` and
`scroll-draft-board` — plain `overflow-auto` divs that Chromium makes focusable
so a keyboard can scroll them. None of that is visible: it is all behind an
opaque overlay.

## What already works, and must keep working

Both dialogs get the other two thirds right, and the trap must not disturb
them:

- **Focus in on open**, and **restored to the opener on close**.
  `drilldown.spec.js:115` pins the modal's restore; the sheet's is pinned by
  `draftphone.spec.js:402`.
- **Escape closes**, from a document-level `keydown` listener.

## The fix

One shared hook, used by both shells. They have the same shape — focus in,
restore out, Escape — so containment belongs beside that rather than written
twice.

**It must be driven by the Tab keydown, never by an effect that re-asserts
focus.** `draftphone.spec.js:422` focuses `seat-board` and requires it still
focused 1600ms later, and the sheet re-renders every second from the countdown
clock. An effect-based trap that "puts focus back" would break that test —
correctly, because that test exists to pin a bug where the sheet stole focus
back every second and made its own headline control unusable.

So: on `Tab`, compute the focusable set *at that moment* (the set is dynamic —
five conditionally-rendered controls, and the season selector inside the modal
appears only for multi-season players), and wrap at both ends. Between presses
the hook does nothing at all.

**The boundary is the overlay, not the dialog.** In `ControlSheet` the backdrop
close button is a *sibling* of the dialog inside a `fixed inset-0` wrapper, so
trapping the wrapper keeps that button reachable by keyboard — matching what a
mouse user can already do. In `PlayerModal` the dialog is *nested inside* the
backdrop element, which carries a click handler but is not focusable, so
"trap the overlay" and "trap the dialog" coincide there. One hook, applied to
each component's outermost overlay element, serves both.

## Decisions

**A hook, not a wrapper component.** Both shells already own their overlay
markup and their portal decisions; a wrapper would have to reproduce those.

**No `inert` on the background.** It would be the other way to do this, but it
means reaching outside the component to mark the app root, and the two dialogs
mount from different places. Wrapping the tab cycle is local and testable.

**The scroll containers are left alone.** `scroll-rosters` and
`scroll-draft-board` are focusable because Chromium makes scrollable regions
focusable for keyboard scrolling, which is correct behaviour. They are only
reachable behind an overlay because containment is missing; the trap resolves
it without touching them.

## Testing

**Both directions, both dialogs — four tests.** Forward from the last
focusable element must wrap to the first; backward from the first must wrap to
the last. The backward case is the one that would otherwise be missed, and it
is the one that fails after a single press today.

**Assert containment, not a press count.** A test that says "3 presses stays
inside" passes against a trap that leaks on the 4th. Each test presses more
times than there are focusable elements and requires focus to be inside the
overlay after *every* press.

**The 1600ms test is the guard.** `draftphone.spec.js:422` must stay green
untouched. If the trap breaks it, the trap is wrong, not the test.

**Mutation checks.** Remove the forward wrap and the forward tests go red;
remove the backward wrap and only the backward tests go red. If removing one
turns both red, the tests are not measuring the ends separately.

**Render it.** Every number above came from a browser. Three tests on the
previous branch were green while the page was visibly wrong.

## Out of scope

The tab bar's `role="tablist"` question, and the Big Board panel's own
focusable scroll container. Both are on the accepted list and neither is a
lie the markup tells.
