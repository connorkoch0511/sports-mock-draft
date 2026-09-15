# A queue the clock will draft from

**Status:** approved design, not yet implemented
**Scope:** `backend/src/drafts.js`, `backend/src/lib/autoPick.js`;
`frontend/src/pages/Draft.jsx` and a new panel beside the existing ones.

## Why this and not a bookmark list

The app already has a big board: your season-long ranking, edited once and
reused. What it has no way to record is *situational* intent — given what has
actually happened in this draft, these are the next three you want.

The distinction matters because of what the queue is allowed to do:
**it outranks the big board when the clock picks for you.** Today an expired
clock takes the best available player by your board, which was ordered in
July and knows nothing about the run of tight ends that just happened. A
queue is you saying "regardless of all that, take these, in this order."

Sleeper's queue works exactly this way — it auto-picks from your list on
timeout rather than falling back to ADP. Without that, a queue is a list of
bookmarks and not worth the build.

## Decisions

### A queued player who gets drafted disappears

Not struck through. An earlier draft of this idea proposed striking them out
so you could see the run happening — that was wrong. The queue is a list of
players you are going to pick; an entry you *cannot* pick is noise in the one
place that should be nothing but signal. Where a run happened is legible on
the draft board, which exists for that.

### Dropping is done by filtering on read, never by writing

The stored array keeps every id you put there. Both the UI and the auto-picker
skip ids already in `picked`:

```js
queue.filter((id) => !pickedSet.has(id))
```

This matters more than it looks. The alternative — pruning each seat's queue
when a pick lands — means a write per pick per affected seat, on the hot path
that the shared clock's conditional write already guards, with a race every
time two seats queue the same player. Filtering on read has none of that: the
player vanishes from your queue the instant the pick lands, for everyone, with
no coordination at all. The stored list is tidied for real the next time you
edit it.

### The queue beats the roster guard

The auto-picker refuses kickers and defences until late, so it cannot wreck a
roster while guessing on your behalf. The queue is not a guess. If your top
queued player is a kicker in round three, the clock takes the kicker.

That guard exists for when you have said nothing. Here you have said
something, and the feature is worthless if it second-guesses you.

### Per-seat state, written the way `boardId` already is

`seats[i].queue`, an array of player ids, set by a conditional update that
proves the seat is yours — the same shape as
`SET seats[i].boardId = :b ... ConditionExpression: seats[i].sub = :me`.

One route, `POST /drafts/{draftId}/queue`, replacing the whole array. Reordering
is then a single write with no partial-order race, and the payload is a few
ids.

## Where it lives

**At `3xl` (1600px) and above: a fourth column** — and the page container widens from
`max-w-7xl` (1280) to 1600 to make room. **The page's height binding moves to
the same breakpoint.** Bound at `xl` with only three tracks, the fourth item
wrapped to a second row and CSS split the height between them: every panel
halved, content overflowing, the queue painted across the Big Board. The
column's breakpoint and the height binding must always be the same one.

That widening is load-bearing, not cosmetic. Measured: the grid is capped at
**1232px by the container, not by the viewport**, so a 1728px monitor renders
the same 1232px of columns and wastes ~500px of margin. Four columns inside
1232 leaves the Draft Board 164px against a table that wants 620 — it would
scroll horizontally in a sliver on every screen. Widening is what lets the
fourth column cost nothing.

**Between `lg` and `3xl`:** a fourth item below the three columns, on a page
that scrolls rather than being height-bound — the same trade `lg` has always
made. Note `RosterPanel`'s own `lg:col-span-2` means this is three rows at
`lg`, not the two-by-two the first draft of this spec claimed.

**Below `lg`:** the fourth tab the bar was built for. `grid-cols-3` becomes
`grid-cols-4` — the change the tab bar was deliberately laid out to absorb.

## Adding and ordering

A `+` on each Big Board row appends. A row in the queue removes itself, and
rows reorder by drag, reusing the Board page's dnd-kit configuration —
`PrimaryMouseSensor` at 4px (**not** `MouseSensor`, which arms on middle-click -- and a drop here writes to the server) and `TouchSensor` on a 250ms hold, so a thumb can
reorder without the list running away. That configuration exists because
reordering with a finger was impossible until recently; this is the second
feature to need it.

An empty queue says what it is for rather than sitting blank.

## Testing

- The queue survives a reload and is visible only to its own seat.
- **A queued id that is only an `Object.prototype` key is ignored.** `byId`
  comes from `Object.fromEntries` and inherits the prototype, and the route
  accepts any non-empty string — so `{ queue: ["constructor"] }` made the
  lookup truthy, set the pick to the `Object` constructor, spread `undefined`
  into every field and threw on the write: a 500 on every `/expire` that
  wedged the shared clock for the whole draft. Own-property check, and a test.
- **The queue never overlaps another panel, at any width**, and the three
  original panels keep a real height. This is the assertion that was missing
  when the 1280–1599 band shipped broken.
- A conditional write refuses a queue update for a seat that is not yours.
- **Auto-pick takes the first queued player, ignoring the board** — and the
  same fixture with an empty queue still picks by board, so the test cannot
  pass by accident.
- **Auto-pick takes a queued kicker in round three.** The roster guard is
  deliberately overridden and a test has to say so, or a later reader will
  "fix" it.
- A queued player drafted by somebody else is gone from the queue on the next
  render, with no write having occurred.
- Auto-pick skips a queued player already taken and moves to the next.
- An exhausted queue falls through to the board, and the board's own
  behaviour is unchanged.
- The fourth column appears at `xl`, the fourth cell between `lg` and `xl`,
  and the fourth tab below `lg`.
- **The page is wider at `xl` than it was**, and the Draft Board's width did
  not shrink — the arithmetic above, asserted.
- Reordering works with a mouse and with a touch hold.
- Phone: the draft page still fits 390×844 with a fourth tab, and nothing
  overflows horizontally.

## Out of scope

- Queueing from anywhere except the Big Board.
- A queue anyone else can see. It is per-seat and private.
- Any suggestion of *what* to queue. The advice engine recommends; the queue
  records what you decided.
- Pruning the stored array on the pick path. Filtering on read is the design,
  not a shortcut.
