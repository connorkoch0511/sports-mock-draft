# Draft Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scorecard on the Results page saying how your draft went, ranked against the other teams, computed entirely from data the page already fetches.

**Architecture:** Three tasks. Task 1 builds the pure analysis module and its unit tests — all the arithmetic risk lives there. Task 2 brings the test fixture up to production parity and adds the tabbed views to Results. Task 3 links the analysis from My Drafts.

**Tech Stack:** React 19, React Router 7, Tailwind 4, `node:test`, Playwright.

## Global Constraints

- **The frontend is ESM.** `import`/`export` only. The backend is CommonJS; mixing them is a defect.
- **No new dependencies.** No `frontend/package.json` changes.
- **No backend change.** No new endpoint, no schema change, no Lambda deploy. `Results.jsx` already fetches everything needed.
- **The sign convention is `overall − adp`.** Positive means the player fell to you; negative means you reached. Getting this backwards inverts every verdict on the page.
- Tailwind utility classes only — no new stylesheet, no inline `style`.
- The pick log stays the **default** view. An existing link with no `view` parameter must behave exactly as it does today.
- Unit tests run with `cd frontend && npm run test:unit`; Playwright with `cd frontend && npx playwright test`.
- Existing suites must stay green: **106 backend unit**, **63 frontend unit**, **106 Playwright**.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/src/lib/draftAnalysis.js` | All analysis arithmetic, pure | Task 1 — **new** |
| `frontend/src/lib/draftAnalysis.test.js` | Unit tests for the above | Task 1 — **new** |
| `frontend/tests/fixtures.js` | Shared Playwright fixtures | Task 2 — production parity |
| `frontend/src/pages/Results.jsx` | Results page | Task 2 — tabs, `?view=` |
| `frontend/tests/analysis.spec.js` | Analysis e2e | Task 2 — **new** |
| `frontend/src/pages/MyDrafts.jsx` | My Drafts page | Task 3 — analysis link |

### The sign convention, stated once

| Case | ADP | Taken at | `overall − adp` | Reads as |
|---|---|---|---|---|
| Reach | 5.5 | pick 1 | **−4.5** | taken 4.5 picks early |
| Value | 5.5 | pick 20 | **+14.5** | fell 14.5 picks |

---

## Task 1: The analysis module

**Files:**
- Create: `frontend/src/lib/draftAnalysis.js`
- Create: `frontend/src/lib/draftAnalysis.test.js`

**Interfaces:**
- Consumes: `largestGap(picks)` from `frontend/src/lib/snake.js` — it takes an array of **pick numbers** and returns the largest difference between consecutive entries, or 0 for fewer than two.
- Produces: `analyzeDraft(draft)`, consumed by Tasks 2 and 3.

**Background.** Every pick in a real draft carries a player snapshot taken at draft time: `{ id, name, position, team, rank, adp, tier }`. `rosterSlots` is stored on the draft. So everything here is computable with no fetching.

**The ADP coverage limit is load-bearing.** Only 272 of 3,875 players carry an ADP, topping out at 197. A pick spent on an unranked player has no ADP to compare against, and must be **excluded from value math and counted**, never scored as zero — scoring a missing ADP as zero would turn a late flier into a 150-point reach and poison every total.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/draftAnalysis.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { analyzeDraft } from "./draftAnalysis.js";

function player(id, { adp = null, tier = null, position = "RB", rank = null } = {}) {
  return { id, name: `Player ${id}`, position, team: "SF", rank, adp, tier };
}

function pick(overall, team, p) {
  return { overall, round: 1, team, playerId: p ? p.id : null, player: p };
}

function draftWith(picks, extra = {}) {
  return {
    draftId: "d1",
    teams: 2,
    rounds: 2,
    userTeam: 1,
    rosterSlots: ["RB", "WR"],
    completed: true,
    picks,
    ...extra,
  };
}

test("a player taken earlier than his ADP is a reach, scoring negative", () => {
  const d = draftWith([pick(1, 1, player("a", { adp: 5.5 }))]);
  const out = analyzeDraft(d);
  assert.strictEqual(out.you.valueCaptured, -4.5);
});

test("a player who falls past his ADP is value, scoring positive", () => {
  const d = draftWith([pick(20, 1, player("a", { adp: 5.5 }))]);
  const out = analyzeDraft(d);
  assert.strictEqual(out.you.valueCaptured, 14.5);
});

test("value is summed across a team's scoreable picks", () => {
  const d = draftWith([
    pick(1, 1, player("a", { adp: 5.5 })),   // -4.5
    pick(20, 1, player("b", { adp: 5.5 })),  // +14.5
  ]);
  assert.strictEqual(analyzeDraft(d).you.valueCaptured, 10);
});

test("a pick whose player has no ADP is excluded, not scored as zero", () => {
  const d = draftWith([
    pick(1, 1, player("a", { adp: 5.5 })),
    pick(2, 1, player("b", { adp: null })),
  ]);
  const out = analyzeDraft(d);

  assert.strictEqual(out.you.valueCaptured, -4.5, "the ADP-less pick must not contribute");
  assert.strictEqual(out.scoreable.without, 1);
  assert.strictEqual(out.scoreable.with, 1);
});

test("a draft where no pick has an ADP yields zero value and does not throw", () => {
  const d = draftWith([pick(1, 1, player("a")), pick(2, 1, player("b"))]);
  const out = analyzeDraft(d);

  assert.strictEqual(out.you.valueCaptured, 0);
  assert.strictEqual(out.scoreable.with, 0);
  assert.strictEqual(out.scoreable.without, 2);
});

test("teams rank by value, best first, and you get your own rank", () => {
  const d = draftWith([
    pick(1, 1, player("a", { adp: 5.5 })),    // team 1: -4.5
    pick(2, 2, player("b", { adp: 30 })),     // team 2: +28
  ]);
  const out = analyzeDraft(d);

  assert.deepStrictEqual(out.teams.map((t) => t.team), [2, 1]);
  assert.strictEqual(out.you.rank, 2);
  assert.strictEqual(out.teams.length, 2, "every team appears, even with no picks");
});

test("a tie in value ranks by team number, deterministically", () => {
  const d = draftWith([
    pick(10, 1, player("a", { adp: 5 })),   // +5
    pick(10, 2, player("b", { adp: 5 })),   // +5
  ]);
  assert.deepStrictEqual(analyzeDraft(d).teams.map((t) => t.team), [1, 2]);
});

test("best pick and biggest reach are named", () => {
  const d = draftWith([
    pick(1, 1, player("reacher", { adp: 5.5 })),  // -4.5
    pick(20, 1, player("steal", { adp: 5.5 })),   // +14.5
  ]);
  const out = analyzeDraft(d);

  assert.strictEqual(out.you.bestPick.player.id, "steal");
  assert.strictEqual(out.you.bestPick.delta, 14.5);
  assert.strictEqual(out.you.biggestReach.player.id, "reacher");
  assert.strictEqual(out.you.biggestReach.delta, -4.5);
});

test("best pick and biggest reach are null when nothing is scoreable", () => {
  const out = analyzeDraft(draftWith([pick(1, 1, player("a"))]));
  assert.strictEqual(out.you.bestPick, null);
  assert.strictEqual(out.you.biggestReach, null);
});

test("roster shape reports a slot never drafted as unfilled", () => {
  const d = draftWith([pick(1, 1, player("a", { position: "RB" }))]);
  const out = analyzeDraft(d);

  assert.deepStrictEqual(out.you.rosterShape.filled, ["RB"]);
  assert.deepStrictEqual(out.you.rosterShape.unfilled, ["WR"]);
});

test("roster shape reports a position drafted beyond its slot count as extra", () => {
  const d = draftWith([
    pick(1, 1, player("a", { position: "RB" })),
    pick(2, 1, player("b", { position: "RB" })),
  ]);
  const out = analyzeDraft(d);

  assert.deepStrictEqual(out.you.rosterShape.extra, [{ position: "RB", count: 1 }]);
});

test("roster shape reads the draft's own rosterSlots, not a default roster", () => {
  // Three QB slots is not any default. If the code hardcodes a roster this fails.
  const d = draftWith([pick(1, 1, player("a", { position: "QB" }))], {
    rosterSlots: ["QB", "QB", "QB"],
  });
  const out = analyzeDraft(d);

  assert.deepStrictEqual(out.you.rosterShape.unfilled, ["QB", "QB"]);
  assert.deepStrictEqual(out.you.rosterShape.extra, []);
});

test("tier counts tally by tier and ignore players without one", () => {
  const d = draftWith([
    pick(1, 1, player("a", { tier: 1 })),
    pick(2, 1, player("b", { tier: 1 })),
    pick(3, 1, player("c", { tier: 3 })),
    pick(4, 1, player("d", { tier: null })),
  ]);
  assert.deepStrictEqual(analyzeDraft(d).you.tierCounts, { 1: 2, 3: 1 });
});

test("the longest wait spans a team's biggest gap and lists who went during it", () => {
  const d = draftWith([
    pick(1, 1, player("mine-1")),
    pick(2, 2, player("theirs-a")),
    pick(3, 2, player("theirs-b")),
    pick(4, 1, player("mine-2")),
  ]);
  const out = analyzeDraft(d);

  assert.strictEqual(out.you.longestWait.from, 1);
  assert.strictEqual(out.you.longestWait.to, 4);
  assert.strictEqual(out.you.longestWait.span, 3);
  assert.deepStrictEqual(
    out.you.longestWait.playersGone.map((p) => p.id),
    ["theirs-a", "theirs-b"]
  );
});

test("a single pick has no wait", () => {
  const out = analyzeDraft(draftWith([pick(1, 1, player("a"))]));
  assert.strictEqual(out.you.longestWait, null);
});

test("a draft with no completed picks returns zeroes rather than throwing", () => {
  const out = analyzeDraft(draftWith([pick(1, 1, null), pick(2, 2, null)]));

  assert.strictEqual(out.you.valueCaptured, 0);
  assert.strictEqual(out.you.bestPick, null);
  assert.strictEqual(out.you.longestWait, null);
  assert.strictEqual(out.scoreable.with, 0);
});

test("an in-progress draft analyzes only the picks made so far", () => {
  const d = draftWith(
    [pick(1, 1, player("a", { adp: 5.5 })), pick(2, 2, null), pick(3, 1, null)],
    { completed: false }
  );
  const out = analyzeDraft(d);

  assert.strictEqual(out.you.valueCaptured, -4.5);
  assert.strictEqual(out.scoreable.with, 1);
});

test("a null or malformed draft returns an empty result rather than throwing", () => {
  for (const bad of [null, undefined, {}, { picks: null }]) {
    const out = analyzeDraft(bad);
    assert.strictEqual(out.you.valueCaptured, 0);
    assert.deepStrictEqual(out.teams, []);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npm run test:unit 2>&1 | tail -15
```

Expected: FAIL — `draftAnalysis.js` does not exist, so the import cannot resolve.

- [ ] **Step 3: Write the module**

Create `frontend/src/lib/draftAnalysis.js`:

```js
import { largestGap } from "./snake";

/**
 * Analyse a completed or in-progress draft.
 *
 * Everything here comes from the draft object itself: each pick carries a
 * player snapshot taken at draft time (`rank`, `adp`, `tier`), and the draft
 * carries its own `rosterSlots`. Nothing is fetched.
 *
 * The sign convention is `overall - adp`, so a player who FELL to you scores
 * positive and one you REACHED for scores negative. ADP 5.5 taken at pick 1
 * is -4.5; taken at pick 20 it is +14.5. Getting this backwards inverts every
 * verdict the page renders.
 *
 * Only about 270 players carry an ADP at all, so a pick spent on an unranked
 * player has nothing to compare against. Those are excluded and counted, never
 * scored as zero -- zero would read as a fair-value pick and quietly drag every
 * total toward the middle.
 */
export function analyzeDraft(draft) {
  const teamCount = Number(draft?.teams) || 0;
  const userTeam = draft?.userTeam ?? null;
  const rosterSlots = Array.isArray(draft?.rosterSlots) ? draft.rosterSlots : [];
  const made = (Array.isArray(draft?.picks) ? draft.picks : []).filter(
    (p) => p && p.player
  );

  const scoreable = {
    with: made.filter((p) => typeof p.player.adp === "number").length,
    without: made.filter((p) => typeof p.player.adp !== "number").length,
  };

  const teams = [];
  for (let t = 1; t <= teamCount; t++) {
    const mine = made.filter((p) => p.team === t);
    teams.push({
      team: t,
      picks: mine,
      valueCaptured: round1(
        mine.reduce((sum, p) => sum + (delta(p) ?? 0), 0)
      ),
      tierCounts: countTiers(mine),
    });
  }

  // Best value first. Ties break by team number so the order never depends on
  // the engine's sort stability.
  teams.sort((a, b) => b.valueCaptured - a.valueCaptured || a.team - b.team);

  const yours = teams.find((t) => t.team === userTeam) || null;

  return {
    scoreable,
    teams,
    you: yours
      ? {
          team: yours.team,
          rank: teams.indexOf(yours) + 1,
          valueCaptured: yours.valueCaptured,
          tierCounts: yours.tierCounts,
          bestPick: extreme(yours.picks, "max"),
          biggestReach: extreme(yours.picks, "min"),
          rosterShape: shape(yours.picks, rosterSlots),
          longestWait: wait(yours.picks, made),
        }
      : emptyYou(),
  };
}

function delta(p) {
  const adp = p?.player?.adp;
  return typeof adp === "number" ? round1(p.overall - adp) : null;
}

function round1(n) {
  // Values are sums of one-decimal ADPs, so bare addition drifts into
  // 10.000000000000002. One decimal is all the precision ADP has anyway.
  return Math.round(n * 10) / 10;
}

function countTiers(picks) {
  const out = {};
  for (const p of picks) {
    const t = p.player?.tier;
    if (t == null) continue;
    out[t] = (out[t] || 0) + 1;
  }
  return out;
}

function extreme(picks, which) {
  const scored = picks
    .map((p) => ({ player: p.player, overall: p.overall, delta: delta(p) }))
    .filter((x) => x.delta !== null);
  if (scored.length === 0) return null;

  return scored.reduce((best, x) =>
    which === "max"
      ? x.delta > best.delta ? x : best
      : x.delta < best.delta ? x : best
  );
}

function shape(picks, rosterSlots) {
  const need = {};
  for (const slot of rosterSlots) need[slot] = (need[slot] || 0) + 1;

  const have = {};
  for (const p of picks) {
    const pos = p.player?.position;
    if (pos) have[pos] = (have[pos] || 0) + 1;
  }

  const filled = [];
  const unfilled = [];
  for (const [pos, count] of Object.entries(need)) {
    const got = have[pos] || 0;
    for (let i = 0; i < Math.min(got, count); i++) filled.push(pos);
    for (let i = got; i < count; i++) unfilled.push(pos);
  }

  const extra = [];
  for (const [pos, count] of Object.entries(have)) {
    const room = need[pos] || 0;
    if (count > room) extra.push({ position: pos, count: count - room });
  }

  return { filled, unfilled, extra };
}

function wait(picks, allMade) {
  if (picks.length < 2) return null;

  const numbers = picks.map((p) => p.overall).sort((a, b) => a - b);
  const span = largestGap(numbers);
  if (span === 0) return null;

  let from = numbers[0];
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] - numbers[i - 1] === span) {
      from = numbers[i - 1];
      break;
    }
  }
  const to = from + span;

  return {
    from,
    to,
    span,
    playersGone: allMade
      .filter((p) => p.overall > from && p.overall < to)
      .sort((a, b) => a.overall - b.overall)
      .map((p) => p.player),
  };
}

function emptyYou() {
  return {
    team: null,
    rank: null,
    valueCaptured: 0,
    tierCounts: {},
    bestPick: null,
    biggestReach: null,
    rosterShape: { filled: [], unfilled: [], extra: [] },
    longestWait: null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: 81 tests, 81 pass, 0 fail (63 pre-existing + 18 added here).

- [ ] **Step 5: Prove the sign convention is pinned**

```bash
cd frontend
sed -i '' 's/round1(p.overall - adp)/round1(adp - p.overall)/' src/lib/draftAnalysis.js
npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: FAIL. Inverting the convention must break the reach and value tests. If it does not, the tests are not pinning the direction and the page could ship every verdict backwards.

Restore:

```bash
cd frontend
sed -i '' 's/round1(adp - p.overall)/round1(p.overall - adp)/' src/lib/draftAnalysis.js
grep -n "p.overall - adp" src/lib/draftAnalysis.js
npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: the grep matches and 81 pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/draftAnalysis.js frontend/src/lib/draftAnalysis.test.js
git commit -m "Add the draft analysis module

Pure functions over the draft object: value against ADP, roster shape
against the draft's own rosterSlots, tier counts, and the longest gap
between a team's picks with who went during it. Nothing is fetched --
every pick already carries a player snapshot from draft time.

The sign convention is overall - adp, so a player who fell to you scores
positive and one you reached for scores negative. A mutation test pins
it: inverting the subtraction fails the reach and value cases, because
shipping that backwards would invert every verdict on the page.

Picks whose player has no ADP are excluded and counted rather than
scored as zero. Only ~270 of 3,875 players carry one, and a zero would
read as a fair-value pick while dragging every total toward the middle."
```

---

## Task 2: Tabs on the Results page

**Files:**
- Modify: `frontend/tests/fixtures.js` (`makeCompletedDraft`)
- Modify: `frontend/src/pages/Results.jsx`
- Create: `frontend/tests/analysis.spec.js`

**Interfaces:**
- Consumes: `analyzeDraft(draft)` from Task 1.
- Produces: the `?view=analysis` URL contract and the test ids `view-tab-picks`, `view-tab-analysis`, `analysis-panel`, which Task 3 relies on.

**Background — the fixture has drifted from production.** `makeCompletedDraft` builds pick snapshots as `{ id, name, position, team }` and sets no `rosterSlots`. Real drafts carry `{ id, name, position, team, rank, adp, tier }` on every pick and a `rosterSlots` array on the draft — verified against the deployed API. Without fixing this the analysis renders against data no real draft produces, and every e2e assertion would be meaningless.

The fixture change is **additive** — no existing test asserts these fields are absent — but `makeCompletedDraft` is shared, so run the full suite, not just the new spec.

- [ ] **Step 1: Bring the fixture to production parity**

In `frontend/tests/fixtures.js`, change `makeCompletedDraft` so each pick's player snapshot carries the same seven fields production stores, and the draft carries `rosterSlots`:

```js
export function makeCompletedDraft() {
  const picks = buildSnakePicks(4, 3);
  MOCK_PLAYERS.slice(0, 12).forEach((player, i) => {
    picks[i].playerId = player.id;
    // Production stores the full seven-field snapshot taken at draft time.
    picks[i].player = {
      id: player.id,
      name: player.name,
      position: player.position,
      team: player.team,
      rank: player.rank,
      adp: player.adp,
      tier: player.tier,
    };
  });
  return {
    draftId: DRAFT_ID,
    sport: "nfl",
    format: "standard",
    year: 2025,
    teams: 4,
    rounds: 3,
    userTeam: 1,
    rosterSlots: ["QB", "RB", "RB", "WR", "WR", "TE", "K", "DEF"],
    picked: MOCK_PLAYERS.slice(0, 12).map((p) => p.id),
    currentIndex: 12,
    currentRound: 3,
    currentPick: 4,
    currentTeam: null,
    completed: true,
    picks,
  };
}
```

- [ ] **Step 2: Confirm the fixture change broke nothing**

```bash
cd frontend && npx playwright test
```

Expected: PASS, 106 tests — unchanged. This is purely additive; if anything fails, an existing test was asserting on the old shape and you should report it rather than adjusting the fixture back. Do not run this in the background.

- [ ] **Step 3: Write the failing tests**

Create `frontend/tests/analysis.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { DRAFT_ID, makeCompletedDraft } from "./fixtures.js";

const API = "http://localhost:9999";

async function openResults(page, draft = makeCompletedDraft(), query = "") {
  await page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: draft }));
  await page.goto(`/draft/${DRAFT_ID}/results${query}`);
  await expect(page.getByRole("heading", { name: "Draft Results" })).toBeVisible();
}

test("the pick log is the default view", async ({ page }) => {
  await openResults(page);
  await expect(page.getByRole("heading", { name: "Pick Log" })).toBeVisible();
  await expect(page.getByTestId("analysis-panel")).toHaveCount(0);
});

test("?view=analysis opens the analysis directly", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=analysis");
  await expect(page.getByTestId("analysis-panel")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pick Log" })).toHaveCount(0);
});

test("switching tabs updates the URL, and the URL survives a reload", async ({ page }) => {
  await openResults(page);

  await page.getByTestId("view-tab-analysis").click();
  await expect(page).toHaveURL(/view=analysis/);
  await expect(page.getByTestId("analysis-panel")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("analysis-panel")).toBeVisible();

  await page.getByTestId("view-tab-picks").click();
  await expect(page.getByRole("heading", { name: "Pick Log" })).toBeVisible();
});

test("an unrecognised view falls back to the pick log", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=nonsense");
  await expect(page.getByRole("heading", { name: "Pick Log" })).toBeVisible();
  await expect(page.getByTestId("analysis-panel")).toHaveCount(0);
});

test("the analysis names your team and its rank against the field", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=analysis");

  const panel = page.getByTestId("analysis-panel");
  await expect(panel).toContainText("Team 1");
  await expect(panel).toContainText(/of 4/i);
});

test("the analysis reports how many picks could not be scored", async ({ page }) => {
  const draft = makeCompletedDraft();
  draft.picks[0].player.adp = null;

  await openResults(page, draft, "?view=analysis");

  await expect(page.getByTestId("unscoreable-note")).toContainText("1");
});

test("no unscoreable note when every pick has an ADP", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=analysis");
  await expect(page.getByTestId("unscoreable-note")).toHaveCount(0);
});
```

- [ ] **Step 4: Run them to verify they fail**

```bash
cd frontend && npx playwright test tests/analysis.spec.js
```

Expected: FAIL on everything except the default-view and unrecognised-view cases, which pass already because no tabs exist and the pick log is all there is. That is expected — they guard the default behavior against the change you are about to make.

- [ ] **Step 5: Add the tabs**

In `frontend/src/pages/Results.jsx`:

Add `useSearchParams` to the existing router import, and `analyzeDraft` to the imports:

```jsx
import { Link, useParams, useSearchParams } from "react-router-dom";
import { analyzeDraft } from "../lib/draftAnalysis";
```

Inside the component, beside the existing hooks:

```jsx
  const [searchParams, setSearchParams] = useSearchParams();
  // Anything unrecognised -- including an absent parameter -- is the pick log,
  // so an old link with no ?view keeps behaving exactly as it did.
  const view = searchParams.get("view") === "analysis" ? "analysis" : "picks";
```

Immediately **before** the `{/* Layout */}` block, add the tab strip:

```jsx
      <div className="mb-4 flex gap-2">
        <button
          type="button"
          data-testid="view-tab-picks"
          onClick={() => setSearchParams({})}
          className={`rounded-2xl border px-4 py-2 text-sm ${
            view === "picks"
              ? "border-cyan-300/60 bg-cyan-950/30 text-cyan-200"
              : "border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:border-zinc-600"
          }`}
        >
          Pick Log
        </button>
        <button
          type="button"
          data-testid="view-tab-analysis"
          onClick={() => setSearchParams({ view: "analysis" })}
          className={`rounded-2xl border px-4 py-2 text-sm ${
            view === "analysis"
              ? "border-cyan-300/60 bg-cyan-950/30 text-cyan-200"
              : "border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:border-zinc-600"
          }`}
        >
          Analysis
        </button>
      </div>
```

Then wrap the existing `{/* Layout */}` grid so it renders only for the pick view — `{view === "picks" && ( ...the existing grid unchanged... )}` — and add the analysis panel after it.

- [ ] **Step 6: Render the analysis**

Still in `frontend/src/pages/Results.jsx`, after the pick-log grid:

```jsx
      {view === "analysis" && (() => {
        const a = analyzeDraft(draft);
        const fmt = (n) => (n > 0 ? `+${n}` : `${n}`);

        return (
          <div data-testid="analysis-panel" className="space-y-4">
            <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
              <div className="text-sm text-zinc-400">Team {a.you.team}</div>
              <div className="mt-1 text-3xl font-semibold">
                {fmt(a.you.valueCaptured)}
                <span className="ml-2 text-base font-normal text-zinc-400">
                  value captured
                </span>
              </div>
              <div className="mt-1 text-sm text-zinc-400">
                {a.you.rank} of {a.teams.length} in this draft. Positive means players
                fell to you; negative means you reached.
              </div>
              {a.scoreable.without > 0 && (
                <div data-testid="unscoreable-note" className="mt-2 text-xs text-zinc-500">
                  {a.scoreable.without} of {a.scoreable.with + a.scoreable.without} picks
                  had no ADP to compare against and are excluded.
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {a.you.bestPick && (
                <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
                  <div className="text-sm text-zinc-400">Best value</div>
                  <div className="mt-1 font-medium">{a.you.bestPick.player.name}</div>
                  <div className="text-xs text-zinc-500">
                    pick {a.you.bestPick.overall} · {fmt(a.you.bestPick.delta)}
                  </div>
                </div>
              )}
              {a.you.biggestReach && (
                <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
                  <div className="text-sm text-zinc-400">Biggest reach</div>
                  <div className="mt-1 font-medium">{a.you.biggestReach.player.name}</div>
                  <div className="text-xs text-zinc-500">
                    pick {a.you.biggestReach.overall} · {fmt(a.you.biggestReach.delta)}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
              <div className="text-sm text-zinc-400">Roster shape</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {a.you.rosterShape.filled.map((s, i) => (
                  <span key={`f${i}`} className="rounded-full border border-cyan-300/40 px-2 py-0.5 text-[10px] text-cyan-200">
                    {s}
                  </span>
                ))}
                {a.you.rosterShape.unfilled.map((s, i) => (
                  <span key={`u${i}`} className="rounded-full border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-600">
                    {s}
                  </span>
                ))}
              </div>
              {a.you.rosterShape.unfilled.length > 0 && (
                <div className="mt-2 text-xs text-zinc-500">
                  Unfilled: {a.you.rosterShape.unfilled.join(", ")}
                </div>
              )}
            </div>

            {a.you.longestWait && (
              <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
                <div className="text-sm text-zinc-400">Your longest wait</div>
                <div className="mt-1 text-sm">
                  {a.you.longestWait.span} picks between {a.you.longestWait.from} and{" "}
                  {a.you.longestWait.to}
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  Gone in that span:{" "}
                  {a.you.longestWait.playersGone.map((p) => p.name).join(", ") || "nobody"}
                </div>
              </div>
            )}

            <div className="text-xs text-zinc-600">
              This grades how the draft went, not how the team will do — the app has no
              projections or bye weeks.
            </div>
          </div>
        );
      })()}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd frontend && npx playwright test tests/analysis.spec.js
```

Expected: PASS, 7 tests.

- [ ] **Step 8: Run the full suites**

```bash
cd frontend && npx playwright test
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
cd frontend && npm run build 2>&1 | tail -2
```

Expected: 113 Playwright pass (106 pre-existing + 7 here), 81 unit pass, clean build. Do not run these in the background.

- [ ] **Step 9: Commit**

```bash
git add frontend/tests/fixtures.js frontend/src/pages/Results.jsx frontend/tests/analysis.spec.js
git commit -m "Add an analysis view to the Results page

Tabs between the pick log and a scorecard, with the active view in the
URL as ?view=analysis so it can be linked and shared. Anything
unrecognised -- including no parameter at all -- is the pick log, so
every existing link behaves exactly as before.

Also brings makeCompletedDraft to production parity. It built pick
snapshots as four fields and set no rosterSlots; real drafts carry seven
fields per pick and a rosterSlots array, verified against the deployed
API. Without that the analysis would have been tested against data no
real draft produces.

The panel says plainly that it grades the draft, not the team -- there
are no projections or bye weeks to support a quality claim."
```

---

## Task 3: Link the analysis from My Drafts

**Files:**
- Modify: `frontend/src/pages/MyDrafts.jsx`
- Test: `frontend/tests/analysis.spec.js` (append)

**Interfaces:**
- Consumes: the `?view=analysis` URL contract from Task 2.
- Produces: the test id `analysis-link`.

**Background.** A completed row currently links to `/draft/:id/results`. It gains a second, smaller link straight to the analysis. In-progress rows are unchanged — there is little to analyse before picks exist, and the row already links into the live draft.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/analysis.spec.js`:

```js
test("a completed draft links to its analysis from My Drafts", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "perfectpick.myDrafts",
      JSON.stringify([
        {
          id: "test-draft-abc123",
          teams: 4,
          rounds: 3,
          format: "standard",
          userTeam: 1,
          boardId: null,
          completed: true,
          owned: true,
          updatedAt: Date.now(),
        },
      ])
    )
  );

  await page.goto("/drafts");
  await page.getByTestId("analysis-link").click();

  await expect(page).toHaveURL(/\/draft\/test-draft-abc123\/results\?view=analysis$/);
});

test("an in-progress draft has no analysis link", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "perfectpick.myDrafts",
      JSON.stringify([
        {
          id: "in-progress-1",
          teams: 4,
          rounds: 3,
          format: "standard",
          userTeam: 1,
          boardId: null,
          completed: false,
          owned: true,
          updatedAt: Date.now(),
        },
      ])
    )
  );

  await page.goto("/drafts");
  await expect(page.getByTestId("draft-row")).toHaveCount(1);
  await expect(page.getByTestId("analysis-link")).toHaveCount(0);
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd frontend && npx playwright test tests/analysis.spec.js
```

Expected: FAIL on the first — `analysis-link` does not exist. The second passes already, guarding against the link appearing on in-progress rows.

- [ ] **Step 3: Add the link**

In `frontend/src/pages/MyDrafts.jsx`, immediately after the row's main `</Link>` and before the Forget button:

```jsx
                {d.completed && (
                  <Link
                    to={`/draft/${d.id}/results?view=analysis`}
                    data-testid="analysis-link"
                    aria-label={`Analysis of ${describe(d)} draft`}
                    className="rounded-2xl border border-zinc-800 px-3 py-3 text-xs text-zinc-400 hover:border-cyan-300/40 hover:text-cyan-200"
                  >
                    Analysis
                  </Link>
                )}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx playwright test tests/analysis.spec.js
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Run the full suites**

```bash
cd frontend && npx playwright test
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
cd frontend && npm run build 2>&1 | tail -2
```

Expected: 115 Playwright pass, 81 unit pass, clean build. Do not run these in the background.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/MyDrafts.jsx frontend/tests/analysis.spec.js
git commit -m "Link the analysis from My Drafts

A completed row gains a direct link to its analysis view. In-progress
rows are unchanged -- there is little to analyse before picks exist, and
those rows already link into the live draft."
```

---

## Verification Summary

| Check | Command | Expected |
|---|---|---|
| Frontend unit | `cd frontend && npm run test:unit` | 81 pass |
| Playwright | `cd frontend && npx playwright test` | 115 pass |
| Build | `cd frontend && npm run build` | no errors |
| Backend unit | `cd backend/src && npm test` | 106 pass |
| Lint | `cd frontend && npm run lint` | still exactly 2 errors |

The backend is untouched; its suite and the lint count are listed to confirm the change stayed in the frontend and introduced no new lint. **No deploy of anything but the frontend is needed.**
