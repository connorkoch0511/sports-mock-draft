# Draft Page Fixed-Viewport Layout

**Date:** 2026-08-31
**Status:** Approved, ready for implementation planning
**Scope:** Frontend only — no backend, no schema, no deploy of Lambdas

---

## Summary

Give the app shell a definite height so the draft page's three panels finally scroll
independently, and move the three-column breakpoint to where the columns actually fit.

---

## Motivation

`Draft.jsx` is written as a fixed-viewport app layout: three panels each carrying
`flex-1 min-h-0 overflow-auto`, and a roster column with `2xl:sticky`. None of it has ever
worked. The page scrolls as one long document and always has.

Measured on the live app with a completed 15-round draft loaded, viewport height 900px:

| Width | scrollHeight | Overflow |
|---|---|---|
| 1280 | 8,346px | +7,446 |
| **1440** | 8,346px | **+7,446** |
| 1536 | 6,090px | +5,190 |
| 1728 | 6,090px | +5,190 |

It overscrolls at **every** width. Crossing the `2xl` breakpoint changes the column count
and reduces the damage, but never fixes it.

### Why `overflow-auto` does nothing

The height chain has no definite height anywhere in it:

```
<div class="flex min-h-screen flex-col">     ← a minimum, never a maximum
  <div class="flex flex-1 min-h-0 flex-col">
    <div class="flex-1 min-h-0">             ← routes wrapper
      Draft: <div class="min-h-full">        ← 100% of an indefinite height
             <div class="min-h-full flex flex-col">
               <div class="grid flex-1 min-h-0">   ← the three panels
```

`min-h-screen` and `min-h-full` set minimums. Content taller than the viewport simply grows
the page. `overflow-auto` scrolls an element only when something bounds its height, and
nothing here does — so each panel sizes to its content and the document scrolls instead.

This predates the landing-page work. A reviewer measured the same overflow before that
change and confirmed it was identical afterward.

### Why the breakpoint is also wrong

The app container is `max-w-[1400px]`. A `2xl` (1536px) breakpoint therefore cannot mean
"the container got wider" — above 1400px the container stops growing. Meanwhile the three
columns are `420px + minmax(0,1fr) + 360px`: at a 1280px viewport the container is about
1216px, leaving roughly 404px for the middle column. They fit at `xl`.

Gating on `2xl` forces the roster panel to wrap onto a second row at exactly the widths
people use most.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Layout model | Fixed viewport: panels scroll, page does not | It is what the existing classes were written for, and what a 60-second pick clock needs — board, picks and rosters all visible at once |
| Where the height is bounded | `h-screen` on the app shell root | One definite height at the top makes every `min-h-0` below it meaningful |
| Other pages | Unchanged behavior | They size to their content, grow past the wrapper, and scroll it instead of the document |
| Three-column breakpoint | `2xl` → `xl` | The container caps at 1400px, so 1536 measures nothing; the columns fit at 1280 |

---

## Architecture

### `frontend/src/App.jsx`

- Root: `min-h-screen` → `h-screen`. A definite height, which is the whole point.
- Routes wrapper (`flex-1 min-h-0`): gains `overflow-y-auto`.

The wrapper's `overflow-y-auto` is what keeps every other page working. A page taller than
the wrapper scrolls the wrapper rather than the document, which looks and behaves the same
to a user. The nav stays fixed above it, which is a small improvement.

### `frontend/src/pages/Draft.jsx`

- Both page wrappers: `min-h-full` → `h-full`. With a bounded ancestor this is now a
  definite height, so the grid's `flex-1 min-h-0` bounds the row, and each panel's
  `flex-1 min-h-0 overflow-auto` finally clips and scrolls.
- The grid's `2xl:grid-cols-[420px_minmax(0,1fr)_360px]` → `xl:`
- The roster panel's `2xl:col-span-1` → `xl:col-span-1`, and `2xl:sticky 2xl:top-6` → `xl:`

`lg:grid-cols-2` and `lg:col-span-2` stay, so 1024–1279px keeps the two-column layout with
the roster panel below — bounded now, and scrolling internally rather than growing the page.

No other page changes. Of the remaining pages, only `Home.jsx` carries a height class
(`min-h-full`); `Boards.jsx`, `Board.jsx`, `NewDraft.jsx`, and `Results.jsx` carry none and
simply size to their content. Both cases behave identically under this change — the page
grows past the wrapper and scrolls the wrapper rather than the document. None of them are
edited.

---

## Risk

`h-screen` on the shell root affects **every page in the app**, not just the draft. If the
routes wrapper's `overflow-y-auto` is wrong or missing, a page taller than the viewport is
clipped rather than scrolled, and its content becomes unreachable — a worse failure than the
overscroll being fixed.

The mitigation is that the regression test covers both directions: a draft page that must
*not* scroll, and a long page that must. Testing only the draft would let the clipping bug
ship green.

---

## Testing

### End-to-end — `frontend/tests/draftlayout.spec.js`

Measurement-based, mirroring the check that found the bug.

- At 1280, 1440, and 1536 with a loaded draft, `document.documentElement.scrollHeight` is
  within a small tolerance of `window.innerHeight` — the page does not scroll
- At 1440, each of the three panels is present and its `scrollHeight` exceeds its
  `clientHeight`, proving content is being clipped and scrolled internally rather than the
  panels having simply collapsed to nothing
- At 1440 the roster panel sits beside the other columns rather than below them, confirming
  the `xl` breakpoint engaged — asserted on geometry, not on class names
- **A long page still scrolls.** Seed `localStorage.perfectpick.myBoards` with enough
  entries to exceed the viewport (the registry caps at 50, which is ample), load `/boards`,
  and assert `scrollHeight > innerHeight` and that the last board is reachable by scrolling.
  This is the guard against the shell change clipping content everywhere else — the failure
  that would be worse than the bug being fixed.

A panel collapsing to zero height would satisfy a naive "page does not scroll" assertion,
which is why the second case checks the panels have real, scrollable content.

### Existing suites

64 Playwright, 31 frontend unit, 55 backend unit. All must still pass. The backend is
untouched.

---

## Out of Scope

- **Any backend change.** This is markup and CSS only; no Lambda deploy is needed.
- **Redesigning the panels themselves** — their internal layout, sizing, and content are
  unchanged.
- **The `lg` two-column arrangement** below 1280px, beyond it now being bounded.
- **Mobile layout.** Below `lg` the panels stack, which is correct and unaffected.
