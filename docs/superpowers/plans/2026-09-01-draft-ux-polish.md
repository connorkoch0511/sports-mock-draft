# Draft UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a cross-format board burying players ranked for the draft's format, confirm on the draft page which board is driving it, and explain the Sleeper dynasty round/roster mismatch instead of leaving two correct numbers looking contradictory.

**Architecture:** Three independent tasks, ordered by risk. Task 1 changes `orderByBoard` — the function that decides what the user sees and drafts from — in isolation, with its ten existing tests as the contract. Tasks 2 and 3 are display-only and carry no ordering risk.

**Tech Stack:** React 19, Tailwind 4, Vite 7, `node:test` for unit tests, Playwright for end-to-end.

## Global Constraints

- **The frontend is ESM.** `import`/`export` only. The backend is CommonJS; mixing them is a defect.
- **No new dependencies.** No `frontend/package.json` changes.
- **No backend change.** Nothing under `backend/` is touched, and no Lambda deploy is part of this work.
- **No value changes on the New Draft page.** `rounds` still comes from `draft.settings.rounds` and `rosterSlots` still from `league.roster_positions`. Task 3 is labelling only.
- Tailwind utility classes only — no new stylesheet, no inline `style`.
- Test ids follow the repo convention: lowercase, hyphen-separated, on `data-testid`.
- Unit tests run with `cd frontend && npm run test:unit`; Playwright with `cd frontend && npx playwright test`.
- Existing suites must stay green: **47 frontend unit**, **85 Playwright**, 100 backend unit.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/src/lib/boardOrder.js` | Order the pool by a saved board | Task 1 — the interleave |
| `frontend/src/lib/boardOrder.test.js` | Unit tests for the above | Task 1 — new cases appended |
| `frontend/src/pages/Draft.jsx` | Draft page | Task 2 — keep board name/format, render two notices |
| `frontend/tests/boarddraft.spec.js` | Board-drives-draft e2e | Task 2 — new cases appended |
| `frontend/src/pages/NewDraft.jsx` | New Draft page | Task 3 — label the roster chips |
| `frontend/tests/sleeper.spec.js` | Sleeper import e2e | Task 3 — new cases appended |

### The measurement behind Task 1

Taken against production before this plan was written:

| Format | Players ranked |
|---|---|
| standard | 223 |
| half-ppr | 236 |
| ppr | 272 |

Standard's ranked set is a strict **subset** of PPR's — 0 players are standard-ranked but
not PPR-ranked, while 49 are PPR-ranked but not standard-ranked. So a PPR board driving a
standard draft buries nobody, while a **standard board driving a PPR draft buries 49
players below its 223 rows — 22 of them ranking inside the top 223**, the best at PPR rank
139, displaced roughly 84 positions.

---

## Task 1: Interleave off-board ranked players instead of appending them

**Files:**
- Modify: `frontend/src/lib/boardOrder.js`
- Test: `frontend/src/lib/boardOrder.test.js` (append only)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `orderByBoard(players, boardRows)` — signature unchanged. Tasks 2 and 3 do not touch it.

**Background.** `orderByBoard` currently returns `[...onBoard, ...rest]`. Its comment explains why that was sound: a board holds every ranked player for its format, so the trailing group is just the unranked remainder. That holds **only when the board's format matches the draft's**. When it does not, players ranked for the draft's format but absent from the board are dumped below every board row.

**The contract you must not break.** The ten existing tests in `boardOrder.test.js` must pass **completely unmodified**. Their fixture's off-board players (`p4`, `p5`) are unranked, so they sort last under the new ordering exactly as they do under the old one. If you find yourself needing to edit one of those ten tests, **stop and report it** — that means the interleave has changed the matching-format contract, which it must not.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/boardOrder.test.js`, after the existing tests:

```js
// A board built for one scoring format against a pool ranked for another.
// The board covers p1 and p3; p2 and p6 are ranked in the pool but absent
// from it, which is exactly the case the old append-everything behavior
// mishandled.
const CROSS_POOL = [
  { id: "p1", name: "Alpha",   position: "RB", rank: 1 },
  { id: "p2", name: "Bravo",   position: "WR", rank: 2 },
  { id: "p3", name: "Charlie", position: "WR", rank: 3 },
  { id: "p6", name: "Foxtrot", position: "TE", rank: 4 },
  { id: "p7", name: "Golf",    position: "QB", rank: null },
];

const CROSS_ROWS = [
  { playerId: "p1", myRank: 1, consensusRank: 1, delta: 0 },
  { playerId: "p3", myRank: 3, consensusRank: 3, delta: 0 },
];

test("a ranked off-board player places by its rank, not after every board row", () => {
  const out = orderByBoard(CROSS_POOL, CROSS_ROWS);

  // p1 (board, 1), p2 (pool rank 2), p3 (board, 3), p6 (pool rank 4), p7 unranked.
  assert.deepStrictEqual(out.map((p) => p.id), ["p1", "p2", "p3", "p6", "p7"]);
});

test("an unranked off-board player still sorts last", () => {
  const out = orderByBoard(CROSS_POOL, CROSS_ROWS);
  assert.strictEqual(out[out.length - 1].id, "p7");
});

test("off-board ranked players keep their order relative to each other", () => {
  const out = orderByBoard(CROSS_POOL, CROSS_ROWS);
  const offBoard = out.filter((p) => p.id === "p2" || p.id === "p6").map((p) => p.id);
  assert.deepStrictEqual(offBoard, ["p2", "p6"]);
});

test("a tie between a board rank and a pool rank goes to the board player", () => {
  const pool = [
    { id: "off", name: "Off",   position: "WR", rank: 2 },
    { id: "on",  name: "On",    position: "RB", rank: 9 },
  ];
  const rows = [{ playerId: "on", myRank: 2, consensusRank: 9, delta: 7 }];

  const out = orderByBoard(pool, rows);

  // Both claim position 2. The user's own ranking wins.
  assert.deepStrictEqual(out.map((p) => p.id), ["on", "off"]);
});

test("a board player promoted above a better-ranked off-board player still leads", () => {
  const pool = [
    { id: "consensus-top", name: "Top",     position: "RB", rank: 1 },
    { id: "my-favourite",  name: "Sleeper", position: "WR", rank: 50 },
  ];
  const rows = [{ playerId: "my-favourite", myRank: 1, consensusRank: 50, delta: 49 }];

  const out = orderByBoard(pool, rows);

  assert.deepStrictEqual(out.map((p) => p.id), ["my-favourite", "consensus-top"]);
});

test("off-board players still carry neither myRank nor delta after interleaving", () => {
  const out = orderByBoard(CROSS_POOL, CROSS_ROWS);
  const off = out.find((p) => p.id === "p2");
  assert.strictEqual(off.myRank, undefined);
  assert.strictEqual(off.delta, undefined);
});

test("every player survives the interleave exactly once", () => {
  const out = orderByBoard(CROSS_POOL, CROSS_ROWS);
  assert.strictEqual(out.length, CROSS_POOL.length);
  assert.strictEqual(new Set(out.map((p) => p.id)).size, CROSS_POOL.length);
});

test("a player ranked after the board was built is placed, not buried", () => {
  // The nightly sync ranks someone the board predates. Same bug in miniature.
  const pool = [
    { id: "a", name: "A",     position: "RB", rank: 1 },
    { id: "new", name: "New", position: "WR", rank: 2 },
    { id: "b", name: "B",     position: "TE", rank: 3 },
  ];
  const rows = [
    { playerId: "a", myRank: 1, consensusRank: 1, delta: 0 },
    { playerId: "b", myRank: 3, consensusRank: 3, delta: 0 },
  ];

  const out = orderByBoard(pool, rows);

  assert.deepStrictEqual(out.map((p) => p.id), ["a", "new", "b"]);
});

test("all-unranked off-board players preserve pool order among themselves", () => {
  const pool = [
    { id: "on",  name: "On", position: "RB", rank: 1 },
    { id: "u1",  name: "U1", position: "WR", rank: null },
    { id: "u2",  name: "U2", position: "TE", rank: null },
  ];
  const rows = [{ playerId: "on", myRank: 1, consensusRank: 1, delta: 0 }];

  const out = orderByBoard(pool, rows);

  assert.deepStrictEqual(out.map((p) => p.id), ["on", "u1", "u2"]);
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

```bash
cd frontend && npm run test:unit 2>&1 | tail -25
```

Expected: the ten pre-existing `boardOrder` tests PASS, and several of the new ones FAIL — the interleaving cases, because today every off-board player is appended after every board player.

Record exactly which new tests fail. Some (the unranked-last case, the survives-once case, the promoted-board-player case) may already pass, since appending happens to satisfy them. That is fine. If **none** fail, stop and report it.

- [ ] **Step 3: Replace the concatenation with a single ordered merge**

In `frontend/src/lib/boardOrder.js`, replace the body of `orderByBoard` — and update the doc comment, whose current claim about the trailing group is what this change corrects:

```js
/**
 * Reorder the player pool by a user's saved board.
 *
 * Every player gets one ordinal: board players use the rank the user gave
 * them, and everyone else uses their consensus rank in the draft's format.
 * Unranked players have no position to claim, so they sort last. Board
 * players carry `myRank` and `delta` for display; nobody else does.
 *
 * The pool and the board can disagree about who is ranked at all. A board
 * covers every player ranked in ITS format, which is not the same set as the
 * draft's format -- measured against production, standard ranks 223 players
 * and PPR ranks 272, with standard a strict subset. Appending the off-board
 * group wholesale, as this used to, therefore buried players who belong near
 * the top: a standard board driving a PPR draft pushed 49 of them below its
 * 223 rows, 22 of those inside the top 223. The same happens in miniature to
 * anyone the nightly sync ranks after a board was built.
 *
 * Ties go to the board player: it is the user's explicit ranking.
 *
 * Returns the pool untouched when there are no rows, which is the fallback
 * path for a board that was deleted or failed to load.
 */
export function orderByBoard(players, boardRows) {
  if (!Array.isArray(boardRows) || boardRows.length === 0) return players;

  const byId = new Map(boardRows.map((r) => [String(r.playerId), r]));

  const decorated = players.map((p, index) => {
    const row = byId.get(String(p.id));
    if (row) {
      return {
        player: { ...p, myRank: row.myRank, delta: row.delta },
        rank: row.myRank,
        fromBoard: 1,
        index,
      };
    }
    return { player: p, rank: p.rank ?? null, fromBoard: 0, index };
  });

  decorated.sort((a, b) => {
    // Unranked sorts last. Comparing them numerically would be NaN, so the
    // null cases are settled before any subtraction happens.
    if (a.rank === null && b.rank === null) return a.index - b.index;
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;

    if (a.rank !== b.rank) return a.rank - b.rank;

    // Same position claimed: the user's own ranking wins, then pool order,
    // so the result never depends on the engine's sort stability.
    if (a.fromBoard !== b.fromBoard) return b.fromBoard - a.fromBoard;
    return a.index - b.index;
  });

  return decorated.map((d) => d.player);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: 56 tests, 56 pass, 0 fail (47 pre-existing + 9 added here).

- [ ] **Step 5: Confirm the ten original tests are untouched**

```bash
cd frontend && git diff src/lib/boardOrder.test.js | grep -E "^-" | grep -v "^---"
```

Expected: **no output.** The diff must be additions only. Any removed line means an existing test was modified, which is the stop condition described above — report it rather than proceeding.

- [ ] **Step 6: Run the full suites**

```bash
cd frontend && npx playwright test
```

Expected: PASS, 85 tests. `orderByBoard` drives the draft page's Big Board, so a failure here is in scope for this task. Do not run this in the background — wait for it and report the actual counts.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/boardOrder.js frontend/src/lib/boardOrder.test.js
git commit -m "Interleave off-board ranked players instead of appending them

orderByBoard assumed the trailing group was the unranked remainder, which
holds only when the board and the draft share a scoring format. Measured
against production, standard ranks 223 players and PPR ranks 272, with
standard a strict subset -- so a standard board driving a PPR draft
buried 49 ranked players below its 223 rows, 22 of them inside the top
223, the worst displaced about 84 positions.

Every player now takes one ordinal: board players by the rank the user
gave them, everyone else by their consensus rank, unranked last. Ties go
to the board player.

The matching-format case is unchanged, and the ten existing tests pass
untouched -- their off-board players are unranked and still sort last.
Also fixes the same bug in miniature for a player the nightly sync ranks
after a board was built."
```

---

## Task 2: Say which board is driving the draft, and flag a format mismatch

**Files:**
- Modify: `frontend/src/pages/Draft.jsx`
- Test: `frontend/tests/boarddraft.spec.js` (append only)

**Interfaces:**
- Consumes: `orderByBoard` from Task 1, unchanged in signature.
- Produces: test ids `board-active-note` and `board-format-note`.

**Background.** The board fetch at `Draft.jsx:62-93` keeps only `rows` and discards the rest. `GET /boards/:id` returns `boardId`, `name`, `sport`, `format`, `season`, `version`, `rows`, and `changelog` (`backend/src/boards.js:140-149`), so the name and format are already on the wire.

Today the panel speaks only on failure — `boardFailed` renders `board-load-note`. Success is silent, so there is no way to tell a board took effect except by recognising your own ordering.

The draft's own format is on the draft object as `draft.format` (confirmed against production), stored by `setDraft(d)` at `Draft.jsx:46`.

The three states are mutually exclusive: failed, loaded-with-matching-format, loaded-with-different-format.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/boarddraft.spec.js`:

```js
test("the draft page names the board driving it", async ({ page }) => {
  await seedBoard(page);
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: makeDraftState({ currentIndex: 0, boardId: BID, format: "ppr" }) })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ json: { boardId: BID, name: "My PPR Board", format: "ppr", rows: BOARD_ROWS } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  await expect(page.getByTestId("board-active-note")).toContainText("My PPR Board");
});

test("no board means no affirmation", async ({ page }) => {
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: makeDraftState({ currentIndex: 0 }) })
  );

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();

  await expect(page.getByTestId("board-active-note")).toHaveCount(0);
});

test("a board that fails to load shows the failure, not the affirmation", async ({ page }) => {
  await seedBoard(page);
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: makeDraftState({ currentIndex: 0, boardId: BID, format: "ppr" }) })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ status: 404, json: { error: "Board not found" } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  await expect(page.getByTestId("board-load-note")).toBeVisible();
  await expect(page.getByTestId("board-active-note")).toHaveCount(0);
});

test("a board in a different format is flagged, naming both formats", async ({ page }) => {
  await seedBoard(page);
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: makeDraftState({ currentIndex: 0, boardId: BID, format: "standard" }) })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ json: { boardId: BID, name: "My PPR Board", format: "ppr", rows: BOARD_ROWS } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();

  const note = page.getByTestId("board-format-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText(/ppr/i);
  await expect(note).toContainText(/standard/i);
});

test("a matching format shows no mismatch note", async ({ page }) => {
  await seedBoard(page);
  await mockPlayers(page);
  await page.route(`${API}/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ json: makeDraftState({ currentIndex: 0, boardId: BID, format: "ppr" }) })
  );
  await page.route(`${API}/boards/${BID}`, (route) =>
    route.fulfill({ json: { boardId: BID, name: "My PPR Board", format: "ppr", rows: BOARD_ROWS } })
  );

  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("board-active-note")).toBeVisible();

  await expect(page.getByTestId("board-format-note")).toHaveCount(0);
});
```

**`makeDraftState` must be extended first — it does not accept these today.** Its current signature is `makeDraftState({ currentIndex = 0, completedPicks = [] } = {})`. Add two optional parameters, defaulting to the values it already produces, so every existing caller is unaffected:

```js
export function makeDraftState({
  currentIndex = 0,
  completedPicks = [],
  boardId = null,
  format = "standard",
} = {}) {
```

and in the returned object, replace the hard-coded `format: "standard",` line with `format,` and add `boardId,` beside it. Do not change any existing default — several specs depend on them.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx playwright test tests/boarddraft.spec.js
```

Expected: FAIL on the affirmation and mismatch tests — neither test id exists. The "no board means no affirmation" and "failure not affirmation" cases pass trivially, since a missing element satisfies `toHaveCount(0)`; that is expected, they guard against over-rendering later.

- [ ] **Step 3: Keep the board's name and format**

In `frontend/src/pages/Draft.jsx`, add a state hook beside the existing `boardRows` declaration at line 28:

```jsx
  const [boardMeta, setBoardMeta] = useState(null);
```

In the board effect, set it alongside the rows and clear it on both the no-board and failure paths. The three assignments mirror the existing `setBoardRows` calls exactly:

- where the effect returns early for no board: `setBoardMeta(null);`
- on success, beside `setBoardRows(b.rows || [])`: `setBoardMeta({ name: b.name, format: b.format });`
- in the catch, beside `setBoardRows(null)`: `setBoardMeta(null);`

- [ ] **Step 4: Render the two notices**

In `frontend/src/pages/Draft.jsx`, immediately **before** the existing `{boardFailed && (...)}` block, add:

```jsx
            {boardMeta && boardRows?.length > 0 && (
              <div data-testid="board-active-note" className="rounded-2xl border border-cyan-900/50 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-200">
                Drafting off <span className="font-medium">{boardMeta.name}</span>
              </div>
            )}

            {boardMeta && boardRows?.length > 0 && boardMeta.format !== draft.format && (
              <div data-testid="board-format-note" className="rounded-2xl border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                This board is ranked for {boardMeta.format} — this draft is {draft.format}.
                Players are placed by rank, but the board's order reflects {boardMeta.format} scoring.
              </div>
            )}
```

Leave the `boardFailed` block exactly as it is. `boardMeta` is null whenever the fetch failed, so the affirmation and the failure note cannot both appear.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd frontend && npx playwright test tests/boarddraft.spec.js
```

Expected: PASS. Report the actual count.

- [ ] **Step 6: Run the full Playwright suite**

```bash
cd frontend && npx playwright test
```

Expected: PASS, 90 tests (85 pre-existing + 5 added here). Do not run this in the background.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Draft.jsx frontend/tests/boarddraft.spec.js frontend/tests/fixtures.js
git commit -m "Say which board is driving the draft, and flag a format mismatch

The panel spoke only on failure -- 'your board could not be loaded' --
so a board that worked was indistinguishable from no board at all except
by recognising your own ordering. The board fetch already received the
name and format and discarded both.

Adds the affirmative counterpart, and a notice when the board's scoring
format differs from the draft's. Interleaving fixes where those players
land; it does not make a standard board the right ranking for a PPR
draft, and that judgement is the user's to make."
```

---

## Task 3: Explain the Sleeper dynasty round and roster counts

**Files:**
- Modify: `frontend/src/pages/NewDraft.jsx`
- Test: `frontend/tests/sleeper.spec.js` (append only)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: test id `roster-rounds-note`. The existing `roster-summary` test id is unchanged.

**Background.** `toDraftConfig` (`frontend/src/lib/sleeper.js:39-62`) takes `rounds` from `draft.settings.rounds` and `rosterSlots` from `league.roster_positions`. For a dynasty league those legitimately differ: a 5-round rookie draft against a 33-slot roster. The page shows "Rounds: 5" beside 33 unlabelled chips and explains nothing, so two correct numbers read as a contradiction.

**No value changes.** This task adds a label and a conditional sentence. `rounds` and `rosterSlots` keep their current sources and values.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/sleeper.spec.js`:

The file's `mockSleeper(page, { user, leagues })` helper hard-codes the draft response at `rounds: 16`, and the default `LEAGUE` fixture has exactly 16 `roster_positions` — so the default import already has the two counts **agreeing**. That makes the negative case free, and the positive case a matter of overriding just the draft.

Playwright resolves the **last** registered matching route first, so re-routing `/draft/*` after `mockSleeper` overrides it without touching the shared helper. Do not modify `mockSleeper` or `LEAGUE`; other tests in this file depend on both.

```js
const SLEEPER_API = "https://api.sleeper.app/v1";

async function importFirstLeague(page) {
  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();
  await page.getByTestId("sleeper-leagues").getByRole("button").first().click();
}

test("a rookie draft explains why rounds and roster slots differ", async ({ page }) => {
  await mockSleeper(page);
  // Registered after mockSleeper, so this handler wins: a 5-round rookie
  // draft against the fixture league's 16 roster slots.
  await page.route(`${SLEEPER_API}/draft/*`, (route) =>
    route.fulfill({
      json: { type: "snake", settings: { rounds: 5, teams: 12 }, draft_order: {} },
    })
  );

  await page.goto("/draft/new");
  await importFirstLeague(page);

  await expect(page.getByLabel("Rounds")).toHaveValue("5");
  const note = page.getByTestId("roster-rounds-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("5");
  await expect(note).toContainText("16");
});

test("no explanation when rounds and roster slots agree", async ({ page }) => {
  // The default fixture is 16 rounds against 16 roster slots.
  await mockSleeper(page);

  await page.goto("/draft/new");
  await importFirstLeague(page);

  await expect(page.getByTestId("roster-summary")).toBeVisible();
  await expect(page.getByTestId("roster-rounds-note")).toHaveCount(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx playwright test tests/sleeper.spec.js
```

Expected: FAIL on the first test — `roster-rounds-note` does not exist. The second passes trivially; it guards against showing the note when the counts agree.

- [ ] **Step 3: Label the chips and explain a mismatch**

In `frontend/src/pages/NewDraft.jsx`, inside the `{rosterSlots && (...)}` block, change the existing caption line so it names what the chips are:

```jsx
            <div className="text-xs text-zinc-400">
              Roster imported from {importedFrom} — {rosterSlots.length} roster slots
            </div>
```

Then, immediately after the chip list's closing `</div>` and still inside the `rosterSlots` block, add:

```jsx
            {rosterSlots.length !== rounds && (
              <div data-testid="roster-rounds-note" className="text-xs text-zinc-500">
                This draft is {rounds} rounds, and the roster holds {rosterSlots.length} slots.
                Both are expected — a rookie or partial draft fills only part of a roster.
              </div>
            )}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx playwright test tests/sleeper.spec.js
```

Expected: PASS. Report the actual count.

- [ ] **Step 5: Run the full suites**

```bash
cd frontend && npx playwright test
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
cd frontend && npm run build 2>&1 | tail -3
```

Expected: 92 Playwright pass (85 + 5 from Task 2 + 2 here), 56 unit pass, clean build. Do not run these in the background.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/NewDraft.jsx frontend/tests/sleeper.spec.js
git commit -m "Explain the Sleeper rounds-versus-roster-slots difference

A dynasty import shows a 5-round rookie draft beside 33 roster chips.
Both numbers are correct -- rounds come from the draft, slots from the
roster -- but the chips were unlabelled and nothing said the two were
meant to differ, so it read as a bug.

Labels the chips as roster slots and, only when the counts disagree,
says both are expected. No value changes."
```

---

## Verification Summary

| Check | Command | Expected |
|---|---|---|
| Frontend unit | `cd frontend && npm run test:unit` | 56 pass |
| Playwright | `cd frontend && npx playwright test` | 92 pass |
| Build | `cd frontend && npm run build` | no errors |
| Backend unit | `cd backend/src && npm test` | 100 pass |
| Original board tests untouched | `git diff <base>..HEAD -- frontend/src/lib/boardOrder.test.js \| grep '^-' \| grep -v '^---'` | no output |

The backend is untouched; its suite is listed only to confirm the change stayed in the frontend. No deploy is part of this plan.
