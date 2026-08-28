# Sleeper League Connection

**Date:** 2026-08-28
**Status:** Approved, ready for implementation planning
**Research:** `docs/superpowers/research/2026-08-28-sleeper-api-findings.md` — API shapes verified against three real leagues

---

## Summary

Teach the draft engine to understand real rosters — dedicated starters, FLEX, and bench —
then let a user import those settings from their Sleeper league in two clicks.

---

## Motivation

The bots draft against a roster that does not exist. `needScore()` targets a hardcoded
`{ QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 }` — nine slots, no FLEX, no bench, unrelated
to any real league. Every mock draft is therefore practice against opponents with the
wrong priorities.

Three real leagues, all with FLEX and 5–22 bench spots:

| League | Teams | Roster | Scoring |
|---|---|---|---|
| Arcade League | 10 | QB, RB×2, WR×2, TE, FLEX×2, K, DEF + 5 BN (15) | PPR |
| Average Joes 26' | 12 | QB, RB×2, WR×3, TE, FLEX, K, DEF + 6 BN (16) | Half-PPR |
| Designated Drinkers | 10 | QB, RB×2, WR×3, TE, FLEX×2, K, DEF + 22 BN (33) | PPR |

Sleeper's read API needs no authentication and sends `access-control-allow-origin: *`, so
the browser can fetch this directly. The import is the easy half; the engine is the feature.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the import runs | Browser, directly against Sleeper | CORS allows it; a Lambda proxy would add a hop and a deploy for no benefit |
| What "connect" produces | Prefilled `/draft/new` form | The league is a source of settings, not a stored association. No new page, no registry |
| Bot need model | Starters first, then best available | Matches how people actually draft; bench positional pull causes late reaches over value |
| K/DEF suppression | Gated on starters being filled | The current `round <= 10` rule means kickers in round 11 of a 33-round draft |
| Manual roster editing | Not included | You cannot hand-build a FLEX league without Sleeper. Separate want |
| Scoring | Mapped to the existing three formats | ADP data only exists in those three; modeling 132 scoring keys needs projections we lack |

---

## Data Model

### Drafts table — additive

`rosterSlots: string[]` — the flat slot array exactly as Sleeper supplies it, e.g.
`["QB","RB","RB","WR","WR","WR","TE","FLEX","K","DEF","BN","BN","BN","BN","BN","BN"]`.

Drafts created before this feature have no `rosterSlots`. They read as `DEFAULT_ROSTER`,
which reproduces today's implicit roster exactly:

```js
const DEFAULT_ROSTER = ["QB","RB","RB","WR","WR","TE","K","DEF"];
```

so existing in-flight drafts keep the same roster shape.

**Their bot behavior does change slightly, and that is intended.** Dropping the early-round
RB/WR boost (below) alters pick order even for a draft using `DEFAULT_ROSTER`. Existing
drafts remain fully playable — picks, auto-pick, and sim-to-end all work — but a bot mid-way
through an old draft will not make identical choices to the ones it would have made before.
No stored data is invalidated; only future auto-picks differ.

### Rounds clamp

`drafts.js:174` clamps rounds to 30. Designated Drinkers is a **33-round** draft and cannot
be imported today. The clamp rises to 40.

---

## Roster model — `backend/src/lib/roster.js`

A pure module with no I/O, following the `reconcile.js` precedent.

```js
parseRosterSlots(slots) → { starters, flex, bench, unknown }
rosterNeed(counts, position, roster) → number
kDefBlocked(counts, roster) → boolean
```

`parseRosterSlots` counts the array into dedicated starters by position, a FLEX count, and a
bench count. `BN` is bench. Any label the app does not recognise — `SUPER_FLEX`,
`WRRB_FLEX`, `REC_FLEX`, IDP slots, `TAXI` — is counted as bench and reported in `unknown`,
so an unfamiliar league degrades to something sane rather than crashing. None of the three
sample leagues use these.

### The three phases

`rosterNeed` returns demand for a position given what a team already has:

1. **Dedicated starters unfilled** — need is the count still missing for that position.
2. **FLEX open** — once dedicated RB/WR/TE are filled and FLEX slots remain, RB, WR, and TE
   regain demand. FLEX eligibility is RB/WR/TE.
3. **Starters complete** — need is zero. Bench picks fall through to pure best-available,
   which is what real drafters do.

`kDefBlocked` returns true while any non-K/DEF starter slot is unfilled. This replaces the
hardcoded `round <= 10` and scales to any roster length without a magic number.

---

## Bot logic — `backend/src/drafts.js`

`needScore()` is deleted and replaced by `rosterNeed()`. `pickBestForTeam()` gains the
parsed roster and swaps its round-based `kDefPenalty` for the `kDefBlocked` gate. The
scoring shape is otherwise unchanged — rank still dominates, need is still weighted at 500,
the blocked penalty stays at its current `-20000`, which is large enough to outrank any
rank-derived score and therefore decisive.

The early-round RB/WR boost in the current `needScore` is dropped. It was compensating for
a roster model that did not know about FLEX; with FLEX modeled, RB/WR demand emerges from
the roster itself rather than from a round heuristic.

---

## Sleeper client — `frontend/src/lib/sleeper.js`

Fetch helpers plus one pure mapping function, so the mapping is unit-testable without network.

```js
fetchUser(username)            → { user_id, ... }
fetchLeagues(userId, season)   → league[]
fetchLeagueDraft(leagueId)     → draft
toDraftConfig(league, draft, userId)
  → { teams, rounds, format, rosterSlots, userTeam, leagueName }
```

Mapping rules, each verified against real data:

- `teams` ← `league.total_rosters`
- `rounds` ← `draft.settings.rounds`, falling back to `league.roster_positions.length`.
  **Never `league.settings.draft_rounds`** — it reads 3, 3, and 5 for the 15, 16, and
  33-round drafts above.
- `format` ← `league.scoring_settings.rec`: `>= 1` is `ppr`, `0.5` is `half-ppr`, otherwise
  `standard`
- `rosterSlots` ← `league.roster_positions` verbatim
- `userTeam` ← the user's slot from `draft.draft_order[userId]`, defaulting to 1 when the
  draft order is not yet set

---

## Import UI — `frontend/src/pages/NewDraft.jsx`

An "Import from Sleeper" section above the existing controls: a username field, a fetch
button, and the resulting league list. Selecting a league fills teams, rounds, format, and
draft slot, and stores the imported `rosterSlots`, which render as read-only chips. Every
filled field stays editable; the import is a starting point, not a lock.

Copy must not overclaim. The lookup is unauthenticated and anyone can query anyone's
username — so the UI says "Find my leagues" and asks for a Sleeper username. It does not say
"Connect account" or "Sign in," which would imply a link that does not exist.

Error states: unknown username, a user with no leagues for the season, and a network
failure each surface a plain message and leave the form untouched.

---

## Testing

### Unit — `backend/src/lib/roster.test.js` (`node:test`)

- `parseRosterSlots` on each of the three real rosters produces the right starter counts,
  FLEX count, and bench count
- Unknown slot labels count as bench and appear in `unknown`
- FLEX contributes no demand while dedicated RB/WR/TE remain unfilled
- FLEX opens RB/WR/TE demand once dedicated slots are full
- Need is zero once all starters are filled — the bench best-available property
- `kDefBlocked` is true while any non-K/DEF starter is missing, false after
- A team that has filled everything returns zero need for every position

### Unit — `frontend/src/lib/sleeper.test.js` (`node:test`)

`toDraftConfig` runs against **fixtures captured from the three real leagues**, not invented
shapes, so the mapping is tested against data the API actually returns. Covers the `rec` →
format mapping at 1.0, 0.5, and absent; rounds coming from the draft object rather than
`league.settings.draft_rounds`; and `userTeam` defaulting to 1 when `draft_order` is null.

### End-to-end — `frontend/tests/sleeper.spec.js`

Sleeper's endpoints are mocked at the route level, as every other suite does. Covers a
successful import filling the form, an unknown username showing an error, and a user with no
leagues. Also asserts the imported values are still editable afterward.

---

## Backward Compatibility

- `rosterSlots` is additive; drafts without it use `DEFAULT_ROSTER` and behave exactly as today
- The rounds clamp only widens, so no existing value becomes invalid
- No change to the players table, the boards table, or any existing endpoint's response shape
- `reconcile.js`, `boards.js`, and the whole board feature are untouched

---

## Out of Scope

- **Keeper and dynasty handling** beyond round count. `settings.type: 2` on one sample
  league is a product question, not an API one.
- **Auction drafts.** All three sample leagues are `type: snake`. An auction is a different
  engine, not a variation of this one.
- **SUPERFLEX**, which inverts QB valuation. No sample league uses it; the parser degrades it
  to bench and reports it rather than pretending to support it.
- **Writing back to Sleeper.** There is no public write API to anyone, authenticated or not.
- **ESPN and Yahoo**, both of which need real auth — Yahoo an OAuth app, ESPN cookies pasted
  from the browser.
