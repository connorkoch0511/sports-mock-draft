# Draft UX Polish

**Date:** 2026-09-01
**Status:** Approved, ready for implementation planning
**Scope:** Frontend only — no backend, no schema, no Lambda deploy

---

## Summary

Three rough edges on the draft path: a board that silently may or may not be driving
the draft, a cross-format board that buries players who belong near the top, and a
Sleeper dynasty import showing two correct numbers that appear to contradict each other.

---

## Motivation

### 1. Nothing confirms a board is actually driving the draft

`Draft.jsx` renders a note when the board **fails**:

> Your board could not be loaded — showing consensus order.

There is no counterpart for success. Pick a board on the New Draft page, land on the
draft, and the only way to tell whether it took is to recognise your own ordering in the
Big Board. The board fetch already returns the board's `name`; the page keeps `rows` and
discards it.

### 2. A cross-format board buries players ranked for the draft's format

`orderByBoard` returns `[...onBoard, ...rest]` — every board player, then everyone else.
Its own comment explains why that is sound:

> A board holds every ranked player for its format (the boards API filters its pool to
> `rank[format] != null`), so the trailing group is essentially the unranked remainder —
> there is no interleaving to do.

That holds only when the board's format matches the draft's. Measured against production:

| Format | Players ranked |
|---|---|
| standard | 223 |
| half-ppr | 236 |
| ppr | 272 |

The sets are not the same, and the relationship is **directional**: every standard-ranked
player is also PPR-ranked (0 in standard but not PPR), while 49 are PPR-ranked but not
standard-ranked.

So:

- A **PPR board driving a standard draft buries nobody** — the board is a superset of the
  pool's ranked players, and the trailing group really is just the unranked remainder.
- A **standard board driving a PPR draft buries 49 players** below its 223 rows. **22 of
  them rank inside the top 223**, the best being PPR rank 139 (Zach Ertz), displaced by
  roughly 84 positions.

Real, bounded, and concentrated in the late-middle rounds. Nobody's early pick vanishes,
which is why this is polish rather than a defect.

The same burying happens, at smaller scale, to a player the nightly sync ranks *after* a
board was built: ranked in the pool, absent from the board, dumped below every board row.

### 3. A dynasty import shows two correct numbers that look wrong together

`toDraftConfig` takes rounds from `draft.settings.rounds` and roster slots from
`league.roster_positions`. For a Sleeper dynasty league those are legitimately different
numbers — a 5-round rookie draft against a 33-slot roster. The New Draft page shows
"Rounds: 5" beside 33 unlabelled chips, and nothing explains that both are right.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Board affirmation | Show the board's name in the Big Board header once it is driving the order | The failure case already speaks; the success case should too, so the panel is never silent about something this consequential |
| Cross-format ordering | Interleave by rank rather than appending | Fixes placement for the 22 displaced players, and for any player ranked after the board was built |
| The interleave ordinal | Board players by `myRank`, off-board by pool `rank`, unranked last | Both are positions in a ranked list of substantially the same players, so they compare meaningfully |
| Tie-break | The board player wins | It is the user's explicit ranking. Same precedent as `reconcile.js`, which breaks ties toward the saved order |
| Cross-format notice | Keep it, alongside the interleave | Interleaving fixes *placement*, not *judgment*: a standard board still reflects standard values in a PPR draft, and that is the user's call to make |
| Dynasty mismatch | Label, do not change any number | Both values are correct. The defect is that they are unexplained, not that they are wrong |

---

## Architecture

### `frontend/src/lib/boardOrder.js` — the interleave

`orderByBoard(players, boardRows)` keeps its signature and its two existing contracts:
`null` or `[]` rows return the pool untouched, and a board row for a player absent from
the pool is ignored.

What changes is the final assembly. Instead of concatenating two groups, every player
gets one sort key:

- on the board → its `myRank`
- off the board, ranked in the draft's format → its pool `rank`
- off the board, unranked → sorts last

Ties resolve toward the board player.

**Effect on the matching-format case.** Every player not on a board of the same format is
unranked, so they sort last and the result is what it is today. All ten existing
`boardOrder` tests use a fixture whose off-board players are unranked, and they pass
unchanged.

The one deliberate behavior change beyond the mismatch fix: a player ranked in the pool
but missing from the board — because the board predates the nightly sync that ranked them
— now places by rank instead of being buried. That is the same bug in miniature and the
same fix.

### `frontend/src/pages/Draft.jsx` — affirmation and notice

The board fetch keeps the board's `name` and `format` alongside `rows`, all of which
`GET /boards/:id` already returns.

Two additions to the Big Board panel:

- **Affirmation** — the board's name, shown when rows are present and driving the order.
- **Cross-format notice** — shown when the board's `format` differs from the draft's,
  naming both so the difference is legible rather than implied.

The existing `board-load-note` failure message is unchanged. The three states —
loaded, loaded-but-different-format, failed — are mutually exclusive and each says
something specific.

### `frontend/src/pages/NewDraft.jsx` — dynasty labelling

The roster chips gain a label identifying them as roster slots rather than draft rounds.
When the round count and the slot count differ, the page states that both are expected —
a rookie draft is shorter than the roster it fills.

No value changes. `rounds` still comes from `draft.settings.rounds` and `rosterSlots`
still comes from `league.roster_positions`.

---

## Risk

**`orderByBoard` is the highest-value function on the draft path** — it determines what
the user sees and what they draft from. It has ten tests and they must all still pass
untouched; a test needing modification would mean the interleave changed the
matching-format contract, which it must not.

The mitigation is that the change is additive in effect: it alters ordering only for
players who are ranked in the pool but absent from the board, which is empty in the
matching-format case. That set is precisely the bug.

The remaining items are display-only and carry no ordering risk.

---

## Testing

### Unit — `frontend/src/lib/boardOrder.test.js` (extend)

The ten existing tests stay **unmodified**. If any needs changing, stop: the interleave
has altered the matching-format contract.

New cases:

- A ranked off-board player places by its pool rank, between the board players it belongs
  between — not after all of them
- With a board of 3 and an off-board player ranked between board positions 1 and 2, the
  output order is board-1, off-board, board-2, board-3
- An unranked off-board player still sorts last, after every ranked player
- A tie between a board player's `myRank` and an off-board player's `rank` resolves to
  the board player
- Off-board ranked players keep their relative order among themselves
- The mismatch scenario end to end: a 3-row board against a pool containing two ranked
  players absent from it yields a single correctly-ordered list
- Every player still appears exactly once, and off-board players still carry neither
  `myRank` nor `delta`

### End-to-end — `frontend/tests/boarddraft.spec.js` (extend)

- The board's name appears on the draft page when a board is driving it
- No affirmation appears for a draft with no board
- The affirmation does not appear when the board fails to load; the existing failure note
  does
- A board whose format differs from the draft's shows the cross-format notice, naming both
  formats
- A matching-format board shows no such notice

### End-to-end — `frontend/tests/sleeper.spec.js` (extend)

- Importing a league whose draft rounds differ from its roster slot count shows both,
  labelled, with the explanation
- A league where they agree shows no explanation

### Existing suites

47 frontend unit, 85 Playwright, 100 backend unit. All must still pass.

---

## Out of Scope

- **Any backend change.** No Lambda deploy is part of this work.
- **Blocking a mismatched board at draft creation.** Considered and rejected: a PPR board
  driving a standard draft buries nobody, and choosing your own ranking regardless of
  scoring is legitimate.
- **Converting a board between formats**, or re-ranking it against the draft's scoring.
  That is a boards feature, not a draft-page one.
- **Changing which players the boards API includes.** The format-specific rank sets are
  upstream data, and this work adapts to them rather than altering them.
- **The `relativeTime` rounding and the Forget `aria-label`** on the My Drafts page.
  Unrelated cosmetics, tracked separately.
