# My Drafts Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a local record of every mock draft you start or open, so a draft is no longer lost the moment you lose its link.

**Architecture:** Three tasks, ordered so each one's test is meaningful on its own. Task 1 builds the storage module in isolation and establishes the `localStorage` stubbing pattern the frontend has never had. Task 2 builds the `/drafts` page against seeded storage. Task 3 adds the hook that populates the registry from real draft loads, and its end-to-end test — open a draft by link, then find it listed — is the behavior the whole feature exists for.

**Tech Stack:** React 19, React Router 7, Tailwind 4, Vite 7, `node:test` for unit tests, Playwright for end-to-end.

## Global Constraints

- **The frontend is ESM.** `import`/`export` only. The backend is CommonJS; mixing them is a defect.
- **No new dependencies.** No `frontend/package.json` changes.
- **No backend change.** Nothing under `backend/` is touched, and no Lambda deploy is part of this work.
- **No change to `NewDraft.jsx`.** Creation navigates to `/draft/:id`, where the hook records the draft from server data. This is deliberate, not an omission.
- The storage key is exactly `perfectpick.myDrafts`. The board registry's key, `perfectpick.myBoards`, is a different store and must not be touched.
- The registry caps at **50** entries, matching `boardRegistry.js`.
- Removal is **local only** and the control is labelled **Forget**, never Delete. There is no `DELETE /drafts` endpoint; the label must not imply a deletion that is not happening.
- Every `localStorage` access is wrapped in try/catch. A throw in a load-path hook would break the draft page itself.
- Tailwind utility classes only — no new stylesheet, no inline `style`.
- Unit tests run with `cd frontend && npm run test:unit`; Playwright with `cd frontend && npx playwright test`.
- Existing suites must stay green: **31 frontend unit**, **74 Playwright**, 100 backend unit.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/src/lib/draftRegistry.js` | Read/write the local draft list | Task 1 — **new** |
| `frontend/src/lib/draftRegistry.test.js` | Unit tests for the above | Task 1 — **new** |
| `frontend/src/pages/MyDrafts.jsx` | The `/drafts` page | Task 2 — **new** |
| `frontend/src/App.jsx` | Route table | Task 2 — one route added |
| `frontend/src/components/NavBar.jsx` | Nav links | Task 2 — one link added |
| `frontend/tests/mydrafts.spec.js` | End-to-end for the page and the hook | Task 2 — **new**; Task 3 extends |
| `frontend/src/lib/useRememberDraft.js` | Records a fetched draft | Task 3 — **new** |
| `frontend/src/pages/Draft.jsx` | Draft page | Task 3 — one hook call |
| `frontend/src/pages/Results.jsx` | Results page | Task 3 — one hook call |

### Testing `localStorage` in `node:test` (verified working before this plan was written)

`localStorage` does not exist in Node — `typeof localStorage` is `"undefined"`. The frontend has never unit-tested a storage module for this reason (`boardRegistry.js` has no tests).

The working approach, proven against the real `boardRegistry.js` before this plan was written: assign `globalThis.localStorage` inside each test. ESM imports are hoisted, but these modules read `localStorage` at *call* time inside their functions, not at import time, so a stub assigned after the import is picked up. A stub whose methods throw is how the storage-unavailable path gets covered.

---

## Task 1: The draft registry module

**Files:**
- Create: `frontend/src/lib/draftRegistry.js`
- Create: `frontend/src/lib/draftRegistry.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, used by Tasks 2 and 3:
  - `listDrafts() -> entry[]` — most-recent-first
  - `rememberDraft({ id, teams, rounds, format, userTeam, boardId, completed }) -> void`
  - `forgetDraft(id) -> void`

  Entry shape: `{ id, teams, rounds, format, userTeam, boardId, completed, updatedAt }`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/draftRegistry.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { listDrafts, rememberDraft, forgetDraft } from "./draftRegistry.js";

// localStorage does not exist in Node. These modules read it at call time
// inside their functions, so a stub assigned here is picked up even though
// the import above is hoisted.
function useFakeStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return map;
}

function draft(id, extra) {
  return {
    id,
    teams: 12,
    rounds: 15,
    format: "standard",
    userTeam: 1,
    boardId: null,
    completed: false,
    ...extra,
  };
}

test("a remembered draft is listed", () => {
  useFakeStorage();
  rememberDraft(draft("d1"));

  const all = listDrafts();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].id, "d1");
  assert.strictEqual(all[0].teams, 12);
  assert.strictEqual(all[0].rounds, 15);
  assert.strictEqual(all[0].format, "standard");
  assert.strictEqual(all[0].userTeam, 1);
  assert.strictEqual(all[0].completed, false);
  assert.ok(typeof all[0].updatedAt === "number");
});

test("remembering an existing id updates in place rather than duplicating", () => {
  useFakeStorage();
  rememberDraft(draft("d1"));
  rememberDraft(draft("d1", { completed: true }));

  const all = listDrafts();
  assert.strictEqual(all.length, 1, "must not duplicate");
  assert.strictEqual(all[0].completed, true, "must reflect the newer value");
});

test("the most recently remembered draft comes first", () => {
  useFakeStorage();
  rememberDraft(draft("old"));
  rememberDraft(draft("new"));

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["new", "old"]);
});

test("re-remembering an older draft moves it to the front", () => {
  useFakeStorage();
  rememberDraft(draft("a"));
  rememberDraft(draft("b"));
  rememberDraft(draft("a"));

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["a", "b"]);
});

test("the list is capped at 50, dropping the oldest", () => {
  useFakeStorage();
  for (let i = 0; i < 55; i++) rememberDraft(draft(`d${i}`));

  const all = listDrafts();
  assert.strictEqual(all.length, 50);
  assert.strictEqual(all[0].id, "d54", "newest kept");
  assert.ok(!all.some((d) => d.id === "d0"), "oldest dropped");
});

test("forgetDraft removes only the named entry", () => {
  useFakeStorage();
  rememberDraft(draft("keep"));
  rememberDraft(draft("drop"));

  forgetDraft("drop");

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["keep"]);
});

test("forgetting an id that is not present changes nothing", () => {
  useFakeStorage();
  rememberDraft(draft("keep"));

  forgetDraft("never-existed");

  assert.deepStrictEqual(listDrafts().map((d) => d.id), ["keep"]);
});

test("a corrupt stored value yields an empty list rather than throwing", () => {
  useFakeStorage({ "perfectpick.myDrafts": "{not json" });
  assert.deepStrictEqual(listDrafts(), []);
});

test("a stored value that is not an array yields an empty list", () => {
  useFakeStorage({ "perfectpick.myDrafts": '{"id":"d1"}' });
  assert.deepStrictEqual(listDrafts(), []);
});

test("storage that throws is a silent no-op, not an exception", () => {
  globalThis.localStorage = {
    getItem() { throw new Error("storage unavailable"); },
    setItem() { throw new Error("storage unavailable"); },
  };

  assert.doesNotThrow(() => rememberDraft(draft("d1")));
  assert.doesNotThrow(() => forgetDraft("d1"));
  assert.deepStrictEqual(listDrafts(), []);
});

test("the board registry's store is left alone", () => {
  const map = useFakeStorage({ "perfectpick.myBoards": '[{"id":"b1","name":"My Board"}]' });
  rememberDraft(draft("d1"));

  assert.strictEqual(
    map.get("perfectpick.myBoards"),
    '[{"id":"b1","name":"My Board"}]',
    "drafts must not write to the boards key"
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npm run test:unit 2>&1 | tail -15
```

Expected: FAIL — `draftRegistry.js` does not exist, so the import cannot resolve.

- [ ] **Step 3: Write the module**

Create `frontend/src/lib/draftRegistry.js`:

```js
const KEY = "perfectpick.myDrafts";

// Matches boardRegistry's cap. Fifty entries is far more history than a
// local-only list needs, and it bounds the stored size.
const MAX_ENTRIES = 50;

export function listDrafts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rememberDraft({
  id,
  teams,
  rounds,
  format,
  userTeam,
  boardId = null,
  completed = false,
}) {
  try {
    const drafts = listDrafts().filter((d) => d.id !== id);
    drafts.unshift({
      id,
      teams,
      rounds,
      format,
      userTeam,
      boardId,
      completed,
      updatedAt: Date.now(),
    });
    localStorage.setItem(KEY, JSON.stringify(drafts.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage unavailable (private mode, quota). The draft still exists
    // server-side and remains reachable by link.
  }
}

export function forgetDraft(id) {
  try {
    localStorage.setItem(KEY, JSON.stringify(listDrafts().filter((d) => d.id !== id)));
  } catch {
    // See rememberDraft.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: 42 tests, 42 pass, 0 fail (31 pre-existing + 11 added here).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/draftRegistry.js frontend/src/lib/draftRegistry.test.js
git commit -m "Add a local registry for mock drafts

A draft's only identity is its UUID, so closing the tab loses it. This
mirrors boardRegistry: same localStorage shape, same 50-entry cap, same
silent degradation when storage is unavailable.

Also the frontend's first unit tests for a storage module. localStorage
does not exist in Node, but these modules read it at call time inside
their functions, so a stub assigned in the test is picked up despite the
hoisted import -- including a stub that throws, which is how the
storage-unavailable path gets covered."
```

---

## Task 2: The My Drafts page

**Files:**
- Create: `frontend/src/pages/MyDrafts.jsx`
- Create: `frontend/tests/mydrafts.spec.js`
- Modify: `frontend/src/App.jsx` (imports and route table)
- Modify: `frontend/src/components/NavBar.jsx` (the `links` array near line 5)

**Interfaces:**
- Consumes from Task 1: `listDrafts()`, `forgetDraft(id)`.
- Also consumes the existing `listBoards()` from `frontend/src/lib/boardRegistry.js`, to resolve a board name from a stored `boardId`.
- Produces: the route `/drafts` and the test ids `my-drafts-list`, `draft-row`, `forget-draft`, which Task 3's test reuses.

**Background:** the registry stores `boardId`, not a board name — the fetched draft has no name on it. `MyDrafts.jsx` resolves the name at render from `listBoards()`. A board that is not in your local registry (someone else's, or one you removed) shows a generic label rather than a stale or invented name.

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/mydrafts.spec.js`:

```js
import { test, expect } from "@playwright/test";

const IN_PROGRESS = {
  id: "draft-in-progress",
  teams: 12,
  rounds: 15,
  format: "ppr",
  userTeam: 4,
  boardId: null,
  completed: false,
  updatedAt: Date.now(),
};

const COMPLETED = {
  id: "draft-completed",
  teams: 10,
  rounds: 12,
  format: "standard",
  userTeam: 2,
  boardId: "board-1",
  completed: true,
  updatedAt: Date.now() - 60_000,
};

async function seed(page, drafts, boards = []) {
  await page.goto("/");
  await page.evaluate(
    ([d, b]) => {
      localStorage.setItem("perfectpick.myDrafts", JSON.stringify(d));
      localStorage.setItem("perfectpick.myBoards", JSON.stringify(b));
    },
    [drafts, boards]
  );
}

test("shows an empty state when nothing is stored", async ({ page }) => {
  await seed(page, []);
  await page.goto("/drafts");

  await expect(page.getByTestId("my-drafts-list")).toHaveCount(0);
  await expect(page.getByText(/no drafts yet/i)).toBeVisible();
});

test("lists stored drafts, newest first", async ({ page }) => {
  await seed(page, [IN_PROGRESS, COMPLETED]);
  await page.goto("/drafts");

  const rows = page.getByTestId("draft-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(/12 teams/i);
});

test("an in-progress draft opens the draft page", async ({ page }) => {
  await seed(page, [IN_PROGRESS]);
  await page.goto("/drafts");

  await page.getByTestId("draft-row").first().getByRole("link").first().click();

  await expect(page).toHaveURL(/\/draft\/draft-in-progress$/);
});

test("a completed draft opens its results", async ({ page }) => {
  await seed(page, [COMPLETED]);
  await page.goto("/drafts");

  await page.getByTestId("draft-row").first().getByRole("link").first().click();

  await expect(page).toHaveURL(/\/draft\/draft-completed\/results$/);
});

test("a draft driven by one of your boards names it", async ({ page }) => {
  await seed(page, [COMPLETED], [{ id: "board-1", name: "My PPR Board", format: "ppr" }]);
  await page.goto("/drafts");

  await expect(page.getByTestId("draft-row").first()).toContainText("My PPR Board");
});

test("a board you do not have locally shows a generic label, not an id", async ({ page }) => {
  await seed(page, [COMPLETED], []);
  await page.goto("/drafts");

  const row = page.getByTestId("draft-row").first();
  await expect(row).toContainText(/custom board/i);
  await expect(row).not.toContainText("board-1");
});

test("forget removes the row and it stays gone after a reload", async ({ page }) => {
  await seed(page, [IN_PROGRESS, COMPLETED]);
  await page.goto("/drafts");

  await page.getByTestId("draft-row").first().getByTestId("forget-draft").click();
  await expect(page.getByTestId("draft-row")).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId("draft-row")).toHaveCount(1);
});

test("the nav links to My Drafts", async ({ page }) => {
  await seed(page, []);
  await page.goto("/");

  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("link", { name: "My Drafts" }).click();

  await expect(page).toHaveURL(/\/drafts$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx playwright test tests/mydrafts.spec.js
```

Expected: FAIL — `/drafts` does not resolve to a page and the nav has no such link.

- [ ] **Step 3: Write the page**

Create `frontend/src/pages/MyDrafts.jsx`:

```jsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { usePageTitle } from "../lib/usePageTitle";
import { listDrafts, forgetDraft } from "../lib/draftRegistry";
import { listBoards } from "../lib/boardRegistry";

const FORMAT_LABEL = {
  standard: "Standard",
  "half-ppr": "Half PPR",
  ppr: "PPR",
};

function relativeTime(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function MyDrafts() {
  const [drafts, setDrafts] = useState(() => listDrafts());
  const boards = listBoards();

  usePageTitle("My Drafts");

  const forget = (id) => {
    forgetDraft(id);
    setDrafts(listDrafts());
  };

  return (
    <div className="py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">My drafts</h1>
        <p className="text-sm text-zinc-400">
          Drafts you have started or opened on this device.
        </p>
      </div>

      {drafts.length === 0 ? (
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-8 text-center text-sm text-zinc-500">
          No drafts yet. Start one and it will show up here.
        </div>
      ) : (
        <ul className="space-y-1" data-testid="my-drafts-list">
          {drafts.map((d) => {
            // The registry stores boardId; names live in the board registry,
            // so a board that is not yours resolves to a generic label rather
            // than a stale name or a raw id.
            const boardName = d.boardId
              ? boards.find((b) => b.id === d.boardId)?.name || "a custom board"
              : null;

            return (
              <li key={d.id} className="flex items-center gap-2" data-testid="draft-row">
                <Link
                  to={d.completed ? `/draft/${d.id}/results` : `/draft/${d.id}`}
                  className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-left text-sm text-zinc-200 hover:border-zinc-600"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {FORMAT_LABEL[d.format] || d.format} · {d.teams} teams · {d.rounds} rounds
                    </span>
                    <span
                      className={
                        d.completed
                          ? "rounded-full border border-emerald-900/60 px-2 py-0.5 text-xs text-emerald-300"
                          : "rounded-full border border-cyan-900/60 px-2 py-0.5 text-xs text-cyan-300"
                      }
                    >
                      {d.completed ? "Completed" : "In progress"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    Pick {d.userTeam}
                    {boardName ? ` · off ${boardName}` : ""} · {relativeTime(d.updatedAt)}
                  </div>
                </Link>
                <button
                  type="button"
                  onClick={() => forget(d.id)}
                  data-testid="forget-draft"
                  aria-label={`Forget draft ${d.id}`}
                  title="Removes it from this list only. The draft still exists and its link still works."
                  className="rounded-2xl border border-zinc-800 px-3 py-3 text-xs text-zinc-500 hover:border-rose-900/60 hover:text-rose-300"
                >
                  Forget
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Register the route**

In `frontend/src/App.jsx`, add the import beside the other page imports:

```jsx
import MyDrafts from "./pages/MyDrafts.jsx";
```

and the route, immediately after the `/draft/new` route so the draft routes stay together:

```jsx
            <Route path="/drafts" element={<MyDrafts />} />
```

Note `/drafts` and `/draft/:draftId` are distinct paths and do not conflict.

- [ ] **Step 5: Add the nav link**

In `frontend/src/components/NavBar.jsx`, the `links` array becomes:

```jsx
const links = [
  { to: "/", label: "Home" },
  { to: "/draft/new", label: "New Draft" },
  { to: "/drafts", label: "My Drafts" },
  { to: "/boards", label: "Boards" },
];
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd frontend && npx playwright test tests/mydrafts.spec.js
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Run the full Playwright suite**

```bash
cd frontend && npx playwright test
```

Expected: PASS, 82 tests (74 pre-existing + 8 added here). Do not run this in the background — wait for it and report the actual counts. The nav change touches every page, so a failure anywhere in this suite is in scope for this task.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/MyDrafts.jsx frontend/src/App.jsx frontend/src/components/NavBar.jsx frontend/tests/mydrafts.spec.js
git commit -m "Add the My Drafts page

Lists drafts from the local registry, newest first. In-progress rows
resume the draft; completed rows open its results.

The registry stores boardId rather than a board name, because the
fetched draft carries no name. The name is resolved here from the board
registry, so it survives a rename and a board that is not yours shows a
generic label instead of a raw id.

Forget is local-only and says so in its tooltip: there is no
DELETE /drafts endpoint, and the draft stays reachable by link."
```

---

## Task 3: Record drafts as they are loaded

**Files:**
- Create: `frontend/src/lib/useRememberDraft.js`
- Modify: `frontend/src/pages/Draft.jsx` (imports, and one hook call in the component body)
- Modify: `frontend/src/pages/Results.jsx` (imports, and one hook call in the component body)
- Modify: `frontend/tests/mydrafts.spec.js` (append two tests)

**Interfaces:**
- Consumes from Task 1: `rememberDraft(entry)`.
- Consumes from Task 2: the `/drafts` page and its `draft-row` test id.
- Produces: `useRememberDraft(draft)`, a hook taking the fetched draft object or `null`.

**Background:** this is what actually populates the registry. `NewDraft.jsx` is deliberately not modified — creating a draft navigates straight to `/draft/:id`, so the hook records it from server data a moment later, and the stored entry reflects what the server actually holds rather than what the create request asked for.

The effect is keyed on `[draft?.draftId, draft?.completed]` and nothing else. `Draft.jsx` re-renders on every pick; keying on the draft object would write to `localStorage` on every pick of a sim-to-end.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/mydrafts.spec.js`:

```js
const DRAFT_ID = "linked-draft-xyz";
const API = "http://localhost:9999";

function draftState({ completed = false } = {}) {
  const picks = Array.from({ length: 4 }, (_, i) => ({
    overall: i + 1,
    round: 1,
    team: i + 1,
    playerId: null,
    player: null,
  }));
  return {
    draftId: DRAFT_ID,
    sport: "nfl",
    format: "ppr",
    year: 2025,
    teams: 4,
    rounds: 1,
    userTeam: 3,
    rosterSlots: [],
    boardId: null,
    picked: [],
    currentIndex: completed ? 4 : 0,
    currentRound: 1,
    currentPick: 1,
    currentTeam: completed ? null : 1,
    completed,
    picks,
  };
}

test("opening a draft by link records it, so it is listed afterwards", async ({ page }) => {
  await seed(page, []);
  await page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: [] } }));
  await page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: draftState() }));

  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();

  await page.goto("/drafts");
  const row = page.getByTestId("draft-row").first();
  await expect(row).toContainText(/4 teams/i);
  await expect(row).toContainText(/in progress/i);
});

test("a completed draft is recorded as completed", async ({ page }) => {
  await seed(page, []);
  await page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: [] } }));
  await page.route(`${API}/drafts/${DRAFT_ID}`, (r) =>
    r.fulfill({ json: draftState({ completed: true }) })
  );

  await page.goto(`/draft/${DRAFT_ID}/results`);
  await expect(page.getByRole("heading", { name: "Draft Results" })).toBeVisible();

  await page.goto("/drafts");
  await expect(page.getByTestId("draft-row").first()).toContainText(/completed/i);
});

test("loading a draft does not write to storage once per render", async ({ page }) => {
  await seed(page, []);
  await page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: [] } }));
  await page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: draftState() }));

  await page.addInitScript(() => {
    window.__writes = 0;
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === "perfectpick.myDrafts") window.__writes += 1;
      return real.call(this, k, v);
    };
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
  await page.waitForTimeout(1500);

  // The effect is keyed on [draftId, completed]. Neither changes while the
  // page sits idle, so a handful of writes is expected and dozens would mean
  // the key is wrong.
  const writes = await page.evaluate(() => window.__writes);
  expect(writes, `writes to perfectpick.myDrafts (got ${writes})`).toBeLessThan(5);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx playwright test tests/mydrafts.spec.js
```

Expected: FAIL on the two recording tests — nothing writes to the registry yet, so `/drafts` shows the empty state and no `draft-row` exists. The write-count test passes trivially at zero writes; that is expected, since it is a guard against a regression this task could introduce rather than a reproduction of a current bug.

- [ ] **Step 3: Write the hook**

Create `frontend/src/lib/useRememberDraft.js`:

```js
import { useEffect } from "react";
import { rememberDraft } from "./draftRegistry";

/**
 * Records a fetched draft in the local registry.
 *
 * Keyed on the draft id and its completed flag, and nothing else: the draft
 * page re-renders on every pick, so keying on the draft object would write to
 * localStorage once per pick during a sim-to-end.
 *
 * Safe to call before the fetch resolves — a null or id-less draft is ignored.
 */
export function useRememberDraft(draft) {
  const id = draft?.draftId;
  const completed = Boolean(draft?.completed);

  useEffect(() => {
    if (!id) return;
    rememberDraft({
      id,
      teams: draft.teams,
      rounds: draft.rounds,
      format: draft.format,
      userTeam: draft.userTeam,
      boardId: draft.boardId ?? null,
      completed,
    });
    // Deliberately keyed on id and completed only — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, completed]);
}
```

- [ ] **Step 4: Call it from the draft page**

In `frontend/src/pages/Draft.jsx`, add the import beside the other `../lib/` imports:

```jsx
import { useRememberDraft } from "../lib/useRememberDraft";
```

and call it in the component body, immediately after the existing `usePageTitle(...)` call near line 94:

```jsx
  useRememberDraft(draft);
```

- [ ] **Step 5: Call it from the results page**

In `frontend/src/pages/Results.jsx`, add the same import beside the other `../lib/` imports:

```jsx
import { useRememberDraft } from "../lib/useRememberDraft";
```

and call it in the component body, immediately after the existing `usePageTitle(...)` call:

```jsx
  useRememberDraft(draft);
```

Both pages must call the hook before their early `if (err) return ...` / `if (!draft) return ...` guards. React requires hooks to run in the same order on every render, and a hook placed after a conditional return would break that.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd frontend && npx playwright test tests/mydrafts.spec.js
```

Expected: PASS, 11 tests.

- [ ] **Step 7: Mutation-check that the write-count guard has teeth**

Temporarily change the hook's dependency array from `[id, completed]` to `[draft]`:

```bash
cd frontend && sed -i '' 's/  }, \[id, completed\]);/  }, [draft]);/' src/lib/useRememberDraft.js
npx playwright test tests/mydrafts.spec.js
```

Expected: FAIL on `"loading a draft does not write to storage once per render"`. If it still passes, the guard is not measuring anything — stop and report that rather than continuing.

Restore it:

```bash
cd frontend && sed -i '' 's/  }, \[draft\]);/  }, [id, completed]);/' src/lib/useRememberDraft.js
grep -n "\[id, completed\]" src/lib/useRememberDraft.js
npx playwright test tests/mydrafts.spec.js
```

Expected: the grep matches, and the suite passes 11 again.

- [ ] **Step 8: Run the full suites**

```bash
cd frontend && npx playwright test
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
cd frontend && npm run build 2>&1 | tail -3
```

Expected: 85 Playwright pass (74 pre-existing + 8 from Task 2 + 3 here), 42 unit pass, clean build. Do not run these in the background.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/useRememberDraft.js frontend/src/pages/Draft.jsx frontend/src/pages/Results.jsx frontend/tests/mydrafts.spec.js
git commit -m "Record drafts in the registry as they load

One hook, called from the draft and results pages. NewDraft.jsx is
deliberately untouched: creating a draft navigates to /draft/:id, so the
hook records it from server data a moment later and the stored entry
reflects what the server holds rather than what the request asked for.
That also means a draft opened from someone else's link is recorded
identically to one you started.

Keyed on [draftId, completed] and nothing else -- the draft page
re-renders on every pick, so keying on the draft object would write to
localStorage once per pick during a sim-to-end. A test asserts the write
count stays small, and it fails if the key is widened."
```

---

## Verification Summary

| Check | Command | Expected |
|---|---|---|
| Frontend unit | `cd frontend && npm run test:unit` | 42 pass |
| Playwright | `cd frontend && npx playwright test` | 85 pass |
| Build | `cd frontend && npm run build` | no errors |
| Backend unit | `cd backend/src && npm test` | 100 pass |

The backend is untouched; its suite is listed only to confirm the change stayed in the frontend. No deploy is part of this plan.
