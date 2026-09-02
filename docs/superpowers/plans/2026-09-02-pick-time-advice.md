# Pick-Time Decision Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the drafter who to take and why, at the moment they are picking, with reasons that are the actual factors behind the recommendation.

**Architecture:** Five tasks, ordered so the riskiest change is protected before it happens. Task 1 syncs the injury and depth fields the advice needs. Task 2 exports the roster fitting the engine reuses. Task 3 builds the engine, pure and unit-tested — all the reasoning risk lives there. Task 4 pins the Big Board row's existing behavior **before** Task 5 restructures it, because that row is the app's most-used control.

**Tech Stack:** Node.js 24 (CommonJS backend), React 19, Tailwind 4, `node:test`, Playwright.

## Global Constraints

- **The backend is CommonJS; the frontend is ESM.** Mixing them is a defect, and nothing may import across the boundary.
- **No new dependencies.** No `package.json` changes in either tree.
- **A reason must correspond to a non-zero score contribution.** A reason that did not move the ranking is decoration, and decoration erodes trust in the reasons that are real. This is the spec's central commitment.
- **The sign convention is `overall − adp`** — positive means the player fell to you. It was stated backwards three times during the analysis work; do not restate it.
- **Absent data is never invented.** A player with no stats gets "no prior production", not a zero.
- Tailwind utility classes only — no new stylesheet, no inline `style`.
- Tests: `cd backend/src && npm test`; `cd frontend && npm run test:unit`; `cd frontend && npx playwright test`.
- Existing suites must stay green: **128 backend**, **90 frontend unit**, **127 Playwright**.
- Task 1 requires a **backend deploy**; Tasks 2–5 are frontend only.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `backend/src/syncPlayers.js` | Nightly sync | Task 1 — injury + depth fields |
| `backend/src/syncPlayers.test.js` | Sync tests | Task 1 — extended |
| `backend/src/players.js` | `GET /players` | Task 1 — passthrough |
| `backend/src/players.test.js` | Endpoint tests | Task 1 — extended |
| `frontend/src/lib/draftAnalysis.js` | Draft analysis | Task 2 — export roster fitting |
| `frontend/src/lib/pickAdvice.js` | The reasoning engine | Task 3 — **new** |
| `frontend/src/lib/pickAdvice.test.js` | Engine tests | Task 3 — **new** |
| `frontend/tests/draft.spec.js` | Draft page e2e | Task 4 — pin row behavior |
| `frontend/src/pages/Draft.jsx` | Draft page | Task 5 — card + why control |
| `frontend/tests/advice.spec.js` | Advice e2e | Task 5 — **new** |

### What a ranked player carries today

```json
{ "id": "9221", "name": "Jahmyr Gibbs", "position": "RB", "team": "DET",
  "rank": 1, "adp": 1.5, "tier": 1, "statsSeason": 2025,
  "stats": { "gp": 17, "rec_tgt": 94, "rush_att": 243, "off_snp": 685,
             "tm_off_snp": 1026, "rec_rz_tgt": 12, "pos_rank_ppr": 3,
             "pts_ppr": 366.9, ... } }
```

**35 ranked players carry no `stats` key**, because they are rookies or did not play. That is a signal, not a gap.

---

## Task 1: Sync injury and depth-chart fields

**Files:**
- Modify: `backend/src/syncPlayers.js` (`normalizeSleeperPlayer`), `backend/src/players.js`
- Test: `backend/src/syncPlayers.test.js`, `backend/src/players.test.js`

**Interfaces:**
- Produces: `injuryStatus`, `injuryBodyPart`, `depthChartOrder` on player items and on ranked players in the `/players` response. Task 3 consumes them.

**Background.** These were specced but never built — they appear nowhere in either file today. Measured against Sleeper's live blob across 2,723 players with a team and position: `injury_status` is set for **474 (17%)** — IR 223, Questionable 198, PUP 39, Sus 6 — and `depth_chart_order` for **1,463 (53%)**. `practice_participation` is empty for every injured player and is deliberately **not** synced.

All three are sparse, so they are stored and returned **only when present**, exactly as `stats` is. That is what keeps the payload from growing for the healthy majority.

- [ ] **Step 1: Write the failing sync tests**

Append to `backend/src/syncPlayers.test.js`:

```js
const { pickAvailability } = require("./syncPlayers");

test("pickAvailability keeps an injury status and body part", () => {
  const out = pickAvailability({ injury_status: "Questionable", injury_body_part: "Hamstring" });
  assert.strictEqual(out.injuryStatus, "Questionable");
  assert.strictEqual(out.injuryBodyPart, "Hamstring");
});

test("pickAvailability keeps a depth chart order", () => {
  assert.strictEqual(pickAvailability({ depth_chart_order: 2 }).depthChartOrder, 2);
});

test("pickAvailability omits what the source does not have", () => {
  const out = pickAvailability({ injury_status: "IR" });
  assert.ok(!("injuryBodyPart" in out));
  assert.ok(!("depthChartOrder" in out));
});

test("pickAvailability returns null for a healthy player with no depth entry", () => {
  // The overwhelming majority. Returning {} would add a key to ~2,200 items
  // for no information.
  assert.strictEqual(pickAvailability({}), null);
  assert.strictEqual(pickAvailability(null), null);
});

test("pickAvailability ignores practice_participation", () => {
  // Measured empty for every injured player in the live blob.
  const out = pickAvailability({ practice_participation: "Limited" });
  assert.strictEqual(out, null);
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd backend/src && npm test 2>&1 | tail -12
```

Expected: FAIL — `pickAvailability` is not exported and is `undefined`.

- [ ] **Step 3: Add the helper and wire it into normalisation**

In `backend/src/syncPlayers.js`, beside the other pickers:

```js
// Sleeper carries availability data the app has never kept. Measured on the
// live blob: injury_status is set for 474 of 2,723 players (IR 223,
// Questionable 198), depth_chart_order for 1,463. practice_participation is
// empty for every injured player, so it is deliberately not read.
//
// Sparse by nature, so this returns null rather than {} when there is nothing
// to say -- adding an empty object to ~2,200 healthy players would cost
// payload for no information.
function pickAvailability(p) {
  if (!p || typeof p !== "object") return null;

  const out = {};
  if (typeof p.injury_status === "string" && p.injury_status) {
    out.injuryStatus = p.injury_status;
  }
  if (typeof p.injury_body_part === "string" && p.injury_body_part) {
    out.injuryBodyPart = p.injury_body_part;
  }
  if (typeof p.depth_chart_order === "number" && Number.isFinite(p.depth_chart_order)) {
    out.depthChartOrder = p.depth_chart_order;
  }
  return Object.keys(out).length > 0 ? out : null;
}
```

Export it with `module.exports.pickAvailability = pickAvailability;` — **never by assigning a fresh object to `module.exports`**, which would drop `handler` and silently break the nightly sync. A test already guards this.

In `normalizeSleeperPlayer`, spread the result into the returned item for the non-DEF path, so absent fields add no keys:

```js
    ...(pickAvailability(p) || {}),
```

Team defenses have no injury or depth data; leave that branch alone.

- [ ] **Step 4: Write the failing endpoint tests**

Append to `backend/src/players.test.js`:

```js
test("a ranked player's availability fields are returned", () => {
  stubPages([
    {
      Items: [
        { ...player("a", 1), injuryStatus: "Questionable", injuryBodyPart: "Hamstring", depthChartOrder: 1 },
      ],
    },
  ]);

  return get().then(({ body }) => {
    assert.strictEqual(body.players[0].injuryStatus, "Questionable");
    assert.strictEqual(body.players[0].injuryBodyPart, "Hamstring");
    assert.strictEqual(body.players[0].depthChartOrder, 1);
  });
});

test("availability keys are absent when the item has none", () => {
  stubPages([{ Items: [player("a", 1)] }]);

  return get().then(({ body }) => {
    for (const k of ["injuryStatus", "injuryBodyPart", "depthChartOrder"]) {
      assert.ok(!(k in body.players[0]), `${k} should not appear`);
    }
  });
});

test("an unranked player carries no availability fields", () => {
  // Same rule as stats: ranked players only, so the payload does not grow for
  // the ~3,600 nobody drafts.
  const unranked = player("b", 0, { rank: {}, adp: {}, tier: {} });
  unranked.injuryStatus = "IR";

  stubPages([{ Items: [unranked] }]);

  return get().then(({ body }) => {
    assert.ok(!("injuryStatus" in body.players[0]));
  });
});
```

- [ ] **Step 5: Add the passthrough**

In `backend/src/players.js`, inside the existing `if (rank != null && ...)` region, extend the conditional block so availability rides along on the same ranked-only rule as `stats`. Add each key only when the item has it, so a healthy player gains nothing.

- [ ] **Step 6: Run the tests**

```bash
cd backend/src && npm test 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: 136 tests, 136 pass, 0 fail (128 pre-existing + 8 added here).

- [ ] **Step 7: Confirm the entry point and template**

```bash
cd backend/src && node -e "console.log(typeof require('./syncPlayers').handler)"
cd .. && sam validate --lint 2>&1 | tail -1
```

Expected: `function`, and a valid template.

- [ ] **Step 8: Commit**

```bash
git add backend/src/syncPlayers.js backend/src/syncPlayers.test.js backend/src/players.js backend/src/players.test.js
git commit -m "Sync injury status and depth chart order

Specced with the pick-time advice work and never built. Measured on the
live Sleeper blob: injury_status is set for 474 of 2,723 players (IR
223, Questionable 198), depth_chart_order for 1,463.
practice_participation is empty for every injured player and is
deliberately not read.

All three are sparse, so they are stored and returned only when present,
and only for ranked players -- the same rule that holds the stats
payload at 1.2x rather than 1.7x."
```

---

## Task 2: Export the roster fitting

**Files:**
- Modify: `frontend/src/lib/draftAnalysis.js`
- Test: `frontend/src/lib/draftAnalysis.test.js`

**Interfaces:**
- Produces: `fitRoster(picks, rosterSlots)` — the existing private `shape()`, exported under a name that says what it does. Task 3 consumes it.

**Background.** `draftAnalysis.js` exports only `analyzeDraft`; the roster fitting is private. Task 3 needs it, and **copying it would be dangerous**: that function encodes dedicated → FLEX → bench semantics that were wrong until recently, when a complete 16-man Sleeper roster reported seven unfilled slots and seven surplus players simultaneously. A second copy would be free to drift back into exactly that bug. One implementation, two consumers.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/draftAnalysis.test.js`:

```js
import { fitRoster } from "./draftAnalysis.js";

test("fitRoster is exported for reuse, with the same semantics analyzeDraft uses", () => {
  // The FLEX/BN case, which is what a second copy of this logic would be free
  // to get wrong again.
  const picks = [
    { player: { position: "RB" } },
    { player: { position: "RB" } },
    { player: { position: "QB" } },
  ];

  const shape = fitRoster(picks, ["QB", "RB", "FLEX"]);

  assert.deepStrictEqual(shape.unfilled, []);
  assert.deepStrictEqual(shape.extra, []);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd frontend && npm run test:unit 2>&1 | tail -8
```

Expected: FAIL — `fitRoster` is not exported.

- [ ] **Step 3: Export it**

In `frontend/src/lib/draftAnalysis.js`, rename the private `shape` to `fitRoster` and add `export` to its declaration. Update its call site inside `analyzeDraft`. Do not change its behavior.

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: 91 tests, 91 pass. **The existing roster tests must pass unmodified** — if any needs editing, the rename changed behavior and you should stop and report it.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/draftAnalysis.js frontend/src/lib/draftAnalysis.test.js
git commit -m "Export the roster fitting for reuse

The advice engine needs to know which slots a roster still lacks.
Copying this logic would be actively dangerous: it encodes dedicated ->
FLEX -> bench semantics that were wrong until recently, when a complete
16-man Sleeper roster reported seven unfilled slots and seven surplus
players at once. One implementation, two consumers."
```

---

## Task 3: The advice engine

**Files:**
- Create: `frontend/src/lib/pickAdvice.js`, `frontend/src/lib/pickAdvice.test.js`

**Interfaces:**
- Consumes: `fitRoster` from Task 2; `picksForSlot` from `snake.js`.
- Produces:

```
adviseOnPick({ players, draft, boardRows, myTeam }) -> {
  recommendation: { player, reasons } | null,
  reasonsFor(playerId) -> reasons
}
```

where a reason is `{ kind, text, weight }` and `weight` is the score contribution that reason produced.

**The central commitment.** The reasons **are** the scoring factors. Every reason returned must correspond to a non-zero contribution, and every non-zero contribution must produce a reason. A reason that did not move the ranking is decoration, and decoration erodes trust in the ones that are real. **A test asserts this invariant directly**, not just examples of it.

**Factors.** Base order comes from the board when one is driving the draft, else consensus rank — that establishes the starting point and is not itself a reason. On top: value (`overall − adp`), roster need via `fitRoster`, scarcity before the user's next pick, tier cliff, availability (IR hard, Questionable soft, deep depth-chart mild), and production (opportunity, snap share, red-zone looks, last season's finish). A ranked player with no `stats` earns an explicit "no prior production" reason rather than silence.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/pickAdvice.test.js`. Cover at minimum:

- **The invariant:** for the recommendation and for `reasonsFor` on several players, every returned reason has a non-zero `weight`, and the sum of weights plus the base equals the score used to rank. Assert it over a generated pool, not one hand-picked case.
- A player who fell past ADP earns a value reason with a positive weight; one taken early earns a negative one.
- A player filling an unfilled roster slot earns a need reason; one filling a slot already full does not.
- Scarcity counts against the user's **next** pick, not the end of the draft.
- A tier cliff is reported only when the next available player at that position is in a worse tier.
- A player on IR is penalised hard enough not to be recommended over a healthy comparable.
- Questionable is a soft penalty and names the body part when known.
- High target volume on a high snap share earns a production reason; low volume does not.
- A ranked player with **no** `stats` earns a "no prior production" reason rather than being silently unscored.
- With a board present, board order drives the base; without one, consensus rank does.
- An empty pool, a completed draft, and a malformed draft each return `recommendation: null` rather than throwing.
- `reasonsFor` on an unknown id returns an empty array, not a throw.

Write the fixtures so each assertion fails against a plausible wrong implementation — a factor that always fires, or one that never does, must break something.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd frontend && npm run test:unit 2>&1 | tail -10
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the engine**

Create `frontend/src/lib/pickAdvice.js`, pure: no fetching, no React, no formatting. Each factor computes a weight and, when that weight is non-zero, the reason text explaining it. Build reasons and weights in the same place so they cannot diverge — that is what makes the invariant hold by construction rather than by discipline.

Every stat-derived reason must carry the season, since the data is history and not a forecast.

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: all green. Report the actual total.

- [ ] **Step 5: Prove the invariant is load-bearing**

Add a reason with a hardcoded zero weight, confirm the invariant test fails, then remove it. Report both outcomes. If the test passes with a zero-weight reason present, the central commitment of this feature is unenforced.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/pickAdvice.js frontend/src/lib/pickAdvice.test.js
git commit -m "Add the pick-time advice engine

Scores the available pool and explains itself. The reasons ARE the
scoring factors: every reason corresponds to a non-zero contribution and
every contribution produces a reason, asserted as an invariant rather
than by example. A reason that did not move the ranking would be
decoration, and decoration erodes trust in the reasons that are real.

Starts from the user's board when one is driving the draft, since that
is their own ranking, and falls back to consensus rank. Stat-derived
reasons carry their season, because this is history and not a forecast."
```

---

## Task 4: Pin the Big Board row before touching it

**Files:**
- Test: `frontend/tests/draft.spec.js` (append)

**Interfaces:**
- Produces: regression coverage Task 5 must keep green. No production code changes.

**Background.** Every manual pick in every draft goes through the Big Board row. It is currently a single `<button>` whose `onClick` calls `makePick(p.id)`, and Task 5 restructures it into a container holding that button plus a separate control.

**Restructuring the app's most-used interaction is the real risk in this feature** — breaking picking is worse than shipping no advice at all. These tests must exist and pass **before** the restructure, and pass **unchanged** after it. If Task 5 needs to edit one, that is the signal the restructure changed behavior it should not have.

- [ ] **Step 1: Write the tests**

Append to `frontend/tests/draft.spec.js`, using the spec's existing `mockDraftApis` helper:

```js
test("clicking a Big Board row drafts that player", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0 });
  mockDraftApis(page, state);
  let picked = null;
  await page.route(`${API}/drafts/${DRAFT_ID}/pick`, async (route) => {
    picked = JSON.parse(route.request().postData() || "{}").playerId;
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByText("Christian McCaffrey").first().click();

  await expect.poll(() => picked).toBe("p1");
});

test("Big Board rows are not clickable when it is not your turn", async ({ page }) => {
  // currentTeam 2 with userTeam 1: not the user's clock.
  const state = makeDraftState({ currentIndex: 1 });
  mockDraftApis(page, state);
  let calls = 0;
  await page.route(`${API}/drafts/${DRAFT_ID}/pick`, async (route) => {
    calls += 1;
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  const row = page.getByTestId("scroll-big-board").getByRole("button").first();
  await expect(row).toBeDisabled();
  expect(calls).toBe(0);
});

test("a Big Board row can be drafted from the keyboard", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0 });
  mockDraftApis(page, state);
  let picked = null;
  await page.route(`${API}/drafts/${DRAFT_ID}/pick`, async (route) => {
    picked = JSON.parse(route.request().postData() || "{}").playerId;
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  const row = page.getByTestId("scroll-big-board").getByRole("button").first();
  await row.focus();
  await page.keyboard.press("Enter");

  await expect.poll(() => picked).toBe("p1");
});
```

- [ ] **Step 2: Run them — they must pass now**

```bash
cd frontend && npx playwright test tests/draft.spec.js
```

Expected: PASS. These describe existing behavior. **If any fails, stop and report it** — that would mean picking is already broken, which is far more important than this feature.

- [ ] **Step 3: Run the full suite**

```bash
cd frontend && npx playwright test
```

Expected: 130 tests pass (127 pre-existing + 3 here). Do not run in the background.

- [ ] **Step 4: Commit**

```bash
git add frontend/tests/draft.spec.js
git commit -m "Pin Big Board row behavior before restructuring it

Every manual pick in the app goes through this row, and the advice work
is about to turn it from a single button into a container holding two
controls. Breaking picking would be worse than shipping no advice.

These describe what the row does today: a click drafts, rows are
disabled off your clock, and the keyboard path works. They must pass
unchanged after the restructure -- needing to edit one is the signal
that something moved which should not have."
```

---

## Task 5: The recommendation card and the why control

**Files:**
- Modify: `frontend/src/pages/Draft.jsx`
- Create: `frontend/tests/advice.spec.js`

**Interfaces:**
- Consumes: `adviseOnPick` from Task 3; the regression tests from Task 4.
- Produces: test ids `advice-card`, `why-player`, `why-panel`.

**Background.** Two changes to the Big Board panel. A recommendation card at the top showing the suggested player and the reasons that lifted him. And a **why** control per row: the row becomes a container holding the existing draft button plus a small separate control, because a `<button>` cannot nest inside a `<button>`.

**Task 4's three tests must pass unmodified.** If one needs editing, stop and report it.

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/advice.spec.js` covering:

- The recommendation card names a player and shows at least one reason
- Using the why control on a row reveals reasons for **that** player
- **Using the why control does not draft anybody** — asserted by counting requests to the pick endpoint, which must stay at zero
- The why control works when it is **not** your turn, since reading about a player is not picking
- A completed draft shows no recommendation card
- A stat-derived reason names its season

- [ ] **Step 2: Run them to verify they fail**

```bash
cd frontend && npx playwright test tests/advice.spec.js
```

Expected: FAIL — none of the test ids exist.

- [ ] **Step 3: Restructure the row**

In `frontend/src/pages/Draft.jsx`, change the row from a single `<button>` into a container holding the existing draft `<button>` — with its `disabled`, `onClick`, `title` and contents unchanged — plus a separate `why-player` control. Keep the row's visual appearance as close to today as possible; this is a structural change, not a redesign.

- [ ] **Step 4: Add the recommendation card and the why panel**

Render the card at the top of the Big Board panel, below the existing notices, and a panel revealing the selected player's reasons. Every stat-derived reason must show its season. The card must say plainly that it reasons about draft strategy and prior production, not projections.

- [ ] **Step 5: Run the advice tests**

```bash
cd frontend && npx playwright test tests/advice.spec.js
```

Expected: PASS. Report the count.

- [ ] **Step 6: Confirm Task 4's tests still pass, unmodified**

```bash
cd frontend && npx playwright test tests/draft.spec.js
git diff --stat frontend/tests/draft.spec.js
```

Expected: all pass, and **no diff** on that file. A non-empty diff means the restructure changed behavior the pin was protecting — stop and report it.

- [ ] **Step 7: Run everything**

```bash
cd frontend && npx playwright test
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
cd frontend && npm run build 2>&1 | tail -2
cd frontend && npm run lint 2>&1 | grep problems
```

Expected: Playwright and unit suites green, clean build, lint still exactly 2 errors. Report actual counts. Do not run in the background.

- [ ] **Step 8: Regenerate the draft screenshot**

The Big Board changes visibly, and this repo's convention is that a page's screenshot is refreshed and committed whenever its UI changes. The Playwright run in Step 7 regenerates `screenshots/draft.png`; include it in the commit.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/Draft.jsx frontend/tests/advice.spec.js screenshots/draft.png
git commit -m "Recommend a pick, and explain any player

A recommendation card at the top of the Big Board, and a why control on
every row. The row becomes a container holding the draft button plus
that control, because a button cannot nest inside a button.

The three tests pinning the row's behavior pass unmodified: a click
still drafts, rows are still disabled off your clock, and the keyboard
path still works. Reading about a player never drafts one -- a test
counts pick requests to prove it.

Stat-derived reasons carry their season, because the data is last
year's production and not a forecast."
```

---

## Verification Summary

| Check | Command | Expected |
|---|---|---|
| Backend unit | `cd backend/src && npm test` | 136 pass |
| Frontend unit | `cd frontend && npm run test:unit` | 91 + engine tests |
| Playwright | `cd frontend && npx playwright test` | 130 + advice tests |
| Lint | `cd frontend && npm run lint` | exactly 2 errors |
| Build | `cd frontend && npm run build` | no errors |
| Row pin intact | `git diff --stat frontend/tests/draft.spec.js` | no diff after Task 5 |

## Post-Deploy Verification (controller runs this, not a task)

Task 1 changes the sync and `/players`, so this needs a **backend deploy and a sync run**, then a frontend deploy.

1. Invoke the sync; confirm `ok: true` and a plausible player count
2. `GET /players?format=ppr` — confirm a known injured player carries `injuryStatus`, and a healthy one carries none
3. Confirm an unranked player carries no availability fields
4. Measure the payload against the current 62,372 bytes gzipped
5. On the live site, open a draft and confirm the recommendation card appears with reasons, the why control opens without drafting, and a manual pick still works
