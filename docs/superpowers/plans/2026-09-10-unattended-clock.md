# Unattended Clock (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the draft clock true when nobody is watching, by giving the server a scheduled caller for the deadline it already owns.

**Architecture:** A sparse global secondary index holds only drafts whose clock should be running, keyed by `pickDeadline`, so one Query per minute returns exactly the drafts that are due. An EventBridge schedule drives a new Lambda that drains each due draft in-process, calling the same pick rule the HTTP route calls — extracted from `drafts.js` so both callers share one implementation. The index attribute is written inside the conditional writes that already exist, so it can never disagree with the draft.

**Tech Stack:** AWS SAM (Lambda + DynamoDB + EventBridge Scheduler), Node 24 CommonJS backend tested with `node --test`. No frontend change.

**Spec:** `docs/superpowers/specs/2026-09-10-unattended-clock-design.md`

## Global Constraints

- **The scheduler drains; `POST /expire` does not.** `/expire` keeps its existing rule exactly — one expired deadline, exactly one auto-pick. Do not change its behaviour in any task.
- **`clockRunning` is written only inside writes that already happen.** No task may add a separate update to *maintain* it at runtime. If a site seems to need one, the design is wrong; stop rather than adding it. There are exactly two exemptions, both deliberate and neither maintenance:
  - The one-off backfill in Task 5, a migration for rows written before the attribute existed.
  - **The scheduler's self-heal.** When a drain makes no picks because the draft is *structurally* unable to advance — completed, or paused — the clock conditionally removes `clockRunning` so the draft leaves the index. This is correctness, not maintenance: the index is read ascending by `pickDeadline` with a limit, so a draft that can never advance is returned **first, on every run, forever**, and twenty-five of them stop the clock for everybody. The write is conditioned on the state that justified it (`currentIndex >= size(picks)`, or `attribute_exists(pausedAt)`), so a draft that changed under the read is left indexed. Transient reasons — a lost race, a deadline still in the future — must **not** evict, and neither must an exhausted player pool (`code: "empty"`), which is recoverable: evicting there would mean the draft is never enforced again once the pool is fixed.
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
  const deadline = (deadlineBase ?? now) + PICK_MS;
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

then pass `expression` as the `UpdateExpression` and `values` as the `ExpressionAttributeValues` in the existing `UpdateCommand`.

The `ConditionExpression` carries two guards, not one:

```js
        ConditionExpression: "currentIndex = :expected AND attribute_not_exists(pausedAt)",
```

`currentIndex = :expected` is the concurrency guard and must never be weakened. `attribute_not_exists(pausedAt)` is the pause guard, and it is here for this index specifically: pausing does not move `currentIndex`, so without it a pick racing a pause **succeeds** — and, because this same write sets `clockRunning`, puts the paused draft straight back into the index `/pause` just removed it from. On a condition failure the existing re-read tells the two causes apart, so a caller never reports "Somebody just picked" when nobody did:

```js
    const at = now2.Item?.currentIndex ?? null;
    const version = now2.Item?.version ?? null;
    // The re-read tells the two failures apart. A moved currentIndex is a
    // lost race whatever else is true -- somebody's pick is already stored,
    // and that is the more useful thing to say. Only when the index is still
    // where we left it is a present `pausedAt` the reason we failed.
    if (at === expectedIndex && now2.Item?.pausedAt) throw new DraftPaused(at, version);
    throw new RaceLost(at, version);
```

`DraftPaused` is a sibling of `RaceLost` carrying `currentIndex` and `version` and the message `"Draft is paused"`. `lib/autoPick.js` maps it to `{ ok: false, code: "paused" }`, and every route that calls `advanceDraft` answers both errors with a 409 carrying the error's own message.

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
- Produces: `handler(event, context)` — the Lambda entry point. Returns `{ due, advanced, picks, raced, ineligible, evicted, emptyPool, failed, deferred }` so tests can assert on a run without reading logs, and so the one log line per run can answer "is a draft poisoned?" rather than folding every non-pick into one `skipped`. `context` is read only for `getRemainingTimeInMillis()`, and the handler must work when it is absent.

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

const { PICK_MS } = require("./lib/advance");
const { handler } = require("./clock");

test.afterEach(() => mock.restoreAll());

// These tests drive the REAL autoPickAndAdvance and the REAL advanceDraft
// against a fake DynamoDB, and that is the whole point of the file.
//
// The previous version mocked `autoPick.autoPickAndAdvance` and had the mock
// set `pickDeadline = Date.now() - 1000` after every pick. No real code path
// has ever produced that value: advanceDraft writes a deadline in the FUTURE.
// So the drain looked drained while, against the real write, it made exactly
// one pick and stopped -- the bug the drain exists to prevent, hidden by a
// test that mocked the very write whose value the loop reads. A test may not
// mock the thing it is asserting about.

/** Nine players, ranked 1..9, enough for any draft these tests run. */
const POOL = [
  { sport: "nfl", playerId: "p1", id: "p1", name: "One", position: "RB", team: "AAA", rank: { standard: 1 } },
  { sport: "nfl", playerId: "p2", id: "p2", name: "Two", position: "WR", team: "BBB", rank: { standard: 2 } },
  { sport: "nfl", playerId: "p3", id: "p3", name: "Three", position: "RB", team: "CCC", rank: { standard: 3 } },
  { sport: "nfl", playerId: "p4", id: "p4", name: "Four", position: "WR", team: "DDD", rank: { standard: 4 } },
  { sport: "nfl", playerId: "p5", id: "p5", name: "Five", position: "QB", team: "EEE", rank: { standard: 5 } },
  { sport: "nfl", playerId: "p6", id: "p6", name: "Six", position: "TE", team: "FFF", rank: { standard: 6 } },
  { sport: "nfl", playerId: "p7", id: "p7", name: "Seven", position: "RB", team: "GGG", rank: { standard: 7 } },
  { sport: "nfl", playerId: "p8", id: "p8", name: "Eight", position: "WR", team: "HHH", rank: { standard: 8 } },
  { sport: "nfl", playerId: "p9", id: "p9", name: "Nine", position: "QB", team: "III", rank: { standard: 9 } },
];

/** A draft `n` picks from done whose deadline passed `ms` ago. */
function dueDraft(id, n, ms) {
  return {
    draftId: id,
    sport: "nfl",
    format: "standard",
    picks: Array.from({ length: n }, (_, i) => ({ overall: i + 1, round: 1, team: (i % 2) + 1 })),
    picked: [],
    currentIndex: 0,
    pickDeadline: Date.now() - ms,
    clockRunning: "1",
    version: 1,
    seats: [{ team: 1, kind: "human", sub: "user-me" }],
  };
}

function conditionalCheckFailed() {
  const e = new Error("The conditional request failed");
  e.name = "ConditionalCheckFailedException";
  return e;
}

/**
 * A fake DynamoDB that is honest about the two things these tests depend on:
 * it stores what an UpdateCommand writes, and it enforces the
 * ConditionExpressions the code relies on. Gets return a deep copy, because
 * the real thing does and because handing out the stored object would let a
 * caller's in-memory mutation satisfy the very condition it is being tested
 * against.
 */
function installDdb({ store, due = [], players = POOL, onUpdate } = {}) {
  const seen = { queries: [], updates: [], gets: 0 };
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    // Yield to the event loop once per command. Without this, a mutated-away
    // loop guard makes the drain spin on an unbroken chain of already-
    // resolved promises -- pure microtasks, no macrotask boundary -- which
    // starves node:test's timer-based per-test timeout and lets the loop run
    // until the process dies of OOM instead of failing at the test's
    // timeout. Do not remove this thinking it's dead code.
    await new Promise((r) => setImmediate(r));

    const input = cmd.input;
    const kind = cmd.constructor.name;

    if (kind === "QueryCommand" && input.IndexName === "byClock") {
      seen.queries.push(input);
      return { Items: due.map((draftId) => ({ draftId })) };
    }
    if (kind === "QueryCommand" && input.TableName === "players-test") {
      return { Items: players };
    }
    if (kind === "GetCommand" && input.TableName === "boards-test") return {};
    if (kind === "GetCommand") {
      seen.gets += 1;
      const item = store[input.Key.draftId];
      if (item instanceof Error) throw item;
      return item ? { Item: structuredClone(item) } : {};
    }
    if (kind === "UpdateCommand") {
      seen.updates.push(input);
      if (onUpdate) onUpdate(store, input);
      const item = store[input.Key.draftId];
      const v = input.ExpressionAttributeValues || {};
      const cond = input.ConditionExpression || "";
      if (!item) throw conditionalCheckFailed();
      if (cond.includes("currentIndex = :expected")) {
        if (item.currentIndex !== v[":expected"]) throw conditionalCheckFailed();
      }
      if (cond.includes("attribute_not_exists(pausedAt)") && item.pausedAt) {
        throw conditionalCheckFailed();
      }
      if (cond === "currentIndex >= size(picks)" && !(item.currentIndex >= item.picks.length)) {
        throw conditionalCheckFailed();
      }
      if (cond === "attribute_exists(pausedAt)" && !item.pausedAt) {
        throw conditionalCheckFailed();
      }
      if (":p" in v) item.picks = v[":p"];
      if (":k" in v) item.picked = v[":k"];
      if (":i" in v) item.currentIndex = v[":i"];
      if (":d" in v) item.pickDeadline = v[":d"];
      if (/REMOVE clockRunning/.test(input.UpdateExpression)) delete item.clockRunning;
      if (":run" in v) item.clockRunning = v[":run"];
      return {};
    }
    return {};
  });
  return seen;
}

/** Every deadline the run wrote, in order. */
function deadlinesWritten(seen) {
  return seen.updates
    .filter((u) => u.ExpressionAttributeValues && ":d" in u.ExpressionAttributeValues)
    .map((u) => u.ExpressionAttributeValues[":d"]);
}

test("the run asks the index for exactly the drafts that are due", async () => {
  const store = {};
  const seen = installDdb({ store, due: [] });
  const before = Date.now();
  await handler();
  assert.equal(seen.queries.length, 1);
  const q = seen.queries[0];
  assert.equal(q.IndexName, "byClock");
  // `<` and not `<=` or `>`: an ascending range read of overdue drafts. A `>`
  // here would return every draft that is NOT due and pick for none of them,
  // and no other test in this file would notice.
  assert.equal(q.KeyConditionExpression, "clockRunning = :run AND pickDeadline < :now");
  assert.equal(q.ExpressionAttributeValues[":run"], "1");
  assert.ok(q.ExpressionAttributeValues[":now"] >= before);
  // Without a Limit one run could pull the whole index into a 60s Lambda.
  assert.equal(q.Limit, 25);
});

test("a long-overdue draft is drained, not advanced once", async () => {
  const store = { d1: dueDraft("d1", 3, 600000) };
  installDdb({ store, due: ["d1"] });
  const out = await handler();
  assert.equal(out.picks, 3);
  assert.equal(out.advanced, 1);
  assert.equal(store.d1.currentIndex, 3);
  // The write that completed the draft took it out of the index for good.
  assert.equal(store.d1.clockRunning, undefined);
});

test("catch-up consumes the missed slots: one pick per elapsed minute", async () => {
  // 2.5 minutes overdue, so three picks: the first two land on deadlines
  // still in the past, the third lands 30s in the future and the drain stops.
  const overdueBy = 150000;
  const store = { d1: dueDraft("d1", 8, overdueBy) };
  const t0 = store.d1.pickDeadline;
  const seen = installDdb({ store, due: ["d1"] });

  const out = await handler();

  assert.equal(out.picks, 3);
  // The exact regression proof. Under the old behaviour every pick wrote
  // `Date.now() + PICK_MS` -- always in the future -- so the loop made ONE
  // pick and exited, and these three walking values could not occur.
  assert.deepEqual(deadlinesWritten(seen), [t0 + PICK_MS, t0 + 2 * PICK_MS, t0 + 3 * PICK_MS]);
  assert.ok(store.d1.pickDeadline > Date.now(), "the drain stops at the present, not before it");
  assert.equal(store.d1.currentIndex, 3);
  // Not finished, so it stays in the index for the rest of its picks.
  assert.equal(store.d1.clockRunning, "1");
});

test("the pool is loaded once per drain, not once per pick", async () => {
  const store = { d1: dueDraft("d1", 4, 600000) };
  let poolReads = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    const input = cmd.input;
    const kind = cmd.constructor.name;
    if (kind === "QueryCommand" && input.IndexName === "byClock") {
      return { Items: [{ draftId: "d1" }] };
    }
    if (kind === "QueryCommand" && input.TableName === "players-test") {
      poolReads += 1;
      return { Items: POOL };
    }
    if (kind === "GetCommand") return { Item: structuredClone(store.d1) };
    if (kind === "UpdateCommand") {
      const v = cmd.input.ExpressionAttributeValues || {};
      store.d1.currentIndex = v[":i"];
      store.d1.picked = v[":k"];
      store.d1.picks = v[":p"];
      store.d1.pickDeadline = v[":d"];
      return {};
    }
    return {};
  });
  const out = await handler();
  assert.equal(out.picks, 4);
  assert.equal(poolReads, 1, "~3,900 rows re-read and re-sorted per pick is most of the run");
});

test("a draft whose deadline is now in the future is left alone, and stays indexed", async () => {
  const store = { d1: dueDraft("d1", 3, -30000) };
  const seen = installDdb({ store, due: ["d1"] });
  const out = await handler();
  assert.equal(out.picks, 0);
  assert.equal(out.ineligible, 1);
  assert.equal(out.evicted, 0);
  // A deadline in the future is normal, not structural: evicting here would
  // take a live draft out of the clock permanently.
  assert.equal(seen.updates.length, 0);
  assert.equal(store.d1.clockRunning, "1");
});

test("a completed draft still in the index is evicted from it", async () => {
  const done = dueDraft("d1", 2, 600000);
  done.currentIndex = 2;
  const store = { d1: done };
  const seen = installDdb({ store, due: ["d1"] });
  const out = await handler();
  assert.equal(out.picks, 0);
  assert.equal(out.evicted, 1);
  assert.equal(store.d1.clockRunning, undefined);
  const upd = seen.updates[0];
  assert.match(upd.UpdateExpression, /REMOVE clockRunning/);
  // Conditional, so a draft that changed under us is not un-indexed by a
  // stale read.
  assert.equal(upd.ConditionExpression, "currentIndex >= size(picks)");
});

test("a paused draft still in the index is evicted from it", async () => {
  const paused = dueDraft("d1", 2, 600000);
  paused.pausedAt = Date.now() - 1000;
  const store = { d1: paused };
  const seen = installDdb({ store, due: ["d1"] });
  const out = await handler();
  assert.equal(out.evicted, 1);
  assert.equal(store.d1.clockRunning, undefined);
  assert.equal(seen.updates[0].ConditionExpression, "attribute_exists(pausedAt)");
});

test("an eviction whose condition fails leaves the draft indexed", async () => {
  const done = dueDraft("d1", 2, 600000);
  done.currentIndex = 2;
  const store = { d1: done };
  const seen = installDdb({
    store,
    due: ["d1"],
    // Somebody added a round between the read and the eviction: the draft is
    // no longer complete, and un-indexing it would strand its clock.
    onUpdate: (s) => { s.d1.picks = [...s.d1.picks, { overall: 3, round: 2, team: 1 }]; },
  });
  const out = await handler();
  assert.equal(out.evicted, 0);
  assert.equal(out.ineligible, 1);
  assert.equal(store.d1.clockRunning, "1");
  assert.equal(seen.updates.length, 1);
});

test("an exhausted player pool is counted, never evicted", async () => {
  const store = { d1: dueDraft("d1", 2, 600000) };
  const seen = installDdb({ store, due: ["d1"], players: [] });
  const out = await handler();
  assert.equal(out.picks, 0);
  assert.equal(out.emptyPool, 1);
  assert.equal(out.evicted, 0);
  // Recoverable: evict and this draft is never enforced again once the
  // players table is fixed.
  assert.equal(seen.updates.length, 0);
  assert.equal(store.d1.clockRunning, "1");
});

test("losing a race to a human ends that draft's turn, not the run", { timeout: 5000 }, async () => {
  const store = { d1: dueDraft("d1", 4, 600000), d2: dueDraft("d2", 1, 600000) };
  const seen = installDdb({
    store,
    due: ["d1", "d2"],
    // A person's pick lands between our read and our write, exactly once.
    onUpdate: (s, input) => {
      if (input.Key.draftId === "d1" && s.d1.currentIndex === 0) s.d1.currentIndex = 1;
    },
  });
  const out = await handler();
  assert.equal(out.raced, 1);
  assert.equal(out.evicted, 0, "a lost race is transient; the draft must stay indexed");
  // d2 was still attempted, and finished.
  assert.equal(out.picks, 1);
  assert.equal(out.advanced, 1);
  assert.equal(store.d2.currentIndex, 1);
  assert.ok(seen.updates.some((u) => u.Key.draftId === "d2"));
});

test("a pick that races a pause is reported as paused, not as a lost race", async () => {
  const store = { d1: dueDraft("d1", 4, 600000) };
  const seen = installDdb({
    store,
    due: ["d1"],
    onUpdate: (s) => { if (!s.d1.pausedAt) s.d1.pausedAt = Date.now(); },
  });
  const out = await handler();
  assert.equal(out.picks, 0);
  assert.equal(out.raced, 0);
  // Paused is structural, so the draft leaves the index -- the second update
  // is the eviction.
  assert.equal(out.evicted, 1);
  assert.equal(store.d1.currentIndex, 0, "no pick may land on a paused draft");
  assert.equal(store.d1.clockRunning, undefined);
  assert.equal(seen.updates.length, 2);
});

test("a draft that throws does not abort the run", async () => {
  const store = { boom: new Error("table on fire"), d2: dueDraft("d2", 1, 600000) };
  installDdb({ store, due: ["boom", "d2"] });
  const out = await handler();
  assert.equal(out.failed, 1);
  assert.equal(out.picks, 1);
  assert.equal(out.advanced, 1);
});

test("picks already made are still counted when the drain then throws", async () => {
  const store = { d1: dueDraft("d1", 4, 600000) };
  let updates = 0;
  installDdb({
    store,
    due: ["d1"],
    onUpdate: () => {
      updates += 1;
      if (updates === 3) throw new Error("table on fire");
    },
  });
  const out = await handler();
  assert.equal(out.failed, 1);
  assert.equal(out.picks, 2, "two picks were made and stored before the failure");
  assert.equal(out.advanced, 1);
});

test("a draft item with no picks list is skipped, not a TypeError", async () => {
  const store = { d1: { draftId: "d1", currentIndex: 0, pickDeadline: Date.now() - 1000 } };
  const seen = installDdb({ store, due: ["d1"] });
  const out = await handler();
  assert.equal(out.failed, 0, "d.picks.length on such an item throws, and is then retried forever");
  assert.equal(out.ineligible, 1);
  assert.equal(seen.updates.length, 0);
});

test("the wall-clock budget stops new drafts being started", async () => {
  const store = { d1: dueDraft("d1", 1, 600000), d2: dueDraft("d2", 1, 600000) };
  installDdb({ store, due: ["d1", "d2"] });
  let started = false;
  const context = {
    getRemainingTimeInMillis: () => {
      if (!started) { started = true; return 60000; }
      return store.d1.currentIndex > 0 ? 1000 : 60000;
    },
  };
  const out = await handler({}, context);
  assert.equal(out.advanced, 1);
  assert.equal(out.deferred, 1);
  assert.equal(store.d2.currentIndex, 0);
});

test("the drain budget stops mid-draft, not just between drafts", { timeout: 5000 }, async () => {
  // Long overdue with picks to spare: a drain with no budget check keeps
  // going until the draft is finished.
  const store = { d1: dueDraft("d1", 5, 600000) };
  installDdb({ store, due: ["d1"] });
  const context = { getRemainingTimeInMillis: () => (store.d1.currentIndex === 0 ? 60000 : 1000) };
  const out = await handler({}, context);
  assert.equal(out.picks, 1);
  assert.equal(out.advanced, 1);
  assert.equal(store.d1.currentIndex, 1);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/clock.test.js 2>&1 | tail -12`
Expected: FAIL — `Cannot find module './clock'`.

Note what these tests do **not** do: they never mock `autoPick.autoPickAndAdvance`. They drive the real pick rule and the real `advanceDraft` against a fake DynamoDB that stores what an `UpdateCommand` writes and enforces the `ConditionExpression`s. An earlier version of this file mocked the pick rule and had the mock write `pickDeadline = Date.now() - 1000` after every pick — a value no real code path produces, since `advanceDraft` writes a deadline in the *future*. The drain looked drained while, against the real write, it made exactly one pick and stopped. **A test may not mock the write whose value it is asserting about.**

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
const {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
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

  // Split, rather than one `skipped`, so the log can answer the question that
  // actually matters at 3am: is a draft poisoned, or is the clock simply
  // finding nothing to do? `raced` and `ineligible` are the system working;
  // `failed` and `emptyPool` repeating on every run are not.
  const out = {
    due: due.length,
    advanced: 0,
    picks: 0,
    raced: 0,
    ineligible: 0,
    evicted: 0,
    emptyPool: 0,
    failed: 0,
    deferred: 0,
  };

  for (const draftId of due) {
    if (remaining() < RESERVE_MS) {
      // Not an error: the next tick picks these up, and a half-finished
      // drain is exactly as valid a state as any other.
      out.deferred += 1;
      continue;
    }
    // Held outside the try so picks already made are still counted when the
    // drain throws afterwards. Reporting a run that made four picks and then
    // died as "0 picks" is a lie about the only number anyone reads.
    const tally = { picks: 0 };
    try {
      const reason = await drainDraft({
        draftId, draftsTable, playersTable, boardsTable, remaining, tally,
      });
      if (tally.picks === 0) await countStall({ out, reason, draftId, draftsTable });
    } catch (e) {
      // One draft's failure costs that draft its tick, never the other
      // twenty-four theirs.
      out.failed += 1;
      console.error(`clock: draft ${draftId} failed:`, e?.message || e);
    } finally {
      out.picks += tally.picks;
      if (tally.picks > 0) out.advanced += 1;
    }
  }

  console.log(JSON.stringify({ msg: "clock run", ...out }));
  return out;
}

/**
 * A drain that made no picks: count it, and where the reason is structural,
 * take the draft out of the index.
 *
 * The index is read ascending by `pickDeadline` with a limit, so a draft that
 * can never advance is returned FIRST, on every run, forever. Twenty-five of
 * those and the clock silently stops for everybody else -- the whole run is
 * spent re-reading drafts it cannot move. Self-healing is the only thing that
 * stops that, and it is why this write exists despite the plan's rule that
 * `clockRunning` is only ever written inside a write that already happens.
 *
 * Structural (evict): completed, paused. Neither can ever become due again
 * without a write that re-indexes the draft anyway -- resume sets
 * `clockRunning` itself.
 *
 * Transient (leave indexed): a lost race, a deadline that is simply still in
 * the future, a draft read as missing. All normal, all resolve themselves.
 *
 * An exhausted player pool is NOT structural either, even though it repeats:
 * it is recoverable, and evicting would mean the draft is never enforced
 * again once the pool is fixed. Counted and logged distinctly instead.
 */
async function countStall({ out, reason, draftId, draftsTable }) {
  if (reason === "completed" || reason === "paused") {
    const gone = await evictFromIndex({ draftsTable, draftId, reason });
    if (gone) {
      out.evicted += 1;
      console.log(`clock: draft ${draftId} left the index (${reason})`);
    } else {
      // The condition failed, so the draft is no longer in the state we read
      // -- it changed under us. Leave it indexed; the next run re-reads it.
      out.ineligible += 1;
    }
    return;
  }
  if (reason === "empty") {
    out.emptyPool += 1;
    console.error(
      `clock: draft ${draftId} has no eligible player left to pick; it stays in the index`
    );
    return;
  }
  if (reason === "race") {
    out.raced += 1;
    return;
  }
  if (reason === "budget") {
    out.deferred += 1;
    return;
  }
  if (reason === "malformed") {
    out.ineligible += 1;
    console.error(`clock: draft ${draftId} has no picks array`);
    return;
  }
  out.ineligible += 1;
}

/**
 * Remove `clockRunning`, but only if the draft really is in the state that
 * justified it. Conditional for the usual reason: between the read that said
 * "completed" and this write, somebody may have resumed or the item may have
 * changed, and un-indexing a draft whose clock should be running is exactly
 * the bug the index exists to prevent.
 *
 * A condition failure is not an error -- it means the draft moved on -- so it
 * returns false rather than throwing. The item is never created by this: both
 * conditions are false for a missing item, so a REMOVE can never resurrect a
 * deleted draft.
 */
async function evictFromIndex({ draftsTable, draftId, reason }) {
  const ConditionExpression =
    reason === "completed" ? "currentIndex >= size(picks)" : "attribute_exists(pausedAt)";
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: draftsTable,
        Key: { draftId },
        UpdateExpression: "REMOVE clockRunning",
        ConditionExpression,
      })
    );
    return true;
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/**
 * Pick for one draft until its deadline is in the future or it is finished.
 * Increments `tally.picks` as it goes and returns why it stopped.
 *
 * The drain is what separates this from POST /expire, which deliberately
 * takes exactly one pick however late it is. A browser catching up would
 * burst on a draft somebody is watching; the drafts reached here are by
 * definition ones nobody is watching, and the alternative is a zombie draft
 * needing one scheduler run per remaining pick.
 *
 * What makes the loop actually terminate is the deadline base. Each pick
 * counts a minute forward from the draft's PREVIOUS deadline, not from now,
 * so a draft forty minutes overdue burns forty one-minute slots and stops
 * when its deadline reaches the present. Passing no base -- the browser
 * behaviour -- would write `now + 60s` every time, which is always in the
 * future, and the loop would make exactly one pick and exit.
 */
async function drainDraft({ draftId, draftsTable, playersTable, boardsTable, remaining, tally }) {
  // Loaded at most once per drain and reused across its picks, the way
  // sim-to-end already does it: the pool is ~3,900 rows to read and sort, and
  // now that this really loops, doing that per pick is most of the run.
  let pool = null;
  for (;;) {
    // The outer loop's budget stops a new draft starting; this stops one
    // draft's drain from overrunning the timeout on its own. The draft keeps
    // its index entry, so the next run continues where this one stopped.
    if (remaining() < RESERVE_MS) return "budget";

    const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
    const d = res.Item;
    if (!d) return "missing";
    // An item with no picks list is not a draft this code can reason about.
    // Guarded rather than dereferenced, matching shouldRun in
    // scripts/backfillClockRunning.js: `d.picks.length` on such an item is a
    // TypeError, and a TypeError here is retried every minute forever.
    if (!Array.isArray(d.picks)) return "malformed";
    if ((d.currentIndex ?? 0) >= d.picks.length) return "completed";
    if (d.pausedAt) return "paused";
    // Strictly greater, the same rule /expire applies: a deadline exactly
    // reached has not passed yet.
    if (!(d.pickDeadline != null && Date.now() > d.pickDeadline)) return "future";

    if (!pool) {
      const sport = (d.sport || "nfl").toLowerCase();
      const format = (d.format || "standard").toLowerCase();
      pool = await autoPick.loadPlayersForSport({ ddb, table: playersTable, sport, format });
    }

    const r = await autoPick.autoPickAndAdvance({
      ddb, d, draftId, playersTable, draftsTable, boardsTable,
      pool,
      // The catch-up rule: this pick consumes the slot that already expired.
      deadlineBase: d.pickDeadline,
    });
    // A person picked, or paused, while we were working. They are right and
    // we are stale; stop touching this draft and let the next run re-read it.
    if (!r.ok) return r.code === "empty" ? "empty" : r.code === "paused" ? "paused" : "race";
    tally.picks += 1;
  }
}

module.exports = { handler };
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && node --test src/clock.test.js 2>&1 | tail -10`
Expected: all sixteen PASS.

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Expected: `fail 0`.

- [ ] **Step 5: Mutation-test the guards that matter**

1. Delete the `if (remaining() < RESERVE_MS)` block. "the wall-clock budget stops new drafts being started" must go **red**.
2. Replace `if (!r.ok) return ...` with nothing — i.e. remove the early return. "losing a race to a human ends that draft's turn, not the run" must go **red** (it will loop or over-count).
3. Delete the `try`/`catch` around `drainDraft` and let the error propagate. "a draft that throws does not abort the run" must go **red**.
4. Change `deadlineBase: d.pickDeadline` to nothing, restoring the old `now + PICK_MS` behaviour. "catch-up consumes the missed slots" must go **red** with `1 == 3` — one pick, then exit. This is the regression proof for the whole drain.
5. Drop the `ConditionExpression` from `evictFromIndex`. "an eviction whose condition fails leaves the draft indexed" must go **red**.
6. Swap the two eviction conditions. Both "a completed draft still in the index is evicted from it" and "a paused draft still in the index is evicted from it" must go **red**.
7. Delete the `if (!Array.isArray(d.picks)) return "malformed";` guard. "a draft item with no picks list is skipped, not a TypeError" must go **red**.
8. Flip `pickDeadline < :now` to `>`, and separately delete `Limit: DRAFTS_PER_RUN`. "the run asks the index for exactly the drafts that are due" must go **red** for each.

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

test("a failing tick is not retried 185 times", () => {
  const tpl = loadTemplate();
  const events = Object.values(tpl.Resources.ClockFunction.Properties.Events || {});
  const sched = events.find((e) => e.Type === "ScheduleV2");
  // EventBridge Scheduler defaults to 185 attempts spread over 24 hours. The
  // clock runs every minute and its query is the same one next minute, so a
  // retry can only pile failures on top of a schedule that is already
  // retrying -- and the very first deploy guarantees failures, because the
  // byClock index is CREATING for minutes after the stack updates.
  assert.equal(sched.Properties.RetryPolicy?.MaximumRetryAttempts, 0);
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
            # EventBridge Scheduler's default is 185 attempts over 24 hours.
            # On top of a per-minute schedule that is a retry storm, and the
            # first deploy invites one: the byClock index is CREATING for
            # several minutes and every query against it fails. Retries buy
            # nothing when the next tick is a minute away and re-reads the
            # index anyway.
            RetryPolicy:
              MaximumRetryAttempts: 0
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

/**
 * `byClock` is a composite-key index: HASH clockRunning, RANGE pickDeadline.
 * DynamoDB only projects an item into a composite index when BOTH key
 * attributes are present on the item. This script only ever sets
 * `clockRunning` -- it must never invent a `pickDeadline` -- so a draft that
 * qualifies by `shouldRun` but has no usable deadline would be written,
 * counted as written, and still never appear in the index. That is exactly
 * the silent failure this script exists to prevent, so it gets its own
 * bucket instead of being folded into "to write".
 */
function hasUsableDeadline(d) {
  return typeof d?.pickDeadline === "number" && Number.isFinite(d.pickDeadline);
}

/** Print up to `cap` ids under a label; note how many were left out. */
function printIds(label, ids, cap = 50) {
  console.log(`${label} (${ids.length}):`);
  if (ids.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const id of ids.slice(0, cap)) console.log(`  ${id}`);
  if (ids.length > cap) {
    console.log(`  ... and ${ids.length - cap} more (showing first ${cap} of ${ids.length})`);
  }
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  let cursor;
  let scanned = 0, already = 0, skipped = 0;
  const toWrite = [];
  const noDeadline = [];

  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey: cursor })
    );
    for (const d of page.Items || []) {
      scanned += 1;
      if (d.clockRunning === "1") { already += 1; continue; }
      if (!shouldRun(d)) { skipped += 1; continue; }
      if (!hasUsableDeadline(d)) { noDeadline.push(d.draftId); continue; }
      toWrite.push(d.draftId);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  console.log(
    `scanned ${scanned}, already indexed ${already}, not running ${skipped}, ` +
      `to write ${toWrite.length}, no usable deadline ${noDeadline.length}`
  );

  // Loud and separate: a clean "wrote N" next to this would still be a silent
  // failure for these drafts specifically, so they get their own headline
  // and their ids, not just a folded-in count. An empty bucket is reported
  // just as explicitly -- that's the expected case, and the operator should
  // be able to see it at a glance rather than infer it from an absent line.
  if (noDeadline.length > 0) {
    console.log(
      `\n!! ${noDeadline.length} draft(s) qualify for the clock but have no usable ` +
        `pickDeadline (missing, or not a number).`
    );
    console.log(
      "!! byClock is a composite-key index (clockRunning + pickDeadline); DynamoDB " +
        "only projects an item into it when BOTH keys are present. This script does " +
        "not invent a pickDeadline, so these drafts CANNOT be indexed by this run --"
    );
    console.log(
      "!! the scheduler will not see them. They need a real pickDeadline before " +
        "they can be added to the clock index."
    );
    for (const draftId of noDeadline) console.log(`     ${draftId}`);
  } else {
    console.log(
      "\nNo drafts with a missing/invalid pickDeadline -- every qualifying draft can be indexed."
    );
  }

  console.log("");
  printIds("drafts that would be written to the index", toWrite);

  if (!confirm) {
    console.log("\ndry run. re-run with --confirm to write.");
    return;
  }

  let written = 0, changed = 0;
  const conditionFailed = [];
  for (const draftId of toWrite) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { draftId },
          UpdateExpression: "SET clockRunning = :run",
          // Only add the draft back to the index if it is still eligible
          // right now: not paused, and picks remain. A draft that was
          // paused or finished between the scan above and this write fails
          // this condition -- that's the expected, correct outcome (the
          // draft changed under us), not an error, so it's counted and
          // skipped rather than aborting the run.
          // The attribute_not_exists(currentIndex) arm matches shouldRun's
          // ?? 0 normalization, so a draft with missing currentIndex is
          // treated the same way in both.
          ConditionExpression:
            "attribute_not_exists(pausedAt) AND (attribute_not_exists(currentIndex) OR currentIndex < size(picks))",
          ExpressionAttributeValues: { ":run": "1" },
        })
      );
      written += 1;
    } catch (e) {
      if (e?.name === "ConditionalCheckFailedException") {
        changed += 1;
        conditionFailed.push(draftId);
        continue;
      }
      throw e;
    }
  }
  console.log(`wrote ${written}, skipped ${changed} (changed since the scan)`);
  if (conditionFailed.length > 0) {
    printIds("drafts whose condition failed", conditionFailed);
  }
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

Then, inside the window, wait two minutes and read the log. **Resolve the log group name; do not guess it.** No function in this template sets `FunctionName`, so CloudFormation generates one and `/aws/lambda/sports-mock-draft-ClockFunction` does not resolve:

```bash
CLOCK_FN=$(aws cloudformation describe-stack-resource --stack-name sports-mock-draft --region us-east-1 \
  --logical-resource-id ClockFunction --query StackResourceDetail.PhysicalResourceId --output text)
aws logs tail "/aws/lambda/$CLOCK_FN" --since 5m --region us-east-1 --format short | grep "clock run"
```
Expected: at least one `{"msg":"clock run",...}` line. `due` may legitimately be `0` — that only means nothing was overdue, and it still proves the schedule fires and the query works.

The line names every outcome separately — `advanced`, `picks`, `raced`, `ineligible`, `evicted`, `emptyPool`, `failed`, `deferred`. A non-zero `failed` or `emptyPool` repeating tick after tick is a poisoned draft; `raced` and `ineligible` are the system working.

**The kill switch.** The clock writes to live drafts on a timer, so know how to stop it before you need to:

```bash
CLOCK_SCHED=$(aws scheduler list-schedules --region us-east-1 \
  --query "Schedules[?contains(Name,'Clock')].Name" --output text)

# Read the current definition first. UpdateSchedule is a full replacement,
# not a patch: `--state DISABLED` on its own is rejected for want of
# --schedule-expression, --flexible-time-window and --target, and passing
# only some of them would silently drop the rest.
CUR=$(aws scheduler get-schedule --name "$CLOCK_SCHED" --region us-east-1)
aws scheduler update-schedule --region us-east-1 --name "$CLOCK_SCHED" --state DISABLED \
  --schedule-expression "$(jq -r .ScheduleExpression <<<"$CUR")" \
  --schedule-expression-timezone "$(jq -r .ScheduleExpressionTimezone <<<"$CUR")" \
  --flexible-time-window "$(jq -c .FlexibleTimeWindow <<<"$CUR")" \
  --target "$(jq -c .Target <<<"$CUR")"
```

`--state ENABLED` the same way turns it back on. Note that the next `sam deploy` restores whatever the template says, so this is an incident switch, not a configuration change.

Faster, if the clock is actively doing damage and you want it stopped this second — it takes effect immediately and needs no schedule definition:

```bash
aws lambda put-function-concurrency --region us-east-1 \
  --function-name "$CLOCK_FN" --reserved-concurrent-executions 0
# undo: aws lambda delete-function-concurrency --function-name "$CLOCK_FN" --region us-east-1
```

Either way every draft's `pickDeadline` stays exactly where it is, and browsers calling `/expire` keep enforcing the clock as they did before this phase.

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
