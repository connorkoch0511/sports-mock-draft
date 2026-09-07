# Multi-source ADP — design

**Status:** approved 7 September 2026. Implementation not started.

## Goal

Show ESPN's and Yahoo's average draft position beside our own, everywhere a
player is ranked or picked, so that where the sources *disagree* is visible at
a glance while drafting and while building a big board.

A player our data has at 40, ESPN has at 28 and Yahoo has at 55 is the most
interesting name on the screen. Today the app shows one number and that
disagreement is invisible.

## Not in this project

- **ESPN/Yahoo league import.** A separate project with a separate spec. It is
  an authentication problem; this one is not. Sleeper league import already
  ships and is unaffected.
- **Changing how the pool is ordered.** Our rank stays the default sort.
- **Sleeper ADP.** It does not exist publicly (see Sources).

## Decisions already made

| Decision | Made by | Value |
|---|---|---|
| Default sort | Connor | Our rank. Other sources are an optional sort, never the default. |
| Display | Connor | Every source inline on the row, not a badge and not a one-at-a-time switch. |
| Format mismatch | Connor | Show ESPN and Yahoo always, labelled honestly as platform-wide. Do not invent a scoring correction. |
| Storage | Design | Additive. `p.adp[format]` is untouched; a new `p.adpBySource` sits beside it. |

## Sources — measured, not assumed

All three are fetched **server-side in the existing daily `syncPlayers`
Lambda**. No browser calls, no API keys, no OAuth, no CORS. Two extra HTTP
requests per day.

### Ours — Fantasy Football Calculator (already shipped)

`backend/src/sync/adp.js`. Fetched once per format. Unchanged by this work.

### ESPN — no authentication required

```
GET https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<year>/segments/0/leaguedefaults/3?view=kona_player_info
Header: x-fantasy-filter: {"players":{"limit":N,"sortDraftRanks":{"sortPriority":1,"sortAsc":true,"value":"PPR"}}}
```

Verified 7 Sep 2026: HTTP 200, no credentials of any kind.

Fields, per `players[].player`:

| Field | Example | Note |
|---|---|---|
| `id` | `4429795` | ESPN's player id |
| `fullName` | `Jahmyr Gibbs` | |
| `defaultPositionId` | `2` | **numeric** |
| `proTeamId` | `8` | **numeric** |
| `ownership.averageDraftPosition` | `1.32` | the ADP we want |

Two traps, both verified:

1. **ESPN returns numeric position and team ids and no string form anywhere in
   the payload.** `proTeamAbbreviation` and `positionAbbreviation` are absent.
   The adapter must carry its own id → code lookup tables.
2. `draftRanksByRankType` contains `STANDARD` and `PPR` keys, which is
   tempting. Those are **ranks, not ADP**. The only ADP is the single
   `ownership.averageDraftPosition`, which is platform-wide.

The response is large — 199KB for five players — so the `limit` in the filter
and the size of the response both need care. Fetch only as deep as the app
drafts (see Open build questions).

### Yahoo — no authentication required

```
GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/game/nfl/players;position=ALL;start=0;count=N;sort=rank_season;out=draft_analysis?format=json
```

Verified 7 Sep 2026: HTTP 200, no credentials.

| Field | Example | Note |
|---|---|---|
| `player_id` | `40059` | Yahoo's player id |
| `full` | `Jahmyr Gibbs` | |
| `display_position` | `RB` | string |
| `editorial_team_abbr` | `Det` | **mixed case** — must be normalised |
| `average_pick` | `1.3` | the ADP we want |

The JSON is deeply and irregularly nested (numeric string keys, arrays of
mixed objects). The adapter must flatten defensively rather than index by a
fixed path.

### Sleeper — no public ADP

`GET https://api.sleeper.app/v1/players/nfl/adp` returns **404**. Sleeper
remains the player dump and the league-import source only. Do not spend time
looking for a Sleeper ADP endpoint; it was checked.

## The join, and why it is the hard part

Each source names players its own way, and the number is worthless if it lands
on the wrong player. This is the same problem the board importer solved in
`frontend/src/lib/boardMatch.js`, and it must fail the same way: **an exact
normalised match or nothing. Never a guess.**

### Sleeper's cross-reference ids are NOT sufficient — measured

Sleeper's dump carries `espn_id` and `yahoo_id`, which looks like an exact-id
join that would remove name matching entirely. It does not survive contact:

- Of the **876** draft-relevant players (active, on a team, position in
  QB/RB/WR/TE/K/DEF), only **210 (24.0%)** carry `espn_id` and **217 (24.8%)**
  carry `yahoo_id`.
- Jahmyr Gibbs — a top-three fantasy player — has **neither**.

So name matching stays primary. Where an id *is* present it may be used as a
confirming key, but nothing may depend on it.

### The rule

Each source gets a small adapter whose only job is to normalise its rows into
the map shape `backend/src/sync/adp.js` already produces and
`syncPlayers.js` already consumes:

```
{ byStrict: Map<"POS|TEAM|namekey", adp>, defByTeam: Map, kByName: Map }
```

Reusing that shape means the join and its DEF/K fallbacks are written once,
not three times, and each adapter stays independently testable.

Normalisation uses the existing `normName`, `normTeam`, `toAppPos` from
`backend/src/sync/normalize.js`. ESPN's numeric ids are translated to codes
first; Yahoo's `editorial_team_abbr` is upper-cased through `normTeam`.

**A wrong lookup table fails safe.** Because the key is position, team *and*
name together, a bad team mapping produces a miss — a dash in the UI — rather
than another player's number. That is the correct failure, and it is
detectable (see Testing).

Note some entries lack `full_name` entirely (team defences), which is exactly
why `defByTeam` already exists.

## Data model

Additive. Nothing that exists today changes shape.

```js
p.adp        = { standard: 41.2, "half-ppr": 40.5, ppr: 40.1 }  // ours, unchanged
p.adpBySource = { espn: 28.4, yahoo: 55.0 }                     // new
```

`p.adpBySource` is a flat source → number map with **no format dimension**,
because neither source publishes one. A source with no number for a player is
absent from the map rather than present as `null`, and renders as `—`.

`syncPlayers.js` rewrites the whole players table daily and `p.adp?.[format]`
is read in several places in `players.js` and `drafts.js`. Keeping `adp`
untouched means no migration, and no risk to drafts in flight. `players.js`
and `drafts.js` pass `adpBySource` through alongside the existing `adp`.

## Failure handling

`syncPlayers` already sets the precedent: the season-stats block is
deliberately wrapped so a Sleeper outage degrades to players-without-stats
rather than leaving every draft with an empty pool.

Each ADP source gets the same treatment **independently**:

- One source failing, timing out, or changing shape leaves the other two intact.
- Our own ADP is never affected by an ESPN or Yahoo failure.
- A missing number renders `—`. Never `0`, never a stale value carried
  forward, never a number from another format or player.

## UI

**Draft pool row** (`frontend/src/components/draft/BigBoardPanel.jsx`). The
second line today is `ADP 40.1` plus the delta. It becomes:

```
★3  Ja'Marr Chase
ours 4.2 · esp 4.2 · yah 3.5
[WR] [CIN] [Tier 1]

40  Jaylen Waddle
ours 40.1 · esp 28.4 · yah 55.0
[WR] [MIA] [Tier 4]
```

**Big board editor** — the same trio on each row, because that is where
ranking decisions are made.

**Labelling.** ESPN and Yahoo are platform-wide numbers, not our league's
format. The UI must say so where a person can find it (title/tooltip), and
must not imply the number tracks their scoring settings.

**Sorting.** Our rank remains the default and `frontend/src/lib/boardOrder.js`
is not modified: it already gives every player one ordinal — `myRank` when
they are on the board, consensus `rank` when they are not. A control adds
sort-by-source. Sorting by a source **reorders the list only**; every
displayed number stays the same.

Ranks from different sources are ordinals over different populations — a
caveat `boardOrder.js` already documents for `myRank` versus consensus rank.
They may therefore be displayed side by side, but must not be averaged or
subtracted into a single score.

## Testing

- **Adapters are pure map-builders** — unit-tested against real captured
  payloads from both services rather than hand-written fixtures.
- **A miss is a dash, not a wrong number**: a player present in one source and
  absent from another gets a number and a `—`.
- **Coverage test.** Assert a floor on the proportion of the top-200 pool that
  each source joins successfully. This is what catches a wrong entry in ESPN's
  numeric lookup tables, whose symptom is silent under-matching.
- **Independent degradation**: with one source's fetch failing, the other two
  and our own ADP still populate.
- **UI**: the row renders three numbers, a missing source renders `—`, and
  sorting by a source reorders without altering displayed values.

## Risks

- **Both endpoints are public but undocumented.** They can change shape or
  rate-limit without notice. Mitigated by hitting them twice a day, by
  independent failure wrapping, and by the app degrading to exactly today's
  behaviour if both vanish. This is a deliberate, accepted trade — the
  alternative is OAuth, which neither service requires for this data.
- **ESPN's lookup tables are hand-written** and can drift when the league adds
  a team or ESPN renumbers. The coverage test is the guard.
- **Payload size.** ESPN returned 199KB for five players.

## How deep to fetch — decided, and measured

**Fetch the top 300 by ADP from each source.** Beyond that, no number and a
dash.

A 12-team, 16-round draft is 192 picks. 300 covers everything anyone actually
drafts with room to spare, and the players below it are exactly the ones whose
ADP nobody consults.

Measured 7 Sep 2026:

| | Result |
|---|---|
| ESPN, `limit: 300` | HTTP 200, 300 players, **9.8 MB** |
| ESPN, `limit: 5` | 199 KB — the payload is dominated by per-player `stats` |
| Yahoo, `count: 100` | HTTP 200, 100 players — **not** capped at 25 |

So ESPN is one request per day and Yahoo is three (`start=0,100,200`).
Fetching all ~876 relevant players from ESPN would mean roughly 28 MB for
players nobody drafts; that is the reason for the cap, not an arbitrary limit.

## Open build question

**Where the sort-by-source control sits** on each of the two surfaces. The
default assumption is beside the existing position filter in the draft pool,
and above the rows in the board editor; planning may place it better. This
changes no behaviour described above.
