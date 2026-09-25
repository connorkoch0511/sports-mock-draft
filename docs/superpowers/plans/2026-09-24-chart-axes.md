# Chart Axes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the two player drill-down charts readable axes — tick values, axis names, and an x-span that does not pin an early-season sample to both edges.

**Architecture:** The chart's arithmetic moves out of the component into a pure sibling module (`weeklyChartScale.js`) so it can be unit-tested with `node --test` in milliseconds instead of through Playwright. `WeeklyChart.jsx` keeps rendering only. The viewBox grows in BOTH dimensions so the 280x80 plot area is untouched and every existing mark keeps its exact position and size.

**Tech Stack:** React 19, hand-rolled inline SVG (no charting library), `node --test` for units, Playwright for e2e, Tailwind CSS 4.

## Global Constraints

- viewBox becomes **328 x 122**; margins **top 10, right 10, left 38, bottom 32**; plot area stays exactly **280 x 80**.
- X span floors at **6 weeks**. The floor only ever RAISES a small span — `weeks = 18` must be bit-for-bit unchanged.
- Y ticks come off the real domain (`minValue`/`maxValue`), never a presumed zero: weekly points go negative.
- Snap share is **0-100** (`snapShare` in `gameLog.js`). The same-named function in `playerKpis.js` returns a **0-1 fraction** — never use it here.
- Bars measure `POINTS_FIELD[format]`, so the y-axis name is **"Points"**, never "PPR points".
- Tick glyphs are **9px in viewBox units** (renders 9.3px at 390px wide, 16.5px on desktop). 5px is unreadable on a phone.
- `chart-axis` is asserted `toHaveCount(1)` in `player.spec.js:511`. The new y-axis MUST use a different testid (`chart-axis-y`).
- Tick text is `aria-hidden="true"` — the `<svg>` already carries `role="img"` + `aria-label`.
- Baselines before this work: **366 Playwright**, **286 unit**. Every task states the expected new totals.
- Never interpolate: these changes move where marks sit, never whether a mark exists.

---

### Task 1: The scale module

**Files:**
- Create: `frontend/src/components/draft/weeklyChartScale.js`
- Test: `frontend/src/components/draft/weeklyChartScale.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `GEOM` — `{ WIDTH: 328, HEIGHT: 122, MARGIN: {top,right,bottom,left}, PLOT_WIDTH: 280, PLOT_HEIGHT: 80, BASELINE: 90 }`
  - `spanFor(totalWeeks: number) => number`
  - `xFor(wk: number, totalWeeks: number) => number`
  - `yTicks(minValue: number, maxValue: number) => number[]`
  - `xTicks(totalWeeks: number) => number[]`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/draft/weeklyChartScale.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { GEOM, spanFor, xFor, yTicks, xTicks } from "./weeklyChartScale.js";

// The plot area is the whole promise of the taller box: marks must keep the
// exact position and size they had at viewBox 300x100.
test("the gutters grow, the plot area does not", () => {
  assert.equal(GEOM.PLOT_WIDTH, 280);
  assert.equal(GEOM.PLOT_HEIGHT, 80);
  assert.equal(GEOM.WIDTH - GEOM.MARGIN.left - GEOM.MARGIN.right, 280);
  assert.equal(GEOM.HEIGHT - GEOM.MARGIN.top - GEOM.MARGIN.bottom, 80);
});

// Two weeks into a season, week 1 at t=0 and week 2 at t=1 put two marks on
// opposite edges, which reads as a broken render rather than a small sample.
test("a short season is floored to six weeks", () => {
  assert.equal(spanFor(2), 6);
  assert.equal(spanFor(1), 6);
  assert.equal(spanFor(6), 6);
});

// The floor only ever raises. A completed season must be untouched.
test("a full season is left exactly alone", () => {
  assert.equal(spanFor(18), 18);
  assert.equal(spanFor(17), 17);
});

test("week 1 sits at the left edge of the plot, not at the viewBox edge", () => {
  assert.equal(xFor(1, 18), GEOM.MARGIN.left);
});

test("the last week of the span sits at the right edge of the plot", () => {
  assert.equal(xFor(18, 18), GEOM.MARGIN.left + GEOM.PLOT_WIDTH);
});

// The point of the floor: two played weeks bunch at the left with the rest of
// the season empty ahead of them.
test("two played weeks bunch at the left instead of spanning the box", () => {
  const x2 = xFor(2, 2);
  assert.ok(
    x2 < GEOM.MARGIN.left + GEOM.PLOT_WIDTH / 2,
    `week 2 of 2 should sit in the left half, got ${x2}`
  );
});

// Weekly points go negative -- a lost fumble is -2 -- so the domain is not
// 0-to-max and the ticks must say so.
test("a negative domain is labelled from its real floor", () => {
  const ticks = yTicks(-4, 20);
  assert.equal(ticks[0], -4);
  assert.equal(ticks[ticks.length - 1], 20);
  assert.equal(ticks.length, 3);
});

test("snap share reads 0 / 50 / 100 from its fixed domain", () => {
  assert.deepStrictEqual(yTicks(0, 100), [0, 50, 100]);
});

test("tick values are integers -- no decimal noise on an 80px box", () => {
  for (const t of yTicks(0, 25)) assert.equal(Number.isInteger(t), true);
});

// At 390px wide the chart is ~340px. More than four x labels collide.
test("at most four week labels, always including the first and last", () => {
  for (const weeks of [6, 9, 14, 18]) {
    const ticks = xTicks(weeks);
    assert.ok(ticks.length <= 4, `${weeks} weeks produced ${ticks.length} labels`);
    assert.equal(ticks[0], 1);
    assert.equal(ticks[ticks.length - 1], spanFor(weeks));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx node --test src/components/draft/weeklyChartScale.test.js`
Expected: FAIL — `Cannot find module './weeklyChartScale.js'`

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/components/draft/weeklyChartScale.js`:

```js
// The chart's arithmetic, kept out of the component so it can be tested
// without a browser. WeeklyChart.jsx renders; everything that can be gotten
// wrong by a number lives here.

// Both dimensions grew when the axes arrived. A left gutter eats WIDTH, so
// keeping the box 300 wide would have shrunk the plot to 262 and moved every
// mark -- the one thing the taller box exists to avoid.
const MARGIN = { top: 10, right: 10, bottom: 32, left: 38 };
const PLOT_WIDTH = 280;
const PLOT_HEIGHT = 80;

export const GEOM = {
  WIDTH: PLOT_WIDTH + MARGIN.left + MARGIN.right,   // 328
  HEIGHT: PLOT_HEIGHT + MARGIN.top + MARGIN.bottom, // 122
  MARGIN,
  PLOT_WIDTH,
  PLOT_HEIGHT,
  BASELINE: MARGIN.top + PLOT_HEIGHT,               // 90
};

// The smallest season the x-axis will draw. Two weeks in, the real span put
// week 1 and week 2 on opposite edges of the box: a two-game sample rendered
// as a full-width chart, which reads as a fault. Floored, those two marks
// bunch at the left with the rest of the season visibly empty ahead of them --
// which is the true shape. It only ever raises, so a completed season and
// every existing test are untouched.
const MIN_SPAN_WEEKS = 6;

export function spanFor(totalWeeks) {
  const n = Number.isFinite(totalWeeks) ? totalWeeks : MIN_SPAN_WEEKS;
  return Math.max(n, MIN_SPAN_WEEKS);
}

// Position follows the real week number, not the mark's index: a three-game
// player's marks sit where those games actually fell.
export function xFor(wk, totalWeeks) {
  const weeks = spanFor(totalWeeks);
  const span = Math.max(weeks - 1, 1);
  const t = weeks > 1 ? (wk - 1) / span : 0.5;
  return MARGIN.left + t * PLOT_WIDTH;
}

// Three values: the domain's real floor, its midpoint, its top. Integers,
// because a decimal on an 80px-tall box is noise. The floor is NOT assumed to
// be zero -- weekly points go negative.
export function yTicks(minValue, maxValue) {
  const lo = Math.round(minValue);
  const hi = Math.round(maxValue);
  if (lo === hi) return [lo];
  return [lo, Math.round((lo + hi) / 2), hi];
}

// At most four labels: at 390px wide the chart is ~340px and a fifth collides.
// Always the first and last week of the span, with evenly spaced weeks between.
export function xTicks(totalWeeks) {
  const weeks = spanFor(totalWeeks);
  if (weeks <= 4) return Array.from({ length: weeks }, (_, i) => i + 1);
  const step = (weeks - 1) / 3;
  const out = [1, Math.round(1 + step), Math.round(1 + step * 2), weeks];
  return [...new Set(out)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx node --test src/components/draft/weeklyChartScale.test.js`
Expected: PASS, 11 tests.

Then the whole unit suite: `cd frontend && npm run test:unit`
Expected: `pass 297` (286 baseline + 11), `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/draft/weeklyChartScale.js frontend/src/components/draft/weeklyChartScale.test.js
git commit -m "feat: the chart's arithmetic, out where it can be tested

Pure geometry -- the 328x122 viewBox whose 280x80 plot is unchanged, the
six-week floor on the x span, and the tick values. Ten unit tests that run in
milliseconds instead of through a browser; the component had none.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Axes, ticks, and the taller box

**Files:**
- Modify: `frontend/src/components/draft/WeeklyChart.jsx:14-30` (replace the local constants and `xFor` with imports)
- Modify: `frontend/src/components/draft/WeeklyChart.jsx:84-123` (comment, viewBox, axis block)
- Test: `frontend/tests/player.spec.js` (add to the existing `summary tab charts` describe)

**Interfaces:**
- Consumes: `GEOM`, `xFor`, `yTicks`, `xTicks` from `./weeklyChartScale.js` (Task 1).
- Produces: a `yLabel` prop on `WeeklyChart` (string, optional) consumed by Task 3; DOM testids `chart-axis-y`, `chart-tick-y`, `chart-tick-x`, `chart-axis-name-x`, `chart-axis-name-y`.

- [ ] **Step 1: Write the failing test**

Append inside the `test.describe("summary tab charts", ...)` block in `frontend/tests/player.spec.js`, before its closing `});`:

```js
    // The reported defect: marks drawn against an unlabelled baseline. A line
    // climbing gently is equally consistent with 40->45% and 5->90%, and the
    // chart offered no way to tell which.
    test("each chart names both axes and shows a scale", async ({ page }) => {
      await mockPlayer(page);
      await page.goto(`/player/${PLAYER.id}`);

      const points = page.getByTestId("weekly-points-chart");
      await expect(points.getByTestId("chart-axis-name-y")).toHaveText("Points");
      await expect(points.getByTestId("chart-axis-name-x")).toHaveText("Week");
      await expect(points.getByTestId("chart-tick-y")).not.toHaveCount(0);
      await expect(points.getByTestId("chart-tick-x")).not.toHaveCount(0);

      // Snap share is a percentage on a fixed 0-100 domain: the whole reason
      // it does not auto-scale is that a 16% ceiling and a 96% ceiling drew
      // the identical line.
      const snaps = page.getByTestId("snap-share-chart");
      await expect(snaps.getByTestId("chart-axis-name-y")).toHaveText("Snap %");
      await expect(snaps.getByTestId("chart-tick-y").first()).toHaveText("0");
      await expect(snaps.getByTestId("chart-tick-y").last()).toHaveText("100");
    });

    // chart-axis is asserted toHaveCount(1) elsewhere in this file. The y-axis
    // is a second line and must not borrow that testid.
    test("the y-axis is its own element, leaving the baseline assertion intact", async ({ page }) => {
      await mockPlayer(page);
      await page.goto(`/player/${PLAYER.id}`);

      const chart = page.getByTestId("weekly-points-chart");
      await expect(chart.getByTestId("chart-axis")).toHaveCount(1);
      await expect(chart.getByTestId("chart-axis-y")).toHaveCount(1);
    });

    // At most four, or they collide at 390px.
    test("the week labels never crowd the phone width", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await mockPlayer(page);
      await page.goto(`/player/${PLAYER.id}`);

      const ticks = page.getByTestId("weekly-points-chart").getByTestId("chart-tick-x");
      expect(await ticks.count()).toBeLessThanOrEqual(4);

      // And the drawing still fits its column, which is what preserveAspectRatio
      // is for -- a wider viewBox must not introduce horizontal overflow.
      const fits = await page.evaluate(() => {
        const svg = document.querySelector('[data-testid="weekly-points-chart"] svg');
        const box = svg.parentElement.getBoundingClientRect();
        return Math.round(svg.getBoundingClientRect().width) <= Math.round(box.width) + 1;
      });
      expect(fits, "the chart must not overflow its container at 390px").toBe(true);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx playwright test tests/player.spec.js -g "names both axes" --reporter=list`
Expected: FAIL — `element(s) not found` for `chart-axis-name-y`.

- [ ] **Step 3: Write minimal implementation**

In `WeeklyChart.jsx`, replace lines 14-30 (the constants block and the local `xFor`) with:

```js
import { GEOM, xFor, yTicks, xTicks } from "./weeklyChartScale.js";

const { WIDTH, HEIGHT, MARGIN, PLOT_HEIGHT, BASELINE } = GEOM;
```

Change the signature on line 46 to accept the new prop:

```js
export function WeeklyChart({ rows, valueOf, kind, weeks = 18, label, testId, domainMax, yLabel }) {
```

Replace the stale comment at lines 85-90 — it names a box that no longer exists:

```jsx
      {/*
        preserveAspectRatio scales the fixed 328x122 drawing down to whatever
        width the modal gives it -- as narrow as ~340px at 390px wide -- with
        no horizontal overflow. The viewBox's margins are gutters now, not just
        clearance: 38 on the left for the y scale and its name, 32 at the
        bottom for the week numbers and "Week". The plot inside them is still
        exactly 280x80, so every mark sits where it always did.
      */}
```

Change the `viewBox` on line 102 — it already interpolates `WIDTH`/`HEIGHT`, so it needs no edit once the constants come from `GEOM`. Verify it reads:

```jsx
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
```

Immediately AFTER the existing `chart-axis` `<line>` (which ends at line 123), add the y-axis, the ticks, and the names:

```jsx
        {/* The vertical axis. Its own testid: chart-axis is asserted as
            exactly one element, and the baseline is what distinguishes
            "played and scored nothing" from "did not play". */}
        <line
          data-testid="chart-axis-y"
          x1={MARGIN.left}
          y1={MARGIN.top}
          x2={MARGIN.left}
          y2={BASELINE}
          stroke="#3f3f46"
          strokeWidth="1"
          fill="none"
        />

        {/* Ticks are decoration over the svg's own aria-label -- a reader
            hearing "0 50 100 Week" between the caption and the data gets
            noise, not meaning. 9px in viewBox units renders 9.3px at 390px
            wide and 16.5px on desktop; 5px is unreadable on a phone. */}
        {yTicks(minValue, maxValue).map((t) => (
          <text
            key={`y-${t}`}
            data-testid="chart-tick-y"
            aria-hidden="true"
            x={MARGIN.left - 4}
            y={yFor(t) + 3}
            textAnchor="end"
            fontSize="9"
            fill="#71717a"
          >
            {t}
          </text>
        ))}

        {xTicks(weeks).map((wk) => (
          <text
            key={`x-${wk}`}
            data-testid="chart-tick-x"
            aria-hidden="true"
            x={xFor(wk, weeks)}
            y={BASELINE + 12}
            textAnchor="middle"
            fontSize="9"
            fill="#71717a"
          >
            {wk}
          </text>
        ))}

        <text
          data-testid="chart-axis-name-x"
          aria-hidden="true"
          x={MARGIN.left + GEOM.PLOT_WIDTH / 2}
          y={HEIGHT - 4}
          textAnchor="middle"
          fontSize="9"
          fill="#a1a1aa"
        >
          Week
        </text>

        {yLabel ? (
          <text
            data-testid="chart-axis-name-y"
            aria-hidden="true"
            transform={`rotate(-90 10 ${MARGIN.top + PLOT_HEIGHT / 2})`}
            x={10}
            y={MARGIN.top + PLOT_HEIGHT / 2}
            textAnchor="middle"
            fontSize="9"
            fill="#a1a1aa"
          >
            {yLabel}
          </text>
        ) : null}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx playwright test tests/player.spec.js --reporter=list`
Expected: the three new tests PASS. `chart-axis-name-y` will still fail until Task 3 passes `yLabel` — if so, run only the two that do not need it:

Run: `cd frontend && npx playwright test tests/player.spec.js -g "y-axis is its own element|never crowd" --reporter=list`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/draft/WeeklyChart.jsx frontend/tests/player.spec.js
git commit -m "feat: axes the charts can be read against

The viewBox grows 300x100 -> 328x122, all of it gutter: the plot stays exactly
280x80 so every mark keeps its position and size. Adds a y-axis line, three y
ticks off the REAL domain (weekly points go negative, so it is not 0-to-max),
at most four week labels, and the axis names.

chart-axis-y, not chart-axis: the baseline is asserted as exactly one element
and still is.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The axis names, from the call sites

**Files:**
- Modify: `frontend/src/components/draft/PlayerDetail.jsx:264-276` (weekly points chart)
- Modify: `frontend/src/components/draft/PlayerDetail.jsx:278-289` (snap share chart)

**Interfaces:**
- Consumes: the `yLabel` prop on `WeeklyChart` (Task 2).
- Produces: nothing downstream.

- [ ] **Step 1: Run the failing test**

The assertion already exists from Task 2.

Run: `cd frontend && npx playwright test tests/player.spec.js -g "names both axes" --reporter=list`
Expected: FAIL — `chart-axis-name-y` not found, because no caller passes `yLabel` yet.

- [ ] **Step 2: Write minimal implementation**

In `PlayerDetail.jsx`, add one prop to the weekly points chart (after `kind="bars"`):

```jsx
                // "Points", not "PPR points": the bars follow the league's own
                // scoring via POINTS_FIELD[format], and hard-coding PPR here
                // is a bug this component already fixed once.
                yLabel="Points"
```

And to the snap share chart (after `kind="line"`):

```jsx
                // snapShare() in gameLog.js returns 0-100. The same-named
                // function in playerKpis.js returns a 0-1 fraction -- naming
                // this axis from that one would put a wrong scale under a
                // right-looking line.
                yLabel="Snap %"
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd frontend && npx playwright test tests/player.spec.js --reporter=list`
Expected: all tests in the file PASS, including all three added in Task 2.

- [ ] **Step 4: Mutation check**

Delete the `yLabel="Points"` line, re-run, confirm the axis-names test goes RED, then restore it.

Run: `cd frontend && npx playwright test tests/player.spec.js -g "names both axes" --reporter=list`
Expected: FAIL while removed, PASS once restored.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/draft/PlayerDetail.jsx
git commit -m "feat: name each chart's vertical axis at the call site

Points for the bars -- the league's own scoring, not PPR -- and Snap % for the
line, whose 0-100 comes from gameLog's snapShare and not from the 0-1 function
of the same name in playerKpis.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Verify everything and refresh the shipped screenshot

**Files:**
- Modify: `screenshots/player.png` (regenerated by the suite, not by hand)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Run the full unit suite**

Run: `cd frontend && npm run test:unit`
Expected: `pass 297`, `fail 0`.

- [ ] **Step 2: Run the full Playwright suite**

Run: `cd frontend && caffeinate -dimsu npx playwright test --reporter=list 2>&1 | tail -12`
Expected: `369 passed` (366 baseline + 3 from Task 2). Check the total against `npx playwright test --list` — a short pass count with exit 0 means the run truncated, not that it passed.

`drilldown.spec.js:317` regenerates `screenshots/player.png` at 1280x900 on the Summary tab, which is deliberately framed on the charts. It will differ, and that is the intended outcome of this work.

- [ ] **Step 3: Confirm the screenshot actually changed**

Run: `cd /Users/connor/projects/sports-mock-draft && git status --short screenshots/`
Expected: `M screenshots/player.png`. If it is unchanged, the charts did not visibly change and something is wrong — investigate before continuing.

- [ ] **Step 4: Lint**

Run: `cd frontend && npx eslint src/components/draft/WeeklyChart.jsx src/components/draft/weeklyChartScale.js src/components/draft/weeklyChartScale.test.js src/components/draft/PlayerDetail.jsx tests/player.spec.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add screenshots/player.png
git commit -m "chore: refresh the drill-down screenshot for the labelled charts

The shot is framed on the Summary tab's charts at 1280x900 and they now carry
axes, so the committed image changes with them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Note:** `screenshots/analysis.png` was already modified before this branch began. Do NOT stage it.

---

## Self-Review

**Spec coverage:** viewBox growth → Task 2. Plot area preserved → Task 1 test + Task 2. Y axis names/units → Task 3. Y ticks off the real domain → Task 1 (`yTicks`) + Task 2. Snap share 0/50/100 → Task 1 test + Task 2 test. Six-week floor → Task 1 (`spanFor`). Testable module → Task 1. Ticks capped at 4 → Task 1 (`xTicks`) + Task 2 phone test. `chart-axis` tripwire → Task 2 dedicated test. `aria-hidden` → Task 2. Screenshot refresh → Task 4. Every spec section maps to a task.

**Placeholder scan:** none — every code step carries the code.

**Type consistency:** `GEOM`, `spanFor`, `xFor`, `yTicks`, `xTicks` are defined in Task 1 and used under those exact names in Task 2. `yLabel` is introduced in Task 2's signature and passed in Task 3. `minValue`/`maxValue`/`yFor` referenced in Task 2's tick code already exist in `WeeklyChart.jsx` at lines 57-64.

**Out of scope, deliberately:** the duplicate `snapShare` name across `gameLog.js` and `playerKpis.js`. It is a real trap, it is recorded in both the spec and Task 3's comment, and renaming it touches the KPI row — a separate change.
