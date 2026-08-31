# Board Drives the Draft

**Date:** 2026-08-31
**Status:** Approved, ready for implementation planning
**Predecessor:** Phase 3 of `docs/superpowers/specs/2026-08-27-custom-big-board-design.md`

---

## Summary

Let a draft be started from a saved custom board, so the in-draft Big Board is ordered
by the user's own rankings and each row shows their rank against ADP.

---

## Motivation

The custom big board is currently decorative. A user can build a ranking, drag it into
shape, save it, and share it — and it affects nothing. `boardId` never reaches
`drafts.js` or `Draft.jsx`; every draft is ordered by consensus ADP regardless.

This was phase 3 of the board spec, deliberately deferred so that the riskier
identity-resolution work could be sequenced after the parts that carried no external
dependency. It is the open loop in the application: twelve reviewed tasks built a
feature that does not yet change how anyone drafts.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Where ordering happens | Client-side in `Draft.jsx` | The board endpoint already returns reconciled rows; the players endpoint already returns the pool. No server-side join is needed. |
| What the backend stores | `boardId` on the draft, nothing more | The draft only needs to remember which board it started from, so a reload or shared link keeps working. |
| Bots | Never see the board | If bots drafted the user's rankings they would reach for exactly the players the user likes, and "will he last until my pick?" would stop being a real question. |
| Format mismatch | Allowed, flagged | A PPR board is still a reasonable guide in a half-PPR draft. Filtering the list to exact matches produces an empty dropdown with no explanation. |
| Deleted board | Silent fallback to consensus | `DELETE /boards/:id` exists, so a draft can outlive its board. A dead reference must never break a playable draft. |
| Board selection | At draft creation only | Attaching a board to a draft already in progress is a different feature with its own questions. |

---

## Why ordering is simple

A board contains **every ranked player**. `loadPool` in `boards.js` filters to
`rank[format] != null` — the ~270-player filter chosen when boards were built. Everyone
absent from a board is therefore unranked.

Ordering is consequently: board players in the user's order, then the unranked remainder
in whatever order the players endpoint already returns. There is no interleaving problem,
because there is no ranked player missing from the board.

**One edge case.** When a board's format differs from the draft's, the sets can differ
slightly — a player ranked in standard but not in PPR would be absent from a PPR board
and sort with the unranked remainder despite having a rank in the draft's format. This is
rare, cosmetic, and self-correcting once the user drags that player into their board.

---

## Data Model

### Drafts table — additive

`boardId: string` — optional. Drafts without it behave exactly as they do today.

Validated on `POST /drafts` as a non-empty string of at most 64 characters (board ids are
UUIDs). No existence check: the board lives in the same account-less model as the draft,
and verifying it server-side would mean a cross-table read on every draft creation for a
reference that can be deleted a second later anyway. The client handles absence.

---

## Ordering — `frontend/src/lib/boardOrder.js`

A new pure module, following the `reconcile.js` and `roster.js` precedent.

```js
orderByBoard(players, boardRows) → Array<player & { myRank, delta }>
```

- Players present in `boardRows` come first, ascending by `myRank`
- Every other player follows, preserving the order the players endpoint returned
- Each board player carries `myRank` and `delta` for display
- `boardRows` being `null` or empty returns `players` unchanged — the fallback path
- Pure, no I/O, unit-testable

---

## Draft creation — `frontend/src/pages/NewDraft.jsx`

A "Use my board" select, populated from `listBoards()` in localStorage, each option
labelled with the board's format. Choosing a board whose format differs from the draft's
selected ADP format shows a plain note beneath the select: the ranks still apply, but they
were not built for this scoring.

`boardId` is sent on create only when a board is chosen, spread conditionally in the same
way `rosterSlots` is.

### The registry must carry the format

`boardRegistry` currently stores `{ id, name, updatedAt }` — there is no format on a
remembered board, so neither the label nor the mismatch check is possible as things stand.

`rememberBoard` gains a `format` field and `Boards.jsx` passes it at creation, where the
format is already in hand. This is additive:

```js
rememberBoard({ id: boardId, name, format })
```

**Entries written before this change have no `format`.** They render without a format label
and are exempt from the mismatch check — we cannot warn about a mismatch we cannot detect,
and guessing from the name (`My PPR Board`) would be a convention masquerading as data. The
gap self-heals as boards are created; no migration and no backfill.

Boards are listed from localStorage, which means a board created in another browser is not
offered. That is consistent with how `/boards` already works and is not a regression.

---

## In-draft — `frontend/src/pages/Draft.jsx`

When `draft.boardId` is present, `load()` also fetches `GET /boards/:boardId` and passes
its `rows` through `orderByBoard`. The Big Board's existing filter and pagination are
unchanged; only the input order differs.

Each row shows the user's rank where the consensus rank sits today, with ADP and the delta
alongside — so a player the user ranks 4th who is going at ADP 11 is visible as such
mid-draft.

**Failure handling.** If the board fetch fails for any reason — deleted board, network
error, malformed response — the Big Board falls back to consensus order and a small notice
explains that the board could not be loaded. The draft itself must remain fully playable:
picks, auto-pick, sim-to-end, and the clock are all unaffected, because none of them
consult the board.

---

## Testing

### Unit — `frontend/src/lib/boardOrder.test.js` (`node:test`)

- Board players come first, ascending by `myRank`, regardless of their consensus order
- Players absent from the board follow, in their original relative order
- `myRank` and `delta` are attached to board players and absent from the rest
- `null` and `[]` board rows return the input unchanged — the fallback contract
- A board row referencing a player not in the pool is ignored rather than producing a hole
- Inputs are not mutated

### End-to-end — `frontend/tests/boarddraft.spec.js`

- Selecting a board on `/draft/new` sends `boardId` on create
- Creating a draft without selecting one sends no `boardId` key
- A draft with a board renders the Big Board in the board's order, not ADP order
- A format mismatch between board and draft shows the note
- **A draft whose board returns 404 still renders and is still draftable** — the
  regression test for a deleted board

---

## Out of Scope

- **An in-draft toggle** between the user's order and consensus order. Useful, separate.
- **Applying the user's ranks to the Results page** — showing where each pick fell against
  their board. Natural follow-up, not needed to close this loop.
- **Attaching a board to a draft already in progress.**
- **Backfilling `format` onto boards already in localStorage.** Those entries simply go
  unlabelled and unchecked until replaced.
- **Changing bot behavior in any way.** `pickBestForTeam` is not touched by this work.
