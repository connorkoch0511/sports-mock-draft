# Hamburger Nav + Boards Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every page a hamburger navigation bar, and move the saved-boards list off Home onto its own `/boards` page.

**Architecture:** A `NavBar` component renders in the `App.jsx` shell above `<Routes>`, so all five routes inherit it — which incidentally fixes `/board/:boardId` currently having no way out. The boards list, create, and delete move from `Home.jsx` to a new `Boards.jsx`, leaving Home to do only draft setup.

**Tech Stack:** React 19, React Router 7, Vite 7, Tailwind 4, Playwright. ESM throughout.

**Source spec:** `docs/superpowers/specs/2026-08-28-hamburger-nav-design.md`

## Scope

Frontend only. No Lambda, no DynamoDB, no `sam deploy`. Boards are already tracked client-side in `localStorage` via `boardRegistry`, so `/boards` reads state that already exists. Shipping is `npm run deploy` alone.

Deliberately out of scope: the Sleeper league connection (its own spec — it reshapes the domain model), and a drafts index (no `draftRegistry` exists; separate decision).

## Global Constraints

- **Frontend is ESM** (`"type": "module"`). `import` / `export` only. The backend of this repo is CommonJS — do not copy that style.
- **No new dependencies.** React Router 7 is already present and supplies `Link` and `useLocation`.
- **No backend changes.** Do not touch anything under `backend/`.
- **Tailwind 4**, dark zinc/cyan palette, utility classes inline. Match surrounding style.
- **All hooks called unconditionally** before any early return.
- **These `data-testid` values are a contract** and must keep their exact names when markup moves: `create-board`, `board-list`. The per-board delete button keeps `aria-label="Delete {board name}"`.
- **Baseline is 41 passing Playwright tests.** No existing test may be weakened, skipped, or deleted.

---

## File Structure

**Create**
- `frontend/src/components/NavBar.jsx` — the bar, its toggle, and the menu. New `components/` directory: a shared shell component is not a page.
- `frontend/src/pages/Boards.jsx` — saved-boards index
- `frontend/tests/nav.spec.js` — navigation coverage

**Modify**
- `frontend/src/App.jsx` — add the `/boards` route, render `<NavBar />`
- `frontend/src/pages/Home.jsx` — remove the boards section
- `frontend/tests/board.spec.js` — retarget one test from `/` to `/boards`

---

## Task 1: Boards page and route

Extracts the boards section from Home into its own page. Ends with the whole suite green.

**Files:**
- Create: `frontend/src/pages/Boards.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/pages/Home.jsx` (remove lines 3, 6, 27, 55-82, and the boards JSX block at 211-247)
- Modify: `frontend/tests/board.spec.js:80` (retarget to `/boards`)

**Interfaces:**
- Consumes: `apiPost` / `apiDelete` from `../lib/api`; `listBoards` / `rememberBoard` / `forgetBoard` from `../lib/boardRegistry`; `usePageTitle` from `../lib/usePageTitle`
- Produces: route `/boards`. Task 2's NavBar links to it, and its nav test asserts arrival there.

**One necessary addition the spec did not specify.** `createBoard` currently reads Home's `format` and `year` state to name the board and set its season. Neither exists on `/boards`. Without a replacement you could only ever create one format of board, which is a regression. So `Boards.jsx` gets its own small format select (`data-testid="board-format"`), defaulting to `ppr`. Season is fixed at `2026` to match `DEFAULT_SEASON` in the backend and `ADP_YEAR` in the sync job — Home's `year` defaulted to 2025, which was already inconsistent with the data being synced, and board season is metadata that does not affect which players load.

- [ ] **Step 1: Create the Boards page**

`frontend/src/pages/Boards.jsx`:

```jsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost, apiDelete } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { listBoards, rememberBoard, forgetBoard } from "../lib/boardRegistry";

const BOARD_SEASON = 2026;

export default function Boards() {
  const nav = useNavigate();
  const [boards, setBoards] = useState(() => listBoards());
  const [format, setFormat] = useState("ppr");
  const [err, setErr] = useState("");

  usePageTitle("Boards");

  const createBoard = async () => {
    setErr("");
    try {
      const name = `My ${format.toUpperCase()} Board`;
      const { boardId } = await apiPost("/boards", {
        name,
        format,
        season: BOARD_SEASON,
      });
      rememberBoard({ id: boardId, name });
      setBoards(listBoards());
      nav(`/board/${boardId}`);
    } catch (e) {
      setErr(e.message || "Failed to create board");
    }
  };

  const deleteBoard = async (id) => {
    setErr("");
    try {
      // DELETE /boards/:id is idempotent (a DynamoDB DeleteCommand that
      // succeeds even if the item is already gone), so a resolved call
      // always means it's safe to forget locally. Only drop it from the
      // registry once the server confirms the delete — on failure, keep
      // it listed so the user can retry instead of losing their way back
      // to a board that still exists.
      await apiDelete(`/boards/${id}`);
      forgetBoard(id);
      setBoards(listBoards());
    } catch (e) {
      setErr(e.message || "Failed to delete board");
    }
  };

  return (
    <div className="py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My boards</h1>
          <p className="text-sm text-zinc-400">
            Rank players your way, then draft off your own board.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            data-testid="board-format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-cyan-300/60"
          >
            <option value="standard">Standard</option>
            <option value="half-ppr">Half PPR</option>
            <option value="ppr">PPR</option>
          </select>
          <button
            type="button"
            onClick={createBoard}
            data-testid="create-board"
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-600"
          >
            + New board
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-200">
          {err}
        </div>
      )}

      {boards.length === 0 ? (
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-8 text-center text-sm text-zinc-500">
          No boards yet. Create one to rank players your way.
        </div>
      ) : (
        <ul className="space-y-1" data-testid="board-list">
          {boards.map((b) => (
            <li key={b.id} className="flex items-center gap-2">
              <button
                onClick={() => nav(`/board/${b.id}`)}
                className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-left text-sm text-zinc-200 hover:border-zinc-600"
              >
                {b.name}
              </button>
              <button
                onClick={() => deleteBoard(b.id)}
                aria-label={`Delete ${b.name}`}
                className="rounded-2xl border border-zinc-800 px-3 py-3 text-xs text-zinc-500 hover:border-rose-900/60 hover:text-rose-300"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Register the route**

In `frontend/src/App.jsx`, add the import after the `Board` import:

```jsx
import Boards from "./pages/Boards.jsx";
```

and add the route after the `/board/:boardId` route:

```jsx
          <Route path="/boards" element={<Boards />} />
```

Order matters for readability but not for matching — React Router 7 ranks static segments above dynamic ones, so `/boards` and `/board/:boardId` cannot collide.

- [ ] **Step 3: Strip the boards section out of Home**

In `frontend/src/pages/Home.jsx`, make four deletions:

Replace the two import lines:

```jsx
import { apiPost, apiDelete } from "../lib/api";
```
becomes
```jsx
import { apiPost } from "../lib/api";
```

and delete this line entirely:

```jsx
import { listBoards, rememberBoard, forgetBoard } from "../lib/boardRegistry";
```

Delete the boards state line:

```jsx
  const [boards, setBoards] = useState(() => listBoards());
```

Delete both handlers — the whole `createBoard` function and the whole `deleteBoard` function, from `const createBoard = async () => {` through the closing `};` of `deleteBoard`.

Delete the entire boards JSX block, which begins with:

```jsx
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-white">My boards</div>
```

and ends with the `</div>` closing that `space-y-2 pt-2` wrapper, immediately before the `</div>` that closes the hero column.

Home keeps: `teams`, `rounds`, `loading`, `err`, `format`, `year`, `slot`, `randomSlot`, `safeSlot`, `schedule`, and `createDraft`. `nav` and `useMemo` are both still used — do not remove them.

- [ ] **Step 4: Retarget the moved test**

In `frontend/tests/board.spec.js`, in the test named `deleting a board removes it from the list`, change the navigation from the Home page to the boards page. The line currently reads:

```js
  await page.goto("/");
```

Change it to:

```js
  await page.goto("/boards");
```

There is a second `await page.reload();` later in that same test — leave it alone; reloading `/boards` is correct.

- [ ] **Step 5: Verify the build**

Run: `cd frontend && npm run build`
Expected: `✓ built in <time>` with no errors

- [ ] **Step 6: Verify the whole suite still passes**

Run: `cd frontend && npm test`
Expected: `41 passed`

If `deleting a board removes it from the list` fails, Step 4 was missed. If a `home.spec.js` or `slot.spec.js` test fails, Step 3 deleted too much — those suites only touch draft setup, which stays on Home.

- [ ] **Step 7: Revert regenerated screenshots**

The suite rewrites `screenshots/*.png`. They are committed baselines, not build output:

Run: `cd /Users/connor/projects/sports-mock-draft && git checkout -- screenshots/`

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Boards.jsx frontend/src/App.jsx frontend/src/pages/Home.jsx frontend/tests/board.spec.js
git commit -m "Extract saved boards from Home onto a /boards page"
```

---

## Task 2: NavBar

Test-first. The nav tests are written and watched to fail before the component exists.

**Files:**
- Create: `frontend/tests/nav.spec.js`
- Create: `frontend/src/components/NavBar.jsx`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: the `/boards` route from Task 1; `Link` and `useLocation` from `react-router-dom`
- Produces: `<NavBar />` rendered in the app shell. Testids `nav-toggle` and `nav-menu`.

- [ ] **Step 1: Write the failing tests**

`frontend/tests/nav.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { BOARD_ID, makeBoardState } from "./fixtures.js";

test("the menu is closed until the toggle is clicked", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toBeVisible();
});

test("the toggle closes an open menu", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toBeVisible();
  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

test("the toggle reports its state to assistive tech", async ({ page }) => {
  await page.goto("/");

  const toggle = page.getByTestId("nav-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("Boards navigates to the boards page", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "Boards" }).click();

  await expect(page).toHaveURL(/\/boards$/);
});

test("the menu closes after navigating", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "Boards" }).click();

  await expect(page).toHaveURL(/\/boards$/);
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

test("Escape closes the menu", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

test("clicking outside closes the menu", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toBeVisible();

  // Click far from both the menu and the toggle.
  await page.mouse.click(20, 500);
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

test("the current route is marked for assistive tech", async ({ page }) => {
  await page.goto("/boards");

  await page.getByTestId("nav-toggle").click();
  const boardsLink = page.getByTestId("nav-menu").getByRole("link", { name: "Boards" });
  await expect(boardsLink).toHaveAttribute("aria-current", "page");
});

test("navigation is reachable from a board — the dead-end regression", async ({ page }) => {
  // /board/:boardId previously had no navigation at all: browser back was the
  // only way out. This is the test for that bug.
  await page.route(`**/boards/${BOARD_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeBoardState()),
    })
  );
  await page.goto(`/board/${BOARD_ID}`);
  await expect(page.getByTestId("board-row").first()).toBeVisible();

  await page.getByTestId("nav-toggle").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "Home" }).click();

  await expect(page).toHaveURL(/\/$/);
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd frontend && npx playwright test nav.spec.js`
Expected: all 9 FAIL — the `nav-toggle` testid does not exist yet, so each times out waiting for it.

- [ ] **Step 3: Create the NavBar component**

`frontend/src/components/NavBar.jsx`:

```jsx
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

const LINKS = [
  { to: "/", label: "Home" },
  { to: "/boards", label: "Boards" },
];

export default function NavBar() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const toggleRef = useRef(null);
  const menuRef = useRef(null);

  // Close on route change. Driven off pathname rather than the links' onClick
  // so that programmatic navigation closes the menu too.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e) {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    }
    function onPointerDown(e) {
      if (
        !menuRef.current?.contains(e.target) &&
        !toggleRef.current?.contains(e.target)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <header className="relative flex items-center justify-between py-4">
      <Link
        to="/"
        className="flex items-center gap-2 text-sm font-semibold tracking-tight text-white"
      >
        <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_20px_rgba(34,211,238,0.6)]" />
        PerfectPick
      </Link>

      <button
        ref={toggleRef}
        type="button"
        data-testid="nav-toggle"
        aria-label="Menu"
        aria-expanded={open}
        aria-controls="nav-menu"
        onClick={() => setOpen((v) => !v)}
        className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-lg leading-none text-zinc-200 hover:border-zinc-600"
      >
        ☰
      </button>

      {open && (
        <nav
          id="nav-menu"
          ref={menuRef}
          data-testid="nav-menu"
          className="absolute right-0 top-full z-50 w-48 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur"
        >
          {LINKS.map((link) => {
            const active = pathname === link.to;
            return (
              <Link
                key={link.to}
                to={link.to}
                aria-current={active ? "page" : undefined}
                // The pathname effect misses a click on the route you are
                // already on, since pathname does not change. Close here too.
                onClick={() => setOpen(false)}
                className={`block px-4 py-3 text-sm hover:bg-zinc-900 ${
                  active ? "text-cyan-300" : "text-zinc-200"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
```

- [ ] **Step 4: Render it in the app shell**

In `frontend/src/App.jsx`, add the import after the page imports:

```jsx
import NavBar from "./components/NavBar.jsx";
```

and render it immediately inside the `max-w-[1400px]` container, above `<Routes>`:

```jsx
      <div className="mx-auto w-full max-w-[1400px] px-4 sm:px-6 lg:px-8">
        <NavBar />
        <Routes>
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `cd frontend && npx playwright test nav.spec.js`
Expected: `9 passed`

- [ ] **Step 6: Run the whole suite**

Run: `cd frontend && npm test`
Expected: `50 passed` (41 existing + 9 new)

No existing selector should collide: `home.spec.js:21` matches the longer string `"PerfectPick • Mock Draft Simulator"`, and `results.spec.js` looks for `"New Draft"` and `"Back to Draft"` — none of which the nav introduces. If one does go ambiguous anyway, fix it by scoping the older selector, not by changing the nav's markup; the nav's accessible names are asserted by `nav.spec.js`.

- [ ] **Step 7: Verify the build**

Run: `cd frontend && npm run build`
Expected: `✓ built in <time>` with no errors

- [ ] **Step 8: Revert regenerated screenshots**

Run: `cd /Users/connor/projects/sports-mock-draft && git checkout -- screenshots/`

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/NavBar.jsx frontend/src/App.jsx frontend/tests/nav.spec.js
git commit -m "Add hamburger navigation to every page"
```

---

## Verification

After Task 2, all of the following must pass:

```bash
cd frontend && npm test          # 50 Playwright tests
cd frontend && npm run test:unit # 6 unit tests
cd frontend && npm run build     # clean build
cd backend/src && npm test       # 24 unit tests, untouched by this work
```

Deployment is frontend-only: `cd frontend && npm run deploy`. No `sam deploy` — nothing under `backend/` changes.

## Notes for the implementer

- **Do not touch `backend/`.** This plan is entirely frontend.
- **The `☰` character is a literal** in the JSX, not an icon library import. No new dependencies.
- **`aria-expanded` renders as a string.** React serializes the boolean, so `toHaveAttribute("aria-expanded", "false")` is the correct assertion — do not "fix" the test to expect a boolean.
- **The menu unmounts when closed** (`{open && ...}`), which is why closed-state assertions use `toHaveCount(0)` rather than `not.toBeVisible()`.
- **Screenshots are committed baselines.** The Playwright suite rewrites `screenshots/draft.png` and `screenshots/home.png` on every run; revert them rather than committing the churn.
