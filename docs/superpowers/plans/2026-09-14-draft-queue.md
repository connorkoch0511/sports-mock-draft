# Draft Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-seat queue the expired clock drafts from, ahead of your board.

**Architecture:** `seats[i].queue` — an array of player ids, written by one conditional-update route shaped exactly like `/seat-board`. `autoPickAndAdvance` consults it before resolving a board. Taken players are dropped by filtering on read, never by writing.

**Tech Stack:** Node 24 CommonJS backend (`cd backend/src && npm test`), React 19 + Tailwind 4, Playwright, dnd-kit (already a dependency).

**Spec:** `docs/superpowers/specs/2026-09-14-draft-queue-design.md`

## A note on the stop conditions

"Stop if an existing test needs editing" has misfired three times on this
project, always the same way: it is meant to catch breakage you did **not**
intend, and it keeps catching deliberate contract changes instead. A test that
pins a shape is supposed to fail when the shape deliberately changes — that is
the test working.

So the rule as it applies here: **a test that fails because it asserts exactly
what this task set out to change should be updated, deliberately, and named in
the report.** A test that fails for any other reason is a stop.

## Global Constraints

- **Filtering on read is the design, not a shortcut.** Never prune a stored queue on the pick path: that is a write per pick per affected seat, on the hot path the shared clock's conditional write already guards, with a race whenever two seats queue the same player. Both the UI and the auto-picker skip ids already in `picked`.
- **The queue beats the roster guard.** A queued kicker in round three gets drafted. The guard exists for when the user has said nothing; here they have said something. A test asserts this so nobody "corrects" it later.
- **A queued player who is drafted disappears** — not struck through, not greyed. The queue holds only players you can still take.
- Per-seat and private. The queue is never visible to another seat, and never returned for one.
- Backend suite: `cd backend/src && npm test` (colocated `*.test.js`; there is no `__tests__` directory). Frontend unit: `cd frontend && npm run test:unit` — `node --test`, **not vitest**. Browser: `npx playwright test <file>`; the controller owns the full suite.
- Never edit the working tree while a test run is in flight.

---

### Task 1: The queue is state on your seat

**Files:**
- Modify: `backend/src/drafts.js`
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Produces: `POST /drafts/{draftId}/queue` taking `{ queue: string[] }`, and `yourQueue` on the `GET /drafts/{draftId}` projection. Tasks 2 and 3 consume both.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/drafts.test.js`, beside the existing seat-board tests:

```js
test("a seat's queue is stored, and comes back on the draft", async () => {
  // ...mirror the seat-board test's setup for a seated user...
  const res = await post(`/drafts/${DRAFT_ID}/queue`, { queue: ["4034", "6786"] });
  assert.strictEqual(res.statusCode, 200);

  const got = await get(`/drafts/${DRAFT_ID}`);
  assert.deepStrictEqual(JSON.parse(got.body).yourQueue, ["4034", "6786"]);
});

// The same guard /seat-board has: a queue is per-seat, and writing one for a
// seat you do not hold would let anyone steer anyone else's expired clock.
test("a queue cannot be written for a seat that is not yours", async () => {
  const res = await post(`/drafts/${DRAFT_ID}/queue`, { queue: ["4034"] }, { sub: "somebody-else" });
  assert.strictEqual(res.statusCode, 404);
});

test("a queue is rejected when it is not a list of player ids", async () => {
  for (const bad of [{ queue: "4034" }, { queue: [1, 2] }, { queue: [{ id: "x" }] }]) {
    const res = await post(`/drafts/${DRAFT_ID}/queue`, bad);
    assert.strictEqual(res.statusCode, 400);
  }
});

// A queue is a shortlist, not a second big board. An unbounded array is a
// payload and an item-size problem for no benefit.
test("a queue longer than 50 is rejected", async () => {
  const res = await post(`/drafts/${DRAFT_ID}/queue`, {
    queue: Array.from({ length: 51 }, (_, i) => `p${i}`),
  });
  assert.strictEqual(res.statusCode, 400);
});
```

Match the file's existing helpers for `post`/`get` rather than the names above.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd backend/src && npm test 2>&1 | grep -E "^ℹ (pass|fail)|^✖" | head
```

Expected: the four new tests FAIL — the route does not exist, so they get 404 or 500 rather than 200/400.

- [ ] **Step 3: Add the route**

In `backend/src/drafts.js`, immediately after the `/seat-board` route, following its shape exactly:

```js
    // POST /drafts/{draftId}/queue
    //
    // The shortlist the clock drafts from when it picks for you. Per-seat and
    // private: a queue written for a seat you do not hold would let anyone
    // steer anyone else's expired clock, which is why this carries the same
    // conditional write /seat-board does.
    //
    // The whole array is replaced rather than patched. Reordering is then one
    // write with no partial-order race, and the payload is a handful of ids.
    if (method === "POST" && draftId && path.endsWith("/queue")) {
      if (!sub) return needsAuth();
      const body = event.body ? JSON.parse(event.body) : {};
      const raw = body.queue;
      if (
        !Array.isArray(raw) ||
        raw.length > 50 ||
        !raw.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)
      ) {
        return json(400, { error: "queue must be a list of up to 50 player ids" });
      }
      // Same id twice would draft him once and then skip a slot.
      const queue = [...new Set(raw)];

      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;
      const i = (d.seats || []).findIndex((s) => s?.kind === "human" && s?.sub === sub);
      if (i < 0) return notFound();

      await ddb.send(
        new UpdateCommand({
          TableName: draftsTable,
          Key: { draftId },
          UpdateExpression: `SET seats[${i}].queue = :q, version = if_not_exists(version, :z) + :one`,
          ConditionExpression: `seats[${i}].#sub = :me`,
          ExpressionAttributeNames: { "#sub": "sub" },
          ExpressionAttributeValues: { ":q": queue, ":me": sub, ":z": 0, ":one": 1 },
        })
      );

      return json(200, { ok: true, queue });
    }
```

- [ ] **Step 4: Return it on the draft**

Beside `yourBoardId` in the `GET /drafts/{draftId}` projection:

```js
        // Only ever this caller's own. A queue is private to its seat.
        yourQueue: seatOf(d, sub)?.queue ?? [],
```

- [ ] **Step 5: Run the suite**

```bash
cd backend/src && npm test 2>&1 | grep -E "^ℹ (pass|fail)|^✖" | head
```

Expected: all pass.

**One existing test will need editing, and should.**
`"GET /drafts/{id} found returns the full draft object"` asserts
`deepStrictEqual` on the whole projection, precisely so a field cannot appear
or disappear unnoticed. Adding `yourQueue` to the projection is this task, so
add `yourQueue: []` to its expected object and name the change in your report.

Anything *else* needing an edit is the stop condition: it would mean this
task moved something it was not meant to touch.

- [ ] **Step 6: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js
git commit -m "feat: a queue is state on your seat"
```

---

### Task 2: The clock drafts from the queue first

**Files:**
- Modify: `backend/src/lib/autoPick.js`
- Test: `backend/src/lib/autoPick.test.js` (or wherever `autoPickAndAdvance` is covered)

**Interfaces:**
- Consumes: `seats[i].queue` from Task 1.

- [ ] **Step 1: Write the failing tests**

```js
test("the clock takes the first queued player, ignoring the board", async () => {
  const d = draftWithSeat({ queue: ["queued-guy"] });
  const r = await autoPickAndAdvance({ ...deps, d });
  assert.strictEqual(r.pick.playerId, "queued-guy");
});

// The companion, so the test above cannot pass by accident: the same fixture
// with no queue must still pick by board.
test("an empty queue still picks by board", async () => {
  const d = draftWithSeat({ queue: [] });
  const r = await autoPickAndAdvance({ ...deps, d });
  assert.notStrictEqual(r.pick.playerId, "queued-guy");
});

test("a queued player already drafted is skipped for the next one", async () => {
  const d = draftWithSeat({ queue: ["taken-guy", "queued-guy"], picked: ["taken-guy"] });
  const r = await autoPickAndAdvance({ ...deps, d });
  assert.strictEqual(r.pick.playerId, "queued-guy");
});

// Deliberate: the roster guard refuses kickers early so the picker cannot
// wreck a roster while GUESSING. A queue is not a guess. Without this test
// somebody restores the guard and calls it a bug fix.
test("a queued kicker is drafted in round three, roster guard notwithstanding", async () => {
  const d = draftWithSeat({ queue: ["some-kicker"], currentIndex: 24 });
  const r = await autoPickAndAdvance({ ...deps, d });
  assert.strictEqual(r.pick.playerId, "some-kicker");
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd backend/src && npm test 2>&1 | grep -E "^ℹ (pass|fail)|^✖" | head
```

Expected: the queue tests fail (the pick comes from the board); "an empty queue still picks by board" passes already, which is correct — it exists to stop a false positive on its neighbour.

- [ ] **Step 3: Consult the queue before the board**

In `autoPickAndAdvance`, immediately before the existing `rankOf` line:

```js
  // The queue outranks everything, including the roster guard inside
  // pickBestForTeam. That guard stops the picker wrecking a roster while it
  // is GUESSING; a queue is the user having said exactly what they want, and
  // a feature that second-guesses that is not worth having.
  //
  // Filtered, never pruned: a queued player somebody else drafted is skipped
  // here and disappears from the owner's list on their next render, with no
  // write and no cross-seat race. See the spec.
  const seat = (d.seats || []).find((s) => s?.team === teamNum);
  const pickedSet = new Set(d.picked || []);
  const queued = (seat?.queue || []).find((id) => !pickedSet.has(id) && byId[id]);

  const best = queued
    ? byId[queued]
    : pickBestForTeam(d, teamNum, players, rankOf);
```

and leave the existing `rankOf` resolution where it is — it still runs,
because the queue may be empty. Replace the old `const best =
pickBestForTeam(...)` line with the conditional above.

**Yes, that reads the board even when the queue wins.** One `GetCommand`
against the boards table, on a path that already does a table read and a
conditional write, in exchange for keeping the flow linear and the queue
branch a single expression. Guarding it would mean resolving `rankOf` lazily
in two places. Left deliberate so a reviewer knows it was seen, not missed.

- [ ] **Step 4: Run the suite**

```bash
cd backend/src && npm test 2>&1 | grep -E "^ℹ (pass|fail)|^✖" | head
```

Expected: all pass, no existing test edited.

- [ ] **Step 5: Prove the queue's precedence is load-bearing**

Temporarily change `const best = queued ? byId[queued] : ...` to always call `pickBestForTeam`, confirm "the clock takes the first queued player" fails, restore.

- [ ] **Step 6: Commit**

```bash
git add backend/src/lib/autoPick.js backend/src/lib
git commit -m "feat: the clock drafts from your queue before your board"
```

---

### Task 3: The queue on screen, at every width

**Files:**
- Create: `frontend/src/components/draft/QueuePanel.jsx`
- Modify: `frontend/src/pages/Draft.jsx`, `frontend/src/components/draft/TabBar.jsx`, `frontend/src/components/draft/BigBoardPanel.jsx`
- Test: `frontend/tests/queue.spec.js` (new), `frontend/tests/draftphone.spec.js`

**Interfaces:**
- Consumes: `yourQueue` from Task 1.
- Produces: `QueuePanel` with `data-testid="panel-queue"`; an add control per Big Board row, `data-testid="queue-add"`.

- [ ] **Step 1: Write the failing tests**

In a new `frontend/tests/queue.spec.js`, cover:

- Adding from a Big Board row puts the player at the end of the queue and POSTs the whole array.
- Removing a row takes him out and POSTs the remainder.
- **A player drafted by somebody else disappears from the queue with no POST** — assert the request count is unchanged across the pick. This is the filtering-on-read decision, and the absence of a write is the half that matters.
- An empty queue renders its explanatory text, not a blank box.

And in `draftphone.spec.js`: the tab bar has four tabs, Queue shows `panel-queue`, and the page still fits 390×844.

- [ ] **Step 2: Run and watch them fail**

```bash
cd frontend && npx playwright test tests/queue.spec.js
```

Expected: FAIL — no queue panel exists.

- [ ] **Step 3: Build the panel**

`QueuePanel.jsx` takes `{ queue, playersById, picked, onRemove }` and renders the filtered list:

```jsx
  // Filtered on read. A queued player somebody drafted is gone from here the
  // moment the pick lands -- no write, no race, and nothing struck through:
  // an entry you cannot pick is noise in a list whose whole job is what you
  // are going to pick next.
  const live = queue.filter((id) => !picked.has(id));
```

Match the other panels' outer classes exactly — `rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur ... min-h-0 min-w-0 flex flex-col` — so it sits in the grid like its neighbours.

- [ ] **Step 4: Give it room at `xl`**

The grid and the container both change. In `Draft.jsx`:

```jsx
        <div className="relative mx-auto max-w-7xl px-6 py-6 ...
```

becomes `xl:max-w-[1600px]`, and the grid's `xl:grid-cols-[420px_minmax(0,1fr)_360px]` gains a fourth track — `xl:grid-cols-[420px_minmax(0,1fr)_360px_260px]`.

**Measured, and the reason this is not cosmetic:** the grid is capped at 1232px by `max-w-7xl`, not by the viewport, so a 1728px monitor renders the same 1232px. Four columns inside 1232 leave the Draft Board 164px against a table that wants 620. Widening is what makes the fourth column free.

- [ ] **Step 5: The fourth tab, and the fourth cell**

Between `lg` and `xl` the grid is `lg:grid-cols-2` and takes a fourth cell
with no change — two rows of two, on a page that already scrolls at that
width. Nothing to write; confirm it by looking, and say in your report that
you did.

- [ ] **Step 5b: The fourth tab**

`TabBar.jsx`: add `{ id: "queue", label: "Queue", testid: "tab-queue" }` and change `grid-cols-3` to `grid-cols-4`. The bar was laid out for exactly this.

Add a matching `pane("queue")` wrapper in `Draft.jsx`, alongside the other three.

- [ ] **Step 6: Run the tests**

```bash
cd frontend && npx playwright test tests/queue.spec.js tests/draftphone.spec.js
```

Expected: all pass.

- [ ] **Step 7: Prove the desktop layout got wider, not narrower**

```bash
cd frontend && npx playwright test tests/draftlayout.spec.js
```

Expected: all pass. Then measure and report: at 1440, the Draft Board's width **must not be smaller than the 420px it has today**. If it is, the widening did not take and the fourth column is being paid for by the panel that can least afford it.

- [ ] **Step 8: Look at it**

Render at 1440 and at 390×844, screenshot both, and confirm four columns and four tabs read correctly with nothing overflowing. Three defects on this project's last two branches were invisible to passing tests and found only this way.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/draft frontend/src/pages/Draft.jsx frontend/tests
git commit -m "feat: the queue has a home at every width"
```

---

### Task 4: Reorder by dragging

**Files:**
- Modify: `frontend/src/components/draft/QueuePanel.jsx`
- Test: `frontend/tests/queue.spec.js`

- [ ] **Step 1: Write the failing tests**

A mouse drag reorders and POSTs the new order; a touch **hold** then drag reorders; a touch **swipe** scrolls and reorders nothing.

The touch cases need genuine touch events over CDP — synthetic `PointerEvent`s skip the browser's scroll-versus-drag arbitration and prove nothing. `frontend/tests/board.spec.js` has the helper; copy its approach.

- [ ] **Step 2: Run and watch them fail**

```bash
cd frontend && npx playwright test tests/queue.spec.js -g "reorder"
```

- [ ] **Step 3: Reuse the Board page's sensors**

Copy the configuration from `frontend/src/pages/Board.jsx` exactly:

```js
  const sensors = useSensors(
    useSensor(PrimaryMouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
```

`PrimaryMouseSensor` is not optional: plain `MouseSensor` arms on middle-click, and a drop here writes. Export it from `Board.jsx` or lift it to a shared module rather than copying the class.

- [ ] **Step 4: Run, then commit**

```bash
cd frontend && npx playwright test tests/queue.spec.js
git add frontend/src/components/draft/QueuePanel.jsx frontend/tests/queue.spec.js
git commit -m "feat: drag to reorder the queue"
```

---

## After all four tasks

Controller runs both full suites, checks which screenshots changed (`draft.png` and `draft-phone.png` both will — the layout has a new column and a new tab), and deploys backend then frontend.
