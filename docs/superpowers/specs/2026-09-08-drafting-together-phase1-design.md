# Drafting with people you invite — Phase 1 design

**Status:** approved 8 September 2026. Implementation not started.

## Goal

Two or more people draft in the same draft, at the same time, and it is
correct: you can only pick on your own turn, two people picking at once cannot
lose a pick, you see each other's picks, and the draft appears in the list for
everyone in it rather than only its creator.

## What this phase is not

**The clock.** Phase 2. Decided with the alternatives in front of us: the
draft is a live event, everyone present, sixty seconds enforced, and whoever
wanders off gets auto-picked from their own big board. None of that is here.

That has a consequence this phase must handle rather than ignore, because
today's clock lives in the browser: `Draft.jsx` runs a `setInterval` on
`PICK_SECONDS = 60` and auto-picks when it reaches zero. Left alone in a
multiplayer draft, every browser would run its own timer and fire auto-picks
at each other. **So a draft with more than one human seat runs with no timer
at all** until Phase 2 gives the server the authority. A solo draft is
unchanged.

## Decisions already made

| Decision | Made by | Value |
|---|---|---|
| Draft style | Connor | Everyone at once, with a real clock — the clock in Phase 2. |
| Absent drafter | Connor | Auto-picked, from their own big board where they have one. Phase 2. |
| Joining | Connor | A link. Opening it asks you to sign in, then seats you. No email addresses. |
| Unfilled seats | Connor, earlier | Stay bots. You invite until the draft is full; the rest are the computer. |
| Clock authority | Design, Phase 2 | A server-held deadline that watching browsers ask the server to enforce. |

## What already exists, and what it gets wrong

`seats` is already the model: `[{ team, sub, kind: "human" | "bot" }]`, built
at creation with the creator in `userTeam` and bots everywhere else. Its own
comment says *"One human today; a later phase fills the bot seats with
invitations."* This is that phase.

Two defects are load-bearing here. One is commented in the code; the other is
not written down anywhere and is worse:

**1. `isSeated` checks that you hold *a* seat, not *the* seat.** Every gated
route uses it, including `POST /drafts/{draftId}/pick`. With one human that is
the same thing. With two, either person can pick on the other's turn.

**2. The pick write has no condition at all.** The only `ConditionExpression`
in `drafts.js` guards the DELETE. A pick reads the draft, then writes `picks`,
`picked` and `currentIndex` unconditionally. Two people picking within the
same moment both read `currentIndex = 5`, both write slot 5, and **one pick
silently disappears** — no error, no conflict, just a player who was drafted
and then was not. Unreachable with one browser; a live race with two.

## Architecture

Nothing new is introduced beyond one table. The work is making existing writes
safe and letting seats belong to more than one account.

### Joining

The draft carries an `inviteToken` — random, generated at creation, returned
only to people already seated. The link is
`/draft/{draftId}/join?t={inviteToken}`.

Opening it signs you in if you are not, then calls
`POST /drafts/{draftId}/join` with the token. The server:

1. Rejects a token that does not match. A wrong or missing token is a 404, not
   a 403 — the same anti-oracle rule the rest of the app follows, so a
   guessed draft id learns nothing.
2. Returns success unchanged if you already hold a seat, so re-opening the
   link is harmless.
3. Otherwise takes the **lowest-numbered bot seat** and makes it yours.

That last step is the race: two people opening the link at the same instant
must not both get seat 3. The write is conditional on that seat still being a
bot:

```
UpdateExpression:      SET seats[2].#sub = :me, seats[2].kind = :human
ConditionExpression:   seats[2].kind = :bot
```

A `ConditionalCheckFailedException` means somebody else took it; the handler
retries with the next bot seat, and returns "this draft is full" when there
are none. Losing that race costs a retry, not a seat.

### Picking on your turn

`POST /drafts/{draftId}/pick` gains two things.

**The turn check.** `picks[currentIndex].team` is the team on the clock. The
seat for that team must be held by the caller:

```js
const onClock = draft.picks[draft.currentIndex]?.team;
const seat = draft.seats.find((s) => s.team === onClock);
if (!seat || seat.sub !== sub) return json(409, { error: "Not your pick" });
```

409 rather than 403, because it is a state disagreement rather than a
permission problem — you are in this draft, it simply is not your turn, and
the honest fix is to refresh.

**The conditional write.** Every pick-advancing write —
`/pick`, `/auto-pick` and `/sim-to-end` — becomes conditional on the
`currentIndex` it read:

```
ConditionExpression: currentIndex = :expected
```

A failed condition returns **409 with the current state**, so the browser can
show what actually happened rather than guessing. This is the fix for the
silent-loss defect above, and it is the reason the turn check alone is not
enough: two browsers can agree it is the same person's turn and still race if
that person double-clicks.

### Seeing each other's picks

The draft page polls `GET /drafts/{draftId}` every **3 seconds** while the
draft is open and incomplete. The response already carries `version`, which
increments on every write, so the client re-renders only when it changes.

Polling is chosen over anything cleverer because this stack has no WebSocket
and adding one is a project of its own. Three seconds is a judgement: fast
enough that a pick feels immediate to everyone else, slow enough that a
twelve-person draft is twenty requests a minute per person against a table
that is already read on every action.

Polling **stops** when the draft is complete, and when the tab is hidden
(`document.visibilityState`), so a forgotten tab is not a permanent load.

### Listing drafts you are in

`GET /me/drafts` today queries the `byOwner` GSI: it lists drafts you
*created*. Being in someone else's draft has never been possible, so nothing
lists it.

A GSI cannot index a list, and `seats` is a list, so membership needs its own
rows. **A new `DraftMembersTable`**, keyed `sub` (HASH) and `draftId` (RANGE):

- one row written when a draft is created, for its creator;
- one row written when someone joins;
- `GET /me/drafts` queries it by `sub`, then batch-gets those drafts.

This replaces the `byOwner` query for drafts. `ownerId` stays on the draft
item, because deleting a draft is still owner-only and that check reads the
item directly rather than the index.

**A membership row is a cache of what `seats` already says**, and the two can
in principle disagree — a row written while the seat write failed, or the
reverse. The seat is the truth: `GET /drafts/{draftId}` gates on `isSeated`,
never on membership. A stale membership row therefore shows a draft in your
list that 404s when opened, which is visible and harmless, rather than letting
someone read a draft they were never seated in.

### Sim to End, and Pause

Both are single-player ideas. Simulating the rest of a draft that other people
are sitting in takes their picks away from them.

**Both are hidden and refused once a draft holds more than one human seat.**
The server returns 409 for `/sim-to-end` on such a draft; the button does not
render. A solo draft is entirely unchanged. Pause has nothing to pause in this
phase, since a multi-human draft runs no timer at all.

## Errors, and what each says

| What happened | Status | What they see |
|---|---|---|
| Link with a wrong or missing token | 404 | This draft does not exist |
| Joining a full draft | 409 | This draft is full — every seat is taken |
| Already seated, link opened again | 200 | The draft, as normal |
| Picking when it is not your turn | 409 | It is not your pick |
| Two picks racing, yours lost | 409 | Somebody just picked — here is the board now |
| Sim to End in a shared draft | 409 | Sim to End is for drafts you are in on your own |

## Testing

- **The join race, proven rather than asserted:** two joins against the same
  bot seat, one condition failure, two distinct seats at the end. A test that
  only calls join twice sequentially proves nothing about the race it exists
  for.
- **The pick race:** two picks from the same `currentIndex`; one 200, one 409,
  and the losing pick is not in `picked`. This is the defect that silently
  loses a pick today, so it needs a test that fails against today's code.
- **The turn check:** the person not on the clock gets 409, and their attempt
  changes nothing.
- **The anti-oracle rule:** a wrong invite token returns exactly what a
  non-existent draft returns, byte for byte.
- **No timer in a shared draft:** a draft with two human seats runs no
  countdown and fires no auto-pick, however long the test waits.
- **Membership listing:** a draft you joined appears in your list; one you
  were never seated in does not; and a membership row without a seat produces
  a list entry that 404s rather than opening.

## Risks

- **Polling load.** Twelve people at three seconds is 240 reads a minute
  against one draft row. Acceptable for a handful of friends, and the
  visibility check keeps idle tabs quiet, but it is the first thing that would
  need attention if this were ever used at scale.
- **The dual write** on join — seat and membership row — has no transaction.
  Ordered seat-first so the failure mode is a missing list entry rather than a
  phantom one, and the seat remains the only thing that grants access.
- **A draft can now outlive its creator's interest.** Deleting is still
  owner-only, so somebody else's draft can sit in your list until they remove
  it. Accepted for this phase; leaving a draft is not built.
