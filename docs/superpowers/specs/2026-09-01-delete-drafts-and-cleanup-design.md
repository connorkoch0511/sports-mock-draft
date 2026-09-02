# Delete Drafts, Board Pagination Coverage, and a Cosmetic Sweep

**Date:** 2026-09-01
**Status:** Approved, ready for implementation planning
**Scope:** Backend + frontend + docs. Requires a SAM template change and a **backend deploy**.

---

## Summary

Make removing a draft actually possible, cover the one pagination loop still untested,
and clear the small papercuts that have accumulated.

---

## Motivation

### 1. Forget cannot delete, because nothing can

The My Drafts page has a **Forget** control that removes a draft from your local list only.
It is labelled honestly, because there is no `DELETE /drafts/:id` — verified: `drafts.js`
contains no DELETE branch and `template.yaml` registers no DELETE route for it. `boards.js`
has both.

So a draft cannot be removed. It sits in DynamoDB forever, reachable by anyone holding its
link.

**Why this is not simply "make Forget delete."** `Results.jsx` has a **Copy Share Link**
button — sharing a completed draft is an explicit feature. If Forget deleted server-side,
one click would break a link someone else is holding, and they would get a bare 404 with no
explanation. Boards can conflate the two actions because boards are private working
documents; a finished draft is something you hand to other people.

So the two actions stay separate: **Forget** removes it from your list, **Delete** removes
it from the world.

`DraftsFunction` already carries `DynamoDBCrudPolicy` on the drafts table, so no permission
change is needed — only the route and the handler branch.

### 2. `boards.js` has no pagination test

A DynamoDB Query page caps at 1MB. `boards.js` pages through
`ExclusiveStartKey`/`LastEvaluatedKey` and carries the comment explaining why. `players.js`
and `drafts.js` were given the same loop and both got tests proving the cursor is threaded.

`boards.js` — the original, the one the other two were copied from — has none. Verified: no
occurrence of either key in `boards.test.js`.

### 3. Accumulated papercuts

- `relativeTime` in `MyDrafts.jsx` rounds rather than floors. **90 minutes renders "2h ago"**,
  and worse, **23.5 hours renders "1d ago"** for a draft from earlier the same day. (45
  minutes is unaffected — it returns from the minutes branch before any hour rounding
  happens, so it correctly reads "45m ago".)
- The Forget button's `aria-label` is `Forget draft {id}`, which reads a raw UUID to a
  screen reader. `Boards.jsx` uses the board's name.
- `/drafts` has no screenshot test, while Home, Draft, and Results do, and the README
  documents the app through those images.
- The README's Project Structure section lists none of `Boards.jsx`, `NewDraft.jsx`,
  `MyDrafts.jsx`, `boardRegistry.js`, or `draftRegistry.js`.
- Six ESLint errors, unchanged all session. Three are `'process' is not defined` in
  `playwright.config.js` — a Node file linted with browser globals. One is
  `react-hooks/rules-of-hooks` on `useLeague` in `NewDraft.jsx`, which is a **false
  positive**: `useLeague` is a plain async event handler, flagged only because of its `use`
  prefix. The name is genuinely misleading — it reads as a hook and is not one.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Delete semantics | Idempotent — deleting an absent draft returns 200 | Mirrors `boards.js`. A resolved call always means it is safe to drop locally |
| Forget vs Delete | Two separate controls | Sharing is an explicit feature; one careless click must not break someone else's link |
| Delete confirmation | Required before the call | Irreversible and affects other people. The only destructive action in the app |
| Ordering | Server first, then local | Copies `Boards.jsx`: on failure the row stays listed so the user can retry rather than losing their way back |
| `relativeTime` | Floor, not round | "2h ago" at 90 minutes, and "1d ago" at 23.5 hours, are both simply wrong |
| The two `setState`-in-effect lint errors | **Left alone** | Fixing them changes render behavior. That belongs in its own reviewed change, not a cosmetic sweep |

---

## Architecture

### `backend/src/drafts.js` — the DELETE branch

Added alongside the existing routes, using the same shape as `boards.js`:

```js
if (method === "DELETE" && draftId) {
  await ddb.send(new DeleteCommand({ TableName: draftsTable, Key: { draftId } }));
  return json(200, { ok: true });
}
```

`DeleteCommand` must be added to the existing `@aws-sdk/lib-dynamodb` require. The branch
sits before the catch-all 404 and after the existing `POST /drafts/{id}/...` branches, so it
cannot shadow them.

### `backend/template.yaml` — the route

One `HttpApi` event on `DraftsFunction`, `Path: /drafts/{draftId}`, `Method: DELETE`,
matching the shape of `BoardsFunction`'s delete event. No policy change: `DynamoDBCrudPolicy`
already covers `DeleteItem`.

### `backend/src/boards.test.js` — pagination coverage

Using the stubbing pattern established in `players.test.js`: `mock.method` on
`DynamoDBDocumentClient.prototype.send`, with `mock.restoreAll()` in an `afterEach`.

Two cases, matching what the other two handlers already prove: a two-page response yields
players from both pages, and the second call carries the first page's `LastEvaluatedKey` as
its `ExclusiveStartKey`. The second is the one that matters — without it, a loop that
re-fetches page one forever still passes.

### `frontend/src/pages/MyDrafts.jsx`

- A **Delete** control per row, beside Forget. It confirms, calls `apiDelete`, and only on
  success calls `forgetDraft` and re-reads the list. A failure surfaces a message and leaves
  the row listed.
- `relativeTime` uses `Math.floor` for the minute, hour, and day steps.
- Both controls' `aria-labels` describe the draft — format, team count — rather than its id.

### `frontend/tests/mydrafts.spec.js`

Delete's happy path, its confirmation, and the failure path where the row survives a
server error. Plus the `/drafts` screenshot.

### `frontend/src/pages/NewDraft.jsx`

`useLeague` → `applyLeague`, at its definition and its single call site.

### `frontend/eslint.config.js`

A Node-globals override for `playwright.config.js`, so `process` resolves.

### `README.md`

Project Structure updated to match the tree as it actually is.

---

## Risk

**Delete is the only irreversible action in the app**, and it acts on data other people may
hold links to. Three things bound that:

1. It is a distinct control from Forget, not a rename of it.
2. It confirms before acting.
3. It is idempotent, so a retry after a network failure cannot error.

The backend deploy is the other risk. `drafts.js` is the busiest handler; this adds a branch
rather than modifying existing ones, and the characterization tests written earlier cover
every existing response. A post-deploy check exercises the full draft lifecycle, not just
the new endpoint.

The lint and README changes carry no runtime risk. The `applyLeague` rename touches two
lines in one file.

---

## Testing

### Unit — `backend/src/drafts.test.js` (extend)

- `DELETE /drafts/:id` returns 200 and `{ ok: true }`
- It issues a `DeleteCommand` against the drafts table with the right key
- Deleting an absent draft still returns 200 — idempotence is what makes the frontend's
  ordering safe
- `DELETE` without a draftId falls through to the catch-all 404
- The existing responses are unchanged

### Unit — `backend/src/boards.test.js` (extend)

- A two-page pool query returns players from both pages
- The second query carries the first page's `LastEvaluatedKey` as `ExclusiveStartKey`

### End-to-end — `frontend/tests/mydrafts.spec.js` (extend)

- Delete calls `DELETE /drafts/:id` and removes the row
- Dismissing the confirmation makes no request and leaves the row
- A server error leaves the row listed and shows a message
- Forget still makes **no** network request — the two actions must not converge
- A `/drafts` screenshot is captured

### Existing suites

100 backend unit, 58 frontend unit, 94 Playwright. All must still pass.

### Post-deploy

Create a draft, delete it, confirm a subsequent `GET` returns 404, and confirm a second
delete still returns 200. Then run a full draft — create, pick, auto-pick, sim to
completion — to prove the new branch did not disturb the existing ones.

---

## Out of Scope

- **The two `setState`-in-effect lint errors.** They change render behavior; separate work.
- **Deleting a board from the My Drafts page**, or any cascade between drafts and boards.
- **Undo.** Delete is confirmed and final; a trash state is a larger feature.
- **Cross-device history.** That is the user-accounts project, not a papercut.
- **The known cosmetic items on the draft page** — duplicate rank ordinals on a
  cross-format board, the zero-row board notice, and a zero rounds value. Tracked, shipped
  deliberately, unchanged here.
