# A read-only link to a finished mock

`/draft/:id/results` sits behind `RequireAuth` and is seat-gated, so a finished
mock cannot be shown to anybody who was not in it — which is exactly the moment
people want to show someone.

This adds a share link. It is the app's **first anonymous read path**, and that
is the whole reason this document is longer than the feature.

## The finding that decides the architecture

`GET /drafts/{draftId}` returns, among ~20 fields:

    inviteToken: d.inviteToken,

`inviteToken` is the credential `POST /drafts/{draftId}/join` checks to grant a
seat. **If a share link reused that endpoint, anyone holding a read-only results
link could join the draft.** Read-only becomes participant.

The same projection also carries `pausedBy`, which `/pause` sets to `:me` — the
caller's Cognito sub — and `yourTeam` / `yourBoardId` / `yourQueue`, all derived
from the authenticated caller.

So the share path does not reuse that endpoint, and `shareToken` is a **separate
field from `inviteToken`**. One grants reading, the other grants joining.
Conflating them is the bug this design exists to prevent, and the field's
definition says so in a comment.

## What a stranger receives

`Results.jsx` reads exactly `draft.format`, `draft.picks`, `draft.rounds` and
`draft.teams`; `analyzeDraft` additionally reads `draft.rosterSlots`. That is
the entire data requirement of the page.

The shared projection is therefore exactly those five fields:

    { format, teams, rounds, rosterSlots, picks }

Not `seats`, not `version`, not the clock fields, not `inviteToken`, not
`pausedBy`, not anything derived from a caller. The projection is built from
what the page reads, never by subtracting from what the authenticated endpoint
happens to return — subtraction is how the next field added upstream leaks.

`picks` already contains player objects and team numbers, which is what a
results page is. It carries no Cognito subs.

## Routes

**`GET /drafts/{draftId}/shared?t=<token>`** — public, no authorizer. Returns
the five-field projection, or 404.

**`POST /drafts/{draftId}/share`** — authenticated, owner-only. Mints a
`shareToken` if absent, stores it, returns `{ shareToken }`. Idempotent: calling
it twice returns the same token rather than rotating it, so a second click does
not silently break a link already sent.

The token is `randomUUID()`, the same generator `inviteToken` uses — a
different value space would invite the question of why, and there is no reason
for one.

**`DELETE /drafts/{draftId}/share`** — authenticated, owner-only. Removes the
field. The old link 404s immediately.

Both mutations refuse a draft that is not `completed`.

"Owner-only" means the existing `canMutate(item, sub)` from
`backend/src/lib/owner.js` — the same predicate `DELETE /drafts/{draftId}`
already uses, which that route applies as a DynamoDB `ConditionExpression` so
there is no window between checking ownership and acting on it. These mutations
follow the established pattern rather than introducing a second notion of
ownership.

### The asymmetry is deliberate

Reading is anonymous; *managing* sharing is authenticated and owner-only. Every
mutating route in this app carries the Cognito authorizer and that does not
change. Only one new route is public, and `template.test.js` asserts the exact
set of public routes with `deepStrictEqual` — so adding it forces a deliberate
edit to `PUBLIC_READS` rather than letting a route become public by omission.

## Decisions

### Minted on demand, and revocable

No `shareToken` exists until someone clicks Share. Every draft that exists today
stays exactly as private as it is now until an owner acts.

A credential nobody asked for is a credential nobody is watching. Minting one
for every draft at creation would make every mock anyone has ever run reachable
by whoever learns a token, whether or not sharing was ever intended.

Revocation matters because a share link has no expiry and no audience control:
once sent, it is wherever it was forwarded. Invalidating it is the only way to
take it back.

### Completed drafts only

The feature is "show someone your finished mock". Both mutations check
`completed === true`.

A link to a live draft would let a stranger poll its state, and the results page
for an unfinished draft is mostly empty rows. Refusing it removes a class of
question rather than answering it.

### A bad token is indistinguishable from a missing draft

Wrong token, revoked token, draft that never existed, draft that exists but was
never shared — **all four return 404**, with the same body.

This follows the rule `/join` already states: *"A wrong token and a missing
draft answer identically, so guessing an id learns nothing about whether it
exists."* A 403 on a real-but-wrong token would confirm the draft exists.

## Testing

### The four 404s get four tests, not one test with four assertions

Every one of these must be its own case:

1. draft does not exist
2. draft exists, has no `shareToken` (never shared)
3. draft exists, has a `shareToken`, caller presents the wrong one
4. draft exists, had a `shareToken`, it was revoked

A single test covering all four would pass against an implementation that 404s
for one reason and leaks for another. **This project has already shipped a test
that passed through a router's catch-all 404 and proved nothing about the clause
it named**; that is the specific failure this structure prevents. Each test must
be confirmed to fail for its own reason before the route exists.

### The projection is asserted as a field set, not spot-checked

One test asserts the shared response's keys are **exactly**
`["format", "picks", "rosterSlots", "rounds", "teams"]` — a `deepStrictEqual` on
the sorted key list, not `assert.ok(!body.inviteToken)`.

A spot check confirms today's known leaks are absent. A field-set assertion
fails when a *future* field is added to the shared projection, which is the leak
nobody is looking for. This is the most valuable test in the feature.

### The rest

- Both mutations are owner-only: a seated non-owner gets 404, matching how
  delete already behaves.
- Both mutations refuse an incomplete draft.
- `POST` twice returns the same token rather than rotating it.
- `DELETE` then `GET` with the old token returns 404.
- Frontend: `/shared/:draftId` renders without authentication, and shows no
  control that implies participation.

## The frontend

A genuinely public route, `/shared/:draftId`, registered **outside**
`RequireAuth`, reading the token from `?t=`. `apiGet` already attaches
`Authorization` only when a token exists, so no client change is needed.

It renders the same results content in a reduced mode: no *Copy invite link*, no
export. `/draft/:id/results` is unchanged for a seated user.

The Share control appears on the results page for a completed draft the caller
owns, showing the link and a way to revoke it.

## Out of scope

- **Expiring links.** Revocation covers the realistic case; a TTL adds a clock
  and a "why did my link stop working" question.
- **Analytics on views.** Knowing who opened a link means recording who opened a
  link, which is a privacy surface this feature does not need.
- **Sharing anything other than results.** No shared big boards, no shared live
  drafts.
- **A prettier public page.** The shared view reuses the existing results
  rendering. Designing a separate marketing-quality page is a different task.
