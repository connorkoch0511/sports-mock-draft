# Accounts and Cross-Device History

**Date:** 2026-09-03
**Status:** Draft — awaiting approval
**Scope:** Cognito + Google sign-in, ownership enforcement, cross-device
history. Three phases, each shippable on its own.

---

## Summary

Sign in with Google. Your drafts and boards get your name on them, follow you
to any device, and can only be changed by you.

---

## Motivation

There is no authorization in the API today. `DELETE /drafts/{id}` and
`DELETE /boards/{id}` delete by id with no ownership check, and
`PUT /boards/{id}` checks only a version number. The `owned` flag added on
2026-09-02 gates the *button*, not the endpoint.

Ids are `randomUUID()` — 122 bits, not guessable — so the real model is
**"anyone with the link has full write and delete."** That is defensible for
viewing and indefensible for sharing: sending someone a draft link currently
hands them the ability to destroy it.

Accounts are what close that. Cross-device history is the part you feel; the
authorization fix is the part that matters.

---

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Identity | Cognito user pool, Google as the only identity provider | API Gateway HTTP API verifies Cognito JWTs natively, so no token verification code is written or maintained here. No password ever touches this system. |
| Sign-in required to create | Yes | Chosen deliberately: every draft and board has an owner from birth, so there is one ownership rule and no legacy path. |
| Viewing | Stays public | Sharing is an existing feature. A link recipient must still be able to read a draft; they simply cannot change it. |
| Existing anonymous data | Claimed on first sign-in | Both registries already record only what this browser *created*. |

### The cost of requiring sign-in, stated plainly

Drafts and boards created before this ships have no owner. Once mutations
require ownership they become **readable but frozen** until claimed. Somebody
mid-draft who never signs in cannot finish that draft.

This is the direct consequence of the chosen model and is worth knowing before
it ships rather than after. Nothing is deleted and no link 404s.

---

## Phase 1 — Identity

Cognito user pool, Google federation, hosted sign-in, and a signed-in state in
the app. **No behaviour changes yet**: nothing is owned, nothing is enforced.

- `AWS::Cognito::UserPool`, `UserPoolClient`, `UserPoolDomain`, and a Google
  `UserPoolIdentityProvider` in `template.yaml`.
- **The Google client secret must not live in the template.** It is a
  `NoEcho` parameter sourced from SSM Parameter Store; the template references
  it, and the value never enters git.
- Frontend: sign in / sign out, the current user in the nav, tokens held in
  memory with a refresh token in `localStorage`.
- Every API call attaches `Authorization: Bearer <idToken>` when signed in.
  Nothing rejects it yet, so this is inert and testable on its own.

**Manual prerequisite, and it blocks deploy:** a Google Cloud project with an
OAuth 2.0 client, its consent screen configured, and the Cognito domain
registered as an authorized redirect URI. Only the account owner can do this.

**Shippable because:** you can sign in and see who you are. Nothing else moves.

## Phase 2 — Ownership

- `ownerId` written on create, from `event.requestContext.authorizer.jwt.claims.sub`.
- The JWT authorizer is attached to every mutating route: `POST /drafts`,
  `POST /boards`, `POST /drafts/{id}/pick`, `/auto-pick`, `/sim-to-end`,
  `PUT /boards/{id}`, `DELETE` on both.
- `GET /drafts/{id}`, `GET /boards/{id}`, and everything under `/players`
  stay unauthenticated.
- Handlers compare `sub` to the stored `ownerId` and return **404, not 403**,
  for a resource owned by somebody else. A 403 confirms the id exists, which
  is exactly what an id-guessing probe wants.
- **Claim:** `POST /me/claim` takes ids the browser says it created. Each is a
  conditional write — `SET ownerId = :me IF attribute_not_exists(ownerId)` — so
  the first claimant wins and an already-owned resource cannot be stolen. Only
  ids the local registries marked as created are sent, never every id the
  browser has seen.

**Shippable because:** your drafts become yours and shared links become
read-only.

## Phase 3 — Cross-device history

- A GSI on `ownerId` for both tables.
- `GET /me/drafts` and `GET /me/boards`, authenticated, returning what you own.
- My Drafts and My Boards read the server when signed in and fall back to the
  local registries otherwise, so the pages work identically either way.

**Shippable because:** your drafts appear on your phone.

---

## Risk

**This is the highest-risk work in the project.** An authorization mistake is a
vulnerability, not a bug, and unlike every other change here it cannot be
detected by the app looking correct.

- **Every protected route is tested from three angles**: the owner (allowed),
  a different signed-in user (404), and no token at all (401). Testing only
  the happy path is how an unprotected route ships green.
- **A route added without an authorizer is the likely failure**, so a test
  enumerates the routes in `template.yaml` and asserts every mutating one
  carries the authorizer. A human will forget; a list will not.
- The claim endpoint is tested for the theft case specifically: claiming an
  already-owned resource must change nothing and report that it changed
  nothing.

## Testing

Cognito cannot be run locally, so unit tests supply the authorizer's claims
directly in the `event` — that is exactly the shape API Gateway passes, and it
is the boundary this code actually depends on. Playwright mocks sign-in state
rather than driving Google.

## Out of Scope

- ESPN and Yahoo import. They depend on accounts; they are not this.
- Merging two accounts, or changing which Google account owns a draft.
- Team or league sharing with per-user permissions. Sharing stays "anyone with
  the link can read".
- Email/password sign-in.
