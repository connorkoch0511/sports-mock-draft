# Landing Page + Nav v2

**Date:** 2026-08-28
**Status:** Approved, ready for implementation planning
**Scope:** Frontend only — no Lambda, no DynamoDB, no SAM deploy

---

## Summary

Move the hamburger to the left, turn `/` into a real landing page, and give mock-draft
setup its own `/draft/new` page.

---

## Motivation

The hamburger currently sits on the right. The left is the older and more widely
recognised convention — Material Design put it top-left opening a left drawer — and
that is what most people picture when they hear "hamburger menu."

More substantially, `/` is still the draft-setup form wearing a landing page's clothes.
It opens with a hero and feature cards, then asks for teams, rounds, format, and draft
slot. With `/boards` now its own page, draft setup should be too, leaving `/` free to
be an actual entry point.

This also prepares for the Sleeper league connection, which needs its own nav entry and
a league picker. Those land cleanly once `/` is a landing page rather than a form.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Hamburger position | Far left, `PerfectPick` mark immediately right of it | The Material arrangement; matches what users expect and avoids colliding with the brand |
| Menu contents | Home · New Draft · Boards | Three real destinations; the fourth (Connect League) arrives with the Sleeper spec |
| Home's role | Pure landing page, no functional controls | A landing page that also submits a form is neither |
| Draft setup | Moves verbatim to `/draft/new` | Same testids and button text, so moved tests change only their `goto` target |

---

## Architecture

**Create**
- `frontend/src/pages/NewDraft.jsx` — the draft-setup form
- `frontend/tests/newdraft.spec.js` — tests that move off `home.spec.js` / `slot.spec.js`

**Modify**
- `frontend/src/components/NavBar.jsx` — hamburger to the left, third menu item
- `frontend/src/App.jsx` — add the `/draft/new` route
- `frontend/src/pages/Home.jsx` — strip the form, become a landing page
- `frontend/tests/home.spec.js` — 5 tests move out, 2 stay and are re-asserted
- `frontend/tests/slot.spec.js` — 3 tests retarget to `/draft/new`
- `frontend/tests/nav.spec.js` — cover the third menu item

### Routes after this change

```
/                   Home       landing: hero, feature cards, CTAs
/draft/new          NewDraft   teams, rounds, format, slot picker, schedule
/boards             Boards     saved boards
/board/:boardId     Board      drag-reorder editor
/draft/:draftId     Draft      live draft
/draft/:draftId/results        results
```

`/draft/new` and `/draft/:draftId` do not collide: React Router 7 ranks the static
segment above the dynamic one. A draft ID is a UUID, so `new` could never be one.

---

## NavBar

```
┌──────────────────────────────────┐
│ ☰  ● PerfectPick                 │
└──────────────────────────────────┘
   click ☰ ↓
┌───────────────────┐
│ Home              │
│ New Draft         │
│ Boards            │
└───────────────────┘
```

Only the layout and the link list change. Every existing behavior stays exactly as
built and tested: closes on route change, Escape closes and returns focus to the
toggle, click-outside closes, `aria-expanded` / `aria-controls` / `aria-label="Menu"`,
`aria-current="page"` on the active link, and the menu unmounting when closed.

The menu panel currently anchors to the right (`absolute right-0`). With the toggle on
the left it anchors left instead, so it opens beneath the button rather than across
the header.

---

## Home as a landing page

Home keeps its hero, its gradient background, and its three feature cards. It gains
primary calls to action into `/draft/new` and `/boards`.

It loses the whole form: the `teams`, `rounds`, `format`, `year`, `slot`, `randomSlot`,
`loading`, and `err` state, the `createDraft` handler, and the `apiPost`, `picksForSlot`,
`largestGap`, and `useMemo` imports. After this Home holds no state at all and makes no
network calls.

---

## NewDraft page

Receives the form verbatim — the same controls, the same layout, the same behavior.

These must keep their exact names, because the moved tests select on them:
`slot-select`, `random-slot`, `pick-schedule`, the accessible labels `Teams`, `Rounds`,
and `ADP Format`, and the button text `Start Mock Draft`.

It owns the state and handler Home gives up, and on success navigates to
`/draft/:draftId` exactly as before.

---

## Testing

This is the bulk of the work. Eight tests change page.

### Moving to `/draft/new` — 8 tests

From `home.spec.js`:
- `default form values are 12 teams, 15 rounds, standard format`
- `user can change teams, rounds, and format`
- `clicking Start Mock Draft navigates to draft page`
- `shows error message when API call fails`
- the draft-control half of `renders hero and draft controls` — the hero half stays on Home

From `slot.spec.js` — the three that call `goto("/")`:
- `pick schedule updates with the selected slot`
- `selected slot is sent when creating a draft`
- `random slot disables the selector`

`slot.spec.js`'s fourth test loads `/draft/:draftId` and is unaffected.

Moved tests keep their assertions unchanged; only the navigation target changes.

### Staying on `/` — re-asserted

- `feature cards are visible` — unchanged
- `screenshot — home page` — unchanged mechanically, though it now captures the landing page
- A new assertion that Home renders its CTAs and **no longer renders the draft form**,
  which is what proves the extraction actually happened rather than duplicating

### `nav.spec.js`

Gains a case that the third menu item, New Draft, navigates to `/draft/new`. Every
existing nav test stays, including the mutation-verified Escape focus-return test.

---

## Out of Scope

- **Sleeper league connection.** Its own spec, next. It needs `roster_positions` modeling
  and FLEX/bench support in the bot logic, which is a domain change rather than a UI one.
- **A drafts index.** Drafts are still untracked client-side — there is no `draftRegistry`
  mirroring `boardRegistry`, so a draft is lost once its link is gone.
- **The Draft board's breakpoint gap.** `Draft.jsx:276` only becomes a three-column grid
  at `2xl` (≥1536px); below that the rosters panel wraps and the page overscrolls.
  Pre-existing and unrelated.
