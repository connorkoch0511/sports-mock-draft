# Two lies the drill-down tells on a phone

Both of these sat on the status page's *known, accepted, written down* list. Both
were re-measured before being believed, and **both turned out to be worse than
the list said** — which is the argument for measuring an accepted item before
fixing it rather than trusting its own description.

Measured at 390x844, on `/player/:id`, against a real render.

## What the measurement says

The game log's wrapper is **266px wide inside a 390px screen** (box `61..329`).
That gutter is legitimate: `px-4` (16) + `px-6` (24) + `p-5` (20) = 60.

Every position produces **ten columns** — `WK`, the position set from
`columnsFor`, then `SNP` and `PTS`. `QB` is 4 passing + 3 rushing; `RB`, `WR` and
`TE` are 7 either way. Ten columns do not fit in 266px:

    RB @390x844   table 393px, wrapper client 266  -> 127px hidden
      YDS   9px past the visible edge
      TD   42px past
      SNP  84px past
      PTS 126px past

    QB @390x844   table 389px  -> 123px hidden   (same four columns cut)
    K  @390x844   table 266px  -> fits; 3 columns, nothing cut

**The list said two columns were cut. Four are.** And the two furthest off
screen — `SNP` and `PTS` — are the two a drafter is reading the table for: points
scored, and the usage trend that predicts opportunity. The page itself never
scrolls sideways, so that half of the item's description holds.

The KPI row's defect reproduces exactly, with a deliberately delayed route:

    during fetch   FPTS/GAME—    POS RANK—    SNAP SHARE—     kpi-season absent
    after fetch    FPTS/GAME22.6 POS RANK1    SNAP SHARE63%   kpi-season present

## An em dash is a claim, not a shrug

`detail` starts `null`, so `computeKpis` returns three nulls, and lines 175/177/181
render `—` for each. That is the same glyph the row shows for a player who
genuinely has no stats — Cameron Latu's case, which `player.spec.js:220` pins.
So one mark carries two different facts: *we know, and there is none* and *we do
not know yet*.

This is the distinction `gameLog.js` already makes twice, in its own words:
`statOrNull` exists because "a zero is a drawn mark claiming he scored nothing
this week and absence should draw no mark at all", and `snapShare` returns null
because "played no snaps and we do not know how many snaps look identical as a
zero, and only one of them is a fact". The KPI row is one layer above those and
does not yet honour the same rule.

`computeKpis` does not change — it is pure and tested. The view derives
`loading = !detail && !failed`, the condition already used at line 294 for the
game log's own "Loading…", and renders a neutral placeholder for the three
values while it holds. The placeholder makes no claim; the em dash stays for the
loaded-and-absent case it earned.

Note that `kpi-season` is already truthful here — absent during the fetch,
present after — so the row above the three stats tells the truth while the stats
themselves do not.

## The columns worth reading stop being the hidden ones

Reorder to `WK · PTS · SNP · <position detail>`, at **every width**.

    WK 37 + PTS 42 + SNP 42 = 121px   of the 266px wrapper

Both land on screen with room for two more columns, and the horizontal swipe then
reveals *detail* rather than the headline. Nothing is hidden and no breakpoint is
added.

The alternatives measure worse. Trimming `px-2` to `px-1` recovers about 80px
across ten columns and leaves `PTS` still roughly 46px short — a fix that does not
fix it. Dropping columns below a width both hides data and adds a responsive
band to the one part of this page that has none; this repo has already paid for
per-width configurations once, when the draft page's four layout bands produced
an 80px Draft Board and a four-column rule that applied at no width at all.

The cost is honest and small: on desktop, points move from last to second, where
Sleeper and Yahoo put them last. All ten columns fit on desktop either way, so
this is a convention, not a fit — and one order everywhere beats two orders
divided by a breakpoint.

## Decisions

**One column order at all widths.** Chosen over a phone-only reorder precisely
to avoid the band. See above.

**The placeholder is not an em dash, and not a spinner.** A spinner in three
adjacent boxes is noise for a fetch this short, and it would move layout. A
neutral glyph changes nothing about the row's geometry.

**`computeKpis` keeps returning null for both cases.** The loading state is a
property of the view, not of the computation — the function is given `detail` and
has no way to distinguish "not fetched" from "fetched, empty" without being told,
and telling it would push a rendering concern into a pure function.

## Testing

**The existing em-dash test is the guard.** `player.spec.js:220` asserts a loaded
player with `stats: undefined` reads `FPTS/GAME—` on all three. It must stay
green: it is what stops this fix flattening the two states back into one.

**New, at 390x844:** `PTS` and `SNP` right edges must fall within the wrapper's
right edge. Red against today's order, where they sit 126px and 84px past it.

**New, in flight:** with a delayed route, the three values show the placeholder
and **not** `—`; after it resolves they read `22.6 / 1 / 63%`.

**Mutation checks.** Reverting the loading branch must turn the in-flight test
red. Restoring the old column order must turn the geometry test red. Neither
should be believed until it has been seen to fail.

**Render it.** The numbers above came from a browser, not from the suite, and
both defects were invisible in a green suite until measured. `screenshots/player.png`
is regenerated as part of this work.

## Out of scope, and one correction

**`frontend/src/App.css` is dead.** It is never imported — `main.jsx:6` imports
only `index.css` — and none of its classes (`logo`, `card`, `read-the-docs`) is
used anywhere. It still carries the Vite scaffold's `#root` rule:
`padding: 2rem`, `max-width: 1280px`, `text-align: center`. If it were ever
imported it would centre the whole app and fight `App.jsx`'s own
`max-w-[1400px] 3xl:max-w-[1680px]` — the same class of scaffold residue
`index.css` records removing after an `h1.text-2xl` measured 51.2px. Deleting it
is zero-risk and belongs in its own change, not this one.

**The status page understates `ALLOWED_POS` too.** It says the set is "defined
identically in two files". It is three: `boards.js:18`, `drafts.js:26` and
`lib/autoPick.js:14`.

Neither of those is fixed here. Both are written down so that finding them later
is a recollection rather than a discovery.
