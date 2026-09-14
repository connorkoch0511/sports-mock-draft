# The draft page on a phone

**Status:** approved design, not yet implemented
**Scope:** `frontend/src/pages/Draft.jsx` and new components under
`frontend/src/components/draft/`. Below the `lg` breakpoint only.

## The problem

Measured at 390×844 on 12 September: the draft page is **6,333px tall against
a 776px screen — 8.2 screens of scrolling**, and the header wraps into **five
rows** of controls before any content begins.

Nothing is broken. There is no horizontal scroll, every panel renders
correctly, and the app degrades honestly. It is simply unusable for its
purpose: Big Board renders first, so Draft Board and Team Rosters sit below
the *entire* player list. Seeing who is on the clock means scrolling past
everything and back, during a timed turn.

Every other page is fine — My Drafts 1.0 screens, Boards 1.0, the board
editor 1.1, New Draft 1.2, Results 2.1. This is a one-page problem, and the
page is the one a draft is actually played on.

The app has 26 responsive utilities in total. The draft's three columns
collapse to one below `lg` with nothing taking their place.

## What it becomes

Below `lg`, three bands:

```
┌─────────────────────────┐
│ ⏱ 0:47  Team 4  ⏸  ⋯   │   status strip, fixed
├─────────────────────────┤
│                         │
│   active panel          │   flex-1, scrolls internally
│                         │
├─────────────────────────┤
│ Board   Draft   Rosters │   tab bar, fixed
└─────────────────────────┘
```

At `lg` and above, **nothing changes**: the same
`xl:grid-cols-[420px_minmax(0,1fr)_360px]` grid, the same header row, no
strip, no tab bar.

## Decisions

### Tabs are destinations; the strip is state; the sheet is actions

This is the organising rule, and it comes from what Sleeper and ESPN already
do. Tabs hold places you go. A tab bar is never where a button goes to solve
crowding — that is what the overflow sheet is for. The strip holds what is
true right now and cannot be a tap away.

### Three tabs now, built for four

**Big Board · Draft Board · Team Rosters**, matching the panels' existing
headings and their `panel-big-board` / `panel-draft-board` / `panel-rosters`
testids.

A **Queue** tab is the intended fourth and is deliberately not in this
project. A queue worth having outranks the big board in the auto-pick chain,
which is server-side work in `autoPick.js` plus per-seat state. Sleeper's
queue auto-picks from your list on timeout rather than falling back to ADP,
which is the same design. Building a local-only queue here would ship a
bookmark list and require rebuilding. The tab bar is laid out so a fourth tab
is an addition, not a reflow.

### Panels stay mounted; the tab toggles visibility

All three render today, so this costs nothing new — and it preserves each
tab's scroll position. Scrolling forty players into the board, checking a
roster, and returning to the top would be infuriating.

**This is a deliberate departure from the rule set on the completed-draft
header**, where controls were made absent rather than disabled. There,
absence was the point: a control that cannot act should not be offered. Here,
state preservation is the point, and an unmounted panel loses it. Tab tests
therefore assert **visibility**, not `toHaveCount(0)`.

### The strip carries state and Pause, and nothing else

Countdown, whose turn it is, your team, Pause, `⋯`.

Pause earns its place because stepping away suddenly is the one thing you
need in a hurry, and the clock is shared — a paused draft stops everyone's
clock rather than burning your turn. Everything else is setup.

**When it is your turn the strip changes appearance, not just its text** —
ESPN's clock turning gold is the precedent — and **tapping the strip switches
to Big Board**. That makes the notification-to-pick path one tap.

**It does not switch tabs by itself.** Moving the view while someone is
reading a roster is hostile, and between the strip and a push notification
they already know. Tappable, never automatic.

### The `⋯` sheet holds the setup controls

A bottom sheet — not a dropdown — with full-width labelled rows: the
auto-pick board picker, Auto Pick, Sim to End, Copy invite link,
Notifications. A sheet rises near the thumb and gives each row a real touch
target; a desktop-style dropdown at the top of a tall phone is a mis-tap
generator.

These five are all decided once: which board drives your auto-pick, whether
to notify, who to invite. The research found that Sleeper and ESPN carry no
equivalents in-draft at all.

### The phone chrome does not exist at desktop

**Corrected during implementation.** The plan said all phone styling would be
expressed with `max-lg:` variants, which is true of layout but cannot be true
of existence: CSS has no way to say "do not be in the DOM", and **a
`display: none` element still matches Playwright locators**.

The strip repeats what the header says — the countdown, `✅ Completed` — so a
strip merely hidden at desktop made two pre-existing unscoped `getByText`
assertions resolve to two elements and fail under strict mode. Desktop
rendered identically; the DOM had gained a hidden twin.

Scoping those two assertions would have fixed today's two collisions and left
the class of problem in place: every element the strip carries has a twin in
the header, so each future addition would collide next, paid for by making
another old test more specific. Instead the strip, the sheet and the tab bar
are gated on a `useIsPhone()` hook (`matchMedia` via `useSyncExternalStore`)
and are simply absent above `lg` — the same rule `ControlSheet` already
followed by returning `null` when closed.

Their `lg:hidden` classes stay as belt-and-braces. The `max-lg:` classes on
the page root, the content div and `pane()` are genuine styling and are
unaffected.

A test asserts the chrome's **absence** — `toHaveCount(0)` — at desktop width.
That does not contradict the visibility rule below: that rule governs tab
switching, where panels stay mounted deliberately. This governs existence at
the wrong breakpoint, where count is the right question.

### Two presentations, one source of truth

Below `lg` the existing header row is hidden and the strip renders; above, the
reverse. This duplicates *presentation*, not logic — every control keeps its
handler, its `data-testid` and its state, and there is one set of state
behind both.

The alternative, one row that reshapes itself into both, produces a component
nobody can change safely. This row has already been fixed twice for wrapping
(`b31dbed`, and the completed-draft declutter) and is the most-edited markup
in the app.

## Testing

**The existing suite is the desktop regression net, for free.** Playwright
runs at 1280×720 (`devices["Desktop Chrome"]` overrides the config's
1440×900), which is above the 1024px `lg` breakpoint. Every existing draft
test therefore keeps exercising the desktop layout. **If any existing draft
test needs editing, stop** — that means the desktop layout moved, which this
design forbids. The two header no-wrap tests in `boarddraft.spec.js` are
included in that.

**New tests**, in a `test.describe` with `test.use({ viewport: 390×844 })` so
the phone layout is scoped and the rest of the file is untouched:

- The page fits its screen: the scroll container's `scrollHeight` is within a
  small margin of its `clientHeight`, and certainly nowhere near 8.2×. This is
  the measurement that opened this spec, inverted into an assertion.
- Each tab shows its panel and hides the other two.
- Switching away from a tab and back preserves its scroll position — the
  reason panels stay mounted, and a test that fails if someone "simplifies"
  it to conditional rendering.
- The strip is visible on every tab.
- Tapping the strip when it is your turn switches to Big Board.
- It does **not** switch tabs on its own when the turn changes.
- Pause is in the strip; the five setup controls are not, and are in the sheet
  once opened.
- At 1280 wide, the tab bar and strip do not render at all.

**Screenshots.** A phone-width shot of the draft page is worth adding, since
no screenshot currently shows any mobile layout and this is the project that
creates one.

## Out of scope

- The Queue tab and the queue itself — its own project, frontend and backend.
- Anything at `lg` and above.
- The panels' internal layouts. A panel that is cramped on a phone stays
  cramped; this project is about being able to reach it, not about
  redesigning what is inside it.
- The other pages, all of which measured fine.
- Landscape orientation as a distinct design.
