# A pick length per draft

**Status:** approved design, not yet implemented
**Depends on:** the shared clock (`2026-09-09-shared-clock-design.md`) and the unattended clock (`2026-09-10-unattended-clock-design.md`), both merged and deployed.

## Problem

Every draft gets sixty seconds a pick, because `PICK_SECONDS = 60` is a
constant in `backend/src/lib/advance.js`. Real leagues do not agree on that:
some run thirty-second drafts, some give two minutes, some run slow drafts
measured in hours. A drafter importing a Sleeper league brings across teams,
rounds, scoring, roster slots and their draft slot — and then silently loses
the one setting that governs how the draft actually feels to sit through.

The constant reaches production in exactly three places, which is what makes
this small: the initial deadline at creation (`drafts.js:143`), every later
deadline inside `advanceDraft` (`advance.js:58`), and a pre-load display
fallback on the draft page (`Draft.jsx:16`).

## Decisions

1. **Set once, when the draft is created.** Not editable mid-draft and not
   per seat. It joins teams, rounds and scoring as a league setting, which is
   how people already think about it, and it means no code ever has to decide
   what a length change does to a deadline that is already ticking.
2. **Every draft is timed.** There is no "no clock" option.
3. **The control offers presets**, not a free-form number: 30 seconds, 1
   minute, 90 seconds, 2 minutes, 5 minutes, 10 minutes, 30 minutes, 1 hour,
   2 hours, 4 hours, 8 hours, 12 hours, 24 hours. One minute is the default,
   so a draft created without touching the field behaves exactly as every
   draft does today. The longer presets exist for the same reason the range
   goes to a full day (see the API contract below): Sleeper's own "slow
   draft" leagues run pick timers of two to twenty-four hours, and without
   these an import from one would land on a lone "from your league" entry
   instead of a selectable option.
4. **A Sleeper import carries the league's real timer across**, including
   values that are not on the preset list.
5. **An imported value that is not a preset is offered as its own option**
   rather than snapped to the nearest one. Silently rewriting a setting the
   user just imported would defeat the point of importing it.

### The consequence of decision 2, and why it is smaller than it looks

Now that the clock runs unattended, an untimed option would have been the
escape hatch for a slow draft among friends: without one, a multi-day draft
gets picked for while everyone is asleep.

**Pause already is that escape hatch.** Pausing removes `clockRunning` from
the draft, which takes it out of the scheduler's sparse index entirely — a
paused draft is not enforced by anything, for as long as it stays paused.
Anyone seated may pause. So the async case has an answer today; it is a
manual one, and it is worth knowing about rather than discovering.

## Data model

One new field on the draft item:

```
pickSeconds: number   // written at creation; absent on every draft made before this
```

**No migration.** Unlike `clockRunning`, a missing `pickSeconds` has a
correct meaning: sixty seconds, which is what those drafts have always had.
Every read falls back, so existing drafts keep behaving exactly as they do
now and no backfill script is needed.

## Threading the value through

`advanceDraft` already receives the whole `draft` object. It reads the length
from there instead of importing the constant:

```js
const seconds = draft.pickSeconds ?? PICK_SECONDS;
const deadline = (deadlineBase ?? now) + seconds * 1000;
```

That single change gives the per-draft length to **every** caller with no
signature change and no caller edits: `/pick`, `/auto-pick`, `/expire`,
sim-to-end and the scheduled clock all move together. The scheduler's
catch-up is correct for free as well, because it advances in units of
whatever `advanceDraft` writes — a thirty-second draft catches up in
thirty-second slots.

`PICK_SECONDS` stays exported and keeps its job: it is now the default rather
than the rule, and the frontend keeps it as a pre-load display fallback.

Creation (`drafts.js:143`) writes `Date.now() + pickSeconds * 1000` and
stores `pickSeconds` on the item.

## The API contract

`POST /drafts` accepts an optional `pickSeconds`.

**Validation is a range, not the preset list.** The client offers presets
plus, after an import, one arbitrary value from the user's league — so
membership of a fixed set is the wrong check. The server requires an integer
between **30 and 86400** inclusive and rejects anything else with a 400. The
presets are a UI affordance; the range is the contract, and the server does
not trust the client for either.

The floor is 30, not 15: 30 is already the shortest preset the UI offers, so
raising the floor to it does not make any existing option unreachable. And
the slop already built into how the clock is enforced -- a per-seat `/expire`
stagger of up to 2.75 seconds (see `expireDelayMs`), and, for a draft with no
browser open, the scheduler's own one-minute tick -- is a larger fraction of
a 15-second slot than anyone would want it to be.

The ceiling is a full day, not an hour: Sleeper's "slow draft" leagues run
pick timers from two to twenty-four hours (`pick_timer` 7200-86400), and the
original 3600-second ceiling rejected every one of them. Importing such a
league produced a form that could not be submitted, with a raw server error
and nothing in it pointing at the pick-length field as the culprit — the
range needed to cover what real leagues actually do, not just what this
app's own presets happened to offer at first.

A missing or absent value defaults to 60 rather than erroring, so an older
client, or a caller that does not care, keeps working.

`GET /drafts/{draftId}` returns `pickSeconds` so the page can render the
right fallback before the first deadline arrives.

## Frontend

**New Draft** gains a select beside the other league settings, with the
thirteen presets and 1 minute selected by default. Its value is sent on
create.

**The draft page** replaces its hard-coded `const PICK_SECONDS = 60` with the
value from the draft response, keeping 60 as the fallback for the moment
before the draft has loaded. Nothing else changes: the countdown already
renders from the server's deadline and evaluates nothing itself.

## The Sleeper import

Sleeper's pick timer lives at `settings.pick_timer` on the **draft** object,
which `frontend/src/lib/sleeper.js` already fetches for `rounds` and
`draft_order` — so no extra request is needed.

- Missing, or `0` (Sleeper's own "no timer"), leaves the default of 1 minute,
  since decision 2 says every draft here is timed.
- A value matching a preset selects that preset.
- Any other value is added to the select as its own option, labelled so its
  origin is obvious (for example "45s · from your league", using the same
  `formatCountdown` the draft page's clock renders with, rather than raw
  seconds), and selected. It is sent as-is, and the server's range check
  still applies — though with the range now 30-86400, no timer Sleeper offers
  as a preset, including a slow draft's, falls outside it, so tripping this
  check on import is now the rare case rather than the common one. It is not
  the impossible case: nothing here validates an imported value before
  submit, so a league with some other, out-of-range `pick_timer` still reaches
  the server and comes back as a submit-time 400 in the generic error banner,
  naming the field but not pre-empting the trip. Closing that properly means
  validating at import time, which this branch does not do.

## Testing

- **The fallback is the whole migration story.** A draft item with no
  `pickSeconds` must still produce a 60-second deadline. Mutation-test it:
  remove the `?? PICK_SECONDS` and that test must go red. A test that passes
  without the fallback is testing nothing.
- A draft created with `pickSeconds: 30` gets a deadline 30 seconds out, and
  its next deadline after a pick is 30 seconds beyond the last one — not 60.
- The scheduler's drain advances a 30-second draft in 30-second slots.
- Validation: 29 and 86401 are refused; 30, 60 and 86400 are accepted; a
  non-integer and a missing value behave as specified. Mutation-test the
  range guard.
- `GET /drafts/{draftId}` includes `pickSeconds`.
- Frontend unit: the Sleeper mapper reads `pick_timer`, treats `0` and a
  missing value as "leave the default", and passes anything else through.
- Playwright: the select's value reaches the create call; an imported league
  with a 45-second timer shows a custom option selected; a league with no
  timer leaves 1 minute selected.
- Regenerate `screenshots/newdraft.png`.

## Out of scope

- Changing the length mid-draft, and per-seat lengths. Both were considered
  and deferred; decision 1 is what keeps this change small.
- An untimed option. See decision 2 and the pause note above.
- Carrying a pick timer across from Yahoo. That import is switched off in
  production and blocked on API entitlement.
- Any change to pause, to the scheduler, or to how the deadline is enforced.
