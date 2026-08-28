# Landing Page + Nav v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move draft setup off the home page onto `/draft/new`, make `/` a real landing page, and move the hamburger to the left with a third menu item.

**Architecture:** `Home.jsx` currently holds a hero, a full draft-setup form, and feature cards. The form moves verbatim to a new `NewDraft.jsx` at `/draft/new`; Home keeps the hero and cards and gains calls to action, ending with no state and no network calls. `NavBar` then flips its layout and gains a New Draft entry.

**Tech Stack:** React 19, React Router 7, Vite 7, Tailwind 4, Playwright. ESM throughout.

**Source spec:** `docs/superpowers/specs/2026-08-28-landing-page-and-nav-v2-design.md`

## Scope

Frontend only. No Lambda, no DynamoDB, no `sam deploy`. Shipping is `npm run deploy` alone.

Out of scope, each its own future work: the Sleeper league connection, a drafts index (no `draftRegistry` exists), and the Draft board's `2xl` breakpoint gap.

## Global Constraints

- **Frontend is ESM** (`"type": "module"`). `import` / `export` only. The backend of this repo is CommonJS — do not copy that style.
- **No new dependencies.**
- **No backend changes.** Do not touch anything under `backend/`.
- **Tailwind 4**, dark zinc/cyan palette, utility classes inline. Match surrounding style.
- **All hooks called unconditionally** before any early return.
- **These selectors are a contract** and must survive the move with exact names, because tests match on them: `data-testid` values `slot-select`, `random-slot`, `pick-schedule`; the accessible labels `Teams`, `Rounds`, `ADP Format`; and the button text `Start Mock Draft`.
- **Playwright's `getByLabel` relies on the wrapping `<label>` structure.** Each control is a `<label className="space-y-1">` containing a `<div>` with the label text and then the input. Preserve that nesting exactly or `getByLabel("Teams")` stops resolving.
- **Baseline is 50 passing Playwright tests.** No existing test may be weakened, skipped, or deleted.
- **Screenshots are committed baselines.** The suite rewrites `screenshots/*.png`; revert them before committing.

---

## File Structure

**Create**
- `frontend/src/pages/NewDraft.jsx` — draft-setup form
- `frontend/tests/newdraft.spec.js` — the tests that move off Home

**Modify**
- `frontend/src/App.jsx` — add the `/draft/new` route
- `frontend/src/pages/Home.jsx` — strip the form, add CTAs
- `frontend/src/components/NavBar.jsx` — hamburger left, third menu item
- `frontend/tests/home.spec.js` — delete 4 moved tests, rewrite 1 to assert the form is gone, leave 2 untouched
- `frontend/tests/slot.spec.js` — retarget 3 tests to `/draft/new`
- `frontend/tests/nav.spec.js` — cover the third menu item

---

## Task 1: Move draft setup to /draft/new

The form, its state, and eight tests move. Home becomes presentational. Ends with the suite green at 50.

**Files:**
- Create: `frontend/src/pages/NewDraft.jsx`, `frontend/tests/newdraft.spec.js`
- Modify: `frontend/src/App.jsx`, `frontend/src/pages/Home.jsx`, `frontend/tests/home.spec.js`, `frontend/tests/slot.spec.js`

**Interfaces:**
- Consumes: `apiPost` from `../lib/api`; `picksForSlot` / `largestGap` from `../lib/snake`; `usePageTitle` from `../lib/usePageTitle`
- Produces: route `/draft/new`. Task 2's NavBar links to it and asserts arrival.

- [ ] **Step 1: Create the NewDraft page**

`frontend/src/pages/NewDraft.jsx`:

```jsx
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { picksForSlot, largestGap } from "../lib/snake";

// Home carried this as state with a setter that was never called. It is a
// constant here rather than dead state; the request body is unchanged.
const DRAFT_YEAR = 2025;

export default function NewDraft() {
  const nav = useNavigate();
  const [teams, setTeams] = useState(12);
  const [rounds, setRounds] = useState(15);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [format, setFormat] = useState("standard");
  const [slot, setSlot] = useState(1);
  const [randomSlot, setRandomSlot] = useState(false);

  usePageTitle("New Draft");

  const safeSlot = Math.min(Math.max(1, slot), teams);
  const schedule = useMemo(
    () => picksForSlot(safeSlot, teams, rounds),
    [safeSlot, teams, rounds]
  );

  const createDraft = async () => {
    setLoading(true);
    setErr("");
    try {
      const userTeam = randomSlot
        ? Math.floor(Math.random() * teams) + 1
        : safeSlot;
      const draft = await apiPost("/drafts", {
        teams, rounds, sport: "nfl", format, year: DRAFT_YEAR, userTeam,
      });
      nav(`/draft/${draft.draftId}`);
    } catch (e) {
      setErr(e.message || "Failed to create draft");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">New mock draft</h1>
        <p className="text-sm text-zinc-400">
          Set your league up, pick your slot, and draft.
        </p>
      </div>

      <div className="max-w-2xl space-y-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <div className="text-sm text-zinc-300">Teams</div>
            <input
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none ring-0 focus:border-cyan-300/60 focus:shadow-[0_0_0_4px_rgba(34,211,238,0.10)]"
              type="number"
              min={2}
              max={32}
              value={teams}
              onChange={(e) => setTeams(Number(e.target.value))}
            />
          </label>

          <label className="space-y-1">
            <div className="text-sm text-zinc-300">Rounds</div>
            <input
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none ring-0 focus:border-sky-300/60 focus:shadow-[0_0_0_4px_rgba(59,130,246,0.10)]"
              type="number"
              min={1}
              max={30}
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
            />
          </label>

          <label className="space-y-1 sm:col-span-2">
            <div className="flex items-center justify-between text-sm text-zinc-300">
              <span>Your draft slot</span>
              <button
                type="button"
                onClick={() => setRandomSlot((v) => !v)}
                data-testid="random-slot"
                className={`rounded-full border px-3 py-0.5 text-xs ${
                  randomSlot
                    ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-200"
                    : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
                }`}
              >
                Random
              </button>
            </div>
            <select
              data-testid="slot-select"
              disabled={randomSlot}
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none focus:border-cyan-300/60 disabled:opacity-40"
              value={safeSlot}
              onChange={(e) => setSlot(Number(e.target.value))}
            >
              {Array.from({ length: teams }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>Slot {n} of {teams}</option>
              ))}
            </select>
            {!randomSlot && (
              <div data-testid="pick-schedule" className="text-xs text-zinc-500">
                Your picks: {schedule.slice(0, 8).join(", ")}
                {schedule.length > 8 ? ", …" : ""}
                {schedule.length > 1 && ` · ${largestGap(schedule)}-pick longest wait`}
              </div>
            )}
          </label>
        </div>

        <label className="space-y-1 block">
          <div className="text-sm text-zinc-300">ADP Format</div>
          <select
            className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="standard">Standard</option>
            <option value="half-ppr">Half PPR</option>
            <option value="ppr">PPR</option>
          </select>
        </label>

        {err ? (
          <div className="rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-red-200 text-sm">
            {err}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            onClick={createDraft}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-cyan-300 to-sky-300 px-5 py-3 font-semibold text-black shadow-[0_10px_40px_rgba(34,211,238,0.20)] disabled:opacity-50"
          >
            {loading ? "Creating…" : "Start Mock Draft"}
          </button>

          <div className="text-xs text-zinc-400">
            Tip: Once inside the draft, use <span className="text-zinc-200">Auto Pick</span> to simulate quickly.
          </div>
        </div>
      </div>
    </div>
  );
}
```

`year` had no control on Home either — it was `useState(2025)` whose setter was never
called. It becomes the module constant `DRAFT_YEAR` rather than dead state, so the
request body is byte-identical while the new file carries no unused setter. Do not add
a control for it.

- [ ] **Step 2: Register the route**

In `frontend/src/App.jsx`, add the import beside the other page imports:

```jsx
import NewDraft from "./pages/NewDraft.jsx";
```

and add the route **before** the `/draft/:draftId` route:

```jsx
          <Route path="/draft/new" element={<NewDraft />} />
```

React Router 7 ranks static segments above dynamic ones, so order does not decide the match — but listing the static route first reads correctly.

- [ ] **Step 3: Reduce Home to a landing page**

Replace the entire contents of `frontend/src/pages/Home.jsx`:

```jsx
import { Link } from "react-router-dom";
import { usePageTitle } from "../lib/usePageTitle";

function Card({ title, desc }) {
  return (
    <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur">
      <div className="text-sm font-semibold text-white">{title}</div>
      <div className="mt-1 text-sm text-zinc-400">{desc}</div>
    </div>
  );
}

export default function Home() {
  usePageTitle("Home");

  return (
    <div className="relative min-h-full w-full overflow-hidden">
      {/* Background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1000px_500px_at_20%_10%,rgba(34,211,238,0.18),transparent_60%),radial-gradient(900px_500px_at_80%_20%,rgba(59,130,246,0.16),transparent_55%),radial-gradient(700px_500px_at_50%_85%,rgba(168,85,247,0.10),transparent_55%)]" />
        <div className="absolute inset-0 opacity-[0.12] [background-image:linear-gradient(to_right,rgba(255,255,255,0.10)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.10)_1px,transparent_1px)] [background-size:64px_64px]" />
      </div>

      {/* Content */}
      <div className="relative mx-auto max-w-7xl px-6 py-12">
        <div className="grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
          {/* Hero */}
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/60 px-3 py-1 text-xs text-zinc-300 backdrop-blur">
              <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_20px_rgba(34,211,238,0.6)]" />
              PerfectPick • Mock Draft Simulator
            </div>

            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              Draft smarter.
              <span className="block bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent">
                Build the perfect board.
              </span>
            </h1>

            <p className="max-w-2xl text-zinc-300">
              PerfectPick is a modern mock draft simulator with a live Big Board, snake draft engine,
              smart auto-picks, and serverless persistence.
            </p>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                to="/draft/new"
                data-testid="cta-new-draft"
                className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-cyan-300 to-sky-300 px-5 py-3 font-semibold text-black shadow-[0_10px_40px_rgba(34,211,238,0.20)]"
              >
                Start a mock draft
              </Link>
              <Link
                to="/boards"
                data-testid="cta-boards"
                className="inline-flex items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950/70 px-5 py-3 text-zinc-200 hover:border-zinc-600"
              >
                My boards
              </Link>
            </div>
          </div>

          {/* Feature cards */}
          <div className="space-y-4">
            <Card
              title="Big Board + Search"
              desc="Filter by position, search names, and draft directly from the board."
            />
            <Card
              title="Snake Draft Engine"
              desc="Round-by-round snake ordering with picks persisted to DynamoDB."
            />
            <Card
              title="Smart Auto Picks"
              desc="Roster-aware auto picks using position needs, rank, and tier weighting."
            />
          </div>
        </div>
      </div>
    </div>
  );
}
```

Home now imports only `Link` and `usePageTitle`. It holds no state and makes no network calls.

- [ ] **Step 4: Move five tests off home.spec.js**

Open `frontend/tests/home.spec.js`. Delete these four tests entirely — they move to the new file in Step 5:

- `default form values are 12 teams, 15 rounds, standard format`
- `user can change teams, rounds, and format`
- `clicking Start Mock Draft navigates to draft page`
- `shows error message when API call fails`

Then edit `renders hero and draft controls`. It currently asserts both the hero and the `Start Mock Draft` button. Rename it to `renders hero and calls to action` and replace its assertions so it checks the hero plus the two new CTAs, and — critically — that the draft form is **gone**:

```js
  test("renders hero and calls to action", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("PerfectPick • Mock Draft Simulator")).toBeVisible();
    await expect(page.getByTestId("cta-new-draft")).toBeVisible();
    await expect(page.getByTestId("cta-boards")).toBeVisible();

    // The draft form moved to /draft/new. If it is still here, the extraction
    // duplicated it instead of moving it.
    await expect(page.getByLabel("Teams")).toHaveCount(0);
    await expect(page.getByTestId("slot-select")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start Mock Draft" })).toHaveCount(0);
  });
```

Leave `feature cards are visible` and `screenshot — home page` untouched. If either mocks `**/drafts` in its setup, that mock is now unnecessary but harmless — leave it rather than risk changing behavior.

- [ ] **Step 5: Create newdraft.spec.js with the four moved tests**

`frontend/tests/newdraft.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { DRAFT_ID } from "./fixtures.js";

const API = "http://localhost:9999";

test.describe("New Draft page", () => {
  test("default form values are 12 teams, 15 rounds, standard format", async ({ page }) => {
    await page.goto("/draft/new");

    await expect(page.getByLabel("Teams")).toHaveValue("12");
    await expect(page.getByLabel("Rounds")).toHaveValue("15");
    await expect(page.getByLabel("ADP Format")).toHaveValue("standard");
  });

  test("user can change teams, rounds, and format", async ({ page }) => {
    await page.goto("/draft/new");

    await page.getByLabel("Teams").fill("8");
    await page.getByLabel("Rounds").fill("10");
    await page.getByLabel("ADP Format").selectOption("ppr");

    await expect(page.getByLabel("Teams")).toHaveValue("8");
    await expect(page.getByLabel("Rounds")).toHaveValue("10");
    await expect(page.getByLabel("ADP Format")).toHaveValue("ppr");
  });

  test("clicking Start Mock Draft navigates to draft page", async ({ page }) => {
    await page.route(`${API}/drafts`, async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ json: { draftId: DRAFT_ID } });
      }
    });

    await page.goto("/draft/new");
    await page.getByRole("button", { name: /Start Mock Draft/i }).click();
    await expect(page).toHaveURL(`/draft/${DRAFT_ID}`);
  });

  test("shows error message when API call fails", async ({ page }) => {
    await page.route(`${API}/drafts`, async (route) => {
      await route.fulfill({ status: 500, json: { error: "Server error" } });
    });

    await page.goto("/draft/new");
    await page.getByRole("button", { name: /Start Mock Draft/i }).click();

    await expect(page.getByText(/Server error|Failed to create draft/i)).toBeVisible();
  });
});
```

This mirrors `home.spec.js` exactly, including its `test.describe` wrapper, its
method check on the POST mock, and the `/Start Mock Draft/i` regex. Note the navigate
test deliberately does **not** mock the draft page's own data calls — it asserts the URL,
which resolves the moment navigation happens, so the Draft page's subsequent fetches are
irrelevant to it. Do not add mocks it does not need.

- [ ] **Step 6: Retarget three slot tests**

In `frontend/tests/slot.spec.js`, three tests call `await page.goto("/")`. Change each to:

```js
  await page.goto("/draft/new");
```

They are `pick schedule updates with the selected slot`, `selected slot is sent when creating a draft`, and `random slot disables the selector`. The fourth test navigates to `/draft/${DRAFT_ID}` — leave it alone.

- [ ] **Step 7: Run the whole suite**

Run: `cd frontend && npm test`
Expected: `50 passed`

The count is unchanged: four tests left `home.spec.js` and four arrived in `newdraft.spec.js`.

If `getByLabel("Teams")` fails on `/draft/new`, the `<label>` nesting was altered — Playwright resolves that label through the wrapping element, not an `htmlFor`.

- [ ] **Step 8: Verify the build**

Run: `cd frontend && npm run build`
Expected: `✓ built in <time>` with no errors

- [ ] **Step 9: Revert regenerated screenshots**

Run: `cd /Users/connor/projects/sports-mock-draft && git checkout -- screenshots/`

- [ ] **Step 10: Commit**

```bash
git add frontend/src/pages/NewDraft.jsx frontend/src/pages/Home.jsx frontend/src/App.jsx frontend/tests/newdraft.spec.js frontend/tests/home.spec.js frontend/tests/slot.spec.js
git commit -m "Move draft setup to /draft/new and make Home a landing page"
```

---

## Task 2: Hamburger to the left

**Files:**
- Modify: `frontend/src/components/NavBar.jsx`, `frontend/tests/nav.spec.js`

**Interfaces:**
- Consumes: the `/draft/new` route from Task 1
- Produces: nothing later depends on

- [ ] **Step 1: Write the failing test**

In `frontend/tests/nav.spec.js`, add this test at the end of the file:

```js
test("New Draft navigates to the draft setup page", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "New Draft" }).click();

  await expect(page).toHaveURL(/\/draft\/new$/);
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx playwright test nav.spec.js`
Expected: the new test FAILS — no `New Draft` link exists in the menu yet. The other 9 pass.

- [ ] **Step 3: Add the third link**

In `frontend/src/components/NavBar.jsx`, replace the `LINKS` array:

```jsx
const LINKS = [
  { to: "/", label: "Home" },
  { to: "/draft/new", label: "New Draft" },
  { to: "/boards", label: "Boards" },
];
```

- [ ] **Step 4: Flip the header layout**

In the same file, change the `<header>` so the toggle comes first and the brand follows it. Replace `justify-between` with a gap-based layout, and move the `<button>` above the `<Link>` in source order:

```jsx
    <header className="relative flex items-center gap-3 py-4">
```

Then reorder the two children so the `<button ref={toggleRef} …>` element appears **before** the `<Link to="/" …>` element. Change nothing else about either — same refs, same handlers, same classes, same `data-testid`, same aria attributes.

- [ ] **Step 5: Re-anchor the menu panel**

The menu currently opens from the right edge, which is wrong once the toggle is on the left. In the `<nav id="nav-menu">` element, change `right-0` to `left-0`:

```jsx
          className="absolute left-0 top-full z-50 w-48 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur"
```

- [ ] **Step 6: Run the nav suite**

Run: `cd frontend && npx playwright test nav.spec.js`
Expected: `10 passed`

- [ ] **Step 7: Run the whole suite**

Run: `cd frontend && npm test`
Expected: `51 passed`

- [ ] **Step 8: Verify the build**

Run: `cd frontend && npm run build`
Expected: `✓ built in <time>` with no errors

- [ ] **Step 9: Revert regenerated screenshots**

Run: `cd /Users/connor/projects/sports-mock-draft && git checkout -- screenshots/`

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/NavBar.jsx frontend/tests/nav.spec.js
git commit -m "Move hamburger to the left and add New Draft to the menu"
```

---

## Verification

After Task 2:

```bash
cd frontend && npm test          # 51 Playwright tests
cd frontend && npm run test:unit # 6 unit tests
cd frontend && npm run build     # clean build
cd backend/src && npm test       # 24 unit tests, untouched by this work
```

Deployment is frontend-only: `cd frontend && npm run deploy`.

## Notes for the implementer

- **Do not touch `backend/`.** This plan is entirely frontend.
- **`getByLabel` depends on `<label>` nesting**, not `htmlFor`. The controls are a `<label>` wrapping a text `<div>` and then the input. Flattening that breaks four tests.
- **Do not change any NavBar behavior in Task 2** — only layout, the menu's anchor edge, and the link list. The close-on-route-change, Escape-with-focus-return, click-outside, and aria wiring are all covered by existing tests, including one that was mutation-verified.
- **Screenshots are committed baselines.** The suite rewrites `screenshots/draft.png` and `screenshots/home.png` every run; revert rather than committing the churn.
