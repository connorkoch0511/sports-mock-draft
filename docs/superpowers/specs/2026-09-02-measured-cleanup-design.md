# Measured Cleanup: Stale Rows, Board Confirmation, Starter CSS

**Date:** 2026-09-02
**Status:** Approved, ready for implementation planning
**Scope:** Backend sync + two frontend fixes. No schema change.

---

## Summary

Three independently-verified defects, each measured against production before
being designed. They share a branch because they are small, not because they
are related.

---

## 1. Stale player rows

### Motivation

The players table holds **3,876** rows. The last sync wrote **815**. The
remaining **3,061** are never deleted — `syncPlayers` only ever `Put`s.
They range from 1.3 to 196 days old.

Every one of them is carried on every `GET /players`, which is the draft
page's largest fetch and blocks board load behind it.

### The rows are safe to delete — verified, not assumed

Each of the 3,061 was cross-referenced against Sleeper's live feed:

| | count |
|---|---|
| Not present in Sleeper's feed at all | 2,635 |
| Active but on no NFL team (free agents) | 315 |
| `status=inactive` | 110 |
| No status | 1 |
| **Active and on an NFL roster** | **0** |

**Waiver-wire depth is not at risk.** The sync's filter is
`status === "active"` AND has a team — it does not consider ADP or rank, so
fantasy-irrelevant depth is retained. Of the 773 players Sleeper currently
qualifies: 160 starters, 125 backups, 261 at depth 3+, and 227 with no depth
chart. **488 of 773 are depth-3-or-worse or unlisted.** That is the waiver
wire, and it stays.

What is dropped is players on **no NFL roster**: retired players and true free
agents (Sleeper still flags names like Le'Veon Bell "active" with no team).

### Design

After the batch write succeeds, delete every row for this sport whose
`updatedAt` predates the run's start timestamp.

| Decision | Choice | Why |
|---|---|---|
| What marks a row current | `updatedAt >= runStartedAt` | The field already exists and is already written every run. No schema change. |
| When deletion runs | After the write completes | A failed write must never be followed by a delete. Order is the safety property. |
| Sport scoping | Deletes only within the synced `sport` partition | A future sport's rows must not be collateral. |

### The safety valve

This job runs unattended. A Sleeper hiccup returning a short list would,
without a guard, empty the table.

**If the run wrote fewer than `MIN_EXPECTED_PLAYERS` (500), skip deletion
entirely and log loudly.** The write still commits — partial data beats no
data — but nothing is removed. Today's run writes 815, so the valve is not
close to tripping in normal operation, and it fires long before the table
could be gutted.

Deletion failure is logged and does not fail the sync. Stale rows are a
performance problem, not a correctness one; a sync that wrote good data and
failed to tidy up has still succeeded at its job.

---

## 2. `Boards.jsx` deletes without confirmation

`deleteBoard` calls the API immediately on click. A board represents
substantial manual ranking work and there is no undo.

Drafts already confirm — `MyDrafts.jsx` gates its server delete behind
`window.confirm`. Boards is the same destructive action, one nav item away,
with no gate. This aligns the two.

Match the existing draft confirmation's copy and shape rather than inventing
a second pattern.

---

## 3. The Vite starter's `button` rule

`frontend/src/index.css:39` still carries the scaffold's unlayered rule:

```css
button {
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.6em 1.2em;
  font-size: 1em;
  font-weight: 500;
  font-family: inherit;
  background-color: #1a1a1a;
  cursor: pointer;
  transition: border-color 0.25s;
}
button:hover { border-color: #646cff; }
```

Being unlayered, it beats every Tailwind utility. It is why buttons render
chunky and why recent work needed `!` modifiers to defeat it.

### Risk — the largest in this branch

This affects **31 buttons across 7 files**: `Draft.jsx` (15), `Results.jsx`
(5), `NewDraft.jsx` (4), `Boards.jsx` (3), `MyDrafts.jsx` (2), `Board.jsx`
(1), `NavBar.jsx` (1). Nothing is scoped; every button in the app changes at
once.

Buttons currently relying on the starter's `padding` or `background-color`
rather than their own utilities will visibly change. The remedy is not to
keep the rule — it is to give those buttons explicit utilities, which is what
they should have had.

`cursor: pointer` is worth preserving deliberately: Tailwind 4's reset does
not restore it, and losing it silently degrades every button. It is re-added
as an explicit base rule rather than left to chance.

`button:focus-visible`'s outline must survive in some form. Removing a focus
indicator is an accessibility regression, not a cosmetic one.

---

## Testing

- **Sync deletion:** stale rows removed, current rows retained, correct
  `sport` partition only. **The valve is tested by simulating a short run and
  asserting nothing is deleted** — an untested valve is decoration.
  Order matters: assert no delete is issued when the write throws.
- **Board confirmation:** confirm→deletes, cancel→does not. The cancel case
  is the one that matters; only asserting the accept path would pass against
  no confirmation at all.
- **CSS:** existing Playwright suites must pass. Screenshots regenerated for
  every page per the standing preference, and reviewed for buttons that lost
  padding or background.

## Out of Scope

- The 2 deliberate `setState`-in-effect lint errors.
- Any redesign of button styling beyond restoring what the rule was masking.
- The player drill-down (separate spec).
