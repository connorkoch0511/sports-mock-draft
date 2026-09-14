# The player drill-down, rebuilt around what he did

**Status:** approved design, not yet implemented
**Scope:** `frontend/src/components/draft/PlayerDetail.jsx` and new components
beside it; `backend/src/sync/gameLogs.js`, `backend/src/syncPlayers.js`,
`backend/src/players.js`.

## The problem

Open the drill-down on Cameron Latu, a fourth-string tight end, and the three
most prominent things on screen are **ADP —, RANK —, TIER —**. The panel's
whole top half says nothing. What he actually did is a fifteen-row table
below the fold, and the interesting number in it — an 8% snap share — is in
the last column.

The KPI row is three *draft-position* numbers. They are the right numbers for
a first-rounder and useless for everybody else, which is most of the pool.
Yahoo and Sleeper both lead with production instead, and they are right to.

Separately, the log shows one season, and which one it is changes without
warning. The coverage rule decides between the completed season and the one
in progress, so in September it serves 2025 and at some point in the autumn
it starts serving 2026. There is no way to ask for the other one.

## What it becomes

```
┌──────────────────────────────────────┐
│ Cameron Latu            TE · NE  [×] │
│ Depth 4                              │
├──────────────────────────────────────┤
│  0.0        —          8%            │  KPI row: production
│  FPTS/GAME  POS RANK   SNAP SHARE    │
├──────────────────────────────────────┤
│  Summary          Game Log           │  tabs
├──────────────────────────────────────┤
│  ADP — · esp — · yah —   Tier —      │
│  ┌────────────────────────────────┐  │
│  │ Why Cameron Latu is here       │  │
│  └────────────────────────────────┘  │
│  weekly points    ▁▁▁▁▁▁▁▁▁▁▁▁      │
│  snap share       ▂▁▃▁▂▁▂▁▁▂▁▁      │
└──────────────────────────────────────┘
```

## Decisions

### Production leads; draft position follows

The KPI row becomes **FPTS/GAME · POS RANK · SNAP SHARE**, all computed from
data already stored: points over `gp`, `pos_rank_ppr`, and
`off_snp / tm_off_snp`. It is the direct analogue of Sleeper's trio, with
snap share standing in for ownership, which we do not have.

For Latu it reads `0.0 · — · 8%`. That is a real answer where three dashes
were not, and the 8% is the part worth knowing.

ADP, the per-source ADP trio, rank and tier move into the Summary tab. They
are still the reason he is on the board; they are not what you are here to
find out.

**`pos_rank_ppr` is PPR-only** — the feed publishes no equivalent for
standard or half. In those formats the KPI shows an em dash rather than a PPR
rank relabelled, for the same reason the ADP columns show a dash where a
source has not ranked someone.

### Two tabs, and the log is never abridged

**Summary** holds the draft numbers, the existing "Why he is here" card, and
the charts. **Game Log** holds the table.

Every week stays in the table, always. A run of zeros is the answer for a
player like Latu, and collapsing it would mean scrolling to find out that
nothing happened — the current failing — solved by hiding rather than by
leading with the summary. The KPI row is what saves the scroll now.

### Charts show what happened, and stop there

Two, both from the game log, both hand-rolled SVG — the app has no charting
library and these do not need one.

- **Weekly points**, as bars. Boom-versus-bust at a glance, which is a real
  draft decision and invisible in a column of numbers.
- **Snap share**, as a line. Usage is what predicts opportunity, and a rising
  or falling share tells a story the season total cannot.

**No trend lines and no extrapolation.** A player with three games gets three
marks and visible gaps, not a smoothed curve. The app says "Played 63% of
SF's offensive snaps in 2025", never "expect 65%", and a chart that implies a
forecast breaks that more convincingly than prose would, because it looks
more authoritative.

### The Game Log gets a year selector, defaulting to the current season

The selector defaults to the **current calendar season**, chosen
deliberately over the most-recent-with-data alternative: this matches what
Yahoo and Sleeper do, and it was raised and reaffirmed.

One case is handled rather than asked about: **if the current season has no
games at all** — July, before week one — the tab opens on the most recent
season that does. An empty default tab is not a useful default, and the
selector still lets you pick the empty year.

Note the consequence, so nobody is surprised by it later: during draft
season the log opens on a nearly empty year and most users will switch to the
completed one. That is the accepted cost of matching the convention.

## The backend half

### Two seasons, keyed by year

`gameLog` / `gameLogSeason` become **`gameLogs: { [season]: rows }`** plus
`gameLogThrough: { [season]: week }`. A map, not a `gameLogPrev`, so a third
season is data rather than a schema change.

No migration is needed: the sync rewrites every player nightly, so the new
shape appears with the next run. `players.js` should tolerate the old shape
until then and return the new one, so a deploy that lands before a sync does
not blank the tab.

### A completed season is immutable — fetch it once

This is the decision that makes the cost acceptable. `mergeGameLogs` fetches
eighteen weeks one at a time; doing that for two seasons doubles it to
thirty-six, and **`SyncPlayersFunction` has a 120-second timeout** already
shared with the ADP feeds, which can take ~40s of it in the worst case.

But a finished season never changes. So: fetch the current season every
night, and fetch the previous one **only when it is not already stored**.
Steady-state cost is then unchanged at eighteen fetches, with one expensive
night when the previous season is first backfilled.

That requires knowing what is already stored, which the sync does not read
today. **Whether to read the existing items or to run the backfill as a
one-off script is the implementation's main open question** — and the plan
must answer it before any code, because getting it wrong means either a
timeout every night or a sync that silently never backfills.

Either way, **measure the real duration before and after.** The 120s budget
is the constraint, and no design argument substitutes for the number.

## Testing

- The KPI row renders production for a player with a game log, and em dashes
  where a value genuinely does not exist — with `pos_rank_ppr` absent in
  standard and half formats specifically covered.
- FPTS/GAME uses the format's own points field, not PPR for everyone.
- Tabs: Summary and Game Log each show their own content; switching preserves
  the selected year.
- The game log table still renders every week, including "did not play" gaps,
  for a player whose every week is zero. Latu is the fixture worth having.
- The year selector lists the seasons actually stored, defaults to the
  current calendar season, and falls back when that season has no games.
- The charts render for a player with a partial season and do not draw marks
  where there is no data.
- Backend: two seasons stored under the map; a completed season already
  present is not re-fetched; `players.js` returns the new shape and tolerates
  the old.
- Phone: the drill-down is a modal over the draft page, which is now tabbed —
  it must fit 390×844 and not overflow horizontally, per
  `phone-fit-is-a-requirement`.

## Out of scope

- Anything requiring data we do not have: ownership and roster percentages,
  waiver availability, the managing user, betting lines, matchup narratives,
  player photographs.
- Projections of any kind.
- A third season.
- The advice engine's factors, which the Summary tab displays unchanged.
