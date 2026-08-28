# Hamburger Navigation + Boards Page

**Date:** 2026-08-28
**Status:** Approved, ready for implementation planning
**Scope:** Frontend only — no Lambda, no DynamoDB, no SAM deploy

---

## Summary

Add a global hamburger navigation bar to every page, and extract the saved-boards
list from Home onto its own `/boards` page.

---

## Motivation

The app has four routes and almost no way to move between them. `/board/:boardId`
has **no navigation at all** — once a user opens a board, browser back is the only
exit. That dead-end shipped with the board editor on 2026-08-27.

`Home.jsx` has also grown to 269 lines doing two unrelated jobs: configuring a mock
draft, and managing saved ranking boards. Splitting it is the natural fix, and the
nav is what makes the split navigable.

This also clears the way for the Sleeper league connection, which will add its own
entry points ("Connect League", "My Leagues"). Without a nav those land on Home too,
and the untangling gets worse.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Home's role | Stays the draft-setup page, loses only the boards section | Smallest change that still gives the nav real destinations |
| Nav behavior | Hamburger at **every** width, not responsive | One code path, one test path; scales when league connection adds items |
| Nav placement | App shell, above `<Routes>` | Every page inherits it, which fixes the Board dead-end without separate work |
| Boards data source | Existing `boardRegistry` localStorage | Boards are already tracked client-side; no backend endpoint needed |
| New directory | `frontend/src/components/` | A shared shell component is not a page; `pages/` is the wrong home |

---

## Architecture

Two new files, three modified.

**Create**
- `frontend/src/components/NavBar.jsx` — the bar and its menu
- `frontend/src/pages/Boards.jsx` — saved-boards index
- `frontend/tests/nav.spec.js` — navigation coverage

**Modify**
- `frontend/src/App.jsx` — render `<NavBar />` above `<Routes>`; add the `/boards` route
- `frontend/src/pages/Home.jsx` — remove the boards section
- `frontend/tests/board.spec.js` — retarget one test from `/` to `/boards`

### Routes after this change

```
/                   Home      draft setup (teams, rounds, format, slot)
/boards             Boards    saved boards: open, create, delete
/board/:boardId     Board     drag-reorder editor
/draft/:draftId     Draft     live draft
/draft/:draftId/results       results
```

The hamburger lists **Home** and **Boards**. `/board/:id`, `/draft/:id`, and the
results page are reached contextually, not from the menu.

---

## NavBar

A single component holding one piece of state: whether the menu is open.

```
┌──────────────────────────────────┐
│ ● PerfectPick                  ☰ │
└──────────────────────────────────┘
   click ☰ ↓
┌───────────────────┐
│ Home              │
│ Boards            │
└───────────────────┘
```

**Required behaviors.** Each is cheap to implement and irritating to omit:

- **Closes on route change.** Without this the menu stays open on top of the page
  the user just navigated to. Drive it off `useLocation()`, not off the click
  handler, so programmatic navigation closes it too.
- **Escape closes the menu** and returns focus to the toggle button.
- **Clicking outside closes the menu.**
- `aria-expanded` and `aria-controls` on the toggle, `aria-label="Menu"`.
- The active route carries `aria-current="page"` and is visually marked.

**Styling** follows the existing dark zinc/cyan Tailwind palette used across the
app. The bar sits inside the existing `max-w-[1400px]` container in `App.jsx`.

---

## Boards Page

The board list, the "New board" button, and the per-board delete button move from
`Home.jsx` to `Boards.jsx` unchanged in behavior:

- Lists boards from `listBoards()`
- Create posts to `POST /boards`, calls `rememberBoard`, navigates to `/board/:id`
- Delete calls `DELETE /boards/:id` and forgets locally **only on success** —
  preserve this; forgetting on failure strands a board that still exists server-side
- Empty state when no boards are saved

`Home.jsx` afterward keeps only draft setup: teams, rounds, format, year, slot
picker, pick schedule, and "Start Mock Draft".

**Splitting the shared state.** Home currently uses one `err` state for both draft
creation and board creation, and one `apiPost` import for both endpoints. After the
split:

| | Home keeps | Boards gets |
|---|---|---|
| State | `teams`, `rounds`, `format`, `year`, `slot`, `randomSlot`, `loading`, `err` | its own `boards`, `err` |
| Imports | `apiPost`, `picksForSlot`, `largestGap` | `apiPost`, `apiDelete`, `listBoards`, `rememberBoard`, `forgetBoard` |
| Handlers | `createDraft` | `createBoard`, `deleteBoard` |

Each page owns its own `err`; they are not shared or lifted. Home drops the
`boards` state, both board handlers, and the `apiDelete` / `boardRegistry` imports
entirely.

These `data-testid` values move with the markup and must keep their exact names,
since tests select on them: `create-board`, `board-list`. The delete button keeps
its `aria-label` of `Delete {board name}`.

---

## Testing

### Moved

`frontend/tests/board.spec.js` — the test "deleting a board removes it from the
list" navigates to `/` and asserts on `board-list`. It must navigate to `/boards`
instead. This is the only existing test that breaks.

### Unaffected — confirmed

All 7 tests in `home.spec.js` (hero, form defaults, control changes, feature cards,
Start Mock Draft navigation, API error, screenshot) and all 4 in `slot.spec.js`
touch only draft setup, which stays on Home.

### New — `frontend/tests/nav.spec.js`

- The toggle opens the menu and closes it again
- Each link navigates to its route
- The menu closes after navigating
- Escape closes the menu
- **Navigation is reachable from `/board/:boardId`** — the regression test for the
  dead-end this work fixes

---

## Out of Scope

- **Sleeper league connection.** Its own spec. It reshapes the domain model
  (arbitrary scoring, FLEX/SUPERFLEX rosters, rounds derived from roster size)
  rather than extending it. The nav is deliberately built first so its entry points
  have somewhere to live.
- **A drafts index.** Drafts are not tracked client-side — there is no
  `draftRegistry` mirroring `boardRegistry`, so a created draft is lost once its
  link is gone. Real gap, separate decision.
- **Responsive inline links.** Explicitly rejected in favor of one code path.
