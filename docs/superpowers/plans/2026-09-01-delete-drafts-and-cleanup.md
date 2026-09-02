# Delete Drafts and Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make deleting a draft possible, cover the one DynamoDB pagination loop still untested, and clear the accumulated papercuts.

**Architecture:** Four independent tasks. Task 1 adds the backend delete route and handler branch. Task 2 covers `boards.js`'s pagination loop. Task 3 wires a Delete control into the My Drafts page beside the existing Forget. Task 4 is lint and documentation. Tasks 1 and 3 are ordered — the frontend needs the endpoint to exist.

**Tech Stack:** Node.js 24 (CommonJS backend), AWS SAM, React 19, Tailwind 4, `node:test`, Playwright.

## Global Constraints

- **The backend is CommonJS** (`require`/`module.exports`); **the frontend is ESM** (`import`/`export`). Mixing them is a defect.
- **No new dependencies.** No `package.json` changes in either tree.
- **No change to bot scoring, roster logic, or snake order.**
- **Forget must remain local-only and make no network request.** Delete is a separate control. One of the tests asserts Forget issues no request — the two actions must not converge.
- Delete is **idempotent**: deleting an absent draft returns 200. That is what makes the frontend's server-first ordering safe.
- Tailwind utility classes only — no new stylesheet, no inline `style`.
- Backend tests run with `cd backend/src && npm test` (there is no `backend/package.json`). Frontend unit with `cd frontend && npm run test:unit`; Playwright with `cd frontend && npx playwright test`.
- Existing suites must stay green: **100 backend unit**, **58 frontend unit**, **94 Playwright**.
- **The two `setState`-in-effect ESLint errors are out of scope.** They change render behavior. Lint must go from 6 errors to 2, not to 0.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `backend/src/drafts.js` | Draft endpoints | Task 1 — DELETE branch, `DeleteCommand` import |
| `backend/template.yaml` | SAM routes | Task 1 — one DELETE event |
| `backend/src/drafts.test.js` | Draft response tests | Task 1 — delete cases |
| `backend/src/boards.test.js` | Board handler tests | Task 2 — pagination cases |
| `frontend/src/pages/MyDrafts.jsx` | My Drafts page | Task 3 — Delete control, error state, `relativeTime`, aria-labels |
| `frontend/tests/mydrafts.spec.js` | My Drafts e2e | Task 3 — delete cases, screenshot |
| `frontend/src/pages/NewDraft.jsx` | New Draft page | Task 4 — `useLeague` rename |
| `frontend/eslint.config.js` | Lint config | Task 4 — Node globals for the Playwright config |
| `README.md` | Docs | Task 4 — Project Structure |

---

## Task 1: `DELETE /drafts/{draftId}`

**Files:**
- Modify: `backend/src/drafts.js` (require block at lines 2-8; new branch before the catch-all 404 at line 385)
- Modify: `backend/template.yaml` (a new event on `DraftsFunction`)
- Test: `backend/src/drafts.test.js` (append)

**Interfaces:**
- Consumes: `responder(event)` from `lib/http.js`, unchanged.
- Produces: `DELETE /drafts/{draftId}` returning `{ ok: true }` with status 200, which Task 3 calls.

**Background.** `drafts.js` currently imports `GetCommand`, `PutCommand`, `UpdateCommand`, and `QueryCommand` — **not** `DeleteCommand`. `boards.js` is the model for both the handler branch and the SAM event. `DraftsFunction` already has `DynamoDBCrudPolicy` on the drafts table, so no policy change is needed.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/drafts.test.js`:

```js
test("DELETE removes a draft and reports ok", async () => {
  stubSend({});
  const res = await handler(evt("DELETE", "/drafts/d1", { draftId: "d1" }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
});

test("DELETE issues a DeleteCommand against the drafts table", async () => {
  let seen = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    seen = cmd;
    return {};
  });

  await handler(evt("DELETE", "/drafts/d1", { draftId: "d1" }));

  assert.strictEqual(seen.constructor.name, "DeleteCommand");
  assert.strictEqual(seen.input.TableName, "drafts-test");
  assert.deepStrictEqual(seen.input.Key, { draftId: "d1" });
});

test("deleting a draft that is already gone still returns 200", async () => {
  // DynamoDB's DeleteCommand succeeds whether or not the item existed, and
  // the frontend relies on that: a resolved call always means it is safe to
  // drop the row locally, so a retry after a network blip cannot error.
  stubSend({});
  const res = await handler(evt("DELETE", "/drafts/never-existed", { draftId: "never-existed" }));
  assert.strictEqual(res.statusCode, 200);
});

test("DELETE without a draftId falls through to the catch-all", async () => {
  stubSend({});
  const res = await handler(evt("DELETE", "/drafts"));
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Not found" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend/src && npm test 2>&1 | tail -20
```

Expected: FAIL. The first three fail because no DELETE branch exists, so the request falls through to the catch-all 404. The fourth already passes — it asserts the catch-all behavior that is already correct, and guards it against the new branch being written too broadly.

- [ ] **Step 3: Import `DeleteCommand`**

In `backend/src/drafts.js`, add it to the existing destructured require:

```js
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
```

- [ ] **Step 4: Add the branch**

In `backend/src/drafts.js`, immediately **before** the catch-all `return json(404, { error: "Not found" });` at line 385:

```js
    // DELETE /drafts/{draftId}
    if (method === "DELETE" && draftId) {
      await ddb.send(
        new DeleteCommand({ TableName: draftsTable, Key: { draftId } })
      );
      return json(200, { ok: true });
    }
```

Placing it last means it cannot shadow any existing route. It requires `draftId`, so `DELETE /drafts` still reaches the catch-all.

- [ ] **Step 5: Add the SAM route**

In `backend/template.yaml`, add an event to `DraftsFunction`'s `Events` block, after `SimToEnd`, matching the shape `BoardsFunction` already uses:

```yaml
        DeleteDraft:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /drafts/{draftId}
            Method: DELETE
```

No `Policies` change — `DynamoDBCrudPolicy` already grants `DeleteItem`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd backend/src && npm test 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: 104 tests, 104 pass, 0 fail (100 pre-existing + 4 added here).

- [ ] **Step 7: Validate the template**

```bash
cd backend && sam validate --lint 2>&1 | tail -2
```

Expected: valid SAM template, exit 0.

- [ ] **Step 8: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js backend/template.yaml
git commit -m "Add DELETE /drafts/{draftId}

A draft could not be removed: drafts.js had no DELETE branch and the
template registered no route, so the My Drafts page's Forget control
could only ever clear the local list while the record sat in DynamoDB
indefinitely.

Mirrors boards.js, including idempotence -- deleting an absent draft
returns 200. The frontend depends on that: a resolved call always means
it is safe to drop the row locally, so a retry cannot error.

The branch sits last, after every existing route and before the
catch-all, so it cannot shadow them. No policy change needed;
DynamoDBCrudPolicy already grants DeleteItem."
```

---

## Task 2: Cover `boards.js`'s pagination loop

**Files:**
- Test: `backend/src/boards.test.js` (append)

**Interfaces:**
- Consumes: nothing. No production code changes in this task.
- Produces: nothing consumed by later tasks.

**Background.** A DynamoDB Query page caps at 1MB. `boards.js`'s `loadPool` pages through `ExclusiveStartKey`/`LastEvaluatedKey` — it is the original that `players.js` and `drafts.js` copied. Both of those got tests proving the cursor is threaded; `boards.js` never did.

**This file has never touched DynamoDB.** Its header comment says every case is rejected by validation *before* any DynamoDB call, and warns against adding a case whose happy path reaches `ddb.send()`. You are deliberately adding the first such cases, so also update that comment to say the file now has both kinds. Use the stubbing pattern from `players.test.js`.

The cursor assertion is the one that matters: a loop that re-fetches page one forever still returns both pages' worth of items in the wrong test, and only checking `ExclusiveStartKey` catches it.

- [ ] **Step 1: Write the failing tests**

`backend/src/boards.test.js` currently requires only `test`, `assert`, and `handler` — it has neither `mock` nor `DynamoDBDocumentClient`, because nothing in it has ever touched DynamoDB. Add these two beneath the existing requires at the top of the file:

```js
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
```

Note the file does `const test = require("node:test")`, so `test.afterEach(...)` already resolves.

Then append the rest:

```js
process.env.BOARDS_TABLE = "boards-test";
process.env.PLAYERS_TABLE = "players-test";

function poolPlayer(id, rank) {
  return {
    sport: "nfl",
    playerId: id,
    name: `Player ${id}`,
    position: "RB",
    team: "SF",
    rank: { standard: rank },
  };
}

test.afterEach(() => mock.restoreAll());

test("GET pages the player pool until the cursor is exhausted", async () => {
  const pages = [
    { Items: [poolPlayer("a", 1)], LastEvaluatedKey: { sport: "nfl", playerId: "a" } },
    { Items: [poolPlayer("b", 2)] },
  ];
  let query = 0;

  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    // The board fetch is a Get (carries Key); the pool fetch is a Query.
    if (cmd?.input?.Key) {
      return { Item: { boardId: "b1", name: "B", sport: "nfl", format: "standard", version: 1, order: [] } };
    }
    const page = pages[query] || { Items: [] };
    query += 1;
    return page;
  });

  const res = await handler(event("GET", undefined, "b1"));
  const body = JSON.parse(res.body);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(query, 2, "should query again while LastEvaluatedKey is present");
  assert.deepStrictEqual(body.rows.map((r) => r.playerId).sort(), ["a", "b"]);
});

test("the second pool query carries the first page's cursor", async () => {
  // Without this, a loop that never advances ExclusiveStartKey re-fetches
  // page one forever -- returning plausible data while burning the Lambda's
  // timeout on repeated 1MB reads.
  const cursor = { sport: "nfl", playerId: "a" };
  const seen = [];

  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.Key) {
      return { Item: { boardId: "b1", name: "B", sport: "nfl", format: "standard", version: 1, order: [] } };
    }
    seen.push(cmd.input.ExclusiveStartKey);
    return seen.length === 1
      ? { Items: [poolPlayer("a", 1)], LastEvaluatedKey: cursor }
      : { Items: [poolPlayer("b", 2)] };
  });

  await handler(event("GET", undefined, "b1"));

  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0], undefined, "first query starts with no cursor");
  assert.deepStrictEqual(seen[1], cursor, "second query resumes from the first page's key");
});
```

- [ ] **Step 2: Run the tests to verify they pass**

```bash
cd backend/src && npm test 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: 106 tests, 106 pass, 0 fail (104 from Task 1 + 2 added here).

These describe behavior `boards.js` already has, so both should pass immediately. If either fails, the test is wrong — fix the test, not `boards.js`.

- [ ] **Step 3: Prove the cursor test is load-bearing**

```bash
cd backend/src
sed -i '' 's/^        ExclusiveStartKey,$//' boards.js
npm test 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: FAIL — the cursor test fails, because the loop now re-fetches page one.

Restore it:

```bash
cd backend/src && git checkout -- boards.js
grep -n "ExclusiveStartKey," boards.js
npm test 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: the grep matches, and 106 pass. If the mutation did not fail the test, stop and report it.

- [ ] **Step 4: Update the file's header comment**

`backend/src/boards.test.js` opens with a comment stating that every case is rejected before any DynamoDB call and warning against adding one whose happy path reaches `ddb.send()`. That is no longer true. Amend it to say the file now holds both kinds: validation cases that need no stub, and pool-pagination cases that stub `DynamoDBDocumentClient.prototype.send`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/boards.test.js
git commit -m "Cover the boards pool pagination loop

boards.js is the original the players.js and drafts.js pagination loops
were copied from, and the only one whose cursor threading was never
tested. Both copies got that coverage; the original did not.

The cursor assertion is the load-bearing one: a loop that never advances
ExclusiveStartKey re-fetches page one forever, returning plausible data
while burning the Lambda timeout on repeated 1MB reads. Mutation-checked
by deleting that line.

Also amends the file's header comment, which promised every case avoided
DynamoDB -- these two deliberately do not."
```

---

## Task 3: A Delete control on My Drafts

**Files:**
- Modify: `frontend/src/pages/MyDrafts.jsx`
- Test: `frontend/tests/mydrafts.spec.js` (append)

**Interfaces:**
- Consumes: `DELETE /drafts/:id` from Task 1, and the existing `apiDelete` from `frontend/src/lib/api.js`.
- Produces: test ids `delete-draft` (new) alongside the existing `forget-draft`.

**Background.** `Forget` clears the local registry only. It stays exactly as it is — sharing a finished draft is an explicit feature (`Results.jsx` has a Copy Share Link button), so removing a row from your list must not break a link someone else holds.

`MyDrafts.jsx` currently has **no error state** — no `err`/`setErr`. Delete's failure path needs one. `Boards.jsx` is the model for both the error banner and the server-first ordering: it calls the API, and only drops the local entry once the server confirms, so a failure leaves the row listed and retryable.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/mydrafts.spec.js`:

```js
const DRAFTS_API = "http://localhost:9999";

test("delete removes the draft server-side and drops the row", async ({ page }) => {
  await seed(page, [IN_PROGRESS]);
  let deleted = null;
  await page.route(`${DRAFTS_API}/drafts/${IN_PROGRESS.id}`, (route) => {
    if (route.request().method() === "DELETE") {
      deleted = route.request().url();
      return route.fulfill({ json: { ok: true } });
    }
    return route.fallback();
  });
  page.on("dialog", (d) => d.accept());

  await page.goto("/drafts");
  await page.getByTestId("draft-row").first().getByTestId("delete-draft").click();

  await expect(page.getByTestId("draft-row")).toHaveCount(0);
  expect(deleted).toContain(IN_PROGRESS.id);
});

test("dismissing the confirmation deletes nothing", async ({ page }) => {
  await seed(page, [IN_PROGRESS]);
  let called = false;
  await page.route(`${DRAFTS_API}/drafts/${IN_PROGRESS.id}`, (route) => {
    if (route.request().method() === "DELETE") called = true;
    return route.fulfill({ json: { ok: true } });
  });
  page.on("dialog", (d) => d.dismiss());

  await page.goto("/drafts");
  await page.getByTestId("draft-row").first().getByTestId("delete-draft").click();

  await expect(page.getByTestId("draft-row")).toHaveCount(1);
  expect(called, "no request should be made when the confirmation is dismissed").toBe(false);
});

test("a failed delete leaves the row listed and says so", async ({ page }) => {
  await seed(page, [IN_PROGRESS]);
  await page.route(`${DRAFTS_API}/drafts/${IN_PROGRESS.id}`, (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({ status: 500, json: { error: "Server error" } });
    }
    return route.fallback();
  });
  page.on("dialog", (d) => d.accept());

  await page.goto("/drafts");
  await page.getByTestId("draft-row").first().getByTestId("delete-draft").click();

  await expect(page.getByTestId("draft-row")).toHaveCount(1);
  await expect(page.getByTestId("my-drafts-error")).toBeVisible();
});

test("forget makes no network request at all", async ({ page }) => {
  await seed(page, [IN_PROGRESS]);
  let requests = 0;
  await page.route(`${DRAFTS_API}/**`, (route) => {
    requests += 1;
    return route.fulfill({ json: {} });
  });

  await page.goto("/drafts");
  await page.getByTestId("draft-row").first().getByTestId("forget-draft").click();

  await expect(page.getByTestId("draft-row")).toHaveCount(0);
  expect(requests, "forget must stay local -- it is not delete").toBe(0);
});

test("relative time floors rather than rounds", async ({ page }) => {
  const fortyFiveMinutes = { ...IN_PROGRESS, updatedAt: Date.now() - 45 * 60 * 1000 };
  await seed(page, [fortyFiveMinutes]);

  await page.goto("/drafts");

  // 45 minutes is 45m, not "1h ago".
  await expect(page.getByTestId("draft-row").first()).toContainText("45m ago");
});

test("the remove controls describe the draft, not its id", async ({ page }) => {
  await seed(page, [IN_PROGRESS]);
  await page.goto("/drafts");

  const row = page.getByTestId("draft-row").first();
  for (const id of ["forget-draft", "delete-draft"]) {
    const label = await row.getByTestId(id).getAttribute("aria-label");
    expect(label, `${id} aria-label`).not.toContain(IN_PROGRESS.id);
    expect(label, `${id} aria-label`).toMatch(/ppr/i);
  }
});

test("screenshot — my drafts", async ({ page }) => {
  await seed(page, [IN_PROGRESS, COMPLETED]);
  await page.goto("/drafts");
  await expect(page.getByTestId("my-drafts-list")).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/drafts.png`, fullPage: false });
});
```

The screenshot test needs the same imports the other screenshot specs use. Add at the top of the file if absent:

```js
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx playwright test tests/mydrafts.spec.js
```

Expected: FAIL on the delete tests (`delete-draft` does not exist), the error test (`my-drafts-error` does not exist), the relative-time test ("1h ago" today), and the aria-label test (the current label contains the id). The "forget makes no network request" test passes already — it guards against the two actions converging later.

- [ ] **Step 3: Floor the relative time**

In `frontend/src/pages/MyDrafts.jsx`, change the three `Math.round` calls in `relativeTime` to `Math.floor`:

```js
function relativeTime(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
```

The seconds calculation keeps its `Math.round` — rounding to the nearest second is fine, and flooring it would make a 59.6-second-old draft read "just now" a moment longer than it should.

- [ ] **Step 4: Add the error state and the delete handler**

In `frontend/src/pages/MyDrafts.jsx`, add the import and state, mirroring `Boards.jsx`:

```jsx
import { apiDelete } from "../lib/api";
```

```jsx
  const [err, setErr] = useState("");
```

and the handler beside the existing `forget`:

```jsx
  // Server first, then local: on failure the row stays listed so the user can
  // retry rather than losing their way back to a draft that still exists.
  // DELETE is idempotent, so a resolved call always means it is safe to drop.
  const remove = async (d) => {
    if (!window.confirm(`Delete this ${describe(d)} draft? This cannot be undone, and any link you shared will stop working.`)) {
      return;
    }
    setErr("");
    try {
      await apiDelete(`/drafts/${d.id}`);
      forgetDraft(d.id);
      setDrafts(listDrafts());
    } catch (e) {
      setErr(e.message || "Failed to delete draft");
    }
  };
```

Add a small helper above the component, used by both the confirmation copy and the aria-labels:

```js
function describe(d) {
  return `${FORMAT_LABEL[d.format] || d.format}, ${d.teams} teams`;
}
```

- [ ] **Step 5: Render the error banner and the Delete control**

In `frontend/src/pages/MyDrafts.jsx`, add the banner between the header and the list, matching `Boards.jsx`:

```jsx
      {err && (
        <div data-testid="my-drafts-error" className="mb-4 rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-200">
          {err}
        </div>
      )}
```

Change the existing Forget button's `aria-label` to describe the draft, and add the Delete button beside it:

```jsx
                <button
                  type="button"
                  onClick={() => forget(d.id)}
                  data-testid="forget-draft"
                  aria-label={`Forget ${describe(d)} draft`}
                  title="Removes it from this list only. The draft still exists and its link still works."
                  className="rounded-2xl border border-zinc-800 px-3 py-3 text-xs text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
                >
                  Forget
                </button>
                <button
                  type="button"
                  onClick={() => remove(d)}
                  data-testid="delete-draft"
                  aria-label={`Delete ${describe(d)} draft`}
                  title="Deletes the draft for everyone. Any link you shared will stop working."
                  className="rounded-2xl border border-zinc-800 px-3 py-3 text-xs text-zinc-500 hover:border-rose-900/60 hover:text-rose-300"
                >
                  Delete
                </button>
```

Note the Forget button's hover colours change from rose to zinc — rose now belongs to Delete, which is the destructive one.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd frontend && npx playwright test tests/mydrafts.spec.js
```

Expected: PASS. Report the actual count.

- [ ] **Step 7: Run the full suites**

```bash
cd frontend && npx playwright test
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: 101 Playwright pass (94 pre-existing + 7 added here), 58 unit pass. Do not run these in the background.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/MyDrafts.jsx frontend/tests/mydrafts.spec.js screenshots/drafts.png
git commit -m "Add a Delete control to My Drafts, beside Forget

Forget is unchanged and still local-only. Delete is separate, confirmed,
and irreversible, because sharing a finished draft is an explicit
feature -- one click should not break a link someone else is holding.

Server first, then local, copying Boards.jsx: on failure the row stays
listed and retryable rather than vanishing from a list while the draft
still exists.

Also floors relativeTime, so 45 minutes reads 45m rather than 1h, and
replaces the raw UUID in both controls' aria-labels with a description
of the draft."
```

---

## Task 4: Lint and documentation

**Files:**
- Modify: `frontend/src/pages/NewDraft.jsx` (the `useLeague` definition at line 98 and its call site at line 164)
- Modify: `frontend/eslint.config.js`
- Modify: `README.md` (the Project Structure section at line 164)

**Interfaces:**
- Consumes: nothing. Produces nothing. This task is isolated.

**Background.** Six ESLint errors, unchanged all session:

- Three `'process' is not defined` in `playwright.config.js` — a Node file linted with browser globals.
- One `react-hooks/rules-of-hooks` on `useLeague` in `NewDraft.jsx`. **This is a false positive**: `useLeague` is a plain async event handler, flagged only because its name starts with `use`. The name is genuinely misleading, so renaming fixes both the lint and the confusion.
- Two "Calling setState synchronously within an effect" — **out of scope**. They change render behavior and belong in their own reviewed change. Lint must end at **2 errors, not 0.**

- [ ] **Step 1: Rename the misleading handler**

In `frontend/src/pages/NewDraft.jsx`, rename `useLeague` to `applyLeague` at its definition (line 98) and at its only call site (line 164). It is a local `const`, so there are exactly two occurrences — confirm with a grep before and after.

- [ ] **Step 2: Give the Playwright config Node globals**

In `frontend/eslint.config.js`, add a second config object after the existing one, so the Playwright config is linted as Node rather than browser:

```js
  {
    files: ['playwright.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
```

`globals` is already imported at the top of the file.

- [ ] **Step 3: Verify lint dropped to exactly 2 errors**

```bash
cd frontend && npm run lint 2>&1 | tail -6
```

Expected: **2 errors, 2 warnings**, both errors being the `setState`-in-effect ones. If any other error remains, or if the count is 0, report it — 0 would mean the out-of-scope errors were silenced.

- [ ] **Step 4: Update the README's Project Structure**

`README.md`'s Project Structure section at line 164 predates several pages and libraries. Read the actual tree and bring the listing in line with it, including at minimum `Boards.jsx`, `NewDraft.jsx`, `MyDrafts.jsx`, `boardRegistry.js`, `draftRegistry.js`, `useRememberDraft.js`, and `boardOrder.js`, plus the backend's `drafts.test.js`, `players.test.js`, and `lib/`.

Do not restructure the rest of the README or change its other sections.

- [ ] **Step 5: Confirm nothing else moved**

```bash
cd frontend && npm run test:unit 2>&1 | grep -E "^. (tests|pass|fail)"
cd frontend && npx playwright test
```

Expected: 58 unit pass, 101 Playwright pass. The rename touches a call site the Sleeper import tests exercise, so a failure there is in scope for this task. Do not run these in the background.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/NewDraft.jsx frontend/eslint.config.js README.md
git commit -m "Rename a misleading handler, fix config lint, refresh the README

useLeague was a plain async event handler that ESLint flagged as a
misused hook purely because of its name. The lint error was a false
positive; the name was not -- it reads as a hook and is not one. Now
applyLeague.

playwright.config.js is a Node file that was being linted with browser
globals, so process was undefined three times over.

Lint goes from 6 errors to 2. The two that remain are the
setState-in-effect ones, deliberately untouched: fixing those changes
render behavior and belongs in its own reviewed change.

The README's Project Structure listed none of the pages or libraries
added over the last several branches."
```

---

## Verification Summary

| Check | Command | Expected |
|---|---|---|
| Backend unit | `cd backend/src && npm test` | 106 pass |
| Frontend unit | `cd frontend && npm run test:unit` | 58 pass |
| Playwright | `cd frontend && npx playwright test` | 101 pass |
| Lint | `cd frontend && npm run lint` | exactly 2 errors, 2 warnings |
| SAM template | `cd backend && sam validate --lint` | exit 0 |
| Build | `cd frontend && npm run build` | no errors |

## Post-Deploy Verification (controller runs this, not a task)

This branch changes `template.yaml`, so it needs a **backend deploy** as well as a frontend one.

1. `POST /drafts` — create a draft
2. `DELETE /drafts/{id}` — expect 200 `{ok: true}`
3. `GET /drafts/{id}` — expect 404, proving it is really gone
4. `DELETE /drafts/{id}` again — expect 200, proving idempotence
5. A full draft lifecycle — create, pick, auto-pick, sim to completion — proving the new branch did not disturb the existing routes
