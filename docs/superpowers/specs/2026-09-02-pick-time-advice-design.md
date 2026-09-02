# Pick-Time Decision Support

**Date:** 2026-09-02
**Status:** Approved, ready for implementation planning
**Scope:** Backend (sync + response passthrough) and frontend. Requires a **backend deploy**.

---

## Summary

Tell the drafter who to take and why, at the moment they are picking, using reasons that
are the actual factors behind the recommendation rather than prose written after the fact.

---

## Motivation

The app already has a recommendation engine. `pickBestForTeam` in `backend/src/drafts.js`
drafts for the other eleven teams by scoring rank, roster need, and K/DEF timing. **The
bots make better-informed decisions than the interface lets the user make**, and none of
that reasoning is ever shown.

Meanwhile the draft page already holds everything needed to reason well: the pool with
`rank`, `adp` and `tier`; `draft.picked`; every team's roster; the user's board; and
`rosterSlots`. `draftAnalysis.js` already fits a roster correctly (dedicated → FLEX →
bench), though that helper is private today and this work needs it exported. None of it is
used to help the person drafting.

### What the data supports, measured

Sleeper's player blob carries fields the nightly sync currently discards. Measured against
the live endpoint, across 2,723 players with a team and a position:

| Field | Coverage | Values |
|---|---|---|
| `injury_status` | 474 (17%) | IR 223, Questionable 198, PUP 39, Sus 6, NA 4, COV 2 |
| `depth_chart_order` | 1,463 (53%) | small integers |
| `injury_body_part` | sparse | short strings — "Ankle", "Hamstring" |
| `practice_participation` | **0** | empty for every injured player |

Two things follow. **`practice_participation` will not be synced** — an earlier sketch of
this feature proposed it, and the data says it is worthless. And **223 players are on IR**,
which is a hard signal worth acting on rather than a nuance.

All three useful fields are sparse, so storing and returning them **only when present**
keeps the `/players` payload close to what it is today. That matters: `status`,
`updatedAt` and `playerId` were deliberately trimmed from that response during the
compression work, and undoing that saving would be a regression.

### What it still cannot do

No projections, no snap share, no target volume, no bye weeks. This gives **draft-strategy
reasoning** — value, scarcity, need, tier cliffs, availability — not player-performance
analysis. The recommendation will be explicit about that rather than implying it knows
more than it does.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Reason provenance | Reasons **are** the scoring factors | A reason that did not move the ranking is decoration, and decoration erodes trust in the ones that did |
| Starting order | The user's board when they have one, else consensus rank | A board is the user's own ranking; overriding it would be presumptuous |
| Injury handling | Hard penalty for IR/Out, soft for Questionable | IR is disqualifying; questionable is a judgement the user should make |
| `practice_participation` | Not synced | Measured empty for every injured player |
| Sparse fields | Stored and returned only when present | Preserves the compression work's payload saving |
| The "why" affordance | A separate control beside the draft button | The row *is* the draft button; a button cannot nest inside a button |
| Scarcity horizon | Counted against the user's **next** pick | "Will he last?" is the only version of scarcity that affects this decision |

---

## Architecture

### `backend/src/syncPlayers.js`

`normalizeSleeperPlayer` keeps three more fields, each omitted when the source has no
value: `injuryStatus`, `injuryBodyPart`, `depthChartOrder`. Names are camelCased to match
the item's existing convention. No schema migration — DynamoDB items are schemaless — and
no change to the sync's scheduling or its ADP merge.

### `backend/src/players.js`

The mapped player gains the same three fields, again **only when present**, so a pool of
mostly-healthy players costs nothing extra. The seven existing fields are unchanged.

### `frontend/src/lib/pickAdvice.js` — new, pure

```
adviseOnPick({ players, draft, boardRows, myTeam }) -> {
  recommendation: { player, score, reasons: [...] } | null,
  reasonsFor(playerId) -> [...]          // the same machinery, for any player
}
```

A reason is `{ kind, text, weight }` where `weight` is the score contribution that reason
produced. The recommendation's `reasons` are the non-zero contributions, ordered by
magnitude. This is what makes the explanation honest: it is a readout of the arithmetic,
not a narrative laid over it.

Factors:

- **Base** — the user's board position when a board is driving the draft, else consensus
  rank. Establishes the starting order and is not itself a "reason".
- **Value** — `overall − adp` at the current pick, the same convention the analysis page
  uses. Positive means he has fallen.
- **Need** — whether the player fills a slot the roster still lacks, via the roster fitting
  in `draftAnalysis.js`. **That function is currently private and must be exported**, not
  copied: it encodes dedicated → FLEX → bench semantics that were wrong until recently, when
  a complete Sleeper roster was reporting seven unfilled slots and seven surplus players at
  once. A second copy would be free to drift back into that bug. One implementation, two
  consumers.
- **Scarcity** — how many players at that position are likely gone before the user's next
  pick, derived from `picksForSlot` in `snake.js`.
- **Tier cliff** — the tier gap between this player and the next available at his position.
- **Availability** — a hard penalty for IR and Out, a soft one for Questionable, naming the
  body part when known. A large depth-chart order is a mild negative.

### `frontend/src/pages/Draft.jsx`

Two changes.

A **recommendation card** at the top of the Big Board panel: the player, and the reasons
that lifted him. It states plainly that it reasons about draft strategy, not player
performance.

A **why control** on each row. The row is currently a single `<button>` whose `onClick`
calls `makePick`, so the row becomes a container holding that button plus a small separate
control that reveals the reasons for that player — positive and negative.

---

## Risk

**This changes the app's most-used interaction.** Every manual pick in every draft goes
through that Big Board row. Restructuring it to hold two controls risks breaking picking
itself, which is worse than shipping no advice at all.

The plan must therefore **pin the current behavior before touching it**: that clicking a
row still drafts that player, that rows are disabled when it is not the user's turn, and
that the keyboard path still works. Those tests must exist and pass *before* the
restructure, and pass unchanged *after* it.

Two lesser risks. The `/players` payload could regress the compression saving if the new
fields are emitted for every player — hence storing them only when present, and measuring
the before-and-after size rather than assuming. And the nightly sync rewrites the entire
players table; a mistake there corrupts the pool for every draft, so the sync change is
additive only and leaves the existing ADP merge untouched.

---

## Testing

### Unit — `backend/src/players.test.js` (extend)

- A player with an injury status returns it; one without omits the key entirely
- `depthChartOrder` behaves the same way
- The seven existing fields are unchanged

### Unit — `frontend/src/lib/pickAdvice.test.js` (new)

This is where the reasoning is proven.

- Every reason returned corresponds to a non-zero score contribution — **no reason appears
  that did not move the ranking**
- A player who has fallen past ADP earns a value reason with the correct sign
- A player filling an unfilled roster slot earns a need reason; one filling an already-full
  slot does not
- Scarcity counts against the user's *next* pick, not the end of the draft
- A tier cliff is reported only when the next available player at that position is in a
  worse tier
- A player on IR is penalised hard enough not to be recommended over a healthy comparable
- Questionable is a soft penalty, not disqualifying, and names the body part when known
- With a board present, board order drives the base; without one, consensus rank does
- An empty pool, a completed draft, and a malformed draft each return no recommendation
  rather than throwing

### End-to-end — `frontend/tests/draft.spec.js` (extend) and a new spec

**Before the row restructure**, pinning existing behavior:

- Clicking a Big Board row drafts that player
- Rows are disabled when it is not the user's turn
- The keyboard path to drafting still works

**After:**

- The recommendation card names a player and shows at least one reason
- The why control reveals reasons for a player without drafting him
- Using the why control does not make a pick — asserted by counting pick requests

### Post-deploy

Measure the `/players` payload compressed and uncompressed against the current 52 KB, and
confirm a real draft still picks, auto-picks and sims to completion.

---

## Out of Scope

- **Player performance data** — targets, snaps, yardage, projections. Not available.
- **Bye weeks.** Not stored, and not in Sleeper's player blob.
- **Changing how the bots pick.** `pickBestForTeam` is untouched; this is about showing the
  user reasoning, not altering the simulation.
- **A player drill-down page.** The injury and depth data this adds would serve one, but
  that is its own feature.
- **Reordering the Big Board by the recommendation.** The board keeps the user's order; the
  advice sits alongside it rather than overriding it.
