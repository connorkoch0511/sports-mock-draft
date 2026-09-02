# Draft Analysis

**Date:** 2026-09-01
**Status:** Approved, ready for implementation planning
**Scope:** Frontend only — no backend, no schema, no new endpoint, no Lambda deploy

---

## Summary

A scorecard on the Results page that says how your draft went, ranked against the other
teams, computed entirely from data the page already has.

---

## Motivation

The Results page records a completed draft — a pick log, team rosters, CSV and JSON export.
It says what happened. It says nothing about how you did.

This is the first of several analytics ideas, and it was chosen to go first for a specific
reason: **it needs no new data.** Measured against production, every pick in a completed
draft carries a full player snapshot taken at draft time:

```json
{
  "overall": 1, "round": 1, "team": 1, "playerId": "9488",
  "player": { "id": "9488", "name": "Jaxon Smith-Njigba", "position": "WR",
              "team": "SEA", "rank": 5, "adp": 5.5, "tier": 1 }
}
```

30 of 30 picks carried one in a test draft, `adp` included. `rosterSlots` is stored on the
draft too. So value-against-ADP, positional shape, and tier distribution are all exactly
computable from the object `Results.jsx` already fetches — with no re-fetch, no drift, and
no backend work.

The other analytics ideas are not so lucky. A player drill-down worth the name needs
targets, snap share, and yardage, none of which exist anywhere in this app: the sync pulls
from Sleeper's `/players` blob, which is roster and bio data, and from Fantasy Football
Calculator for ADP. Neither is a stats feed. Building this piece first establishes what
people actually want to look at before anyone invests in a data pipeline.

---

## What the data supports, and what it does not

**Supported, exactly:**

| Signal | Derivation |
|---|---|
| Value captured | `overall − player.adp`, summed per team |
| Best pick / biggest reach | The max and min of that delta |
| Roster shape | Picks by position, against the draft's own `rosterSlots` |
| Tier haul | `player.tier`, counted |
| The wait | The longest gap between a team's picks, and who went during it |

**Not supported, and deliberately not faked:**

- **Whether the team is any good.** No projections exist. This measures *process* — did
  value fall to you, did you fill your slots — not *outcome*.
- **Bye-week conflicts.** Bye weeks are not stored on players.
- **Injury or risk context.** Not stored either, though Sleeper offers it and a later piece
  could.

The page will be explicit that it grades process, not teams. A vague quality score would be
worse than no score.

### The ADP coverage limit

Measured: **272 of 3,875 players carry an ADP, ranging 1.5 to 197.** A 12-team, 15-round
draft is 180 picks, so most are scoreable — but a pick spent on an unranked player has no
ADP to compare against.

Those picks are **excluded from value math, and the count of exclusions is shown.** Treating
a missing ADP as zero would silently score a late flier as a 150-point reach and poison every
total.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Scope | Your team leads; other teams provide ranking | "+14 points of value" means nothing until you know the field averaged +30 or −5 |
| Placement | A view on Results, with `?view=analysis` in the URL | One destination per draft, but directly linkable and shareable, and reachable from My Drafts |
| Default view | The existing pick log | No change for anyone who does not ask for the analysis |
| Where it computes | Frontend, in a pure module | Results already fetches everything needed. No endpoint, no deploy beyond the frontend |
| Unscoreable picks | Excluded, and counted aloud | Scoring a missing ADP as zero would corrupt every total |
| Whose team | `draft.userTeam`, as stored | Opening a shared draft shows it from the creator's seat, which is whose draft it is |
| In-progress drafts | Analyze the picks made so far | The URL is reachable mid-draft; erroring there would be worse than a partial answer |

---

## Architecture

### `frontend/src/lib/draftAnalysis.js` — new

Pure functions over the draft object. No fetching, no React, no formatting — this is where
the logic lives and where the tests point.

```
analyzeDraft(draft) -> {
  scoreable,          // picks with an ADP, and picks without
  teams: [{ team, valueCaptured, tierCounts, picks }],   // every team, for ranking
  you: {
    team, rank, valueCaptured,
    bestPick, biggestReach,      // { player, overall, delta } or null
    rosterShape: { filled, unfilled, extra },
    tierCounts,
    longestWait: { from, to, span, playersGone }
  }
}
```

Behavior that must hold:

- A pick whose player has no `adp` contributes to no value total, and is counted in
  `scoreable.without`.
- A draft with no completed picks returns a well-formed result with zeroes, not a throw.
- `rosterShape` compares against the draft's own `rosterSlots`, not a hardcoded roster.
- Ranking is over every team, so `you.rank` is meaningful even when your total is negative.

### `frontend/src/pages/Results.jsx` — modified

Gains two tabs. The active one reads from and writes to the `view` query parameter via
React Router's `useSearchParams`; absent or unrecognised values fall back to the pick log,
so an old link keeps working.

The existing pick log, rosters, and export controls are unchanged and remain the default.

### `frontend/src/pages/MyDrafts.jsx` — modified

A completed draft's row gains a link to its analysis, alongside the existing link to the
draft. In-progress rows are unchanged.

---

## Risk

Low. Nothing existing changes behavior: a new module, a tab on a page whose default view is
untouched, and one added link.

The one real hazard is the arithmetic. Value-against-ADP is the headline number, and a sign
error would invert every verdict on the page — telling someone they reached when they got
value.

**The convention is `overall − adp`.** Taking a player *earlier* than their ADP is a reach
and scores negative; a player falling *past* their ADP is value and scores positive:

| Case | ADP | Taken at | Delta | Reads as |
|---|---|---|---|---|
| Reach | 5.5 | pick 1 | **−4.5** | you took him 4.5 picks early |
| Value | 5.5 | pick 20 | **+14.5** | he fell 14.5 picks to you |

The implementation and its tests must both assert those two cases by name, in words as well
as numbers.

This is not a hypothetical risk: the first draft of this spec stated the formula as
`adp − overall` in the summary table while stating the correct outcomes here, and the two
contradicted each other. A reader following the table would have shipped every verdict
inverted.

---

## Testing

### Unit — `frontend/src/lib/draftAnalysis.test.js` (`node:test`)

This is where the coverage belongs; the page is a renderer.

- ADP 5.5 taken at overall 1 is a **reach**, scoring −4.5
- ADP 5.5 taken at overall 20 is **value**, scoring +14.5
- A team's `valueCaptured` is the sum across its scoreable picks
- A pick whose player has no `adp` is excluded and counted in `scoreable.without`
- A draft where *no* pick has an ADP yields zero value and no crash
- `you.rank` orders teams by value, ties broken deterministically
- `rosterShape` reports unfilled slots when a position was never drafted
- `rosterShape` reports extras when a position was drafted beyond its slot count
- `rosterShape` reads the draft's `rosterSlots`, proven by a non-default roster
- `tierCounts` counts by tier and ignores players with no tier
- `longestWait` finds the largest gap between a team's picks and lists who went during it
- A draft with zero completed picks returns zeroes rather than throwing
- An in-progress draft analyzes only the picks made so far

### End-to-end — `frontend/tests/analysis.spec.js`

- The pick log is the default view when no `view` parameter is present
- `?view=analysis` opens the analysis directly
- Switching tabs updates the URL, and reloading that URL keeps the tab
- An unrecognised `view` value falls back to the pick log rather than rendering nothing
- The analysis names the user's team, and shows its rank against the field
- The excluded-pick count appears when the draft contains an unscoreable pick
- My Drafts links a completed draft to its analysis

### Existing suites

106 backend unit, 63 frontend unit, 106 Playwright. All must still pass.

---

## Out of Scope

- **Any backend change.** No new endpoint, no schema change, no Lambda deploy.
- **Projections, bye weeks, injury data, or any quality score.** Process only.
- **The other analytics ideas** — player drill-down, pick-time decision support, a public
  analytics page, and real drafts. Each needs its own spec; two of them need a data source
  this app does not have.
- **Persisting or sharing the analysis separately** from the draft it describes.
- **Analysis of boards**, as opposed to drafts.
