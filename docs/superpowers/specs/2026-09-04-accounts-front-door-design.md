# Accounts as the Front Door

**Date:** 2026-09-04
**Status:** Draft — awaiting approval
**Scope:** Sign-in becomes the way in. Drafts and boards are private to the
people in them. The home page becomes a landing page signed out and a
dashboard signed in, pitched on the big board rather than the simulator.

---

## Summary

You sign in, and what you see is yours: your boards, your drafts, on any
device. A draft nobody invited you to does not exist as far as you are
concerned.

---

## Motivation

Phase 2 gave every draft and board an owner and stopped anyone else from
changing one. It deliberately left **reading** public, because sharing a
draft by link was an existing feature and a recipient had to be able to open
it.

That decision is now the thing in the way. The intended product is drafting
*with* people you invite — and an invitation means nothing if anyone holding
the URL is already in. "Only people in the draft can see it" is the rule
this project installs, and it is the precondition for invitations existing at
all.

The app has also outgrown its own pitch. The landing page still says "mock
draft simulator". Since then it has grown a custom big board, pick-time
advice that explains itself, player drill-downs with weekly game logs, season
stats, draft analysis, and Sleeper league import. The board is the part
people would come back for, and it is the part worth owning.

---

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Who can read a draft | Only people seated in it | An invitation is worthless if the link already grants access. |
| Access model for drafts | A `seats` list, not a scalar owner | Invitations later fill empty seats; the access check never changes and no migration is needed. |
| Who can delete a draft | The creator only, not everyone seated | An invited friend should not be able to destroy your draft. |
| Boards | Single `ownerId`, private | A board has one author. Seats would be a shape without a use. |
| `/player/:id` | Stays public | Reference data about a real NFL player, not user data, and the one genuinely shareable page in the app. |
| Signed-in home | A dashboard | Signed-out visitors get the pitch; you get your work. |
| Landing page pitch | The board | "Draft off your board, not theirs." The board is the asset; the draft proves it. |
| Existing unowned rows | Deleted, after a backup dump | All 66 drafts and 3 boards predate sign-in and nobody has claimed one. They are development leftovers. |
| Cross-device history | Included in this project | See below — a dashboard that is empty on your phone is not an account. |

### Cross-device history is in scope, and that is a deliberate widening

The original accounts spec left this to a "Phase 3": a GSI on `ownerId` and
`GET /me/drafts` / `GET /me/boards`, so the lists read from the server rather
than from `localStorage`.

It belongs here rather than later. Both list pages read the browser's local
registry today. Once drafts and boards are private and tied to an account,
signing in on a second device shows an **empty dashboard** while your drafts
sit on the server perfectly intact. That is not a subtle degradation; it is
the central promise of having an account, broken on the first phone.

So this project includes the GSI and the two `/me` list routes, and the
dashboard and both list pages read the server when signed in.

### What this costs: the claim feature, deleted

Phase 2 shipped `POST /me/claim` so a browser could adopt the drafts and
boards it made before accounts existed. This project makes that unreachable:
the unowned rows are deleted, and every new draft and board is owned at birth
by a signed-in caller. No code path can produce an unowned resource again.

`backend/src/me.js`'s claim route, `frontend/src/lib/claim.js`,
`useClaimOnSignIn.js` and `ClaimOnSignIn.jsx` are therefore deleted rather
than carried. `me.js` survives as the home of the two new `/me` list routes.

Deleting a feature shipped the same day is worth saying out loud rather than
doing quietly. It was correct for the world it shipped into; this project
ends that world on purpose.

---

## What changes

### Access

**Drafts** gain `seats`, alongside the `ownerId` they already have:

```js
seats: [
  { team: 1, sub: "a1b2c3...", kind: "human" },
  { team: 2, sub: null,        kind: "bot"   },
  { team: 3, sub: null,        kind: "bot"   },
  // ... one entry per team
]
```

`ownerId` stays and means *who created this*. `seats` means *who may see and
act in it*. Today the creator holds exactly one seat and bots hold the rest.

- **Read or act in a draft:** you must hold a `kind: "human"` seat whose
  `sub` is yours.
- **Delete a draft:** you must be the `ownerId`.

**Boards** keep `ownerId` and gain nothing. Read and write both require
being that owner.

### Routes

| Route | Before | After |
|---|---|---|
| `GET /drafts/{draftId}` | public | authorizer + seat check |
| `GET /boards/{boardId}` | public | authorizer + owner check |
| `GET /me/drafts` | — | new, authorizer, drafts you are seated in |
| `GET /me/boards` | — | new, authorizer, boards you own |
| `POST /me/claim` | exists | deleted |
| `GET /players`, `GET /players/{playerId}` | public | unchanged |
| every mutating route | authorizer | unchanged |

A caller who is not seated gets **404**, byte-identical to a genuine miss,
exactly as the mutating routes already do. That rule now covers reads too.

### `template.test.js` must be tightened, not loosened

The route test currently asserts *no read route carries an authorizer*. Two
reads are about to, deliberately, and the lazy fix — deleting the assertion —
would remove the guard that catches a read being gated by accident.

It becomes an explicit two-list assertion instead: `GET /drafts/{draftId}`
and `GET /boards/{boardId}` **must** carry `CognitoAuth`; `GET /players` and
`GET /players/{playerId}` **must not**. A route moving between those lists
then fails the test in both directions.

### Cross-device lists

A GSI on `ownerId` for each table, and `GET /me/drafts` / `GET /me/boards`
query it.

**Listing is by `ownerId`, while access is by seat, and those agree only
because there is exactly one human seat today.** DynamoDB cannot index inside
a list of objects, and a GSI key must be a scalar — so `seats` is not
directly queryable, and a denormalised set attribute would not be indexable
either. Owning the draft and being the only person seated in it are the same
condition right now, so the `ownerId` index answers "my drafts" exactly.

That equivalence is what invitations break, and it is a known cost handed to
Project 2: the moment a draft has two human seats, listing "drafts I am in"
needs a membership index — one row per person per draft, keyed by `sub` —
which is a table-design decision that belongs with the feature that needs it.
Access control does **not** have this problem; the seat check reads the draft
it already fetched.

Both list pages and the dashboard read the server when signed in, and the
local registries are deleted along with the claim code — they exist to answer
"what did this browser make", which the server now answers better.

### The frontend

- **`RequireAuth`** wraps the gated routes. Signed out, it renders a sign-in
  prompt **in place** — not a redirect — and `signIn` already carries a
  `returnTo`, so you land where you were going.
- **`/` splits.** `Landing.jsx` signed out, `Dashboard.jsx` signed in.
  `Home.jsx` is replaced by the two.
- **The nav**, signed out, shows the brand and Sign in only. Links to pages
  that would immediately ask you to sign in are noise.
- **The dashboard**: drafts you can resume, your boards, and New draft.
- **The landing page**: hero on the board editor — *Draft off your board, not
  theirs* — with Sign in with Google as the single call to action, and three
  sections below it, each pointing at something that exists: build the board,
  draft off it, see where the consensus disagrees. **No invented
  testimonials, usage numbers, or logos.**

### Data cleanup

A one-off script scans both tables, writes every unowned row to a timestamped
JSON file outside the repository, and then deletes them. It runs once,
against production, before the read gate ships — after it ships those rows
are unreachable and the dump is the only way back.

---

## Risk

**This is a smaller security change than Phase 2 and a much larger UX
change.** The authorization model is already built and reviewed; this widens
it to two read routes and swaps a scalar check for a list membership check.
The risk sits in the blast radius instead.

- **Every route in the app becomes unreachable to a signed-out visitor.** A
  bug in `RequireAuth` locks out signed-in users too, and the failure mode is
  a blank app rather than a visible error.
- **The seat check replaces the owner check on five routes at once**
  (`GET`, `/pick`, `/auto-pick`, `/sim-to-end`). Each is tested from three
  angles as in Phase 2: seated (allowed), signed in but not seated (404), no
  claims (401). Delete adds a fourth: seated but not the owner (404).
- **Listing and access use different keys** — `ownerId` for the index, seats
  for the check. They agree only while a draft has one human seat. A test
  asserts that invariant directly, so the day it stops being true it fails
  here rather than silently listing drafts you cannot open.
- **The purge is irreversible.** The dump happens first, is verified
  non-empty and parseable, and is kept outside the repo.

## Testing

The e2e suite is the large piece of work. Most of the 180 specs navigate
straight to `/draft/:id` while signed out, which stops being reachable. Each
gains `signIn` from the existing helper — the same churn as the Phase 2 pass,
wider. Specs asserting the signed-out app works keep doing so, but against
the landing page instead of the draft board.

Backend unit tests supply the authorizer's claims directly in the `event`, as
before. The seat check gets its own unit tests against a table of seat
arrangements, including a draft where you were seated and then were not.

New Playwright coverage: a signed-out visitor sees the landing page and no
app nav; a gated URL prompts in place and returns you there after sign-in;
the dashboard lists what the server returns rather than what `localStorage`
remembers.

## Out of Scope

- **Invitations and multiplayer drafting.** The next project. This one only
  makes it possible.
- **Board export and import.** Wanted, but later, and it needs its own
  decisions about format and what an imported board collides with.
- **Locking down `GET /players`.** It is reference data.
- **Any change to the draft engine, clock, or Sim to End.** Those questions
  belong to multiplayer, where they get hard.
