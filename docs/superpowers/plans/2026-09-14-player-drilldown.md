# Player Drill-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The drill-down leads with what a player did, not where he is drafted; the game log covers two seasons with a year selector.

**Architecture:** Backend keeps two seasons under `gameLogs: { [season]: rows }`. Frontend splits the modal into a production KPI row, a Summary tab and a Game Log tab, with two hand-rolled SVG charts.

**Tech Stack:** Node 24 CommonJS backend (`node --test`), React 19 + Tailwind 4 frontend, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-14-player-drilldown-design.md`

## The open question the spec left, answered

**How does the sync avoid re-fetching a season that never changes?**

It does not. We fetch both seasons every night and raise the Lambda timeout.

The investigation that settles it: `syncPlayers.js:250` writes with
`PutRequest`, a **full item replace**, and the sync never reads existing
items. So a one-off backfill script is impossible — the next nightly run
erases it. The only ways to keep a stored season are to fetch it again, or to
read all ~900 items back and carry their rows forward before writing.

The read-and-carry-forward version is more efficient and considerably more
code: a paginated scan of several MB, a rule for deciding when the stored
copy is trustworthy, and a new failure mode where a partial scan silently
drops history for the players it missed. Fetching twice costs eighteen extra
HTTP calls of a feed we already fetch, on a job that runs once a night with
nothing waiting on it.

**`SyncPlayersFunction`'s 120-second timeout is the only real obstacle, and it
is an arbitrary number, not a physical one.** Raise it. Task 1 measures the
actual duration first so the new value is chosen from evidence.

If the measured duration ever makes this painful, carrying rows forward is
the optimization — recorded here so the reasoning is not lost, and
deliberately not built now.

## Global Constraints

- **No projections, anywhere.** Charts plot what happened: a player with
  three games gets three marks and visible gaps, never a smoothed curve or a
  trend line. This is the rule the advice engine lives by.
- **Absent stays absent.** `pos_rank_ppr` exists only for PPR; standard and
  half formats show an em dash rather than a PPR rank relabelled. Same rule
  the ADP columns already follow.
- The game log table renders **every** week, always, including "did not play"
  gaps. No collapsing, no disclosure, no abridgement.
- FPTS/GAME uses the format's own points field (`pts_ppr` / `pts_half_ppr` /
  `pts_std`), never PPR for everyone.
- The drill-down is a modal over the now-tabbed draft page: it must fit
  390×844 and never overflow horizontally.
- Backend suite is `node --test`; run it from `backend/`. Frontend is
  Playwright — the controller owns the full suite (`caffeinate -i npm test`,
  total compared with `npx playwright test --list`); implementers run focused
  `-g` subsets only.
- Never edit the working tree while a test run is in flight.

---

### Task 1: Measure the sync, then store two seasons

**Files:**
- Modify: `backend/src/sync/gameLogs.js`, `backend/src/syncPlayers.js`, `backend/template.yaml`
- Test: `backend/src/__tests__/syncPlayers.test.js` (or the existing game-log test file)

**Interfaces:**
- Produces: player items carrying `gameLogs: { [season]: rows }` and
  `gameLogThrough: { [season]: week }`. Task 2 reads these.

- [ ] **Step 1: Measure what the sync costs today**

Before changing anything, get the number the timeout decision rests on.

```bash
cd backend && aws logs filter-log-events \
  --log-group-name /aws/lambda/$(aws cloudformation describe-stack-resource \
    --stack-name sports-mock-draft --logical-resource-id SyncPlayersFunction \
    --query 'StackResourceDetail.PhysicalResourceId' --output text) \
  --filter-pattern 'REPORT' --max-items 10 \
  --query 'events[].message' --output text
```

Record the `Duration` and `Max Memory Used` values in your report. If no
REPORT lines are available, say so — do not guess a number.

- [ ] **Step 2: Write the failing test**

Add to the backend game-log tests:

```js
test("keeps both seasons, keyed by year", async () => {
  const players = [{ id: "1", name: "A" }];
  const fetchWeek = async (season, week) =>
    week <= 2 ? { "1": { pts_ppr: season === 2026 ? 10 : 20, off_snp: 30, tm_off_snp: 60 } } : {};

  await mergeGameLogs(players, 2026, fetchWeek);
  await mergeGameLogs(players, 2025, fetchWeek);

  assert.deepEqual(Object.keys(players[0].gameLogs).sort(), ["2025", "2026"]);
  assert.equal(players[0].gameLogs["2026"][0].pts_ppr, 10);
  assert.equal(players[0].gameLogs["2025"][0].pts_ppr, 20);
  assert.equal(players[0].gameLogThrough["2026"], 2);
  // The single-season keys are gone: two seasons cannot share one of them.
  assert.equal(players[0].gameLog, undefined);
  assert.equal(players[0].gameLogSeason, undefined);
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd backend && node --test src/__tests__/ 2>&1 | tail -20
```

Expected: FAIL — `gameLogs` is undefined; the current code writes `gameLog`.

- [ ] **Step 4: Key the merge by season**

In `backend/src/sync/gameLogs.js`, the accumulate and finalize steps change
from one season to a map. Where it currently pushes into `player.gameLog` and
then sets `gameLogSeason` / `gameLogThrough`, write instead:

```js
      ((player.gameLogs ||= {})[season] ||= []).push(row);
```

and in the finalize loop:

```js
    if (p.gameLogs?.[season]) {
      p.gameLogs[season].sort((a, b) => a.wk - b.wk);
      (p.gameLogThrough ||= {})[season] = lastWeekWithData;
    }
```

Delete the `gameLog` / `gameLogSeason` assignments. Two seasons cannot share
a single-season key, and leaving them would mean two sources of truth.

- [ ] **Step 5: Fetch both seasons**

In `backend/src/syncPlayers.js`, replace the single call at ~line 193:

```js
    const logs = await mergeGameLogs(basePlayers, resolved.season);
```

with:

```js
    // Both the season the stats resolved to and the calendar season, so the
    // drill-down's year selector has something to select. They are the same
    // year for most of the season; when they differ -- which is the whole
    // autumn, while the new season is still thin -- we want both.
    const currentSeason = STATS_YEAR;
    const seasons = [...new Set([resolved.season, currentSeason])];
    let logs = { weeksLoaded: 0, playersWithLog: 0 };
    for (const season of seasons) {
      const r = await mergeGameLogs(basePlayers, season);
      logs = {
        weeksLoaded: logs.weeksLoaded + r.weeksLoaded,
        playersWithLog: Math.max(logs.playersWithLog, r.playersWithLog),
      };
    }
```

- [ ] **Step 6: Raise the timeout**

In `backend/template.yaml`, `SyncPlayersFunction`:

```yaml
      Timeout: 120
```

becomes:

```yaml
      # Two seasons of game logs is ~36 week-fetches, against ~18 before, on
      # top of three ADP feeds that can take ~40s between them. Nothing waits
      # on this job -- it runs once a night -- so the ceiling is generous
      # rather than tight. See Step 1's measured duration in the task report.
      Timeout: 300
```

- [ ] **Step 7: Run the backend suite**

```bash
cd backend && node --test src/__tests__/ 2>&1 | tail -8
```

Expected: all pass, including the new test. Report the pass count; it must
be the previous count plus the tests you added, with **no existing test
edited**. If an existing test needed editing, STOP and report — it means the
single-season keys are load-bearing somewhere this plan did not account for.

- [ ] **Step 8: Validate the template**

```bash
cd backend && sam validate --lint 2>&1 | tail -3
```

Expected: valid.

- [ ] **Step 9: Commit**

```bash
git add backend/src/sync/gameLogs.js backend/src/syncPlayers.js backend/template.yaml backend/src/__tests__
git commit -m "feat: the sync keeps two seasons of game logs"
```

---

### Task 2: The API returns both seasons

**Files:**
- Modify: `backend/src/players.js`
- Test: the existing players tests

**Interfaces:**
- Consumes: Task 1's `gameLogs` / `gameLogThrough` maps.
- Produces: the detail response carries `gameLogs` and `gameLogThrough` as
  maps. Frontend tasks read these.

- [ ] **Step 1: Write the failing tests**

```js
test("returns every stored season", () => {
  const out = detailOf({
    id: "1", name: "A",
    gameLogs: { 2025: [{ wk: 1, pts_ppr: 9 }], 2026: [{ wk: 1, pts_ppr: 3 }] },
    gameLogThrough: { 2025: 18, 2026: 2 },
  });
  assert.deepEqual(Object.keys(out.gameLogs).sort(), ["2025", "2026"]);
  assert.equal(out.gameLogThrough["2026"], 2);
});

// A deploy can land before the night's sync rewrites the table, and a blank
// game log for a day is a worse bug than a little tolerance here.
test("tolerates an item still in the single-season shape", () => {
  const out = detailOf({
    id: "1", name: "A",
    gameLog: [{ wk: 1, pts_ppr: 9 }], gameLogSeason: 2025, gameLogThrough: 18,
  });
  assert.deepEqual(Object.keys(out.gameLogs), ["2025"]);
  assert.equal(out.gameLogThrough["2025"], 18);
});
```

Use whatever the test file already calls the detail-shaping function; the
plan's `detailOf` is a stand-in for it.

- [ ] **Step 2: Run and watch them fail**

```bash
cd backend && node --test src/__tests__/ 2>&1 | tail -20
```

Expected: FAIL on both — `out.gameLogs` is undefined.

- [ ] **Step 3: Return the maps, tolerating the old shape**

In `backend/src/players.js`, replace the game-log block:

```js
  if (Array.isArray(p.gameLog) && p.gameLog.length > 0) {
    out.gameLog = p.gameLog;
    out.gameLogSeason = p.gameLogSeason ?? null;
    out.gameLogThrough = p.gameLogThrough ?? null;
  }
```

with:

```js
  // Two shapes for one deploy's worth of time: the sync rewrites every item
  // nightly, so the old single-season keys vanish with the next run. Reading
  // both means a deploy that lands before that run does not blank the tab.
  if (p.gameLogs && typeof p.gameLogs === "object") {
    out.gameLogs = p.gameLogs;
    out.gameLogThrough = p.gameLogThrough ?? {};
  } else if (Array.isArray(p.gameLog) && p.gameLog.length > 0 && p.gameLogSeason) {
    out.gameLogs = { [p.gameLogSeason]: p.gameLog };
    out.gameLogThrough = { [p.gameLogSeason]: p.gameLogThrough ?? null };
  }
```

- [ ] **Step 4: Run the suite**

```bash
cd backend && node --test src/__tests__/ 2>&1 | tail -8
```

Expected: all pass, no existing test edited.

- [ ] **Step 5: Commit**

```bash
git add backend/src/players.js backend/src/__tests__
git commit -m "feat: the player detail returns every stored season"
```

---

### Task 3: A KPI row about production

**Files:**
- Create: `frontend/src/components/draft/playerKpis.js`, `frontend/src/components/draft/playerKpis.test.js`
- Modify: `frontend/src/components/draft/PlayerDetail.jsx`
- Test: `frontend/tests/player.spec.js` (the existing drill-down spec)

**Interfaces:**
- Produces: `computeKpis(detail, format)` → `{ fptsPerGame, posRank, snapShare }`,
  each a number or `null`. Task 5's charts use the same game-log rows but not
  this function.

- [ ] **Step 1: Write the failing unit tests**

Create `frontend/src/components/draft/playerKpis.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { computeKpis } from "./playerKpis.js";

test("divides the format's own points by games played", () => {
  const d = { stats: { gp: 10, pts_ppr: 150, pts_half_ppr: 120, pts_std: 90 } };
  assert.equal(computeKpis(d, "ppr").fptsPerGame, 15);
  assert.equal(computeKpis(d, "half").fptsPerGame, 12);
  assert.equal(computeKpis(d, "standard").fptsPerGame, 9);
});

// The feed publishes a positional rank for PPR and nothing else. Showing it
// under another format would be relabelling, which is the one thing the ADP
// columns refuse to do.
test("offers a positional rank only in PPR", () => {
  const d = { stats: { gp: 10, pts_ppr: 150, pos_rank_ppr: 4 } };
  assert.equal(computeKpis(d, "ppr").posRank, 4);
  assert.equal(computeKpis(d, "half").posRank, null);
  assert.equal(computeKpis(d, "standard").posRank, null);
});

test("reads snap share as a share, not a count", () => {
  const k = computeKpis({ stats: { gp: 4, off_snp: 120, tm_off_snp: 400 } }, "ppr");
  assert.ok(Math.abs(k.snapShare - 0.3) < 1e-9);
});

// Latu's case: fifteen games, nothing in any of them. Zero is an answer and
// null is not -- they must not collapse into the same em dash.
test("keeps a real zero distinct from no data", () => {
  const played = computeKpis({ stats: { gp: 15, pts_ppr: 0, off_snp: 40, tm_off_snp: 500 } }, "ppr");
  assert.equal(played.fptsPerGame, 0);
  assert.ok(Math.abs(played.snapShare - 0.08) < 1e-9);

  const nothing = computeKpis({}, "ppr");
  assert.equal(nothing.fptsPerGame, null);
  assert.equal(nothing.snapShare, null);
});

test("never divides by zero games", () => {
  assert.equal(computeKpis({ stats: { gp: 0, pts_ppr: 0 } }, "ppr").fptsPerGame, null);
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd frontend && node --test "src/components/draft/playerKpis.test.js"
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

Create `frontend/src/components/draft/playerKpis.js`:

```js
// The drill-down used to lead with ADP, rank and tier -- three draft-position
// numbers, all of them an em dash for most of the pool. These are what a
// fourth-string tight end actually has: what he scored, where that ranked,
// and how often he was on the field.

const POINTS_FIELD = {
  ppr: "pts_ppr",
  half: "pts_half_ppr",
  standard: "pts_std",
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function computeKpis(detail, format) {
  const s = detail?.stats;
  const gp = num(s?.gp);

  const points = num(s?.[POINTS_FIELD[format] ?? POINTS_FIELD.standard]);
  const fptsPerGame = gp && gp > 0 && points !== null ? points / gp : null;

  // PPR only: the feed publishes no equivalent for the other formats, and a
  // PPR rank shown under "standard" would be a lie with a number attached.
  const posRank = format === "ppr" ? num(s?.pos_rank_ppr) : null;

  const off = num(s?.off_snp);
  const team = num(s?.tm_off_snp);
  const snapShare = off !== null && team !== null && team > 0 ? off / team : null;

  return { fptsPerGame, posRank, snapShare };
}
```

- [ ] **Step 4: Run and watch them pass**

```bash
cd frontend && node --test "src/components/draft/playerKpis.test.js"
```

Expected: all pass.

- [ ] **Step 5: Put the KPIs in the modal**

In `PlayerDetail.jsx`, replace the ADP / RANK / TIER trio with the production
trio. Keep the existing three-cell markup and testids where they exist; the
cells become:

| Label | Value | Empty |
| --- | --- | --- |
| `FPTS/GAME` | one decimal | `—` |
| `POS RANK` | the number | `—` |
| `SNAP SHARE` | whole percent | `—` |

Give the row `data-testid="player-kpis"` and each cell
`data-testid="kpi-fpts"`, `kpi-posrank`, `kpi-snapshare`.

ADP, the per-source trio, rank and tier move into the Summary tab in Task 4;
until then, render them directly below the KPI row so nothing is lost between
tasks.

- [ ] **Step 6: Add the browser test**

In `frontend/tests/player.spec.js`, add a test that a player with a game log
shows production values, and one that a player with no stats shows three em
dashes and not three zeros.

- [ ] **Step 7: Run the drill-down spec**

```bash
cd frontend && npx playwright test tests/player.spec.js
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/draft/playerKpis.js frontend/src/components/draft/playerKpis.test.js frontend/src/components/draft/PlayerDetail.jsx frontend/tests/player.spec.js
git commit -m "feat: the drill-down leads with production, not draft position"
```

---

### Task 4: Summary and Game Log tabs, with a year selector

**Files:**
- Modify: `frontend/src/components/draft/PlayerDetail.jsx`
- Test: `frontend/tests/player.spec.js`

**Interfaces:**
- Consumes: Task 2's `gameLogs` map, Task 3's KPI row.
- Produces: a `season` state the Game Log tab renders from. Task 5's charts
  read the same selected season.

- [ ] **Step 1: Write the failing tests**

Cover, in `tests/player.spec.js`:

- Summary is the opening tab and holds the ADP trio, tier and the "Why he is
  here" card.
- Game Log holds the table; switching tabs and back keeps the selected year.
- The selector lists exactly the seasons present in `gameLogs`.
- With both 2025 and 2026 stored, it opens on **2026** — the current calendar
  season, per the spec's explicit choice.
- With only 2025 stored, it opens on 2025 rather than an empty 2026.
- Every week renders, including "did not play" rows, for an all-zero player.

Build the all-zero fixture from Cameron Latu's real shape: fifteen weeks of
zeros with snap shares between 1% and 16%, and two "did not play" weeks.

- [ ] **Step 2: Run and watch them fail**

```bash
cd frontend && npx playwright test tests/player.spec.js -g "tab|season|year"
```

Expected: FAIL — no tabs exist.

- [ ] **Step 3: Add the tabs and the selector**

Two tabs, `data-testid="tab-summary"` and `tab-gamelog`, with
`data-testid="player-tabs"` on the container. The Game Log tab carries a
`<select data-testid="season-select">` listing `Object.keys(detail.gameLogs)`
in descending order.

Default season:

```jsx
  // The current calendar season, deliberately -- it is what Yahoo and Sleeper
  // do, and it was chosen knowing that during draft season it opens on a
  // nearly empty year. The fallback is not a second guess at the rule: a
  // season with no games at all is not a useful default, and the selector
  // still offers it.
  const seasons = Object.keys(detail?.gameLogs ?? {}).sort((a, b) => b - a);
  const current = String(new Date().getFullYear());
  const defaultSeason = seasons.includes(current) ? current : seasons[0];
```

- [ ] **Step 4: Run the spec**

```bash
cd frontend && npx playwright test tests/player.spec.js
```

Expected: all pass.

- [ ] **Step 5: Prove the default is load-bearing**

Change `defaultSeason` to `seasons[0]` unconditionally and confirm the
"opens on the current calendar season" test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/draft/PlayerDetail.jsx frontend/tests/player.spec.js
git commit -m "feat: the drill-down has tabs and a season selector"
```

---

### Task 5: Two charts that do not predict anything

**Files:**
- Create: `frontend/src/components/draft/WeeklyChart.jsx`
- Modify: `frontend/src/components/draft/PlayerDetail.jsx`
- Test: `frontend/tests/player.spec.js`

**Interfaces:**
- Consumes: the selected season's rows from Task 4.

- [ ] **Step 1: Write the failing tests**

- The points chart draws one bar per week **with data**, and no bar for a
  "did not play" week — a gap, not a zero.
- The snap-share chart draws a point per played week.
- A player with three games gets three marks, not eighteen.
- An all-zero player still renders bars at zero height with the axis intact,
  because "he played and scored nothing" differs from "he did not play".
- Neither chart renders any element for a projected or interpolated value —
  assert the mark count equals the played-week count exactly.

- [ ] **Step 2: Run and watch them fail**

```bash
cd frontend && npx playwright test tests/player.spec.js -g "chart"
```

Expected: FAIL — no chart exists.

- [ ] **Step 3: Write the chart**

Create `WeeklyChart.jsx`: a hand-rolled inline SVG taking
`{ rows, valueOf, kind }` where `kind` is `"bars"` or `"line"`. No library —
the app has none and these do not need one. Requirements:

- One mark per row that has a value; nothing drawn where there is none.
- `data-testid="chart-mark"` on every mark, so tests can count them.
- The SVG's `viewBox` leaves room for the outermost marks.
- `preserveAspectRatio` set so it scales inside the modal at 390px wide.
- No path smoothing, no line of best fit, no dashed continuation past the
  last played week.

- [ ] **Step 4: Put both charts on the Summary tab**

Weekly points as bars, snap share as a line, each with a short label saying
which season it covers.

- [ ] **Step 5: Run the spec, then look at it**

```bash
cd frontend && npx playwright test tests/player.spec.js
```

Then render the modal at 390×844 and at desktop width, screenshot both, and
confirm the charts are legible and nothing overflows. Report the measured
width of the modal against the viewport. **This branch's predecessor shipped
two geometry defects that every test passed over; do not skip this.**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/draft/WeeklyChart.jsx frontend/src/components/draft/PlayerDetail.jsx frontend/tests/player.spec.js
git commit -m "feat: weekly points and snap share, drawn"
```

---

## After all five tasks

The controller runs the full Playwright suite under `caffeinate` and the
backend suite, checks which screenshots changed, and deploys — this is the
first project in a while that touches the backend, so the deploy is
`sam build && sam deploy` with the full parameter set from the README, then
the frontend. Verify the sync's real duration against the new timeout after
the first nightly run.
