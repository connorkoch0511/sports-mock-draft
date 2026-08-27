# Custom Big Board + Draft Slot Selection

**Date:** 2026-08-27
**Status:** Approved, ready for implementation planning
**Scope:** Phase 1 of a three-subsystem expansion (see [Roadmap](#roadmap-context))

---

## Summary

Add user-owned custom player rankings to PerfectPick. A user seeds a board from a
consensus source, drags players into the order they actually believe, compares that
order against other sites, and drafts off it. Separately, let users choose which draft
slot they occupy instead of always drafting from Team 1.

Two deliverables, one spec, because they share the draft-creation surface and ship together.

---

## Motivation

PerfectPick today is a mock draft simulator with a fixed opinion: FantasyFootballCalculator
ADP is the ranking, and you always draft from Team 1. Both are limiting.

Serious drafters have their own rankings and want to practice against them. And drafting
from the same slot every time is poor practice — the 1.03 and the 1.10 are different drafts,
and the whole point of a mock is rehearsing the one you'll actually get.

---

## Design Decisions

Decisions settled during brainstorming, with the reasoning preserved so future work
doesn't relitigate them.

| Decision | Choice | Why |
|---|---|---|
| Board ownership | Anonymous `boardId` + link | Matches how `/drafts/:id` already works. No auth infrastructure. `ownerId` field present from day one so accounts can be added without migration. |
| Editing model | Flat ranked list, drag to reorder | Simplest to build and use; maps directly onto `pickBestForTeam()`, which already scores off `p.rank`. |
| Storage model | Materialized order, reconciled on read | Predictable and debuggable. A sparse overlay makes rank a computed value and degrades once most rows are pinned. |
| Bot behavior | Bots draft off **consensus**, never your board | If your rankings drove the bots, they'd reach for exactly the players you like and the sim would confirm your priors. Consensus bots are what make "will he last?" a real question. |
| Schema change | Additive `sources` map | Re-keying `adp`/`rank`/`tier` would break every in-flight draft. See [Backward Compatibility](#backward-compatibility). |
| Slot scope | One slot per draft | Multi-team control wasn't asked for. YAGNI. |

---

## Data Model

### Players table — additive change

`perfectpick-players` keeps `adp` / `rank` / `tier` **exactly as they are**. They become
the "consensus" values. A parallel `sources` map is added alongside:

```js
{
  sport: "nfl",
  playerId: "4034",            // Sleeper player ID — the canonical spine
  name, position, team, nameKey, status,

  // UNCHANGED — existing readers keep working
  adp:  { standard: 12.4, "half-ppr": 11.8, ppr: 10.2 },
  rank: { standard: 14,   "half-ppr": 12,   ppr: 11   },
  tier: { standard: 2,    "half-ppr": 1,    ppr: 1    },

  // NEW — per-source, for comparison
  sources: {
    ffc:  { ppr: { adp: 10.2, rank: 11, timesDrafted: 1800 } },
    espn: { ppr: { adp: 12.0, rank: 14 } }
  }
}
```

### Boards table — new

`perfectpick-boards`, `PAY_PER_REQUEST`, PK `boardId` (String). Mirrors `perfectpick-drafts`.

```js
{
  boardId:    "uuid",
  ownerId:    "anon",        // account-upgrade hook; GSI added later
  name:       "My 2026 PPR",
  sport:      "nfl",
  format:     "ppr",
  season:     2026,
  baseSource: "ffc",         // what it was seeded from
  order:      ["4034", "6794", "5849", ...],
  createdAt, updatedAt,
  version:    1              // for conditional writes
}
```

### Drafts table — additive field

`userTeam` (Number, `1..teams`). Existing drafts without the field read as
`d.userTeam || 1`, preserving current behavior for every draft already stored.

---

## Backward Compatibility

This constraint drove the schema design and must not be violated.

`drafts.js:39-41` and `players.js:45-47` both read `p.rank?.[format]`, `p.adp?.[format]`,
`p.tier?.[format]`. Any draft in `perfectpick-drafts` holds player snapshots produced by
that shape.

Re-keying those maps by source would break every in-flight draft. Therefore:

- `adp` / `rank` / `tier` keep their current shape and meaning, sourced from FFC
- `sources` is added in parallel and read only by new code
- No migration, no backfill, no downtime

If consensus ever moves off FFC, that's a separate decision with its own migration.

---

## API

New `BoardsFunction` Lambda (`backend/src/boards.js`), same handler shape as `drafts.js` —
method/path dispatch, shared `corsHeaders()`, JSON responses.

```
POST   /boards                    { name, format, season, seedFrom } -> { boardId }
GET    /boards/:id?vs=ffc,espn                                       -> reconciled board
PUT    /boards/:id                { order, version }                 -> conditional save
DELETE /boards/:id
```

### `GET /boards/:id` response

```js
{
  boardId, name, format, season,
  rows: [
    { playerId, name, position, team,
      myRank: 1, consensusRank: 1, delta: 0, isNew: false,
      sources: { ffc: 1, espn: 3 } }
  ],
  changelog: { added: 3, removed: 1 }
}
```

Comparison rides on `GET` rather than living at a separate endpoint — the player pool is
already loaded there, and a separate call would only re-fetch it.

### Concurrency

`PUT /boards/:id` uses a **conditional update** on `version`:

```
ConditionExpression: "version = :expectedVersion"
```

A stale write returns `409` and the client refetches. This deliberately differs from
`drafts.js:276`, which does read-modify-write with no condition and can silently clobber
concurrent picks. That's a known existing bug; new code should not inherit it.

---

## Reconciliation

`syncPlayers` runs nightly and mutates the player pool. A stored board is a snapshot, so
`GET /boards/:id` reconciles the two.

Pure function, `backend/src/lib/reconcile.js`:

```
reconcile(storedOrder, livePool, format) -> { rows, changelog }
```

Algorithm:

1. Partition `storedOrder` into `kept` (still in pool) and `removed` (gone).
2. Compute `missing` = pool players absent from `storedOrder`.
3. For each missing player, insert **before the first kept player whose consensus rank
   exceeds theirs**. Ties break by consensus rank, then `playerId`, for determinism.
4. Mark inserted players `isNew: true` until the user moves or acknowledges them.
5. Return `changelog: { added, removed }`.

Reconciliation is computed on read and **not** persisted. The stored `order` changes only
when the user saves. This keeps saves intentional and makes the function trivially testable.

---

## Frontend

### New route — `/board/:boardId`

`frontend/src/pages/Board.jsx`. Flat drag-reorderable list, renumbering on drop, with a
comparison column showing delta against each selected source.

- **Dependency:** `@dnd-kit/core` + `@dnd-kit/sortable` — one new dependency, two packages.
  Native HTML5 drag-and-drop would avoid it but has no keyboard story, and a 300-row
  ranking list needs keyboard reordering to be usable.
- **Autosave:** debounced ~800ms, optimistic UI, full-array `PUT`. An order array of 300
  IDs is ~2KB, so partial-update complexity isn't warranted.
- **Conflict:** on `409`, refetch and show a non-destructive notice.

### Home page

- Board list backed by `localStorage.perfectpick.myBoards` — `[{ id, name, updatedAt }]`
- "Create board" seeded from the current format
- **Draft slot picker** (see below)

### Draft page

`Draft.jsx` currently hardcodes `Team 1` in **11 places**: lines 141, 151, 165, 183, 199,
233, 245, 288, 361, 366. All become `draft.userTeam`. This covers the pick clock, the
"on the clock" banner, `canManualPick`, and the timeout auto-pick.

When a draft has a `boardId`, the Big Board orders by the user's board and each row shows
`myRank` alongside ADP so value is visible mid-draft.

---

## Draft Slot Selection

`POST /drafts` gains `userTeam`, validated to `1..teams`, defaulting to `1`.

The Home picker offers slots `1..teams` plus **Random**, since real leagues randomize and
always drafting the same slot is poor practice.

Because it's a snake, the slot determines the user's entire pick schedule — which is the
actual decision being made. `buildSnakeOrder()` already computes this, so the picker
surfaces it directly:

```
Slot 3 of 12 · 15 rounds
Your picks: 3, 22, 27, 46, 51, 70, 75, 94, ...
            └─ 19-pick gap between 3 and 22
```

`sim-to-end` is unchanged: it completes every remaining pick including the user's.

---

## Testing

### Unit — `node:test`

A departure: the repo currently has no unit tests, only Playwright. Two pure functions
warrant them, because both have edge cases that are miserable to debug through a browser.

**`reconcile.js`**
- new player inserts at the correct consensus position
- removed player drops and is counted
- empty stored order returns full pool in consensus order
- pool unchanged returns identical order with `changelog: { added: 0, removed: 0 }`
- ties break deterministically

**`resolver.js`** (`normName` / `normTeam`, lifted from `syncPlayers.js:19-56`)
- suffix stripping: `Kenneth Walker III`, `Michael Pittman Jr.`
- punctuation: `Ja'Marr Chase`, `Amon-Ra St. Brown`
- team aliases: `JAC→JAX`, `OAK→LV`, `SD→LAC`, `STL→LAR`, `WAS→WSH`
- DEF naming variance across sources
- ambiguous names resolve to a stable choice or report unmatched

### End-to-end — Playwright

New `tests/board.spec.js`, following `tests/fixtures.js` route-mocking:

- create board, seeded in consensus order
- drag reorder persists across reload
- `isNew` badge renders after pool change
- comparison deltas render per source
- board drives Big Board order inside a draft
- slot selection: picking slot N puts the user on the clock at the right picks
- stale save surfaces the 409 notice

---

## Implementation Sequencing

| Phase | Deliverable |
|---|---|
| 1 | Boards table, `BoardsFunction` CRUD, reconcile-on-read, drag editor seeded from FFC, slot selection |
| 2 | Multi-source comparison vs FFC variants (`teams=8\|10\|12\|14`) |
| 3 | Draft integration — board drives the Big Board, bots stay on consensus |
| 4 | External source adapters (ESPN → Yahoo → CBS) on the shared resolver |

Draft integration lands **before** external adapters deliberately: it's cheap, it's the
payoff, and it carries no ID-matching risk.

---

## Risks

**Player identity resolution (phase 4).** Every non-Sleeper source keys players by its own
IDs. Matching on name + team + position is fuzzy and will mis-map some players. Mitigations:
a hardened shared resolver, a committed manual-override table, and an unmatched/ambiguous
report emitted by each sync run. Never silently guess.

**Third-party endpoint stability (phase 4).** ESPN, Yahoo, and CBS ADP endpoints are
undocumented and their terms don't contemplate this use. They break without notice and
warrant caching and conservative request rates. This is part of why phases 1–3 rely on FFC,
which publishes an actual API.

**Board row growth.** Materialized order grows as the pool grows. At NFL scale (~3,900
players, ~300 ranked) this is not a concern; revisit if other sports are added.

---

## Roadmap Context

This spec is phase 1 of three subsystems identified during brainstorming. The other two
need their own specs.

### League Connection — needs its own spec

The larger goal is connecting a real fantasy league (Sleeper, ESPN, Yahoo) and importing
its actual configuration to mock against — comparable to WalterPicks.

**This is not an ADP-import feature, and it is bigger than an adapter.** It changes the
core domain model:

- `format` today is one of three fixed strings. Real leagues have arbitrary scoring —
  TE premium, 6-point passing TDs, first-down bonuses.
- Roster construction today is hardcoded in `needScore()` as
  `{ QB:1, RB:2, WR:2, TE:1, K:1, DEF:1 }`, which is not a real roster. Real leagues have
  FLEX, SUPERFLEX, and bench slots that fundamentally change draft strategy.
- `rounds` would derive from roster size rather than being entered by hand.
- Snake / linear / auction and keepers are all currently unmodeled.

**Verified:** Sleeper resolves username → `user_id` → leagues with **no authentication at
all** (`GET /v1/user/<name>`, `GET /v1/user/<id>/leagues/nfl/<season>`). Confirmed live
2026-08-27. The exact field names on the league object (`roster_positions`,
`scoring_settings`) still need to be pinned against a real league ID.

**Corrected during brainstorming:** Sleeper publishes **no ADP endpoint**.
`/v1/adp/nfl/2025` returns 404. `/v1/stats/nfl/regular/<year>` returns end-of-season
finish (`rank_ppr`, `pos_rank_ppr`) keyed by Sleeper ID — useful for analytics, not ADP.

**Note for board work:** once leagues are importable, a board is meaningfully scoped to a
*league configuration*, not just a scoring format — a superflex board is not a PPR board.
The `format` field on `boards` is the natural place to widen later.

### Player Analytics — needs its own spec

Insights on players under consideration. Blocked on data the app does not currently store:
projections, snap share, target share, injury history, strength of schedule, bye weeks. A
player row today holds only name, position, team, status, and ADP-derived rank/tier.
Sleeper's season-finish endpoint is one confirmed free input.
