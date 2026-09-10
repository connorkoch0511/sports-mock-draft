# Unattended Clock (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the draft clock true when nobody is watching, by giving the server a scheduled caller for the deadline it already owns.

**Architecture:** A sparse global secondary index holds only drafts whose clock should be running, keyed by `pickDeadline`, so one Query per minute returns exactly the drafts that are due. An EventBridge schedule drives a new Lambda that drains each due draft in-process, calling the same pick rule the HTTP route calls — extracted from `drafts.js` so both callers share one implementation. The index attribute is written inside the conditional writes that already exist, so it can never disagree with the draft.

**Tech Stack:** AWS SAM (Lambda + DynamoDB + EventBridge Scheduler), Node 24 CommonJS backend tested with `node --test`. No frontend change.

**Spec:** `docs/superpowers/specs/2026-09-10-unattended-clock-design.md`

## Global Constraints

- **The scheduler drains; `POST /expire` does not.** `/expire` keeps its existing rule exactly — one expired deadline, exactly one auto-pick. Do not change its behaviour in any task.
- **`clockRunning` is written only inside writes that already happen.** No task may add a separate update to *maintain* it at runtime. If a site seems to need one, the design is wrong; stop rather than adding it. The one-off backfill in Task 5 is a migration for rows written before the attribute existed, not maintenance, and is the single exemption.
- **Every new function needs its resource in `backend/template.yaml`.** A handler without one is dead code that every unit test passes.
- **Mutation-test every guard:** delete the guard, run the covering test, confirm it goes **red**, restore it, confirm **green**. Record the evidence in the task report.
- Backend source and tests are **CommonJS** (`require`).
- Never run `sam deploy --guided`. Never run `git stash`.
- A board that fails to load **falls back to consensus rankings**; it must never fail a pick or stall the clock.
- The schedule window is `cron(* 8-23,0-1 * * ? *)` with `ScheduleExpressionTimezone: America/Los_Angeles`. Both halves matter; a schedule without the timezone is a bug.

## File Structure

**Backend**
- `backend/src/lib/autoPick.js` — **new.** The pick rule, with no knowledge of HTTP. Owns `loadPlayersForSport`, `getRosterCounts`, `pickBestForTeam`, `boardIdForTeam`, `autoPickAndAdvance`.
- `backend/src/clock.js` — **new.** The scheduled handler. Queries the index, drains each due draft, isolates failures.
- `backend/src/scripts/backfillClockRunning.js` — **new.** One-off migration, dry run by default.
- `backend/src/lib/advance.js` — *modify.* Sets `clockRunning` in the same conditional write, or removes it when the draft completes.
- `backend/src/drafts.js` — *modify.* Imports the extracted rule, wraps its result in `json()`, sets `clockRunning` at creation, maintains it across pause/resume.
- `backend/template.yaml` — *modify.* The `byClock` GSI, `ClockFunction`, its schedule and policies.
- `backend/src/lib/autoPick.test.js`, `backend/src/clock.test.js`, `backend/src/template.test.js` — tests.

**Frontend** — untouched. The page already calls `/expire` and renders the server's deadline.

---

### Task 1: The pick rule, callable without HTTP

`autoPickAndAdvance` returns an HTTP response today, which a scheduler has no use for. This task moves it and its helpers into a library and gives it a plain return value. **No behaviour changes.** The proof is that every existing test passes untouched.

**Files:**
- Create: `backend/src/lib/autoPick.js`
- Modify: `backend/src/drafts.js`
- Test: `backend/src/drafts.test.js` (must pass **unchanged**)

**Interfaces:**
- Consumes: `lib/advance.js` (`advanceDraft`, `RaceLost`), `lib/boardRank.js` (`consensusRank`, `loadBoardRank`), `lib/roster.js`, `lib/adpBySource.js`.
- Produces:
  - `loadPlayersForSport({ ddb, table, sport, format }) -> { players, byId }`
  - `getRosterCounts(draft, teamNum, playerById) -> object`
  - `pickBestForTeam(draft, teamNum, players, rankOf) -> player | null` (unchanged signature)
  - `boardIdForTeam(draft, teamNum) -> string | null` (unchanged signature)
  - `autoPickAndAdvance({ ddb, d, draftId, playersTable, draftsTable, boardsTable }) -> Result`

  where `Result` is exactly one of:
  ```js
  { ok: true,  picked }                                    // a pick was made
  { ok: false, code: "empty" }                             // no players left
  { ok: false, code: "race", error, currentIndex, version } // somebody picked first
  ```

- [ ] **Step 1: Record the baseline**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Write the exact `pass` count into the task report. It must be identical at the end of this task. A changed count means the move changed behaviour.

- [ ] **Step 2: Create `lib/autoPick.js` by moving code verbatim**

Cut these five functions out of `backend/src/drafts.js` and paste them into a new `backend/src/lib/autoPick.js`, in this order, **unchanged except where Step 3 says otherwise**:

- `loadPlayersForSport` (currently `drafts.js:28`)
- `getRosterCounts` (currently `drafts.js:97`)
- `pickBestForTeam` (currently `drafts.js:108`)
- `boardIdForTeam` (currently `drafts.js:171`)
- `autoPickAndAdvance` (currently `drafts.js:182`)

Move their comments with them. Do not reword or "improve" anything — a diff that shows edits inside these bodies is a failed task.

Give the new file this header and these requires:

```js
// backend/src/lib/autoPick.js
//
// Who gets picked when a pick is made for somebody, and how the draft moves
// on. Lives here rather than in drafts.js because it now has three callers:
// POST /auto-pick, POST /expire, and the scheduled clock -- and the last of
// those has no HTTP response to return, which is what made the old shape
// (taking a `json` responder and returning a response) wrong.
const { DEFAULT_ROSTER, parseRosterSlots, rosterNeed, kDefBlocked } = require("./roster");
const { withAdpBySource } = require("./adpBySource");
const { advanceDraft } = require("./advance");
const { consensusRank, loadBoardRank } = require("./boardRank");
const { QueryCommand } = require("@aws-sdk/lib-dynamodb");
```

Trim that require list to exactly what the moved bodies use — if `DEFAULT_ROSTER` or `parseRosterSlots` turns out to be unused here, remove it, and if a moved body uses something not listed, add it. `npm run lint` in Step 6 is what proves this right.

End the file with:

```js
module.exports = {
  loadPlayersForSport,
  getRosterCounts,
  pickBestForTeam,
  boardIdForTeam,
  autoPickAndAdvance,
};
```

- [ ] **Step 3: Make the two signature changes**

Only two bodies change, and only in these ways.

`loadPlayersForSport` took the module-level `ddb` from `drafts.js`, which does not exist in a library. Change its signature from positional to an object that carries the client:

```js
async function loadPlayersForSport({ ddb, table, sport, format }) {
```

`autoPickAndAdvance` loses the `json` responder, gains `ddb`, and returns results instead of responses. Its signature becomes:

```js
async function autoPickAndAdvance({ ddb, d, draftId, playersTable, draftsTable, boardsTable }) {
```

and its three exit points change to:

```js
  const best = pickBestForTeam(d, teamNum, players, rankOf);
  if (!best) return { ok: false, code: "empty" };
```

```js
  } catch (e) {
    if (e?.name === "RaceLost") {
      return { ok: false, code: "race", error: e.message, currentIndex: e.currentIndex, version: e.version };
    }
    throw e;
  }

  return { ok: true, picked: best };
```

Its internal call to `loadPlayersForSport` and its call to `advanceDraft` both now pass `ddb` explicitly:

```js
  const { players, byId } = await loadPlayersForSport({ ddb, table: playersTable, sport, format });
```
```js
    await advanceDraft({ ddb, table: draftsTable, draftId, draft: d, expectedIndex });
```

- [ ] **Step 4: Wire `drafts.js` back up**

Add the require beside the other lib requires at the top of `drafts.js`:

```js
const {
  loadPlayersForSport,
  getRosterCounts,
  pickBestForTeam,
  boardIdForTeam,
  autoPickAndAdvance,
} = require("./lib/autoPick");
```

`drafts.test.js` imports `pickBestForTeam` and `boardIdForTeam` from `drafts.js`, and the existing tests must not be edited, so the re-exports at the bottom of `drafts.js` stay exactly as they are:

```js
module.exports.pickBestForTeam = pickBestForTeam;
module.exports.boardIdForTeam = boardIdForTeam;
```

Add one wrapper next to them, which is the only new logic in this task:

```js
// The three shapes lib/autoPick can return, in the HTTP terms the two routes
// already answer in. Written once so /auto-pick and /expire cannot drift.
function autoPickResponse(json, r) {
  if (r.ok) return json(200, { ok: true, picked: r.picked });
  if (r.code === "empty") return json(409, { error: "No players left" });
  return json(409, { error: r.error, currentIndex: r.currentIndex, version: r.version });
}
```

Replace both call sites (`drafts.js:575` and `drafts.js:614`) with:

```js
      return autoPickResponse(
        json,
        await autoPickAndAdvance({ ddb, d, draftId, playersTable, draftsTable, boardsTable })
      );
```

Fix the two remaining `loadPlayersForSport` callers (the sim-to-end path near `drafts.js:774`, and any other the grep in Step 5 finds) to the new object signature:

```js
      const { players, byId } = await loadPlayersForSport({ ddb, table: playersTable, sport, format });
```

- [ ] **Step 5: Prove nothing was left behind**

Run: `cd backend && grep -n "loadPlayersForSport(" src/drafts.js src/lib/autoPick.js`
Expected: every call site uses the `({ ddb, table: ... })` form. A bare `loadPlayersForSport(playersTable,` anywhere is a missed caller that will fail at runtime with an undefined table.

Run: `grep -n "function autoPickAndAdvance\|function pickBestForTeam\|function getRosterCounts\|function boardIdForTeam\|function loadPlayersForSport" src/drafts.js`
Expected: **no output.** All five now live in the library.

- [ ] **Step 6: Run the whole backend suite and the linter**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Expected: the exact same `pass` count as Step 1, `fail 0`.

Run: `cd ../frontend && npm run lint`
Expected: clean. (ESLint covers the backend sources from the repo root config.)

- [ ] **Step 7: Commit**

```bash
git add backend/src/lib/autoPick.js backend/src/drafts.js
git commit -m "refactor: the pick rule, callable without HTTP"
```

---

### Task 2: `clockRunning` — the index attribute, written where the deadline is

**Files:**
- Modify: `backend/src/lib/advance.js`
- Modify: `backend/src/drafts.js` (creation, pause, resume)
- Modify: `backend/template.yaml`
- Test: `backend/src/drafts.test.js`, `backend/src/template.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: the invariant every later task depends on — a draft has `clockRunning = "1"` exactly when its clock should be running, and the `byClock` index therefore contains exactly the drafts a scheduler should consider.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/drafts.test.js`:

```js
test("a new draft is in the clock index", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.Item?.draftId) put = cmd.input.Item;
    return {};
  });
  const res = await handler(
    evt("POST", "/drafts", { body: { teams: 12, rounds: 2, userTeam: 1 }, claims: ME })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(put.clockRunning, "1");
});

test("pausing takes a draft out of the clock index", async () => {
  const d = ownedDraft(ME.sub);
  const sent = [];
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    sent.push(cmd.input);
    return { Item: d };
  });
  await handler(
    evt("POST", "/drafts/d1/pause", { draftId: "d1", body: { paused: true }, claims: ME })
  );
  const upd = sent.find((i) => i.UpdateExpression?.includes("pausedAt = :n"));
  assert.match(upd.UpdateExpression, /REMOVE .*clockRunning/);
});

test("resuming puts it back", async () => {
  const d = { ...ownedDraft(ME.sub), pausedAt: Date.now() - 5000, pausedBy: ME.sub };
  const sent = [];
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    sent.push(cmd.input);
    return { Item: d };
  });
  await handler(
    evt("POST", "/drafts/d1/pause", { draftId: "d1", body: { paused: false }, claims: ME })
  );
  const upd = sent.find((i) => i.UpdateExpression?.includes("pickDeadline = :d"));
  assert.match(upd.UpdateExpression, /clockRunning = :run/);
  assert.equal(upd.ExpressionAttributeValues[":run"], "1");
});
```

Create `backend/src/lib/advance.test.js` — it does not exist yet — with this header:

```js
const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { advanceDraft } = require("./advance");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

test.afterEach(() => mock.restoreAll());
```

then these two tests below it:

```js
test("advancing an unfinished draft keeps it in the clock index", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1 };
  await advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0 });
  assert.match(input.UpdateExpression, /clockRunning = :run/);
  assert.equal(input.ExpressionAttributeValues[":run"], "1");
});

test("the write that completes a draft removes it from the clock index", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }], picked: [], currentIndex: 1 };
  await advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0 });
  assert.match(input.UpdateExpression, /REMOVE clockRunning/);
  // An UpdateExpression that never sets :run must not declare it: DynamoDB
  // rejects unused ExpressionAttributeValues with a ValidationException, and
  // that failure would only ever appear on the last pick of a draft.
  assert.equal(input.ExpressionAttributeValues[":run"], undefined);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/lib/advance.test.js src/drafts.test.js 2>&1 | tail -12`
Expected: the five new tests FAIL. Read the failures — they must fail on the missing `clockRunning`, not on a typo in the fixture.

- [ ] **Step 3: Write the attribute in `advance.js`**

In `backend/src/lib/advance.js`, replace the single `UpdateExpression` string with a pair built from whether this write finishes the draft:

```js
  const deadline = now + PICK_MS;
  // The index entry rides inside this same conditional write, for the same
  // reason the deadline does: a separate update would leave a window where
  // the index says a draft is due and the draft says somebody already picked.
  const complete = draft.currentIndex >= draft.picks.length;
  const base =
    "SET picks = :p, picked = :k, currentIndex = :i, pickDeadline = :d, version = if_not_exists(version, :z) + :one";
  const values = {
    ":p": draft.picks, ":k": draft.picked, ":i": draft.currentIndex,
    ":d": deadline,
    ":z": 0, ":one": 1, ":expected": expectedIndex,
  };
  let expression;
  if (complete) {
    // A finished draft leaves the index for good; nothing will ever put it
    // back, which is what makes the index sparse rather than ever-growing.
    expression = `${base} REMOVE clockRunning`;
  } else {
    expression = `${base}, clockRunning = :run`;
    // Declared only on this branch. An unused value is a ValidationException.
    values[":run"] = "1";
  }
```

then pass `expression` as the `UpdateExpression` and `values` as the `ExpressionAttributeValues` in the existing `UpdateCommand`. Leave the `ConditionExpression` byte-for-byte alone.

- [ ] **Step 4: Write it at the other three sites in `drafts.js`**

At draft creation, in the item literal beside `pickDeadline`:

```js
        pickDeadline: Date.now() + PICK_MS,
        // In the clock index from birth: pick 1 is already on the clock.
        clockRunning: "1",
```

In the pause branch's `UpdateCommand`, extend the expression:

```js
              UpdateExpression:
                "SET pausedAt = :n, pausedBy = :me, version = if_not_exists(version, :z) + :one REMOVE clockRunning",
```

In the resume branch's `UpdateCommand`, extend the expression and add the value:

```js
            UpdateExpression:
              "SET pickDeadline = :d, clockRunning = :run, version = if_not_exists(version, :z) + :one REMOVE pausedAt, pausedBy",
            ConditionExpression: "pausedAt = :was",
            ExpressionAttributeValues: { ":d": extended, ":run": "1", ":was": d.pausedAt, ":z": 0, ":one": 1 },
```

- [ ] **Step 5: Add the index to the template**

In `backend/template.yaml`, under `DraftsTable`, add the attribute definitions and the index. Both new `AttributeDefinitions` entries are required — DynamoDB rejects a key schema naming an attribute it has not been given a type for:

```yaml
      AttributeDefinitions:
        - AttributeName: draftId
          AttributeType: S
        - AttributeName: ownerId
          AttributeType: S
        - AttributeName: clockRunning
          AttributeType: S
        - AttributeName: pickDeadline
          AttributeType: N
```

```yaml
        # Sparse on purpose: `clockRunning` exists only while a draft's clock
        # should be running, so a finished or paused draft has no entry here
        # at all. The scheduled clock's whole query is "this index, deadline
        # before now" -- no scan, no filter, no reads of drafts not due.
        # KEYS_ONLY for the reason byOwner excludes `picks`: this index is
        # read every minute, and the scheduler loads the full draft only for
        # the few ids that come back.
        - IndexName: byClock
          KeySchema:
            - AttributeName: clockRunning
              KeyType: HASH
            - AttributeName: pickDeadline
              KeyType: RANGE
          Projection:
            ProjectionType: KEYS_ONLY
```

- [ ] **Step 6: Add the template test**

Append to `backend/src/template.test.js`:

```js
test("the drafts table has a sparse clock index", () => {
  const tpl = loadTemplate();
  const t = tpl.Resources.DraftsTable.Properties;
  const gsi = (t.GlobalSecondaryIndexes || []).find((g) => g.IndexName === "byClock");
  assert.ok(gsi, "byClock index is missing");
  assert.deepEqual(
    gsi.KeySchema.map((k) => [k.AttributeName, k.KeyType]),
    [["clockRunning", "HASH"], ["pickDeadline", "RANGE"]]
  );
  assert.equal(gsi.Projection.ProjectionType, "KEYS_ONLY");
  // A key attribute with no definition is a deploy-time failure, not a
  // runtime one, so it never shows up in any other test.
  const defs = Object.fromEntries(t.AttributeDefinitions.map((a) => [a.AttributeName, a.AttributeType]));
  assert.equal(defs.clockRunning, "S");
  assert.equal(defs.pickDeadline, "N");
});
```

- [ ] **Step 7: Run the tests**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Expected: all pass, count up by six from Task 1's baseline.

- [ ] **Step 8: Mutation-test the completion branch**

In `advance.js`, change `const complete = draft.currentIndex >= draft.picks.length;` to `const complete = false;`. "the write that completes a draft removes it from the clock index" must go **red**. Restore, confirm green.

Then delete `values[":run"] = "1";` (leaving the `SET ... clockRunning = :run` branch). "advancing an unfinished draft keeps it in the clock index" must go **red**. Restore, confirm green.

- [ ] **Step 9: Commit**

```bash
git add backend/src/lib/advance.js backend/src/lib/advance.test.js backend/src/drafts.js backend/src/drafts.test.js backend/template.yaml backend/src/template.test.js
git commit -m "feat: a sparse index of drafts whose clock is running"
```

---

### Task 3: The scheduler

**Files:**
- Create: `backend/src/clock.js`
- Test: `backend/src/clock.test.js`

**Interfaces:**
- Consumes: `lib/autoPick.js`'s `autoPickAndAdvance` (Task 1), the `byClock` index (Task 2).
- Produces: `handler(event, context)` — the Lambda entry point. Returns `{ due, advanced, picks, skipped, deferred }` so tests can assert on a run without reading logs. `context` is read only for `getRemainingTimeInMillis()`, and the handler must work when it is absent.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/clock.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");

process.env.DRAFTS_TABLE = "drafts-test";
process.env.PLAYERS_TABLE = "players-test";
process.env.BOARDS_TABLE = "boards-test";

const autoPick = require("./lib/autoPick");
const { handler } = require("./clock");

test.afterEach(() => mock.restoreAll());

/** A draft that is `n` picks from done, with its deadline `ms` in the past. */
function dueDraft(id, n, ms) {
  return {
    draftId: id,
    picks: Array.from({ length: n }, (_, i) => ({ team: (i % 2) + 1 })),
    picked: [],
    currentIndex: 0,
    pickDeadline: Date.now() - ms,
    seats: [{ team: 1, kind: "human", sub: "user-me" }],
  };
}

test("a long-overdue draft is drained, not advanced once", async () => {
  const d = dueDraft("d1", 3, 600000);
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.IndexName === "byClock") return { Items: [{ draftId: "d1" }] };
    return { Item: d };
  });
  // Each call advances the draft the way the real one does, leaving the new
  // deadline in the past until the draft runs out of picks.
  mock.method(autoPick, "autoPickAndAdvance", async ({ d: draft }) => {
    draft.currentIndex += 1;
    draft.pickDeadline = Date.now() - 1000;
    return { ok: true, picked: { id: "p" } };
  });
  const out = await handler();
  assert.equal(out.picks, 3);
  assert.equal(out.advanced, 1);
});

test("a draft whose deadline is now in the future is left alone", async () => {
  const d = dueDraft("d1", 3, 600000);
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.IndexName === "byClock") return { Items: [{ draftId: "d1" }] };
    return { Item: d };
  });
  mock.method(autoPick, "autoPickAndAdvance", async ({ d: draft }) => {
    draft.currentIndex += 1;
    draft.pickDeadline = Date.now() + 60000;
    return { ok: true, picked: { id: "p" } };
  });
  const out = await handler();
  assert.equal(out.picks, 1);
});

test("losing a race to a human ends that draft's turn, not the run", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.IndexName === "byClock") {
      return { Items: [{ draftId: "d1" }, { draftId: "d2" }] };
    }
    return { Item: dueDraft(cmd.input.Key.draftId, 2, 600000) };
  });
  let calls = 0;
  mock.method(autoPick, "autoPickAndAdvance", async ({ draftId, d: draft }) => {
    calls += 1;
    if (draftId === "d1") return { ok: false, code: "race", error: "Somebody just picked" };
    draft.currentIndex += 1;
    draft.pickDeadline = Date.now() + 60000;
    return { ok: true, picked: { id: "p" } };
  });
  const out = await handler();
  assert.equal(calls, 2, "d2 must still be attempted after d1 loses its race");
  assert.equal(out.picks, 1);
  assert.equal(out.skipped, 1);
});

test("a draft that throws does not abort the run", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.IndexName === "byClock") {
      return { Items: [{ draftId: "boom" }, { draftId: "d2" }] };
    }
    if (cmd.input.Key.draftId === "boom") throw new Error("table on fire");
    return { Item: dueDraft("d2", 1, 600000) };
  });
  mock.method(autoPick, "autoPickAndAdvance", async ({ d: draft }) => {
    draft.currentIndex += 1;
    draft.pickDeadline = Date.now() + 60000;
    return { ok: true, picked: { id: "p" } };
  });
  const out = await handler();
  assert.equal(out.picks, 1);
  assert.equal(out.skipped, 1);
});

test("the wall-clock budget stops new drafts being started", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd.input.IndexName === "byClock") {
      return { Items: [{ draftId: "d1" }, { draftId: "d2" }] };
    }
    return { Item: dueDraft(cmd.input.Key.draftId, 1, 600000) };
  });
  mock.method(autoPick, "autoPickAndAdvance", async ({ d: draft }) => {
    draft.currentIndex += 1;
    draft.pickDeadline = Date.now() + 60000;
    return { ok: true, picked: { id: "p" } };
  });
  // A deadline already spent: the first draft runs, the second is deferred.
  const out = await handler({}, { getRemainingTimeInMillis: () => 1000 });
  assert.equal(out.advanced, 1);
  assert.equal(out.deferred, 1);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/clock.test.js 2>&1 | tail -12`
Expected: FAIL — `Cannot find module './clock'`.

- [ ] **Step 3: Write `src/clock.js`**

```js
// backend/src/clock.js
//
// The caller Phase 2 shaped POST /expire for. A browser asks the server to
// check its clock; this asks the same question on a schedule, so a draft with
// nobody watching still moves.
//
// It does NOT call the HTTP route. There is no signed request and no service
// credential -- it runs the same rule in-process, from lib/autoPick, so the
// two callers cannot drift.
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const autoPick = require("./lib/autoPick");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// At most this many drafts per run. Anything not reached is still in the
// index and comes back a minute later, so deferring costs nothing.
const DRAFTS_PER_RUN = 25;
// Stop starting new drafts with less than this left of the Lambda's budget.
const RESERVE_MS = 10000;

async function handler(_event, context) {
  const draftsTable = process.env.DRAFTS_TABLE;
  const playersTable = process.env.PLAYERS_TABLE;
  const boardsTable = process.env.BOARDS_TABLE;
  const now = Date.now();

  const q = await ddb.send(
    new QueryCommand({
      TableName: draftsTable,
      IndexName: "byClock",
      KeyConditionExpression: "clockRunning = :run AND pickDeadline < :now",
      ExpressionAttributeValues: { ":run": "1", ":now": now },
      Limit: DRAFTS_PER_RUN,
    })
  );
  const due = (q.Items || []).map((i) => i.draftId);

  // Absent in tests and in a local run; a real invocation always has it.
  const remaining = () =>
    typeof context?.getRemainingTimeInMillis === "function"
      ? context.getRemainingTimeInMillis()
      : Number.POSITIVE_INFINITY;

  const out = { due: due.length, advanced: 0, picks: 0, skipped: 0, deferred: 0 };

  for (const draftId of due) {
    if (remaining() < RESERVE_MS) {
      // Not an error: the next tick picks these up, and a half-finished
      // drain is exactly as valid a state as any other.
      out.deferred += 1;
      continue;
    }
    try {
      const picks = await drainDraft({ draftId, draftsTable, playersTable, boardsTable });
      if (picks > 0) out.advanced += 1;
      out.picks += picks;
      if (picks === 0) out.skipped += 1;
    } catch (e) {
      // One draft's failure costs that draft its tick, never the other
      // twenty-four theirs.
      out.skipped += 1;
      console.error(`clock: draft ${draftId} failed:`, e?.message || e);
    }
  }

  console.log(JSON.stringify({ msg: "clock run", ...out }));
  return out;
}

/**
 * Pick for one draft until its deadline is in the future or it is finished.
 *
 * The drain is what separates this from POST /expire, which deliberately
 * takes exactly one pick however late it is. A browser catching up would
 * burst on a draft somebody is watching; the drafts reached here are by
 * definition ones nobody is watching, and the alternative is a zombie draft
 * needing one scheduler run per remaining pick.
 */
async function drainDraft({ draftId, draftsTable, playersTable, boardsTable }) {
  let picks = 0;
  for (;;) {
    const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
    const d = res.Item;
    if (!d) return picks;
    if (d.currentIndex >= d.picks.length) return picks;
    if (d.pausedAt) return picks;
    // Strictly greater, the same rule /expire applies: a deadline exactly
    // reached has not passed yet.
    if (!(d.pickDeadline != null && Date.now() > d.pickDeadline)) return picks;

    const r = await autoPick.autoPickAndAdvance({
      ddb, d, draftId, playersTable, draftsTable, boardsTable,
    });
    // A person picked while we were working. They are right and we are
    // stale; stop touching this draft and let the next run re-read it.
    if (!r.ok) return picks;
    picks += 1;
  }
}

module.exports = { handler };
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && node --test src/clock.test.js 2>&1 | tail -10`
Expected: all five PASS.

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Expected: `fail 0`.

- [ ] **Step 5: Mutation-test the three guards that matter**

1. Delete the `if (remaining() < RESERVE_MS)` block. "the wall-clock budget stops new drafts being started" must go **red**.
2. Replace `if (!r.ok) return picks;` with `picks += 1;` only — i.e. remove the early return. "losing a race to a human ends that draft's turn, not the run" must go **red** (it will loop or over-count).
3. Delete the `try`/`catch` around `drainDraft` and let the error propagate. "a draft that throws does not abort the run" must go **red**.

Restore each immediately and confirm green before moving to the next.

- [ ] **Step 6: Commit**

```bash
git add backend/src/clock.js backend/src/clock.test.js
git commit -m "feat: the clock runs when nobody is watching"
```

---

### Task 4: Declaring the function and its schedule

A handler with no resource in the template is dead code that every unit test passes. This task is what actually makes it run.

**Files:**
- Modify: `backend/template.yaml`
- Test: `backend/src/template.test.js`

**Interfaces:**
- Consumes: `src/clock.js`'s `handler` (Task 3).
- Produces: nothing in code. This is the deploy-time gate.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/template.test.js`:

```js
test("the clock runs on a schedule, in a real timezone", () => {
  const tpl = loadTemplate();
  const fn = tpl.Resources.ClockFunction;
  assert.ok(fn, "ClockFunction is missing");
  assert.equal(fn.Properties.Handler, "clock.handler");

  const events = Object.values(fn.Properties.Events || {});
  const sched = events.find((e) => e.Type === "ScheduleV2");
  // Type Schedule (EventBridge rules) cannot express a timezone, so a UTC
  // rule would drift by an hour twice a year. ScheduleV2 is not a style
  // preference here.
  assert.ok(sched, "the clock needs a ScheduleV2 event, not Schedule");
  assert.equal(sched.Properties.ScheduleExpression, "cron(* 8-23,0-1 * * ? *)");
  assert.equal(sched.Properties.ScheduleExpressionTimezone, "America/Los_Angeles");
});

test("the clock can read what it needs and write only drafts", () => {
  const tpl = loadTemplate();
  const policies = tpl.Resources.ClockFunction.Properties.Policies || [];
  const named = policies.map((p) => Object.keys(p)[0]);
  assert.ok(named.includes("DynamoDBCrudPolicy"), "needs write access to drafts");
  assert.ok(named.includes("DynamoDBReadPolicy"), "needs read access to players and boards");
  const env = tpl.Resources.ClockFunction.Properties.Environment.Variables;
  for (const k of ["DRAFTS_TABLE", "PLAYERS_TABLE", "BOARDS_TABLE"]) {
    assert.ok(env[k], `${k} is not passed to the clock`);
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/template.test.js 2>&1 | tail -10`
Expected: FAIL — `ClockFunction is missing`.

- [ ] **Step 3: Declare the function**

Add to `backend/template.yaml`, after `SyncPlayersFunction` (the other scheduled function, so the two live together):

```yaml
  # The clock, when nobody is watching. POST /expire is the same rule asked
  # for by a browser; this asks for it on a timer.
  ClockFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: clock.handler
      # Longer than the 10s default because one run may drain several
      # abandoned drafts, and shorter than the one-minute schedule so a slow
      # run cannot pile up indefinitely. Overlapping runs are safe anyway --
      # advanceDraft's conditional write makes the loser lose cleanly.
      Timeout: 60
      MemorySize: 512
      Environment:
        Variables:
          DRAFTS_TABLE: !Ref DraftsTable
          PLAYERS_TABLE: !Ref PlayersTable
          BOARDS_TABLE: !Ref BoardsTable
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref DraftsTable
        - DynamoDBReadPolicy:
            TableName: !Ref PlayersTable
        - DynamoDBReadPolicy:
            TableName: !Ref BoardsTable
      Events:
        Tick:
          # ScheduleV2 (EventBridge Scheduler), not Schedule: only Scheduler
          # takes a timezone, and this window is expressed in Pacific time.
          # Every minute from 08:00 to 01:59.
          Type: ScheduleV2
          Properties:
            ScheduleExpression: cron(* 8-23,0-1 * * ? *)
            ScheduleExpressionTimezone: America/Los_Angeles
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Expected: all pass, `fail 0`.

- [ ] **Step 5: Verify the template actually parses as CloudFormation**

Run: `cd backend && sam validate --lint`
Expected: no errors. `template.test.js` reads the YAML as data and would not catch an invalid `ScheduleV2` property name.

- [ ] **Step 6: Commit**

```bash
git add backend/template.yaml backend/src/template.test.js
git commit -m "feat: schedule the clock, 08:00-02:00 Pacific"
```

---

### Task 5: The backfill

Every draft already in the table predates `clockRunning`, so a sparse index leaves all of them invisible to the scheduler permanently. Without this task the feature deploys clean, tests green, and does nothing for a single existing draft.

**Files:**
- Create: `backend/src/scripts/backfillClockRunning.js`
- Test: manual dry run against production (this is a one-off script, like `purge-unowned.js`)

**Interfaces:**
- Consumes: the `clockRunning` invariant from Task 2.
- Produces: nothing in code.

- [ ] **Step 1: Write the script**

```js
// backend/src/scripts/backfillClockRunning.js
//
// One-off: put every existing draft into the clock index. Drafts written
// before Phase 3 have no `clockRunning` attribute, and the index is sparse,
// so without this the scheduled clock would never see any of them -- while
// looking, from every log and every test, as though it worked.
//
// Refuses to write anything without --confirm, so a curious run is a dry run.
//
// Lives under src/ for the same reason purge-unowned.js does: the AWS SDK is
// vendored at backend/src/node_modules.
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const TABLE = "perfectpick-drafts";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

/**
 * A draft belongs in the clock index when its clock should be running: it
 * has picks left and nobody has paused it. Finished and paused drafts are
 * deliberately left out -- the same rule advance.js and /pause apply.
 */
function shouldRun(d) {
  if (!Array.isArray(d?.picks)) return false;
  if ((d.currentIndex ?? 0) >= d.picks.length) return false;
  if (d.pausedAt) return false;
  return true;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  let cursor;
  let scanned = 0, already = 0, skipped = 0, toWrite = [];

  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey: cursor })
    );
    for (const d of page.Items || []) {
      scanned += 1;
      if (d.clockRunning === "1") { already += 1; continue; }
      if (!shouldRun(d)) { skipped += 1; continue; }
      toWrite.push(d.draftId);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  console.log(`scanned ${scanned}, already indexed ${already}, not running ${skipped}, to write ${toWrite.length}`);
  if (!confirm) {
    console.log("dry run. re-run with --confirm to write.");
    return;
  }

  let written = 0;
  for (const draftId of toWrite) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { draftId },
        UpdateExpression: "SET clockRunning = :run",
        // Never resurrect a draft that finished or paused between the scan
        // above and this write.
        ConditionExpression: "attribute_exists(draftId)",
        ExpressionAttributeValues: { ":run": "1" },
      })
    );
    written += 1;
  }
  console.log(`wrote ${written}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Check it parses and the predicate is right**

Run: `cd backend/src && node --check scripts/backfillClockRunning.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add backend/src/scripts/backfillClockRunning.js
git commit -m "feat: backfill the clock index for drafts that predate it"
```

---

### Task 6: Deploy, backfill, and prove the clock ran

**Files:** none. This is the whole-feature gate.

- [ ] **Step 1: Run everything, and read the totals**

```bash
cd backend && node --test 'src/**/*.test.js'
cd ../frontend && npm run test:unit && npm run lint && npm test
```

Expected: all green. **A Playwright run that prints a partial count with exit 0 is not a pass** — this machine has produced "132 of 213 passed" with a zero exit. Read the printed totals. The frontend is untouched by this work, so its counts must be exactly what they were before it started.

- [ ] **Step 2: Deploy the backend**

The README's command is correct as of `8e469c6` and passes all four parameters. Adding a GSI to a live table is an asynchronous update that can take several minutes; the table stays available throughout.

```bash
cd backend && sam build && sam deploy --no-confirm-changeset --parameter-overrides \
  GoogleClientId=$(aws cloudformation describe-stacks --stack-name sports-mock-draft --region us-east-1 \
    --query "Stacks[0].Parameters[?ParameterKey=='GoogleClientId'].ParameterValue" --output text) \
  GoogleClientSecret=$(aws ssm get-parameter --name /perfectpick/google-client-secret --with-decryption \
    --query Parameter.Value --output text --region us-east-1) \
  YahooClientId=$(aws cloudformation describe-stacks --stack-name sports-mock-draft --region us-east-1 \
    --query "Stacks[0].Parameters[?ParameterKey=='YahooClientId'].ParameterValue" --output text) \
  YahooClientSecret=$(aws ssm get-parameter --name /perfectpick/yahoo-client-secret --with-decryption \
    --query Parameter.Value --output text --region us-east-1)
```

Do not assign any of these to a shell variable named `GID` — zsh treats `GID` as a special integer parameter and will evaluate the client id as arithmetic.

- [ ] **Step 2b: Wait for the index to finish building**

```bash
aws dynamodb describe-table --table-name perfectpick-drafts --region us-east-1 \
  --query "Table.GlobalSecondaryIndexes[?IndexName=='byClock'].IndexStatus" --output text
```
Expected: `ACTIVE`. While it says `CREATING`, the scheduler's query will fail — wait rather than debugging it.

- [ ] **Step 3: Backfill**

```bash
cd backend/src
node scripts/backfillClockRunning.js            # read the counts
node scripts/backfillClockRunning.js --confirm
```

Read the dry-run line before confirming. `to write` should be roughly the number of unfinished drafts in the table; if it is zero and you know unfinished drafts exist, the predicate is wrong — stop.

- [ ] **Step 4: Prove the schedule exists and fires**

```bash
aws scheduler list-schedules --region us-east-1 --query "Schedules[?contains(Name,'Clock')].[Name,State]" --output text
```
Expected: one schedule, `ENABLED`.

Then, inside the window, wait two minutes and read the log:

```bash
aws logs tail /aws/lambda/sports-mock-draft-ClockFunction --since 5m --region us-east-1 --format short | grep "clock run"
```
Expected: at least one `{"msg":"clock run",...}` line. `due` may legitimately be `0` — that only means nothing was overdue, and it still proves the schedule fires and the query works.

**If nothing appears at all**, check the clock: outside 08:00–02:00 Pacific the schedule is not supposed to fire, and an empty log is then correct behaviour rather than a bug.

- [ ] **Step 5: Prove it actually drafts**

Create a draft in the live app, note its id, close every tab, and wait. Within about a minute of its deadline passing, read it back:

```bash
aws dynamodb get-item --table-name perfectpick-drafts --region us-east-1 \
  --key '{"draftId":{"S":"YOUR_DRAFT_ID"}}' \
  --query "Item.currentIndex.N" --output text
```
Expected: a number greater than 0, with no browser open. That is the whole feature, in one number.

- [ ] **Step 6: Commit and finish the branch**

```bash
git add -A
git commit -m "test: the unattended clock, end to end"
```

Then use the `superpowers:finishing-a-development-branch` skill.
