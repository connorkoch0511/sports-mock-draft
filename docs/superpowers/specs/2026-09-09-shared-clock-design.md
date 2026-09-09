# Drafting Together, Phase 2: The Shared Clock

**Status:** approved design, not yet implemented
**Depends on:** Phase 1 (`docs/superpowers/specs/2026-09-08-drafting-together-phase1-design.md`), merged at `ad90177`

## Problem

Phase 1 put several people in one draft: seats, invite links, a server-side
turn check, and a conditional write that resolves two people picking at once.
It deliberately shipped **no clock**. `Draft.jsx` disables both the countdown
and the timeout auto-pick whenever `humanSeatCount > 1`, because a clock held
in each browser would have every browser firing timeouts at every other seat.

So a shared draft today waits forever on whoever wandered off. Phase 2 gives
it a real 60-second clock that no browser can cheat, and makes the pick that
clock takes come from the drafter's own rankings.

A second problem falls out of the same work. Auto-pick is **board-blind**:
`pickBestForTeam` (`backend/src/drafts.js:107`) scores on the global consensus
`rank`, and `loadPlayersForSport` never sees a board. The draft stores a
`boardId` and the page fetches it, but only to order the list on screen. Your
big board has never driven your own timeout, in shared drafts or solo ones.

## Decisions

Carried in from the Phase 1 brainstorm:

- Everyone drafts at once, against a real 60-second clock.
- An absent drafter is auto-picked from their own big board.
- Clock authority is a **server-held deadline**, evaluated against the
  server's own clock, which watching browsers ask the server to enforce. If
  every browser closes, the draft pauses. That is acceptable for a draft night.
- The endpoint browsers call is deliberately the one a scheduler (EventBridge)
  would call later, so an unattended clock is an addition, not a rewrite.

Made in this brainstorm:

1. **A long absence costs one pick, not many.** One expired deadline produces
   exactly one auto-pick. No catch-up loop.
2. **Boards are per seat.** A joiner names their own board when claiming a
   seat; that board drives that seat's auto-pick.
3. **Board order feeds the existing roster logic**, replacing consensus rank
   as the input rather than bypassing the scoring. Your rankings decide *who*,
   roster shape still decides *when*.
4. **One clock for every draft**, solo included. Which requires pause to move
   to the server.

## Data model

Three new fields on the draft item:

| Field | Type | Meaning |
|---|---|---|
| `pickDeadline` | epoch ms | When the seat on the clock must have picked. Rewritten to `now + 60_000` on every advance. |
| `pausedAt` | epoch ms, absent when running | Set while the draft is stopped. |
| `pausedBy` | Cognito `sub` | Who stopped it, so the page can name them. |

And one new field per seat: `seats[i].boardId` (string or null).

Resume sets `pickDeadline += (now - pausedAt)` and clears `pausedAt`, so a
pause preserves the *remaining* time rather than granting a fresh minute.

`pickDeadline` is first set when the draft is created, so pick 1 is on the
clock from the moment the page opens. Thereafter **`lib/advance.js` writes it
as part of the same conditional write** that moves `currentIndex` — the two
can then never disagree, and a lost race cannot leave a deadline belonging to
a pick that has already been made.

`GET /drafts/{draftId}` gains `pickDeadline`, `pausedAt`, `pausedBy`, and
**`now`** (the server's current epoch ms), alongside the `seats`, `yourTeam`
and `version` Phase 1 added.

## Clock semantics

The deadline is data, never a running timer. Nothing fires on its own; the
deadline is only ever evaluated, and only by the server against its own clock.
A browser reporting "time is up" is making a request, not asserting a fact.

### `POST /drafts/{draftId}/expire`

1. Caller must be seated, else **404** — anti-oracle, as everywhere else.
2. `currentIndex >= picks.length` → **409** "Draft already completed". This
   check comes *before* the two below, for the reason Phase 1 learned the hard
   way: ordering a new guard ahead of the completed check makes a finished
   draft report the wrong thing about itself.
3. `pausedAt` set → **409**, with current state attached.
4. `Date.now() <= pickDeadline` → **409**. The caller's clock was wrong, or
   someone else got there first.
5. Otherwise: make **exactly one** auto-pick for the seat on the clock,
   advance via `lib/advance.js`, set `pickDeadline = now + 60_000`.

Forty minutes past the deadline and forty seconds past it do the identical
thing. That is decision 1, and it is the whole of it.

Two browsers both shouting "time is up" race on `advance.js`'s conditional
write on `currentIndex`: one wins, the loser gets `RaceLost` and re-renders,
which is the path Phase 1 already built and tested.

`/expire` takes no argument naming who to pick for, and does not care that a
human asked. A scheduler calling it on a timer with no browser open is the
same call.

### `POST /drafts/{draftId}/pause`

Body `{ paused: boolean }`. Any seated human may pause or resume; the page
names who did. Griefable in principle — these are people who were sent an
invite link.

### `/auto-pick` is unchanged

It keeps its current meaning: "draft for me, now, on purpose" (the button),
plus the bot-on-clock case, with the Phase 1 authorization guard intact. It
never consults the deadline. `/expire` only ever consults the deadline. The
two share player selection and nothing else.

Consequences worth naming: bots are still picked instantly by whichever
browser notices, so the deadline never really governs a bot seat; and if every
browser is closed while a bot is on the clock, nothing happens, which is the
same standstill as today, resolved when someone opens the page.

## Auto-pick from a board

New module `backend/src/lib/boardRank.js`. Given a `boardId`, one
`GetCommand` on the boards table (keyed by `boardId` alone — no owner filter
needed) yields the stored `order` array, whose index is the rank. It returns:

```
rankOf(p) = index.has(p.id) ? index.get(p.id)
                            : order.length + (p.rank ?? BIG)
```

Everyone on the board outranks everyone off it; the off-board remainder stays
in consensus order among themselves. The fallback is load-bearing, not
defensive padding: a stored `order` goes stale, because `boards.js` reconciles
newly added players in at read time. A board written in July does not list a
player added in August, and without the fallback that player would score as
unranked rather than as "good, just not on your list".

`pickBestForTeam` takes `rankOf` as a parameter, defaulting to `(p) => p.rank`,
so its scoring, its `kDefBlocked` guard, and every existing test go on working
untouched.

**Resolution per seat:** `seats[i].boardId` → `draft.boardId` → consensus.

**A board that fails to load falls back to consensus rather than failing the
pick.** Deleting a board mid-draft must never stall the clock.

**At join time the server verifies the joiner owns the board they name**, so a
seat cannot be pointed at someone else's rankings.

## Frontend

`frontend/src/pages/Draft.jsx`:

- Compute `skew = serverNow - clientNow` once per load and render
  `pickDeadline - (Date.now() + skew)`. Without this a laptop whose clock runs
  two minutes fast sees everyone's timer already expired and hammers
  `/expire`.
- The `shared` guard on the countdown comes out. The clock runs for everyone.
- At zero, call `/expire` instead of `/auto-pick`. Every watching browser
  fires; one wins, the rest get a 409, which is the path the existing pick
  race already handles. Stagger the call by seat index (~250ms per seat) so
  four browsers do not arrive together.
- `PICK_SECONDS` stops being the authority and becomes a display fallback. 60
  lives on the server.
- Pause becomes a button posting to `/pause`; paused state and `pausedBy` are
  read from the draft, replacing the local `paused` state.

`frontend/src/pages/JoinDraft.jsx`: a board picker listing the joiner's own
boards, defaulting to "No board — use consensus rankings", so joining stays
one click for anyone who does not care.

## Testing

Backend:

- `/expire` before the deadline → 409; after → exactly one pick, deadline
  re-armed.
- Two concurrent `/expire` calls → one pick.
- A paused draft refuses to expire however long it has sat.
- Resume preserves remaining time rather than granting 60 fresh seconds.
- A seat's board drives that seat's pick; roster logic still applies.
- A deleted board falls back to consensus without erroring.
- An unseated caller gets 404, not 403.
- A completed draft says it is completed, not that the clock has not expired.
- A creation sets `pickDeadline`, and an ordinary `/pick` re-arms it.

Frontend:

- The countdown derives from the server deadline and survives a refresh.
- Skew correction is applied.
- `/expire` fires at zero.
- A paused draft shows no countdown.

Playwright: two browsers in one shared draft; one lets the clock run out; both
end up seeing the same board.

Every guard is mutation-tested — delete it, watch a test go red, restore it.
Phase 1 used that standard to find ten tests that could not fail.

## Out of scope

- An unattended scheduler (EventBridge calling `/expire`). The endpoint is
  shaped for it; wiring it is a later phase.
- Per-seat clock lengths, or a commissioner-configurable pick duration.
- Any notification when your turn arrives.
