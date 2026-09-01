# My Drafts Registry

**Date:** 2026-09-01
**Status:** Approved, ready for implementation planning
**Scope:** Frontend only — no backend, no schema, no Lambda deploy

---

## Summary

A local record of every mock draft you start or open, so a draft is no longer lost the
moment you lose its link.

---

## Motivation

A draft's only identity is its UUID, handed out once by `POST /drafts` and used to build a
URL. Close the tab and it is gone: there is no list, no history, and no way back. The app
already solved this for boards — `boardRegistry.js` keeps a local list and `/boards`
renders it — but drafts, which take longer to produce and are the app's actual output,
have nothing.

This is more visible now that drafts are the thing worth keeping. A completed 15-round
mock is a result you would want to compare against later; today it evaporates.

Two decisions frame the work:

- The page serves **both** in-progress and completed drafts, with results emphasized. An
  interrupted draft must be resumable — that is the reported problem — but a finished one
  is the artifact worth revisiting.
- It records **drafts you open as well as drafts you create**, so a link someone shared
  with you is reachable later without you having saved the URL yourself.

There are no user accounts, so there is no owner to key a server-side list on. Local
storage is the only option that does not require building auth first, and it is the
pattern already established for boards.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Storage | `localStorage`, key `perfectpick.myDrafts`, capped at 50 | Mirrors `boardRegistry.js` exactly. No accounts exist to key a server list on |
| Where the write happens | One `useRememberDraft(draft)` hook, in `Draft.jsx` and `Results.jsx` | Creating a draft immediately navigates to `/draft/:id`, so recording on load covers creation, shared links, and revisits with a single code path |
| What is recorded | Fields from the **fetched** draft, not the create request | The fetched object is server truth. A draft you opened by link records identically to one you started |
| Board identity | Store `boardId`; resolve the name at render from `boardRegistry` | The draft object has no board name, and `Results.jsx` never fetches the board. Resolving late keeps one source of truth and survives a rename |
| When it writes | Only when `draftId` or `completed` changes | A sim-to-end updates draft state on every pick; writing each time would hammer storage for no gain |
| Removal | "Forget" — local only | There is no `DELETE /drafts` endpoint. The label must not imply a deletion that is not happening |
| Placement | Its own `/drafts` page and nav item | Consistent with the existing decision not to pile everything onto Home |

---

## Architecture

### `frontend/src/lib/draftRegistry.js` — new

Mirrors `boardRegistry.js` in shape, naming, and error handling.

```
listDrafts()            -> entry[]      most-recent-first
rememberDraft(entry)    -> void         upsert by id, moves to front, caps at 50
forgetDraft(id)         -> void         local removal only
```

Entry shape:

```js
{
  id,          // draftId
  teams,       // number
  rounds,      // number
  format,      // "standard" | "half-ppr" | "ppr"
  userTeam,    // the slot you drafted from
  boardId,     // string or null — the board driving the draft, if any
  completed,   // boolean
  updatedAt,   // epoch ms
}
```

Every access is wrapped in try/catch. A corrupt or unavailable store yields `[]` from
`listDrafts()` and a silent no-op from the writers, matching `boardRegistry`'s comment
that the underlying object still exists server-side and stays reachable by link.

### `frontend/src/lib/useRememberDraft.js` — new

```js
useRememberDraft(draft)
```

An effect keyed on `[draft?.draftId, draft?.completed]`. When it fires with a draft
present, it calls `rememberDraft` with that draft's fields. A `null` or partial draft is
ignored, so the hook is safe to call unconditionally before the fetch resolves.

`Draft.jsx` and `Results.jsx` each call it once. **No change to `NewDraft.jsx`** — it
navigates to `/draft/:id`, where the hook records the draft from server data a moment
later. Recording the create request instead would risk drifting from what the server
actually stored.

### `frontend/src/pages/MyDrafts.jsx` — new

Route `/drafts`. Renders `listDrafts()`.

Each row shows format, `teams × rounds`, the slot drafted from, the driving board when
present, and a relative timestamp.

The entry stores `boardId`, not a board name. The fetched draft carries only `boardId` —
`Draft.jsx` resolves the name through a second `GET /boards/:id`, and `Results.jsx` never
fetches the board at all, so a name is simply not available at both of the hook's call
sites. Instead `MyDrafts.jsx` resolves the name at render time from `listBoards()` in
`boardRegistry.js`. That keeps one source of truth for board names, cannot drift when a
board is renamed, and degrades honestly: a board that is not in your local registry shows
as a generic "custom board" rather than a stale or invented name. Rows carry a status: in-progress rows link to
`/draft/:id`, completed rows link to `/draft/:id/results`. Each row has a **Forget**
control.

Empty state mirrors the one on `/boards`.

### `frontend/src/components/NavBar.jsx` — modified

One link added: `{ to: "/drafts", label: "My Drafts" }`, placed after "New Draft".

### `frontend/src/App.jsx` — modified

One route: `<Route path="/drafts" element={<MyDrafts />} />`.

Note this sits alongside the existing `/draft/:draftId`. The paths differ (`drafts` vs
`draft`), so there is no conflict, but the similarity is worth care when reading the
route table.

---

## Risk

Low. The change is additive: a new module, a new hook, a new page, one nav entry, one
route. Nothing existing changes behavior except that `Draft.jsx` and `Results.jsx` each
gain a hook call.

The one real hazard is the hook firing too often. `Draft.jsx` re-renders on every pick
during a sim; an effect keyed on the whole draft object would write to `localStorage`
hundreds of times in seconds. Keying on `[draftId, completed]` is what prevents that, and
it is worth a test rather than an assumption.

A second, smaller hazard: `localStorage` can throw — private browsing, quota, a corrupt
value. `boardRegistry` already handles this and this module must match it, because a
throw in a load-path hook would break the draft page itself rather than merely failing to
record.

---

## Testing

### Unit — `frontend/src/lib/draftRegistry.test.js` (`node:test`)

- A remembered draft appears in `listDrafts()`
- Remembering an existing id updates it in place rather than duplicating, and moves it to
  the front
- The list is capped at 50, dropping the oldest
- `completed` flipping false → true updates the stored entry
- `forgetDraft` removes only the named entry
- A corrupt stored value yields `[]` rather than throwing
- A storage that throws on write is a silent no-op, not an exception

### End-to-end — `frontend/tests/mydrafts.spec.js`

- Empty state renders when nothing is stored
- An in-progress entry links to `/draft/:id`; a completed entry links to
  `/draft/:id/results` — asserted by navigating, not by reading `href`
- Forget removes the row, and it stays gone after a reload
- **Opening a draft by link records it.** Visit `/draft/:id` directly with no registry
  entry, then go to `/drafts` and find it listed. This is the behavior the whole feature
  was chosen for and the one most likely to regress silently
- **A sim-to-end does not write once per pick.** Instrument `localStorage.setItem` and
  assert the count stays small across a completed draft

### Existing suites

100 backend unit, 31 frontend unit, 74 Playwright. All must still pass. The backend is
untouched.

---

## Out of Scope

- **A `DELETE /drafts/:id` endpoint.** Forget is local-only by decision; adding real
  deletion is backend work not requested here.
- **Any backend change at all.** No Lambda deploy is part of this.
- **Syncing the registry across devices or browsers.** That needs accounts.
- **Renaming drafts.** Entries are identified by their configuration and timestamp.
- **The draft-page UX items** (board-active affirmation, cross-format handling, dynasty
  round mismatch). Separate work, sequenced after this.
