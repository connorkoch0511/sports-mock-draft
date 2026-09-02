# Season Stats

**Date:** 2026-09-02
**Status:** Approved, ready for implementation planning
**Scope:** Backend only — sync, storage, and response. Requires a **backend deploy**.

---

## Summary

Pull last completed season's real production for every ranked player, so the app can reason
about what players actually did rather than only where they were drafted.

---

## Motivation

Every analytics conversation on this project has hit the same wall: the app stores `rank`,
`adp` and `tier` and nothing about performance. That limit shaped the draft-analysis spec
("this grades process, not teams") and the pick-time advice spec ("draft-strategy
reasoning, not player-performance analysis").

**That limit was never real.** Sleeper — the same free, unauthenticated API the nightly sync
already calls for the player list — publishes season stats at
`/v1/stats/nfl/regular/{season}`. It was not checked until now.

Measured against the live endpoint:

| | |
|---|---|
| Players with stats (2025) | 8,184 |
| Fields per player | ~100 |
| Payload | ~1.9 MB |
| Auth | none |
| **Join rate against our ranked pool** | **269 of 269 — 100%, zero misses** |

The join is exact because both sides key on Sleeper player ids, which the players table
already stores. There is no matching problem to solve.

The fields that matter are present:

| Signal | Field |
|---|---|
| Target volume | `rec_tgt` |
| Snap share | `off_snp` / `tm_off_snp` |
| Red-zone usage | `rec_rz_tgt`, `g2g_att` |
| Air yards | `rec_air_yd` |
| Fantasy production by format | `pts_ppr`, `pts_half_ppr`, `pts_std` |
| Positional finish | `pos_rank_ppr` |
| Durability | `gp` |

### What this is, and is not

It is **prior-season production** — what a player did. It is **not a projection**. Last
year's RB1 on a new team behind a new line is exactly where that distinction matters, so
the season must travel with the data and every surface that displays it must say which
season it is showing. Presenting history as though it were forecast would be worse than
showing nothing.

---

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Which season | Detected, not hardcoded | 2025 is complete (max `gp` 18); 2026 has not started (max `gp` 0). A hardcoded year silently goes stale every September |
| Which players get stats | Ranked players only | Measured: stats for everyone costs 85.8 KB gzipped against today's 51.7 KB (1.7×); ranked-only costs 60.9 KB (1.2×). The ~3,600 unranked are depth the boards API already filters out |
| Which fields | A curated ~20, not all ~100 | Most of the 100 are team/kicking/defensive columns irrelevant to drafting a skill player |
| Storage shape | A `stats` map plus a `statsSeason` scalar on the item | The season must be inseparable from the numbers, or the UI cannot label them honestly |
| Sync coupling | Additive; the ADP merge is untouched | The sync rewrites the entire players table nightly. A mistake corrupts the pool for every draft |

### Season detection

The sync requests the configured season and inspects the result: if no player has played a
game, it falls back to the prior season. That self-heals across the September boundary,
where the new season exists as an endpoint but holds nothing.

The season actually used is written to each item as `statsSeason` and logged, so a stale or
surprising value is diagnosable from the response rather than only from the sync's logs.

---

## Architecture

### `backend/src/syncPlayers.js`

A new fetch alongside the existing Sleeper player and FFC ADP calls, and a merge step that
attaches a curated stats object to each matched player. The curated set:

```
gp
pts_ppr, pts_half_ppr, pts_std, pos_rank_ppr
rec, rec_tgt, rec_yd, rec_td, rec_rz_tgt, rec_air_yd
rush_att, rush_yd, rush_td
pass_att, pass_yd, pass_td, pass_int
off_snp, tm_off_snp
```

Keys absent from the source are omitted rather than stored as zero — a receiver with no
rushing attempts and a receiver with an unreported figure are different things, and zero
would assert the first.

The existing ADP merge, tiering, and item shape are unchanged. If the stats fetch fails the
sync **still completes**, writing players without stats: a missing stat is a degraded
experience, while a failed sync is an empty player pool.

### `backend/src/players.js`

The mapped player gains `stats` and `statsSeason`, **only when the player is ranked and
stats exist**. Unranked players are unchanged, which is what holds the payload at 1.2×.

**"Ranked" here means ranked in the requested format**, since `players.js` derives `rank`
from `p.rank[format]`. The rank sets differ — standard covers 223 players, PPR 272 — so a
player ranked in PPR but not standard receives stats on a PPR request and not on a standard
one. That is consistent with a format-specific response rather than a bug, but it is
surprising enough to be worth a test: the same player id must carry stats for one format and
not the other.

The seven existing fields are untouched.

---

## Risk

**The nightly sync rewrites the entire players table.** It is the highest-blast-radius job
in the app: a bad write leaves every draft with a broken pool, and it runs unattended on a
daily schedule. Three mitigations:

1. **The stats fetch cannot fail the sync.** It is wrapped so that a Sleeper outage or a
   shape change degrades to players-without-stats rather than aborting the run.
2. **The merge is additive.** No existing field is read, rewritten, or reordered by this
   change.
3. **Post-deploy verification runs the sync and inspects real output**, rather than trusting
   that it worked.

The second risk is payload regression. `/players` was deliberately trimmed and compressed
earlier, and this adds data back. The ranked-only rule holds it to a measured 1.2×, and the
post-deploy check measures the real figure rather than assuming the local estimate held.

---

## Testing

### Unit — `backend/src/syncPlayers.test.js` (new)

There is no test file for the sync today, which is notable for the job with the widest blast
radius. This work adds one, covering the stats path only — the existing ADP behavior is out
of scope and untouched.

- A player present in the stats feed gets a `stats` object containing the curated fields
- A field absent from the source is **omitted**, not stored as zero
- A player absent from the stats feed gets no `stats` key at all
- Fields outside the curated set are dropped
- **Season detection:** a season where every player has `gp: 0` falls back to the prior
  season; a season with real games is used as-is
- `statsSeason` records the season actually used, not the one requested
- **A failing stats fetch still produces players** — the sync completes without stats rather
  than aborting

### Unit — `backend/src/players.test.js` (extend)

- A ranked player with stats returns `stats` and `statsSeason`
- An **unranked** player returns neither, even when stats exist for that id
- A ranked player with no stats returns neither key
- **A player ranked in one format but not another carries stats only on the format where
  they are ranked** — the rank sets genuinely differ, 223 for standard against 272 for PPR
- The seven existing fields are unchanged in every case

### Post-deploy

- Invoke the sync and confirm it completes
- Confirm a known ranked player carries plausible stats and the expected `statsSeason`
- Confirm an unranked player carries none
- **Measure `/players` compressed and uncompressed** against today's 51.7 KB gzipped, and
  compare to the 60.9 KB the local estimate predicted
- Confirm a real draft still creates, picks, auto-picks and sims to completion

---

## Out of Scope

- **Any frontend change.** Nothing displays these stats yet; pick-time advice consumes them
  next, and a player drill-down could later.
- **Projections.** This is history. The app still has no forecast of any kind.
- **Weekly or per-game splits.** Season totals only.
- **Historical seasons beyond the most recent complete one.** Multi-year trends are a
  separate feature with a separate storage question.
- **Stats for unranked players.** Deliberately excluded on measured payload cost.
- **Changing how bots pick.** `pickBestForTeam` does not read stats and is untouched.
