# Board Drives the Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a draft be started from a saved custom board, so the in-draft Big Board is ordered by the user's own rankings and each row shows their rank against ADP.

**Architecture:** `POST /drafts` gains an optional `boardId` that is stored and returned — the only backend change. A pure `frontend/src/lib/boardOrder.js` merges the board's rows into the player pool. `NewDraft.jsx` offers a board picker; `Draft.jsx` fetches the board alongside players and reorders the Big Board. Bots never see the board.

**Tech Stack:** Node.js 24 (CommonJS) Lambdas, DynamoDB, React 19 + Vite 7 + Tailwind 4 (ESM), `node:test`, Playwright.

**Source spec:** `docs/superpowers/specs/2026-08-31-board-drives-draft-design.md`

## Global Constraints

- **Backend is CommonJS** (`require` / `module.exports`); **frontend is ESM** (`import` / `export` with explicit `.js` extensions on relative imports). They differ deliberately.
- **No new dependencies**, backend or frontend.
- **`boardId` is additive.** Drafts without it must behave exactly as they do today.
- **Bots never see the board.** No task in this plan may touch `pickBestForTeam`, `rosterNeed`, `kDefBlocked`, or anything else in the bot scoring path.
- **A draft whose board is gone must remain fully playable.** Picks, auto-pick, sim-to-end and the clock never consult the board; a failed board fetch degrades the Big Board's *order* only.
- **No server-side existence check on `boardId`.** Deliberate — the client handles absence.
- **Baseline is 57 Playwright tests, 21 frontend unit tests, 41 backend unit tests.** None may be weakened, skipped, or deleted.
- **Screenshots are committed baselines.** The Playwright suite rewrites `screenshots/*.png`; revert before committing.

---

## File Structure

**Backend — modify**
- `backend/src/drafts.js` — accept, store, and return `boardId`

**Frontend — create**
- `frontend/src/lib/boardOrder.js` — pure ordering merge
- `frontend/src/lib/boardOrder.test.js` — `node:test` units
- `frontend/tests/boarddraft.spec.js` — end-to-end

**Frontend — modify**
- `frontend/src/lib/boardRegistry.js` — remember a board's format
- `frontend/src/pages/Boards.jsx` — pass format when remembering
- `frontend/src/pages/NewDraft.jsx` — board picker and mismatch note
- `frontend/src/pages/Draft.jsx` — fetch the board, reorder the Big Board

---

## Task 1: Ordering module

Pure, no I/O, test-first. Everything else depends on this shape.

**Files:**
- Create: `frontend/src/lib/boardOrder.test.js`, `frontend/src/lib/boardOrder.js`

**Interfaces:**
- Consumes: nothing
- Produces: `orderByBoard(players, boardRows) → Array` — board players first ascending by `myRank`, each carrying `myRank` and `delta`; all others after in their original relative order, without those fields. Task 4 consumes it.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/boardOrder.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { orderByBoard } from "./boardOrder.js";

// The players endpoint returns its pool already sorted by consensus rank,
// nulls last. These fixtures mirror that.
const POOL = [
  { id: "p1", name: "Alpha",   position: "RB", rank: 1,    adp: 1.2 },
  { id: "p2", name: "Bravo",   position: "WR", rank: 2,    adp: 2.4 },
  { id: "p3", name: "Charlie", position: "WR", rank: 3,    adp: 3.1 },
  { id: "p4", name: "Delta",   position: "TE", rank: null, adp: null },
  { id: "p5", name: "Echo",    position: "QB", rank: null, adp: null },
];

// A board that promotes Charlie to #1 and demotes Alpha to #3.
const ROWS = [
  { playerId: "p3", myRank: 1, consensusRank: 3, delta: 2 },
  { playerId: "p2", myRank: 2, consensusRank: 2, delta: 0 },
  { playerId: "p1", myRank: 3, consensusRank: 1, delta: -2 },
];

test("board players lead, in the user's order rather than consensus", () => {
  const out = orderByBoard(POOL, ROWS);
  assert.deepStrictEqual(out.slice(0, 3).map((p) => p.id), ["p3", "p2", "p1"]);
});

test("players absent from the board follow, keeping their original order", () => {
  const out = orderByBoard(POOL, ROWS);
  assert.deepStrictEqual(out.slice(3).map((p) => p.id), ["p4", "p5"]);
});

test("board players carry myRank and delta", () => {
  const out = orderByBoard(POOL, ROWS);
  assert.strictEqual(out[0].myRank, 1);
  assert.strictEqual(out[0].delta, 2);
  assert.strictEqual(out[2].myRank, 3);
  assert.strictEqual(out[2].delta, -2);
});

test("players absent from the board carry neither field", () => {
  const out = orderByBoard(POOL, ROWS);
  const off = out.find((p) => p.id === "p4");
  assert.strictEqual(off.myRank, undefined);
  assert.strictEqual(off.delta, undefined);
});

test("every player survives the merge exactly once", () => {
  const out = orderByBoard(POOL, ROWS);
  assert.strictEqual(out.length, POOL.length);
  assert.strictEqual(new Set(out.map((p) => p.id)).size, POOL.length);
});

test("null board rows return the pool untouched — the fallback contract", () => {
  const out = orderByBoard(POOL, null);
  assert.deepStrictEqual(out.map((p) => p.id), POOL.map((p) => p.id));
  assert.strictEqual(out[0].myRank, undefined);
});

test("empty board rows return the pool untouched", () => {
  const out = orderByBoard(POOL, []);
  assert.deepStrictEqual(out.map((p) => p.id), POOL.map((p) => p.id));
});

test("a board row for a player not in the pool is ignored, leaving no hole", () => {
  const rows = [...ROWS, { playerId: "ghost", myRank: 4, consensusRank: null, delta: null }];
  const out = orderByBoard(POOL, rows);
  assert.strictEqual(out.length, POOL.length);
  assert.ok(!out.some((p) => p == null));
  assert.ok(!out.some((p) => p.id === "ghost"));
});

test("an unsorted board row list is still ordered by myRank", () => {
  const shuffled = [ROWS[2], ROWS[0], ROWS[1]];
  const out = orderByBoard(POOL, shuffled);
  assert.deepStrictEqual(out.slice(0, 3).map((p) => p.id), ["p3", "p2", "p1"]);
});

test("does not mutate its inputs", () => {
  const poolSnapshot = JSON.stringify(POOL);
  const rowsSnapshot = JSON.stringify(ROWS);
  orderByBoard(POOL, ROWS);
  assert.strictEqual(JSON.stringify(POOL), poolSnapshot);
  assert.strictEqual(JSON.stringify(ROWS), rowsSnapshot);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — cannot find module `./boardOrder.js`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/boardOrder.js`:

```js
/**
 * Reorder the player pool by a user's saved board.
 *
 * Board players lead, ascending by their own rank, each annotated with
 * `myRank` and `delta` for display. Everyone else follows in the order the
 * players endpoint returned them.
 *
 * A board holds every ranked player for its format (the boards API filters
 * its pool to `rank[format] != null`), so the trailing group is essentially
 * the unranked remainder — there is no interleaving to do.
 *
 * Returns the pool untouched when there are no rows, which is the fallback
 * path for a board that was deleted or failed to load.
 */
export function orderByBoard(players, boardRows) {
  if (!Array.isArray(boardRows) || boardRows.length === 0) return players;

  const byId = new Map(
    boardRows.map((r) => [String(r.playerId), r])
  );

  const onBoard = [];
  const rest = [];

  for (const p of players) {
    const row = byId.get(String(p.id));
    if (row) onBoard.push({ ...p, myRank: row.myRank, delta: row.delta });
    else rest.push(p);
  }

  onBoard.sort((a, b) => a.myRank - b.myRank);

  return [...onBoard, ...rest];
}
```

Note the merge iterates the **pool**, not the rows. A row naming a player who is not in the pool simply never matches, so it cannot introduce an `undefined` entry.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm run test:unit`
Expected: PASS — 31 tests (21 existing plus 10 new), 0 failing

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/boardOrder.js frontend/src/lib/boardOrder.test.js
git commit -m "Add pure board ordering module"
```

---

## Task 2: Persist boardId on the draft

**Files:**
- Modify: `backend/src/drafts.js`

**Interfaces:**
- Consumes: nothing
- Produces: `POST /drafts` accepts `boardId`; `GET /drafts/:id` returns it (or `null`). Tasks 3 and 4 rely on both.

- [ ] **Step 1: Accept and validate it on create**

In `backend/src/drafts.js`, in the `POST /drafts` branch, immediately after the `rosterSlots` derivation, add:

```js
      const rawBoardId = typeof body.boardId === "string" ? body.boardId.trim() : "";
      const boardId = rawBoardId.length > 0 && rawBoardId.length <= 64 ? rawBoardId : null;
```

There is deliberately **no check that the board exists**. Verifying it would mean a cross-table read on every draft creation for a reference the user can delete a second later; the client handles absence instead.

- [ ] **Step 2: Persist it**

In the same branch's `item` object literal, add `boardId` immediately after the `rosterSlots,` line:

```js
        rosterSlots,
        boardId,
```

- [ ] **Step 3: Return it on read**

In the `GET /drafts/{draftId}` branch's response object, add immediately after the `rosterSlots:` line:

```js
          boardId: d.boardId || null,
```

Drafts stored before this change have no `boardId`; they read as `null`, which `Draft.jsx` treats as "no board".

- [ ] **Step 4: Verify the module loads and the units still pass**

Run: `cd backend/src && node -e "require('./drafts.js'); console.log('ok')"`
Expected: `ok`

Run: `cd backend/src && npm test`
Expected: 41 passing, 0 failing

- [ ] **Step 5: Confirm the bot path was not touched**

Run: `cd backend/src && git diff -- drafts.js | grep -E "^[-+].*(pickBestForTeam|rosterNeed|kDefBlocked|needs|kDefPenalty)" || echo "bot scoring untouched"`
Expected: `bot scoring untouched`

- [ ] **Step 6: Validate the template**

Run: `cd backend && sam validate --lint`
Expected: valid, exit 0

- [ ] **Step 7: Commit**

```bash
git add backend/src/drafts.js
git commit -m "Store the board a draft was started from"
```

---

## Task 3: Board picker on New Draft

**Files:**
- Modify: `frontend/src/lib/boardRegistry.js`, `frontend/src/pages/Boards.jsx`, `frontend/src/pages/NewDraft.jsx`

**Interfaces:**
- Consumes: `listBoards()` from `../lib/boardRegistry`
- Produces: `rememberBoard({ id, name, format })` now stores `format`. `POST /drafts` receives `boardId` when a board is chosen. Testids `board-select` and `board-format-note`. Task 5 selects on both.

- [ ] **Step 1: Store the format in the registry**

In `frontend/src/lib/boardRegistry.js`, replace `rememberBoard`:

```js
export function rememberBoard({ id, name, format }) {
  try {
    const boards = listBoards().filter((b) => b.id !== id);
    boards.unshift({ id, name, format, updatedAt: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(boards.slice(0, 50)));
  } catch {
    // Storage unavailable (private mode, quota). The board still exists
    // server-side and remains reachable by link.
  }
}
```

Entries written before this change have no `format`. They are not migrated — they render without a format label and skip the mismatch check, because a warning derived from guesswork is worse than no warning. The gap closes as boards are created.

- [ ] **Step 2: Pass the format when creating a board**

In `frontend/src/pages/Boards.jsx`, in `createBoard`, change the `rememberBoard` call:

```js
      rememberBoard({ id: boardId, name, format });
```

`format` is already in scope there — it is the state backing the format select.

- [ ] **Step 3: Add the board state and import to NewDraft**

In `frontend/src/pages/NewDraft.jsx`, add to the imports:

```jsx
import { listBoards } from "../lib/boardRegistry";
```

and add after the existing `rosterSlots` state line:

```jsx
  const [boardId, setBoardId] = useState("");
  const [myBoards] = useState(() => listBoards());

  const selectedBoard = myBoards.find((b) => b.id === boardId) || null;
  const boardFormatMismatch =
    selectedBoard && selectedBoard.format && selectedBoard.format !== format;
```

`selectedBoard.format &&` is what exempts pre-existing registry entries: with no format recorded, there is nothing to compare and no note is shown.

- [ ] **Step 4: Send boardId on create**

In `createDraft`, add to the `apiPost` body, after the `rosterSlots` spread:

```jsx
        ...(rosterSlots?.length ? { rosterSlots } : {}),
        ...(boardId ? { boardId } : {}),
```

- [ ] **Step 5: Add the picker**

In the returned JSX, insert immediately after the closing `</label>` of the ADP Format control and before the `{err ? (` block:

```jsx
        {myBoards.length > 0 && (
          <label className="space-y-1 block">
            <div className="text-sm text-zinc-300">Use my board</div>
            <select
              data-testid="board-select"
              value={boardId}
              onChange={(e) => setBoardId(e.target.value)}
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none focus:border-cyan-300/60"
            >
              <option value="">Consensus ADP (no board)</option>
              {myBoards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.format ? ` · ${b.format.toUpperCase()}` : ""}
                </option>
              ))}
            </select>
            {boardFormatMismatch && (
              <div data-testid="board-format-note" className="text-xs text-amber-300/90">
                This board was built for {selectedBoard.format.toUpperCase()}. Its ranks
                still apply, but they were not made for {format.toUpperCase()} scoring.
              </div>
            )}
          </label>
        )}
```

The picker is hidden entirely when the user has no saved boards, rather than rendering a select whose only option is "no board".

- [ ] **Step 6: Verify the build and existing suites**

Run: `cd frontend && npm run build`
Expected: `✓ built in <time>` with no errors

Run: `cd frontend && npm test`
Expected: `57 passed`

- [ ] **Step 7: Revert regenerated screenshots**

Run: `cd /Users/connor/projects/sports-mock-draft && git checkout -- screenshots/`

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/boardRegistry.js frontend/src/pages/Boards.jsx frontend/src/pages/NewDraft.jsx
git commit -m "Add board picker to the New Draft form"
```

---

## Task 4: Order the in-draft Big Board

**Files:**
- Modify: `frontend/src/pages/Draft.jsx`

**Interfaces:**
- Consumes: `orderByBoard` from `../lib/boardOrder`; `draft.boardId` from `GET /drafts/:id`
- Produces: testid `board-load-note`. Task 5 selects on it.

- [ ] **Step 1: Import the ordering module**

In `frontend/src/pages/Draft.jsx`, add to the imports:

```jsx
import { orderByBoard } from "../lib/boardOrder";
```

- [ ] **Step 2: Add board state**

Add beside the other `useState` declarations:

```jsx
  const [boardRows, setBoardRows] = useState(null);
  const [boardFailed, setBoardFailed] = useState(false);
```

- [ ] **Step 3: Fetch the board alongside the draft**

In `load()`, replace the body of the `try` block:

```jsx
      const d = await apiGet(`/drafts/${draftId}`);
      const p = await apiGet(
        `/players?sport=${d.sport || "nfl"}&format=${encodeURIComponent(d.format || "standard")}`
      );
      setDraft(d);
      setPlayers(p.players || []);

      if (d.boardId) {
        try {
          const b = await apiGet(`/boards/${d.boardId}`);
          setBoardRows(b.rows || []);
          setBoardFailed(false);
        } catch {
          // A board can be deleted after a draft was started from it. The
          // draft stays fully playable; only the Big Board's ORDER falls
          // back to consensus.
          setBoardRows(null);
          setBoardFailed(true);
        }
      } else {
        // Clear any board state from a previously loaded draft, so navigating
        // from a board-backed draft to a plain one does not keep the old order.
        setBoardRows(null);
        setBoardFailed(false);
      }
```

The inner `try` is deliberately separate from the outer one. A board failure must not land in the outer `catch`, which sets the page-level error and would make the whole draft look broken.

- [ ] **Step 4: Order the pool by the board**

Replace the `filtered` memo:

```jsx
  const filtered = useMemo(() => {
    if (!draft) return [];
    const q = query.trim().toLowerCase();
    return orderByBoard(players, boardRows)
      .filter((p) => !draft.picked?.includes(p.id))
      .filter((p) => (pos ? p.position === pos : true))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true));
  }, [players, boardRows, draft, query, pos]);
```

Ordering happens before filtering so position and search filters preserve the board's order rather than reimposing consensus.

- [ ] **Step 5: Show the user's rank on each row**

In the Big Board row markup, replace the name line and the ADP line:

```jsx
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">
                      {p.myRank != null
                        ? `${p.myRank}. `
                        : p.rank != null
                        ? `${p.rank}. `
                        : ""}
                      {p.name}
                    </div>
                    <div className="text-xs text-zinc-400">
                      {p.adp != null ? `ADP ${p.adp}` : "ADP —"}
                      {p.delta != null && p.delta !== 0 ? (
                        <span className={p.delta > 0 ? "ml-1 text-emerald-400" : "ml-1 text-rose-400"}>
                          {p.delta > 0 ? `+${p.delta}` : p.delta}
                        </span>
                      ) : null}
                    </div>
                  </div>
```

With a board loaded the leading number is the user's rank; without one it stays the consensus rank exactly as today.

- [ ] **Step 6: Add the failure notice**

Immediately above the Big Board's search input, add:

```jsx
            {boardFailed && (
              <div data-testid="board-load-note" className="rounded-2xl border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                Your board could not be loaded — showing consensus order.
              </div>
            )}
```

- [ ] **Step 7: Verify the build and existing suites**

Run: `cd frontend && npm run build`
Expected: `✓ built in <time>` with no errors

Run: `cd frontend && npm test`
Expected: `57 passed`

- [ ] **Step 8: Revert regenerated screenshots**

Run: `cd /Users/connor/projects/sports-mock-draft && git checkout -- screenshots/`

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/Draft.jsx
git commit -m "Order the in-draft Big Board by the user's board"
```

---

## Task 5: End-to-end coverage

**Files:**
- Create: `frontend/tests/boarddraft.spec.js`

**Interfaces:**
- Consumes: testids `board-select`, `board-format-note`, `board-load-note` from Tasks 3 and 4
- Produces: regression coverage. Terminal task.

- [ ] **Step 1: Write the spec**

`frontend/tests/boarddraft.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { DRAFT_ID, MOCK_PLAYERS, makeDraftState } from "./fixtures.js";

const API = "http://localhost:9999";
const BID = "board-abc";

// Promote p3 to the top and demote p1, so board order is visibly not ADP order.
const BOARD_ROWS = [
  { playerId: "p3", name: "CeeDee Lamb", position: "WR", team: "DAL", myRank: 1, consensusRank: 3, delta: 2 },
  { playerId: "p1", name: "Christian McCaffrey", position: "RB", team: "SF", myRank: 2, consensusRank: 1, delta: -1 },
];

async function seedBoard(page, { format = "ppr" } = {}) {
  await page.goto("/");
  await page.evaluate(
    ([id, fmt]) =>
      localStorage.setItem(
        "perfectpick.myBoards",
        JSON.stringify([{ id, name: "My PPR Board", format: fmt, updatedAt: Date.now() }])
      ),
    [BID, format]
  );
}

async function mockPlayers(page) {
  await page.route(`${API}/players*`, (route) =>
    route.fulfill({
      json: { sport: "nfl", format: "standard", count: MOCK_PLAYERS.length, players: MOCK_PLAYERS },
    })
  );
}

test("selecting a board sends boardId on create", async ({ page }) => {
  let posted = null;
  await seedBoard(page);
  await page.route(`${API}/drafts`, async (route) => {
    if (route.request().method() === "POST") {
      posted = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ json: { draftId: DRAFT_ID } });
    }
  });

  await page.goto("/draft/new");
  await page.getByTestId("board-select").selectOption(BID);
  await page.getByRole("button", { name: /Start Mock Draft/i }).click();

  await expect.poll(() => posted?.boardId).toBe(BID);
});

test("creating a draft without a board sends no boardId", async ({ page }) => {
  let posted = null;
  await seedBoard(page);
  await page.route(`${API}/drafts`, async (route) => {
    if (route.request().method() === "POST") {
      posted = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ json: { draftId: DRAFT_ID } });
    }
  });

  await page.goto("/draft/new");
  await page.getByRole("button", { name: /Start Mock Draft/i }).click();

  await expect.poll(() => posted?.teams).toBe(12);
  expect(posted.boardId).toBeUndefined();
});

test("a format mismatch is flagged", async ({ page }) => {
  await seedBoard(page, { format: "ppr" });
  await page.goto("/draft/new");

  await page.getByTestId("board-select").selectOption(BID);
  await expect(page.getByTestId("board-format-note")).toHaveCount(0);

  await page.getByLabel("ADP Format").selectOption("standard");
  await expect(page.getByTestId("board-format-note")).toContainText("built for PPR");
});

test("a board without a recorded format is never flagged", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((id) =>
    localStorage.setItem(
      "perfectpick.myBoards",
      JSON.stringify([{ id, name: "Legacy board", updatedAt: Date.now() }])
    ), BID);

  await page.goto("/draft/new");
  await page.getByTestId("board-select").selectOption(BID);
  await page.getByLabel("ADP Format").selectOption("standard");

  await expect(page.getByTestId("board-format-note")).toHaveCount(0);
});

test("the Big Board renders in the board's order, not ADP order", async ({ page }) => {
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: { ...makeDraftState(), boardId: BID } })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ json: { boardId: BID, name: "My PPR Board", format: "ppr", rows: BOARD_ROWS, changelog: { added: 0, removed: 0 } } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);

  // p3 (CeeDee Lamb) is ADP #3 but the user's #1, so it must lead.
  const first = page.getByRole("button", { name: /CeeDee Lamb/ }).first();
  await expect(first).toBeVisible();
  await expect(first).toContainText("1. CeeDee Lamb");
  await expect(first).toContainText("+2");
});

test("a deleted board still leaves the draft playable", async ({ page }) => {
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: { ...makeDraftState(), boardId: BID } })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ status: 404, json: { error: "Board not found" } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);

  await expect(page.getByTestId("board-load-note")).toBeVisible();
  // Consensus order restored, and the board is still usable.
  await expect(page.getByRole("button", { name: /Christian McCaffrey/ }).first()).toBeVisible();
  await expect(page.getByText(/on the clock/i).first()).toBeVisible();
});
```

- [ ] **Step 2: Run the new spec**

Run: `cd frontend && npx playwright test boarddraft.spec.js`
Expected: `6 passed`

Run this in the **foreground**. Do not background it.

- [ ] **Step 3: Run everything**

Run: `cd frontend && npm test`
Expected: `63 passed` (57 existing plus 6 new)

Run: `cd frontend && npm run test:unit`
Expected: 31 passing

Run: `cd backend/src && npm test`
Expected: 41 passing

- [ ] **Step 4: Revert regenerated screenshots**

Run: `cd /Users/connor/projects/sports-mock-draft && git checkout -- screenshots/`

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/boarddraft.spec.js
git commit -m "Add end-to-end coverage for board-driven draft ordering"
```

---

## Verification

After Task 5:

```bash
cd backend/src && npm test          # 41 unit tests
cd ../../frontend && npm run test:unit   # 31 unit tests
npm test                            # 63 Playwright tests
npm run build                       # clean build
cd ../backend && sam validate --lint     # exit 0
```

Deployment touches both halves: `cd backend && sam build && sam deploy`, then `cd frontend && npm run deploy`.

## Notes for the implementer

- **Backend is CommonJS, frontend is ESM.** Do not mix them.
- **Do not touch the bot scoring path.** `pickBestForTeam`, `rosterNeed`, and `kDefBlocked` are out of bounds. Bots drafting the user's own board would defeat the point of a mock draft.
- **The board fetch has its own try/catch inside `load()`.** Letting a board failure reach the outer catch would set the page-level error and make a perfectly playable draft look broken.
- **Order before filtering** in the `filtered` memo, or position and search filters will reimpose consensus order.
- **Run test suites in the foreground.** A previous agent on this project stranded itself waiting on a backgrounded Playwright run.
- **Screenshots are committed baselines.** Revert them rather than committing the churn.
