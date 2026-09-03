# Player Drill-Down

**Date:** 2026-09-02
**Status:** Draft — awaiting approval
**Scope:** Backend sync + new endpoint + frontend modal. Reworks the Big Board
row's primary interaction.

---

## Summary

Click a player — on the draft's Big Board or in the board editor — and get a
modal with their season line, a week-by-week game log, availability, and the
reasons the advice engine already computes.

---

## Motivation

The app can already tell you *that* Jahmyr Gibbs is the pick. It cannot show
you the player. The `Why?` chip is a five-line summary with no underlying
detail, and there is nowhere in the app to answer "how has he actually been
playing lately?"

The data is available and free. Sleeper's weekly endpoint gives, for one
player in one week (Brock Bowers, week 9 2025):

```
rec 12 · rec_tgt 13 · rec_yd 127 · rec_td 3 · rec_rz_tgt 5
off_snp 52 / tm_off_snp 64 · pts_ppr 43.3
```

That is a game-log row, and eighteen of them are a season.

---

## Interaction

### The Big Board row — a deliberate change

Today the entire row is a `<button>` whose `onClick` is `makePick(p.id)`.
A single click drafts, irreversibly, with no undo.

**The row click becomes "open this player". Drafting moves to its own button
on the row.**

This was chosen knowing the cost: it adds a click to every pick, which is real
in a fast draft. It is worth it because the current arrangement makes the
destructive action the easiest one to trigger by accident, and reading about a
player — the safe action — impossible without one.

**The `Why?` chip is retired.** The modal contains everything the chip showed
and more; keeping both would mean two controls on one row that both mean "tell
me about this player". Its reasons render as a section of the modal.

### The board editor row

Every row is a drag handle (`useSortable` with `attributes` and `listeners`
spread onto it). A press that never moves should open the modal; a press that
travels should still reorder.

dnd-kit's `PointerSensor` takes an `activationConstraint`; an 8px distance
constraint means a drag only begins once the pointer has actually traveled, so
a clean click falls through to the row's `onClick`.

**The risk is a shaky click being swallowed as a tiny drag** on a list whose
only purpose is reordering. 8px is the value to start from, and the e2e test
must cover a click with a small jitter, not only a perfectly still one.

### The modal

One component, rendered in both places. Escape and a backdrop click close it;
focus moves into the dialog on open and returns to the invoking row on close.
`role="dialog"` with `aria-modal="true"` and a labelled heading.

Opening a modal must never draft anybody. That is the same promise the `Why?`
chip made in its `title`, and it survives the chip.

---

## Content

| Section | Source | Notes |
|---|---|---|
| Identity | existing | Name, position, team |
| Availability | existing | Injury status/body part, depth chart order |
| Value | existing | ADP, consensus rank, tier, your board rank, `overall − adp` delta |
| Season line | existing `stats` | The 20 curated fields already synced |
| **Game log** | **new** | Week-by-week table, the season's weeks |
| Why | existing `pickAdvice` | The reasons the engine already produces |

The game log is the only new data. Everything else is already stored and is
merely unexposed.

---

## Data

### Sync — weekly stats

Sleeper serves `/v1/stats/nfl/regular/{season}/{week}`. Measured: about
500KB per week, 18 weeks, **3.4s total** fetched serially.

The sync currently runs **4–6s against a 60s timeout** at 173MB of 512MB, so
the fetches fit. Two things eat the remaining headroom, and they are additive:
the new stale-row prune (a first run deleting ~3,061 rows in 123 batched
calls) and these 18 fetches. **`Timeout` moves from 60 to 120** — not because
a run is expected to need it, but because three separate costs now share one
budget.

**`TEAM_*` entries must be filtered.** Of week 9's 2,105 entries, **56 are
team aggregates, not players** — `TEAM_CHI` outscores every human in the feed
because its `pts_ppr` is the whole team's. Keying on numeric player ids
excludes them. Without this, team rows would be joined onto players and a game
log could show a team's offense as a player's week.

Curated per week, mirroring `STATS_FIELDS`' discipline: `wk`, `pts_ppr`,
`pts_half_ppr`, `pts_std`, `rec`, `rec_tgt`, `rec_yd`, `rec_td`, `rec_rz_tgt`,
`rush_att`, `rush_yd`, `rush_td`, `rush_rz_att`, `pass_att`, `pass_yd`,
`pass_td`, `pass_int`, `off_snp`, `tm_off_snp`.

**The interception field is `pass_int`, not `int`.** Verified against week 9:
`int` is present on **zero** players — it is a team/defensive stat, the
interceptions a defense caught. `pass_int` is on 16 quarterbacks. Curating
`int` would store nothing for any QB while looking perfectly reasonable in
the code.

### Missing and zero are different, in two different ways

Sleeper omits any stat a player did not accumulate, so both of these are
absences and they must not be rendered alike:

- **The week is absent entirely** → the player did not play. A gap in the
  log, never a row of zeroes. This is the rule `pickStats` already enforces.
- **The week is present but a field is absent** → the player played and
  recorded none of that. This renders as `0`.

Measured in week 9: `rec_td` appears on 39 players against `rec` on 200.
Treating field-absence as "did not play" would blank most of a real game log;
treating week-absence as zero would invent games nobody played.

Stored as `gameLog` on the player item — roughly 4KB per player, far inside
DynamoDB's 400KB item limit. No new table.

### Serving — a new endpoint, deliberately

**`GET /players/{playerId}` returns one player including `gameLog`.**

The game log must **not** ride along on `GET /players`. That endpoint ships
the entire pool; adding 18 rows per player would undo the payload reduction
the stale-row prune just won and slow the draft page's blocking fetch. The
modal fetches one player when it opens, which is the only time the data is
wanted.

The response is compressed by the shared `responder`, like every other
migrated endpoint.

Loading, empty, and failed states are all real and all rendered: a player with
no game log (a rookie, a DEF) shows the season line and says the log is
unavailable rather than rendering an empty table.

---

## Testing

- **Weekly curation:** `TEAM_*` entries excluded — asserted with a real
  `TEAM_CHI`-shaped fixture, since this is the defect most likely to ship
  silently. A missed week is a gap; a played week with no receiving TD shows
  `0`. Both directions asserted, because a single rule covering both is what
  would be written by mistake.
- **`pass_int` is what a QB's interceptions come from**, asserted on a
  fixture carrying both `pass_int` and a defensive `int` so picking the wrong
  one fails.
- **The endpoint:** returns `gameLog` for a known player; 404 for an unknown
  id; `GET /players` does **not** contain `gameLog` — that last one is the
  guard on the payload decision and will otherwise regress unnoticed.
- **The modal:** opens from a Big Board row and from a board row; Escape and
  backdrop close; focus enters on open and returns on close.
- **Opening the modal drafts nobody** — asserted on the network, not the UI.
- **The Draft button still drafts**, and is the only thing that does.
- **A click with a few pixels of jitter opens the modal rather than
  reordering**, and a real drag still reorders. The still-click case alone
  would pass against a broken constraint.
- Screenshots regenerate for every affected page, per the standing preference.

---

## Out of Scope

- Multi-season history and career arcs.
- A public, linkable `/player/:id` page. The modal is reachable only from the
  draft and the board by decision; a shareable page is a separate spec.
- Projections. Everything here is what happened, not what will.
- Any change to how the advice engine ranks players — the modal displays its
  reasons, it does not alter them.
