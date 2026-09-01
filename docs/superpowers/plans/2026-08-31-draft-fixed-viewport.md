# Draft Fixed-Viewport Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app shell a definite height so the draft page's three panels scroll independently instead of growing the document, and move the three-column breakpoint to the width where the columns actually fit.

**Architecture:** Two CSS-only changes to existing markup. Task 1 moves the three-column grid from the `2xl` (1536px) breakpoint to `xl` (1280px), which is where the columns fit given the app's `max-w-[1400px]` container. Task 2 replaces the minimum-height chain (`min-h-screen` / `min-h-full`) with a definite one (`h-screen` / `h-full`) and gives the routes wrapper `overflow-y-auto`, which makes the panels' existing `flex-1 min-h-0 overflow-auto` finally clip and scroll. Task 1 comes first because Task 2's regression tests measure the three-column layout at 1280 and 1440 — widths that only produce that layout after Task 1.

**Tech Stack:** React 19, React Router 7, Tailwind CSS 4, Vite 7, Playwright.

## Global Constraints

- **Frontend is ESM.** `import`/`export` only. The backend is CommonJS; mixing the two is a defect.
- **No new dependencies.** No package.json changes.
- **CSS-only via Tailwind utility classes.** No new stylesheet, no inline `style` attributes, no CSS-in-JS.
- **No backend change.** Nothing under `backend/` is touched, and no Lambda deploy is part of this work.
- **Only `App.jsx` and `Draft.jsx` are modified.** `Home.jsx`, `Boards.jsx`, `Board.jsx`, `NewDraft.jsx`, and `Results.jsx` are not edited.
- **`lg:` classes are preserved.** `lg:grid-cols-2` and `lg:col-span-2` stay exactly as they are; only the `2xl:` variants move to `xl:`.
- **Existing suites must stay green:** 64 Playwright tests, 31 frontend unit tests, 55 backend unit tests.
- Test ids follow the existing convention in this repo: lowercase, hyphen-separated, on a `data-testid` attribute (see `board-list`, `create-board`, `board-load-note`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/src/App.jsx` | App shell: full-height root, nav, scrollable routes wrapper | Modified in Task 2 |
| `frontend/src/pages/Draft.jsx` | Draft page: full-height wrappers, three-column grid, three scrolling panels | Modified in Tasks 1 and 2 |
| `frontend/tests/draftlayout.spec.js` | Measurement-based layout regression suite | Created in Task 1, extended in Task 2 |

No other files are created or modified.

### Why the breakpoint moves to `xl`

The app container is `max-w-[1400px]`, so above 1400px it stops growing — a 1536px breakpoint cannot mean "the container got wider." The actual space at a 1280px viewport:

```
1280 viewport
 -64  App container padding (lg:px-8, both sides)
=1216 container width (under the 1400px cap)
 -48  Draft's own padding (px-6, both sides)
=1168 content width (under max-w-7xl = 1280px)

columns: 420 + 360 + (2 gaps x 16px) = 812
middle column: 1168 - 812 = 356px
```

356px is a workable middle column, so the three-column layout fits at `xl`.

---

## Task 1: Move the three-column breakpoint from `2xl` to `xl`

**Files:**
- Modify: `frontend/src/pages/Draft.jsx:316` (grid template), `:318` (Big Board panel), `:443` (Draft Board panel), `:528` (rosters panel)
- Create: `frontend/tests/draftlayout.spec.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: three `data-testid` attributes on the outer panel elements, used by Task 2 —
  - `panel-big-board` on the Big Board panel
  - `panel-draft-board` on the Draft Board panel
  - `panel-rosters` on the Team Rosters panel

  and one Playwright helper exported from the new spec file's module scope (not exported across files; Task 2 appends to the same file and reuses it in place):
  - `mockDraftApis(page, draftState)` — routes `GET /players*` to `MOCK_PLAYERS` and `GET /drafts/<DRAFT_ID>` to `draftState`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/draftlayout.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { MOCK_PLAYERS, DRAFT_ID, makeDraftState } from "./fixtures.js";

const API = "http://localhost:9999";

function mockDraftApis(page, draftState) {
  page.route(`${API}/players*`, async (route) => {
    await route.fulfill({ json: { players: MOCK_PLAYERS } });
  });
  page.route(`${API}/drafts/${DRAFT_ID}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: draftState });
    }
  });
}

// Pausing stops the auto-pick timer so the layout is measured against a
// stable DOM rather than one mutating between the two boundingBox() calls.
async function openPausedDraft(page) {
  mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("panel-rosters")).toBeVisible();
}

test.describe("Draft layout", () => {
  test("roster panel sits beside the other columns at 1440px", async ({ page }) => {
    await openPausedDraft(page);

    const draftBoard = await page.getByTestId("panel-draft-board").boundingBox();
    const rosters = await page.getByTestId("panel-rosters").boundingBox();

    // Three columns: rosters begins to the right of the draft board's right
    // edge. When the layout wraps to two columns, rosters spans the full
    // width on a second row, so its x is at the container's left edge and
    // its top is below the draft board's bottom -- both assertions fail.
    expect(rosters.x).toBeGreaterThan(draftBoard.x + draftBoard.width - 1);
    expect(rosters.y).toBeLessThan(draftBoard.y + draftBoard.height);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd frontend && npx playwright test tests/draftlayout.spec.js
```

Expected: FAIL. The `data-testid` attributes do not exist yet, so `openPausedDraft` times out waiting for `panel-rosters` to be visible.

- [ ] **Step 3: Add the panel test ids without changing any layout class**

In `frontend/src/pages/Draft.jsx`, add `data-testid` to the three outer panel elements. Change nothing else on these lines.

Line 318 — Big Board panel — becomes:

```jsx
          <div data-testid="panel-big-board" className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 space-y-3 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] min-h-0 min-w-0 flex flex-col">
```

Line 443 — Draft Board panel — becomes:

```jsx
          <div data-testid="panel-draft-board" className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] min-h-0 min-w-0 flex flex-col gap-3">
```

Line 528 — Team Rosters panel — becomes (layout classes still unchanged, `2xl:` intact):

```jsx
          <div data-testid="panel-rosters" className="2xl:sticky 2xl:top-6 min-h-0 min-w-0 flex flex-col rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] lg:col-span-2 2xl:col-span-1">
```

- [ ] **Step 4: Re-run the test to verify it now fails on the real assertion**

```bash
cd frontend && npx playwright test tests/draftlayout.spec.js
```

Expected: FAIL on `expect(rosters.x).toBeGreaterThan(...)`, with `rosters.x` roughly equal to the draft board's left edge rather than beyond its right edge.

This step is the proof that the test measures the bug rather than a missing selector. Do not proceed until the failure message names the `rosters.x` assertion.

- [ ] **Step 5: Move the breakpoint from `2xl` to `xl`**

`frontend/src/pages/Draft.jsx` line 316 — the grid. `lg:grid-cols-2` is unchanged:

```jsx
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[420px_minmax(0,1fr)_360px] flex-1 min-h-0 min-w-0">
```

`frontend/src/pages/Draft.jsx` line 528 — the rosters panel. `lg:col-span-2` is unchanged; `2xl:sticky`, `2xl:top-6`, and `2xl:col-span-1` become `xl:`:

```jsx
          <div data-testid="panel-rosters" className="xl:sticky xl:top-6 min-h-0 min-w-0 flex flex-col rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] lg:col-span-2 xl:col-span-1">
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd frontend && npx playwright test tests/draftlayout.spec.js
```

Expected: PASS, 1 test.

- [ ] **Step 7: Confirm no `2xl:` variant was left behind in Draft.jsx**

```bash
grep -n "2xl:" frontend/src/pages/Draft.jsx
```

Expected: no output. If any line matches, it is a missed edit from Step 5 — fix it and re-run Step 6.

- [ ] **Step 8: Run the full Playwright suite**

```bash
cd frontend && npx playwright test
```

Expected: PASS, 65 tests (the 64 existing plus the new one). Do not run this in the background — wait for it and report the actual counts.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/Draft.jsx frontend/tests/draftlayout.spec.js
git commit -m "Move draft three-column layout from 2xl to xl

The app container caps at max-w-[1400px], so a 1536px breakpoint cannot
mean the container got wider. The columns (420 + 360 + gaps) leave a
356px middle column at a 1280px viewport, so they fit at xl -- gating on
2xl pushed the roster panel onto a second row at the most common widths.

Adds data-testid to the three panels and a geometry-based regression test
that fails when the roster panel wraps below instead of sitting beside."
```

---

## Task 2: Bound the height chain so the panels scroll instead of the page

**Files:**
- Modify: `frontend/src/App.jsx:12` (root), `:17` (routes wrapper)
- Modify: `frontend/src/pages/Draft.jsx:245` (outer wrapper), `:253` (content wrapper), `:397` (Big Board scroller), `:484` (Draft Board scroller), `:534` (rosters scroller)
- Test: `frontend/tests/draftlayout.spec.js` (extend the file created in Task 1)

**Interfaces:**
- Consumes from Task 1: the `panel-big-board`, `panel-draft-board`, and `panel-rosters` test ids, and the `openPausedDraft(page)` helper already defined at module scope in `frontend/tests/draftlayout.spec.js`.
- Produces: `data-testid` on the three inner scroll containers — `scroll-big-board`, `scroll-draft-board`, `scroll-rosters`.

**Background the implementer needs:**

`min-h-screen` and `min-h-full` set a *minimum* height. Content taller than the viewport grows the element rather than being clipped. `overflow-auto` scrolls an element only when something bounds its height, so today the three panels size to their content and the whole document scrolls. Replacing the chain's minimums with definite heights (`h-screen` on the root, `h-full` on the Draft wrappers) is what makes every `min-h-0` and `overflow-auto` below them take effect.

The routes wrapper's `overflow-y-auto` is what keeps every *other* page working: a page taller than the wrapper scrolls the wrapper instead of the document. To a user that looks and behaves the same. Without it, tall pages would be clipped and their content unreachable — a worse failure than the bug being fixed, which is why the test below covers a long page as well as the draft page.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/draftlayout.spec.js`, inside the existing `test.describe("Draft layout", ...)` block, after the Task 1 test:

```js
  // The panel-bottom assertion is the load-bearing one. Once the routes
  // wrapper scrolls, documentElement.scrollHeight equals innerHeight even
  // when content overflows inside it -- so "the document does not scroll"
  // alone would pass with the layout still broken.
  for (const width of [1280, 1440, 1536]) {
    test(`panels stay inside the viewport at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPausedDraft(page);

      const documentScrolls = await page.evaluate(
        () => document.documentElement.scrollHeight > window.innerHeight + 2
      );
      expect(documentScrolls).toBe(false);

      for (const id of ["panel-big-board", "panel-draft-board", "panel-rosters"]) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box.y + box.height, `${id} bottom edge`).toBeLessThanOrEqual(902);
        // A panel collapsed to nothing would satisfy the bound above, so
        // require it to still be a real panel.
        expect(box.height, `${id} height`).toBeGreaterThan(200);
      }
    });
  }

  test("panels scroll their own overflowing content", async ({ page }) => {
    await openPausedDraft(page);

    // Both lists paginate at 25 rows, which is more than fits in a 900px
    // viewport, so each of these must be clipped and internally scrollable.
    for (const id of ["scroll-big-board", "scroll-draft-board"]) {
      const metrics = await page
        .getByTestId(id)
        .evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      expect(metrics.scroll, `${id} scrollHeight`).toBeGreaterThan(metrics.client);
    }
  });

  test("a long page still scrolls after the shell gains a fixed height", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      const boards = Array.from({ length: 50 }, (_, i) => ({
        id: `layout-b${i}`,
        name: `Board ${i}`,
        format: "ppr",
        updatedAt: Date.now() - i,
      }));
      localStorage.setItem("perfectpick.myBoards", JSON.stringify(boards));
    });

    await page.goto("/boards");
    await expect(page.getByTestId("board-list")).toBeVisible();

    // Reachability, not documentElement.scrollHeight: with the shell at a
    // fixed height the routes wrapper scrolls, not the document. What must
    // hold is that the last board can still be scrolled to and seen.
    const last = page.getByRole("button", { name: "Board 49", exact: true });
    await expect(last).not.toBeInViewport();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx playwright test tests/draftlayout.spec.js
```

Expected: FAIL.
- The three `panels stay inside the viewport at Npx` tests fail on a `panel-* bottom edge` assertion — a panel bottom far beyond 902 (measured today at roughly 6,000–8,300).
- `panels scroll their own overflowing content` fails because `scroll-big-board` does not exist yet.
- `a long page still scrolls...` passes already (the document itself scrolls today). That is expected: it is a guard against a regression this task could introduce, not a reproduction of the current bug.

- [ ] **Step 3: Add the scroller test ids**

In `frontend/src/pages/Draft.jsx`, add `data-testid` to the three inner scroll containers. Change nothing else on these lines.

Line 397 — Big Board list:

```jsx
            <div data-testid="scroll-big-board" className="flex-1 min-h-0 overflow-auto space-y-2 pr-1">
```

Line 484 — Draft Board table container:

```jsx
            <div data-testid="scroll-draft-board" className="flex-1 min-h-0 overflow-auto rounded-2xl border border-zinc-900">
```

Line 534 — rosters list:

```jsx
            <div data-testid="scroll-rosters" className="mt-3 flex-1 min-h-0 overflow-auto space-y-3 pr-1">
```

- [ ] **Step 4: Give the app shell a definite height**

`frontend/src/App.jsx` line 12 — root `min-h-screen` becomes `h-screen`:

```jsx
    <div className="flex h-screen flex-col bg-[#070A0F] text-white">
```

`frontend/src/App.jsx` line 17 — routes wrapper gains `overflow-y-auto`:

```jsx
        <div className="flex-1 min-h-0 overflow-y-auto">
```

Line 13 (the `max-w-[1400px]` container) and lines 14–16 (the nav) are unchanged.

- [ ] **Step 5: Give the Draft page's wrappers a definite height**

`frontend/src/pages/Draft.jsx` line 245 — outer wrapper:

```jsx
    <div className="relative h-full w-full overflow-x-hidden">
```

`frontend/src/pages/Draft.jsx` line 253 — content wrapper:

```jsx
      <div className="relative mx-auto max-w-7xl px-6 py-6 h-full flex flex-col gap-4">
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd frontend && npx playwright test tests/draftlayout.spec.js
```

Expected: PASS, 6 tests (the 1 from Task 1 plus the 5 added here).

- [ ] **Step 7: Mutation-check that the height fix is what the tests measure**

Temporarily revert line 253 back to `min-h-full`:

```bash
cd frontend && sed -i '' '253s/py-6 h-full/py-6 min-h-full/' src/pages/Draft.jsx
npx playwright test tests/draftlayout.spec.js
```

Expected: FAIL on the `panel-* bottom edge` assertions. If they still pass, the tests are not measuring the fix — stop and report this rather than continuing.

Restore it:

```bash
cd frontend && sed -i '' '253s/py-6 min-h-full/py-6 h-full/' src/pages/Draft.jsx
grep -n "py-6 h-full" src/pages/Draft.jsx
```

Expected: line 253 matches. Then re-run `npx playwright test tests/draftlayout.spec.js` and confirm PASS, 6 tests, before moving on.

- [ ] **Step 8: Run the full Playwright suite**

```bash
cd frontend && npx playwright test
```

Expected: PASS, 70 tests (64 existing + 1 from Task 1 + 5 from this task). Do not run this in the background — wait for it and report the actual counts. `h-screen` on the shell root affects every page, so a failure anywhere in this suite is in scope for this task, not a pre-existing flake to wave through.

- [ ] **Step 9: Run the frontend unit tests and the production build**

```bash
cd frontend && npm run test:unit && npm run build
```

Expected: 31 unit tests pass; the build completes with no errors.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/App.jsx frontend/src/pages/Draft.jsx frontend/tests/draftlayout.spec.js
git commit -m "Bound the app height chain so draft panels scroll, not the page

min-h-screen and min-h-full are minimums, so nothing in the chain ever
had a definite height and the panels' flex-1 min-h-0 overflow-auto never
clipped -- the draft page scrolled as one long document at every width
(7,446px of overflow at 1440). h-screen on the shell root and h-full on
the Draft wrappers make those existing classes take effect.

The routes wrapper gains overflow-y-auto so other pages scroll the
wrapper instead of the document; a /boards test covers that, since a
missing overflow rule there would clip content unreachably."
```

---

## Verification Summary

After both tasks:

| Suite | Command | Expected |
|---|---|---|
| Playwright | `cd frontend && npx playwright test` | 70 pass |
| Frontend unit | `cd frontend && npm run test:unit` | 31 pass |
| Backend unit | `cd backend && npm test` | 55 pass |
| Build | `cd frontend && npm run build` | no errors |

The backend is untouched; its suite is listed only to confirm the change stayed inside the frontend.
