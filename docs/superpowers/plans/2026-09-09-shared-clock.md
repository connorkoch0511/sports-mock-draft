# Shared Draft Clock (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every draft a 60-second clock that lives on the server, and make the pick it takes come from the drafter's own big board.

**Architecture:** The deadline is data, never a running timer. `pickDeadline` is written into the same conditional write that moves `currentIndex`, so the two can never disagree. Browsers evaluate nothing — they call `POST /expire`, and the server checks its own clock. One expired deadline produces exactly one auto-pick, never a catch-up loop. Auto-pick gains a `rankOf` parameter so a seat's board can replace consensus rank as the input to the existing roster scoring.

**Tech Stack:** AWS SAM (Lambda + DynamoDB + HttpApi with a Cognito JWT authorizer), Node 20 CommonJS backend tested with `node --test`, React 19 + Vite frontend (ESM) tested with `node --test` and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-09-shared-clock-design.md`

## Global Constraints

- Pick length is **60 seconds**, defined once as `PICK_SECONDS = 60` / `PICK_MS = 60_000` in `backend/src/lib/advance.js` and exported. The frontend's own `PICK_SECONDS` becomes a display fallback only; the server is the authority.
- **Anti-oracle:** a caller who is not seated gets **404**, never 403 — a resource you cannot see must be indistinguishable from one that does not exist.
- **Every new route needs an `Events:` entry in `backend/template.yaml`.** Routes are declared explicitly per path; a handler without one returns 404 in production while every unit test passes.
- **Mutation-test every guard:** delete the guard, run the covering test, confirm it goes **red**, restore it, confirm **green**. A guard whose test still passes without it is not tested. Phase 1 found ten such tests this way. Record the evidence in the task report.
- Backend source and tests are **CommonJS** (`require`); frontend is **ESM** (`import`).
- Never run `sam deploy --guided` (it writes parameter values into the git-tracked `backend/samconfig.toml`). Never run `git stash`.
- A board that fails to load **falls back to consensus rankings**; it must never fail a pick or stall the clock.
- Do not change the meaning of `/auto-pick`. It never consults the deadline; `/expire` only ever consults the deadline.

## File Structure

**Backend**
- `backend/src/lib/advance.js` — *modify.* Owns `PICK_SECONDS`/`PICK_MS`; writes `pickDeadline` inside the existing conditional write.
- `backend/src/lib/boardRank.js` — **new.** Pure rank-function construction plus the one DynamoDB read that feeds it. No knowledge of drafts or picking.
- `backend/src/drafts.js` — *modify.* New routes `/expire`, `/pause`, `/seat-board`; extracted `autoPickAndAdvance` shared by `/auto-pick` and `/expire`; `pickBestForTeam` gains a `rankOf` parameter.
- `backend/template.yaml` — *modify.* Three route events, `BOARDS_TABLE` env var, boards read policy.
- `backend/src/drafts.test.js`, `backend/src/lib/boardRank.test.js` — tests.

**Frontend**
- `frontend/src/pages/Draft.jsx` — *modify.* Skew-corrected countdown from the server deadline; `/expire` at zero; server-backed pause; the seat board picker.
- `frontend/src/pages/JoinDraft.jsx` — **untouched, deliberately.** It claims the seat with no UI; a chooser there would leave the seat unclaimed while the person deliberates.
- `frontend/src/pages/Draft.test.jsx`, `frontend/e2e/draft.spec.js` — tests.

---

### Task 1: `pickDeadline` — written, returned, never drifting

**Files:**
- Modify: `backend/src/lib/advance.js`
- Modify: `backend/src/drafts.js` (create handler; `GET /drafts/{draftId}` response)
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PICK_SECONDS` (60), `PICK_MS` (60000) exported from `lib/advance.js`; `advanceDraft({ ddb, table, draftId, draft, expectedIndex, now })` now returns the new deadline (a number). `GET /drafts/{draftId}` gains `pickDeadline`, `pausedAt`, `pausedBy`, `now`.

- [ ] **Step 1: Write the failing tests**

In `backend/src/drafts.test.js`:

```js
test("creating a draft puts pick 1 on the clock", async () => {
  let written = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.Item?.draftId) written = cmd.input.Item;
    return {};
  });
  const before = Date.now();
  const res = await handler(evt("POST", "/drafts", { body: { teams: 2, rounds: 2 }, claims: ME }));
  assert.equal(res.statusCode, 200);
  assert.ok(written.pickDeadline >= before + 60000, "deadline is at least 60s out");
  assert.ok(written.pickDeadline <= Date.now() + 60000, "and no further");
});

test("a pick re-arms the clock in the same conditional write", async () => {
  const d = ownedDraft(ME.sub);
  let update = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    const t = cmd?.input?.TableName;
    if (t === "drafts-test" && cmd.input.UpdateExpression) { update = cmd.input; return {}; }
    if (t === "drafts-test") return { Item: d };
    return { Items: [{ sport: "nfl", id: "p1", name: "A", position: "RB", team: "SF", rank: 1 }] };
  });
  const res = await handler(evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" }, claims: ME }));
  assert.equal(res.statusCode, 200);
  assert.match(update.UpdateExpression, /pickDeadline = :d/);
  assert.match(update.ConditionExpression, /currentIndex = :expected/);
  assert.ok(update.ExpressionAttributeValues[":d"] > Date.now(), "deadline is in the future");
});

test("GET returns the clock fields the page needs", async () => {
  const d = { ...ownedDraft(ME.sub), pickDeadline: 1750000000000, pausedAt: 1749999000000, pausedBy: ME.sub };
  stubSend({ Item: d });
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  const body = JSON.parse(res.body);
  assert.equal(body.pickDeadline, 1750000000000);
  assert.equal(body.pausedAt, 1749999000000);
  assert.equal(body.pausedBy, ME.sub);
  assert.ok(Math.abs(body.now - Date.now()) < 5000, "now is the server's clock");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/drafts.test.js`
Expected: the three new tests FAIL — `written.pickDeadline` is `undefined`, `UpdateExpression` has no `pickDeadline`, `body.pickDeadline` is `undefined`.

- [ ] **Step 3: Write the deadline into `advance.js`**

In `backend/src/lib/advance.js`, above `class RaceLost`:

```js
// The one definition of how long a pick may take. The browser renders a
// countdown but decides nothing; this is the number the server enforces.
const PICK_SECONDS = 60;
const PICK_MS = PICK_SECONDS * 1000;
```

Then in `advanceDraft`, take `now` as a parameter and write the deadline inside the same conditional write:

```js
async function advanceDraft({ ddb, table, draftId, draft, expectedIndex, now = Date.now() }) {
  // Written here rather than by the callers, and inside the SAME conditional
  // write that moves currentIndex, so the two can never disagree. A separate
  // update would leave a window in which the deadline belongs to a pick that
  // has already been made -- and the loser of a race would arm a clock for
  // somebody else's turn.
  const deadline = now + PICK_MS;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { draftId },
        UpdateExpression:
          "SET picks = :p, picked = :k, currentIndex = :i, pickDeadline = :d, version = if_not_exists(version, :z) + :one",
        ConditionExpression: "currentIndex = :expected",
        ExpressionAttributeValues: {
          ":p": draft.picks, ":k": draft.picked, ":i": draft.currentIndex,
          ":d": deadline,
          ":z": 0, ":one": 1, ":expected": expectedIndex,
        },
      })
    );
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
    const now2 = await ddb.send(new GetCommand({ TableName: table, Key: { draftId } }));
    throw new RaceLost(now2.Item?.currentIndex ?? null, now2.Item?.version ?? null);
  }
  return deadline;
}

module.exports = { advanceDraft, RaceLost, PICK_SECONDS, PICK_MS };
```

- [ ] **Step 4: Set the deadline at creation and return it on GET**

In `backend/src/drafts.js`, change the import:

```js
const { advanceDraft, PICK_MS } = require("./lib/advance");
```

In the `POST /drafts` item, directly after `createdAt: Date.now(),`:

```js
        // Pick 1 is on the clock from the moment the page opens. Every later
        // deadline is written by advanceDraft, inside the conditional write.
        pickDeadline: Date.now() + PICK_MS,
```

In the `GET /drafts/{draftId}` response object, after `version: d.version ?? 1,`:

```js
        pickDeadline: d.pickDeadline ?? null,
        pausedAt: d.pausedAt ?? null,
        pausedBy: d.pausedBy ?? null,
        // The page corrects for clock skew against this. Without it a laptop
        // running two minutes fast sees every timer already expired and
        // hammers /expire.
        now: Date.now(),
```

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend && node --test 'src/**/*.test.js'`
Expected: all tests PASS, including the three new ones and every pre-existing `advance.js` test.

- [ ] **Step 6: Mutation-test the conditional write**

Delete `pickDeadline = :d, ` from the `UpdateExpression` in `advance.js`, run `node --test src/drafts.test.js`, confirm "a pick re-arms the clock in the same conditional write" goes **red**, restore it, confirm green. Record both outputs in the report.

- [ ] **Step 7: Commit**

```bash
git add backend/src/lib/advance.js backend/src/drafts.js backend/src/drafts.test.js
git commit -m "feat: put the pick clock on the draft item"
```

---

### Task 2: `POST /expire` — the server enforces its own clock

**Files:**
- Modify: `backend/src/drafts.js`
- Modify: `backend/template.yaml`
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: `PICK_MS` and the deadline-writing `advanceDraft` from Task 1.
- Produces: `autoPickAndAdvance({ d, draftId, playersTable, json })` — a module-level async helper in `drafts.js` that loads the pool, picks the best available for the team on the clock, stores it, advances, and returns the HTTP response. Used by `/auto-pick` and `/expire`. Task 5 gives it board awareness.

- [ ] **Step 1: Write the failing tests**

```js
const EXPIRED = Date.now() - 1000;
const FUTURE = Date.now() + 60000;

function clockDraft(deadline, extra = {}) {
  return { ...ownedDraft(ME.sub), pickDeadline: deadline, ...extra };
}

test("expire refuses while the clock still has time", async () => {
  stubSend({ Item: clockDraft(FUTURE) });
  const res = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: ME }));
  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /not expired/i);
});

test("expire makes exactly one pick once the deadline has passed", async () => {
  const d = clockDraft(EXPIRED);
  let updates = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    const t = cmd?.input?.TableName;
    if (t === "drafts-test" && cmd.input.UpdateExpression) { updates += 1; return {}; }
    if (t === "drafts-test") return { Item: d };
    return { Items: [
      { sport: "nfl", id: "p1", name: "A", position: "RB", team: "SF", rank: 1 },
      { sport: "nfl", id: "p2", name: "B", position: "WR", team: "KC", rank: 2 },
    ] };
  });
  const res = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: ME }));
  assert.equal(res.statusCode, 200);
  assert.equal(updates, 1, "one expired deadline is one pick, never a catch-up loop");
});

test("expire refuses on a paused draft however long it has sat", async () => {
  stubSend({ Item: clockDraft(Date.now() - 3600000, { pausedAt: Date.now() - 3600000 }) });
  const res = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: ME }));
  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /paused/i);
});

test("expire says a completed draft is completed, not that the clock is unexpired", async () => {
  const d = clockDraft(EXPIRED);
  d.currentIndex = d.picks.length;
  stubSend({ Item: d });
  const res = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: ME }));
  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /completed/i);
});

test("an unseated caller cannot expire anyone's clock", async () => {
  stubSend({ Item: clockDraft(EXPIRED) });
  const res = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: THEM }));
  assert.equal(res.statusCode, 404, "404, never 403 -- see Global Constraints");
});

test("two browsers shouting 'time is up' produce one pick", async () => {
  const d = clockDraft(EXPIRED);
  let firstWrite = true;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    const t = cmd?.input?.TableName;
    if (t === "drafts-test" && cmd.input.UpdateExpression) {
      if (firstWrite) { firstWrite = false; return {}; }
      const e = new Error("conditional"); e.name = "ConditionalCheckFailedException"; throw e;
    }
    if (t === "drafts-test") return { Item: { ...d, currentIndex: 1, version: 2 } };
    return { Items: [{ sport: "nfl", id: "p1", name: "A", position: "RB", team: "SF", rank: 1 }] };
  });
  const one = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: ME }));
  const two = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: ME }));
  assert.equal(one.statusCode, 200);
  assert.equal(two.statusCode, 409);
  assert.equal(JSON.parse(two.body).currentIndex, 1, "the loser is told where the draft actually is");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/drafts.test.js`
Expected: all six FAIL — the route does not exist, so every call falls through to the handler's final 404.

- [ ] **Step 3: Extract the shared auto-pick body**

In `backend/src/drafts.js`, add a module-level helper (place it directly after `pickBestForTeam`). Its body is the existing `/auto-pick` code from `const sport = ...` to the end, moved verbatim:

```js
// Shared by /auto-pick ("draft for me, on purpose") and /expire ("the clock
// ran out"). The two differ only in what they check before calling this --
// authorization in one, the deadline in the other -- and keeping the picking
// itself in one place is what stops those two paths drifting into picking
// differently.
async function autoPickAndAdvance({ d, draftId, playersTable, draftsTable, json }) {
  const sport = (d.sport || "nfl").toLowerCase();
  const format = (d.format || "standard").toLowerCase();
  const { players, byId } = await loadPlayersForSport(playersTable, sport, format);

  const teamNum = d.picks[d.currentIndex]?.team;
  d.__counts = getRosterCounts(d, teamNum, byId);

  const best = pickBestForTeam(d, teamNum, players);
  if (!best) return json(409, { error: "No players left" });

  d.picks[d.currentIndex].playerId = best.id;
  d.picks[d.currentIndex].player = {
    id: best.id,
    name: best.name,
    position: best.position,
    team: best.team,
    rank: best.rank,
    adp: best.adp,
    ...withAdpBySource(best.adpBySource),
    tier: best.tier,
  };

  const expectedIndex = d.currentIndex;
  d.picked = [best.id, ...(d.picked || [])];
  d.currentIndex = d.currentIndex + 1;

  try {
    await advanceDraft({ ddb, table: draftsTable, draftId, draft: d, expectedIndex });
  } catch (e) {
    if (e?.name === "RaceLost") {
      return json(409, { error: e.message, currentIndex: e.currentIndex, version: e.version });
    }
    throw e;
  }

  return json(200, { ok: true, picked: best });
}
```

Then replace that same block in the `/auto-pick` route with:

```js
      return await autoPickAndAdvance({ d, draftId, playersTable, draftsTable, json });
```

- [ ] **Step 4: Add the `/expire` route**

Immediately after the `/auto-pick` route block in `backend/src/drafts.js`:

```js
    // POST /drafts/{draftId}/expire
    //
    // The clock, enforced. A browser calling this is making a request, not
    // asserting a fact: the deadline is compared against the SERVER's clock,
    // so no browser can shorten anyone's turn by lying about the time.
    //
    // Deliberately takes no argument naming who to pick for, and does not
    // care that a human asked -- an EventBridge schedule calling this on a
    // timer with no browser open is the same call.
    if (method === "POST" && draftId && path.endsWith("/expire")) {
      if (!sub) return needsAuth();
      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;
      // Before the two checks below, for the reason Phase 1 learned the hard
      // way: a guard ordered ahead of the completed check makes a finished
      // draft report the wrong thing about itself.
      if (d.currentIndex >= d.picks.length) return json(409, { error: "Draft already completed" });

      if (d.pausedAt) {
        return json(409, { error: "Draft is paused", currentIndex: d.currentIndex, version: d.version ?? 1 });
      }

      // Strictly greater: a deadline exactly reached has not passed yet.
      if (!(d.pickDeadline != null && Date.now() > d.pickDeadline)) {
        return json(409, {
          error: "Clock has not expired",
          currentIndex: d.currentIndex,
          version: d.version ?? 1,
        });
      }

      // Exactly one pick, no matter how far past the deadline we are. Forty
      // minutes late and forty seconds late do the identical thing: the draft
      // paused because nobody was watching, and nobody was skipped.
      return await autoPickAndAdvance({ d, draftId, playersTable, draftsTable, json });
    }
```

- [ ] **Step 5: Declare the route**

In `backend/template.yaml`, inside `DraftsFunction`'s `Events:`, after the `AutoPick` entry:

```yaml
        ExpireDraft:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /drafts/{draftId}/expire
            Method: POST
            Auth:
              Authorizer: CognitoAuth
```

- [ ] **Step 6: Run the tests**

Run: `cd backend && node --test 'src/**/*.test.js'`
Expected: PASS, all six new tests plus every existing `/auto-pick` test (the extraction must not have changed its behaviour).

- [ ] **Step 7: Mutation-test the two guards that matter**

1. Delete the `pausedAt` check → "expire refuses on a paused draft" must go red.
2. Change `Date.now() > d.pickDeadline` to `>=`… that is too weak to catch; instead delete the whole deadline check → "expire refuses while the clock still has time" must go red.

Restore each and confirm green. Record all four outputs.

- [ ] **Step 8: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js backend/template.yaml
git commit -m "feat: POST /expire, the clock the server enforces"
```

---

### Task 3: `POST /pause` — stopping the clock without losing your time

**Files:**
- Modify: `backend/src/drafts.js`
- Modify: `backend/template.yaml`
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: the `pausedAt` check added to `/expire` in Task 2 (the field it reads is written here).
- Produces: `POST /drafts/{draftId}/pause`, body `{ paused: boolean }`, responding `{ ok: true, pausedAt, pausedBy, pickDeadline }`.

- [ ] **Step 1: Write the failing tests**

```js
test("pausing records who stopped it", async () => {
  let update = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.UpdateExpression) { update = cmd.input; return {}; }
    return { Item: { ...ownedDraft(ME.sub), pickDeadline: Date.now() + 30000 } };
  });
  const res = await handler(evt("POST", "/drafts/d1/pause", { draftId: "d1", body: { paused: true }, claims: ME }));
  assert.equal(res.statusCode, 200);
  assert.equal(update.ExpressionAttributeValues[":me"], ME.sub);
  assert.match(update.UpdateExpression, /pausedAt = :n/);
});

test("resuming gives back the time that was left, not a fresh minute", async () => {
  const pausedAt = Date.now() - 600000;      // paused ten minutes ago
  const pickDeadline = pausedAt + 10000;     // with ten seconds on the clock
  let update = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.UpdateExpression) { update = cmd.input; return {}; }
    return { Item: { ...ownedDraft(ME.sub), pickDeadline, pausedAt, pausedBy: ME.sub } };
  });
  const res = await handler(evt("POST", "/drafts/d1/pause", { draftId: "d1", body: { paused: false }, claims: ME }));
  assert.equal(res.statusCode, 200);
  const restored = update.ExpressionAttributeValues[":d"] - Date.now();
  assert.ok(restored > 5000 && restored < 15000, `about ten seconds left, got ${restored}ms`);
  assert.match(update.UpdateExpression, /REMOVE pausedAt, pausedBy/);
});

test("an unseated caller cannot pause someone else's draft", async () => {
  stubSend({ Item: ownedDraft(ME.sub) });
  const res = await handler(evt("POST", "/drafts/d1/pause", { draftId: "d1", body: { paused: true }, claims: THEM }));
  assert.equal(res.statusCode, 404);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/drafts.test.js`
Expected: the first two FAIL with `update` still `null` (no route, so no update is ever issued); the third fails by returning 404 for the wrong reason — it currently falls through to the handler's catch-all. Confirm the first two are red before continuing.

- [ ] **Step 3: Add the route**

After the `/expire` block in `backend/src/drafts.js`:

```js
    // POST /drafts/{draftId}/pause  { paused: boolean }
    //
    // Any seated human may stop or restart the clock, and the page names who
    // did. Griefable in principle; these are people who were sent an invite
    // link.
    if (method === "POST" && draftId && path.endsWith("/pause")) {
      if (!sub) return needsAuth();
      const body = event.body ? JSON.parse(event.body) : {};
      const wantPaused = body.paused === true;

      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;
      if (d.currentIndex >= d.picks.length) return json(409, { error: "Draft already completed" });

      const now = Date.now();

      if (wantPaused) {
        // Idempotent: a second pause must not overwrite the first one's
        // timestamp, or the elapsed time it is holding is lost and resume
        // hands back the wrong remainder.
        if (d.pausedAt) return json(200, { ok: true, pausedAt: d.pausedAt, pausedBy: d.pausedBy ?? null });
        await ddb.send(
          new UpdateCommand({
            TableName: draftsTable,
            Key: { draftId },
            UpdateExpression: "SET pausedAt = :n, pausedBy = :me, version = if_not_exists(version, :z) + :one",
            ConditionExpression: "attribute_not_exists(pausedAt)",
            ExpressionAttributeValues: { ":n": now, ":me": sub, ":z": 0, ":one": 1 },
          })
        );
        return json(200, { ok: true, pausedAt: now, pausedBy: sub });
      }

      if (!d.pausedAt) return json(200, { ok: true, pausedAt: null, pickDeadline: d.pickDeadline ?? null });

      // Push the deadline forward by exactly as long as we were stopped, so a
      // pause preserves the REMAINING time rather than granting a fresh
      // minute -- otherwise pausing at four seconds left is a free reset.
      const extended = (d.pickDeadline ?? now) + (now - d.pausedAt);
      await ddb.send(
        new UpdateCommand({
          TableName: draftsTable,
          Key: { draftId },
          UpdateExpression:
            "SET pickDeadline = :d, version = if_not_exists(version, :z) + :one REMOVE pausedAt, pausedBy",
          ConditionExpression: "pausedAt = :was",
          ExpressionAttributeValues: { ":d": extended, ":was": d.pausedAt, ":z": 0, ":one": 1 },
        })
      );
      return json(200, { ok: true, pausedAt: null, pickDeadline: extended });
    }
```

- [ ] **Step 4: Declare the route**

In `backend/template.yaml`, after the `ExpireDraft` entry:

```yaml
        PauseDraft:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /drafts/{draftId}/pause
            Method: POST
            Auth:
              Authorizer: CognitoAuth
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && node --test 'src/**/*.test.js'`
Expected: PASS.

- [ ] **Step 6: Mutation-test the resume arithmetic**

Replace `const extended = (d.pickDeadline ?? now) + (now - d.pausedAt);` with `const extended = now + PICK_MS;` (a fresh minute). "resuming gives back the time that was left" must go **red**. Restore, confirm green.

- [ ] **Step 7: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js backend/template.yaml
git commit -m "feat: pause and resume the draft clock"
```

---

### Task 4: `lib/boardRank.js` — a board as a rank function

**Files:**
- Create: `backend/src/lib/boardRank.js`
- Create: `backend/src/lib/boardRank.test.js`
- Modify: `backend/src/drafts.js` (`pickBestForTeam` gains a `rankOf` parameter)
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `UNRANKED` (100000)
  - `consensusRank(p)` → number
  - `rankFromOrder(order)` → `(player) => number`
  - `loadBoardRank({ ddb, boardsTable, boardId })` → `Promise<rankFn | null>`
  - `pickBestForTeam(draft, teamNum, players, rankOf)` — fourth parameter, defaulting to `consensusRank`.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/lib/boardRank.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { rankFromOrder, consensusRank, UNRANKED } = require("./boardRank");

test("board position is the rank", () => {
  const r = rankFromOrder(["p9", "p3"]);
  assert.equal(r({ id: "p9", rank: 400 }), 0);
  assert.equal(r({ id: "p3", rank: 1 }), 1, "your order beats consensus order");
});

test("a player missing from the board sorts behind everyone on it, in consensus order", () => {
  const r = rankFromOrder(["p1", "p2"]);
  // A board written in July does not list a player added in August. That
  // player is not unranked -- he is good, just not on the list.
  assert.equal(r({ id: "rookie", rank: 5 }), 7);
  assert.equal(r({ id: "scrub", rank: 300 }), 302);
  assert.ok(r({ id: "rookie", rank: 5 }) > r({ id: "p2", rank: 999 }));
});

test("an unranked off-board player stays a finite number", () => {
  const r = rankFromOrder(["p1"]);
  const v = r({ id: "nobody", rank: null });
  assert.ok(Number.isFinite(v), "Infinity would poison pickBestForTeam's arithmetic");
  assert.equal(v, 1 + UNRANKED);
});

test("consensusRank is what an absent board falls back to", () => {
  assert.equal(consensusRank({ rank: 12 }), 12);
  assert.equal(consensusRank({ rank: null }), UNRANKED);
});

test("a duplicated id keeps its first (best) position", () => {
  const r = rankFromOrder(["p1", "p2", "p1"]);
  assert.equal(r({ id: "p1", rank: 9 }), 0);
});
```

In `backend/src/drafts.test.js`:

```js
test("pickBestForTeam takes its ranking from the rankOf it is given", async () => {
  const { pickBestForTeam } = require("./drafts");
  const players = [
    { id: "p1", name: "Consensus One", position: "RB", rank: 1 },
    { id: "p2", name: "My Guy", position: "RB", rank: 200 },
  ];
  const draft = { picked: [], picks: [{ team: 1 }], currentIndex: 0, rosterSlots: ["RB"] };
  const dflt = pickBestForTeam(draft, 1, players);
  assert.equal(dflt.id, "p1", "default is still consensus rank");
  const mine = pickBestForTeam(draft, 1, players, (p) => (p.id === "p2" ? 0 : 500));
  assert.equal(mine.id, "p2", "my board decides who");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/lib/boardRank.test.js src/drafts.test.js`
Expected: FAIL — `Cannot find module './boardRank'`, and `pickBestForTeam` is not exported.

- [ ] **Step 3: Write `boardRank.js`**

```js
/**
 * A big board, expressed as the one thing the drafting code needs from it:
 * a function from player to rank, lower being better.
 *
 * Kept apart from drafts.js because it knows nothing about drafts, picks or
 * seats -- it turns a stored `order` array into a comparison, and that is all.
 */

const { GetCommand } = require("@aws-sdk/lib-dynamodb");

// Sorts behind every ranked player while staying a finite number. Infinity
// would poison pickBestForTeam's `100000 - rank` arithmetic into NaN, and
// NaN compares false against everything -- the loop would pick nobody.
const UNRANKED = 100000;

function consensusRank(p) {
  return p?.rank != null ? Number(p.rank) : UNRANKED;
}

/**
 * Position in the array is the rank. Anyone absent from it sorts behind
 * everyone present, ordered among themselves by consensus.
 *
 * That fallback is load-bearing, not padding: boards.js reconciles newly
 * added players in at read time, so a stored order written in July does not
 * list a player added in August. Without the fallback he would score as
 * unranked rather than as "good, just not on your list".
 */
function rankFromOrder(order) {
  const list = Array.isArray(order) ? order : [];
  const index = new Map();
  list.forEach((id, i) => {
    const key = String(id);
    // First occurrence wins: a duplicated id is a board that lists someone
    // twice, and the higher slot is the one its owner meant.
    if (!index.has(key)) index.set(key, i);
  });

  return (p) => {
    const hit = index.get(String(p?.id));
    return hit !== undefined ? hit : list.length + consensusRank(p);
  };
}

/**
 * Boards are keyed by boardId alone, so this reads a seat-holder's board
 * without needing to be that person.
 *
 * Returns null -- meaning "use consensus" -- for a board that is missing or
 * unreadable. Deleting a board mid-draft must never be able to stall the
 * clock, so a failure here degrades rather than throwing.
 */
async function loadBoardRank({ ddb, boardsTable, boardId }) {
  if (!boardId || !boardsTable) return null;
  try {
    const res = await ddb.send(new GetCommand({ TableName: boardsTable, Key: { boardId } }));
    if (!res.Item) return null;
    return rankFromOrder(res.Item.order);
  } catch (e) {
    console.error("board unreadable, falling back to consensus:", e.message);
    return null;
  }
}

module.exports = { UNRANKED, consensusRank, rankFromOrder, loadBoardRank };
```

- [ ] **Step 4: Parameterize `pickBestForTeam`**

In `backend/src/drafts.js`, add to the imports:

```js
const { consensusRank, loadBoardRank } = require("./lib/boardRank");
```

Change the signature and the one line that reads a rank:

```js
function pickBestForTeam(draft, teamNum, players, rankOf = consensusRank) {
```

```js
    // Rank dominates (lower rank = better). Which ranking is the caller's
    // choice: consensus by default, the seat's own board when it has one.
    const base = 100000 - rankOf(p);
```

(The default is behaviour-identical to the `p.rank != null ? (100000 - Number(p.rank)) : 0` it replaces, because `consensusRank` returns `UNRANKED` — 100000 — for a null rank, giving `base === 0`.)

Export it for the test by extending the module's exports at the bottom of `drafts.js`:

```js
module.exports.pickBestForTeam = pickBestForTeam;
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && node --test 'src/**/*.test.js'`
Expected: PASS — including every pre-existing auto-pick test, which must be unaffected by the default parameter.

- [ ] **Step 6: Mutation-test the off-board fallback**

Change `list.length + consensusRank(p)` to `consensusRank(p)`. The test "a player missing from the board sorts behind everyone on it" must go **red**. Restore, confirm green.

- [ ] **Step 7: Commit**

```bash
git add backend/src/lib/boardRank.js backend/src/lib/boardRank.test.js backend/src/drafts.js backend/src/drafts.test.js
git commit -m "feat: a big board as a rank function"
```

---

### Task 5: The clock drafts from the seat's board

**Files:**
- Modify: `backend/src/drafts.js` (`autoPickAndAdvance`)
- Modify: `backend/template.yaml` (`BOARDS_TABLE` env var + read policy)
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: `loadBoardRank`, `consensusRank` (Task 4); `autoPickAndAdvance` (Task 2).
- Produces: `boardIdForTeam(draft, teamNum)` — the resolution chain, exported for testing.

- [ ] **Step 1: Write the failing tests**

```js
function boardDraft(seatBoard, draftBoard) {
  const d = ownedDraft(ME.sub);
  d.boardId = draftBoard;
  if (seatBoard !== undefined) d.seats[0].boardId = seatBoard;
  d.pickDeadline = Date.now() - 1000;
  return d;
}

const POOL = { Items: [
  { sport: "nfl", id: "p1", name: "Consensus One", position: "RB", team: "SF", rank: 1 },
  { sport: "nfl", id: "p2", name: "My Guy", position: "RB", team: "KC", rank: 200 },
] };

function stubWithBoard(draft, boardItem) {
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    const t = cmd?.input?.TableName;
    if (t === "drafts-test" && cmd.input.UpdateExpression) return {};
    if (t === "drafts-test") return { Item: draft };
    if (t === "boards-test") return boardItem === null ? {} : { Item: boardItem };
    return POOL;
  });
}

test("the clock drafts from the seat's own board", async () => {
  stubWithBoard(boardDraft("b-mine", "b-creator"), { boardId: "b-mine", order: ["p2", "p1"] });
  const res = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: ME }));
  assert.equal(JSON.parse(res.body).picked.id, "p2");
});

test("a seat with no board of its own inherits the draft's", async () => {
  stubWithBoard(boardDraft(undefined, "b-creator"), { boardId: "b-creator", order: ["p2", "p1"] });
  const res = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: ME }));
  assert.equal(JSON.parse(res.body).picked.id, "p2", "falls through to the draft's board");
});

test("a seat that explicitly chose consensus does NOT inherit the draft's board", async () => {
  // null means "I picked Consensus rankings", which is a decision, not an
  // absence -- it must not fall through to the creator's board.
  stubWithBoard(boardDraft(null, "b-creator"), { boardId: "b-creator", order: ["p2", "p1"] });
  const res = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: ME }));
  assert.equal(JSON.parse(res.body).picked.id, "p1");
});

test("a deleted board falls back to consensus instead of stalling the clock", async () => {
  stubWithBoard(boardDraft("b-gone", null), null);
  const res = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: ME }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).picked.id, "p1");
});

test("roster needs still apply on top of the board's order", async () => {
  const d = boardDraft("b-mine", null);
  d.rosterSlots = ["QB", "RB"];
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    const t = cmd?.input?.TableName;
    if (t === "drafts-test" && cmd.input.UpdateExpression) return {};
    if (t === "drafts-test") return { Item: d };
    if (t === "boards-test") return { Item: { boardId: "b-mine", order: ["rb1", "rb2", "qb1"] } };
    return { Items: [
      { sport: "nfl", id: "rb1", name: "RB One", position: "RB", team: "SF", rank: 1 },
      { sport: "nfl", id: "rb2", name: "RB Two", position: "RB", team: "KC", rank: 2 },
      { sport: "nfl", id: "qb1", name: "QB One", position: "QB", team: "BUF", rank: 3 },
    ] };
  });
  // rb1 is already on the roster, so the empty QB slot outweighs rb2's higher
  // board position -- your rankings decide who, roster shape decides when.
  d.picks[0].playerId = "rb1";
  d.picks[0].player = { id: "rb1", position: "RB" };
  d.picked = ["rb1"];
  d.currentIndex = 1;
  d.picks[1].team = 1;
  const res = await handler(evt("POST", "/drafts/d1/expire", { draftId: "d1", claims: ME }));
  assert.equal(JSON.parse(res.body).picked.id, "qb1");
});
```

Add near the top of the file, beside the other env vars:

```js
process.env.BOARDS_TABLE = "boards-test";
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/drafts.test.js`
Expected: the board-driven tests FAIL by picking `p1` (consensus) where `p2` is expected — nothing reads a board yet.

- [ ] **Step 3: Resolve the board and pass its rank in**

In `backend/src/drafts.js`, add beside the other table constants (`const draftsTable = ...`):

```js
  const boardsTable = process.env.BOARDS_TABLE;
```

Add the resolution helper next to `autoPickAndAdvance`:

```js
/**
 * Which board drives this team's auto-pick: the seat's own, else the draft's,
 * else none (consensus).
 *
 * `undefined` and `null` mean different things here and the distinction is
 * the whole point. An absent boardId is a seat that has never chosen, and
 * inherits. An explicit null is a seat that chose "Consensus rankings" -- a
 * decision, which must NOT then be overridden by the creator's board. `??`
 * cannot tell those apart, so this asks whether the property is present.
 */
function boardIdForTeam(draft, teamNum) {
  const seat = (draft?.seats || []).find((s) => s?.team === teamNum);
  if (seat && Object.prototype.hasOwnProperty.call(seat, "boardId")) return seat.boardId;
  return draft?.boardId ?? null;
}
```

In `autoPickAndAdvance`, add the `boardsTable` parameter and use it:

```js
async function autoPickAndAdvance({ d, draftId, playersTable, draftsTable, boardsTable, json }) {
```

```js
  const teamNum = d.picks[d.currentIndex]?.team;
  d.__counts = getRosterCounts(d, teamNum, byId);

  const rankOf =
    (await loadBoardRank({ ddb, boardsTable, boardId: boardIdForTeam(d, teamNum) })) || consensusRank;

  const best = pickBestForTeam(d, teamNum, players, rankOf);
```

Update both call sites (in `/auto-pick` and `/expire`) to pass it:

```js
      return await autoPickAndAdvance({ d, draftId, playersTable, draftsTable, boardsTable, json });
```

And export the helper for testing at the bottom of `drafts.js`:

```js
module.exports.boardIdForTeam = boardIdForTeam;
```

- [ ] **Step 4: Give the Lambda access to the boards table**

In `backend/template.yaml`, under `DraftsFunction` → `Environment` → `Variables`, after `DRAFT_MEMBERS_TABLE`:

```yaml
          BOARDS_TABLE: !Ref BoardsTable
```

and under `Policies`, after the members-table entry:

```yaml
        - DynamoDBReadPolicy:
            TableName: !Ref BoardsTable
```

Read-only: the drafting path reads a board and must never be able to change one.

- [ ] **Step 5: Run the tests**

Run: `cd backend && node --test 'src/**/*.test.js'`
Expected: PASS.

- [ ] **Step 6: Mutation-test the null/undefined distinction and the fallback**

1. Replace the body of `boardIdForTeam` with `return seat?.boardId ?? draft?.boardId ?? null;` → "a seat that explicitly chose consensus does NOT inherit the draft's board" must go **red**.
2. In `boardRank.js`, make `loadBoardRank` rethrow instead of returning null on error → "a deleted board falls back to consensus" must go **red** (or 500).

Restore both, confirm green.

- [ ] **Step 7: Verify the template parses**

Run: `cd backend && sam validate --lint`
Expected: `template.yaml is a valid SAM Template`.

- [ ] **Step 8: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js backend/template.yaml
git commit -m "feat: the clock drafts from the seat's own board"
```

---

### Task 6: `POST /seat-board` — choosing your rankings

**Files:**
- Modify: `backend/src/drafts.js`
- Modify: `backend/template.yaml`
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: `boardIdForTeam` (Task 5).
- Produces: `POST /drafts/{draftId}/seat-board`, body `{ boardId: string | null }`, responding `{ ok: true, boardId }`. `GET /drafts/{draftId}` gains `yourBoardId` — the **effective** board for the caller's seat, resolved through `boardIdForTeam`.

- [ ] **Step 1: Write the failing tests**

```js
test("setting your seat's board writes only your seat", async () => {
  let update = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    const t = cmd?.input?.TableName;
    if (t === "drafts-test" && cmd.input.UpdateExpression) { update = cmd.input; return {}; }
    if (t === "drafts-test") return { Item: ownedDraft(ME.sub) };
    return { Item: { boardId: "b1", ownerId: ME.sub } };
  });
  const res = await handler(evt("POST", "/drafts/d1/seat-board", { draftId: "d1", body: { boardId: "b1" }, claims: ME }));
  assert.equal(res.statusCode, 200);
  assert.match(update.UpdateExpression, /seats\[0\]\.boardId = :b/);
  assert.match(update.ConditionExpression, /seats\[0\]\.#sub = :me/);
  assert.equal(update.ExpressionAttributeValues[":b"], "b1");
});

test("a seat cannot be pointed at somebody else's board", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    const t = cmd?.input?.TableName;
    if (t === "drafts-test") return { Item: ownedDraft(ME.sub) };
    return { Item: { boardId: "b1", ownerId: THEM.sub } };
  });
  const res = await handler(evt("POST", "/drafts/d1/seat-board", { draftId: "d1", body: { boardId: "b1" }, claims: ME }));
  assert.equal(res.statusCode, 400);
});

test("null means consensus, and is stored rather than ignored", async () => {
  let update = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.UpdateExpression) { update = cmd.input; return {}; }
    return { Item: ownedDraft(ME.sub) };
  });
  const res = await handler(evt("POST", "/drafts/d1/seat-board", { draftId: "d1", body: { boardId: null }, claims: ME }));
  assert.equal(res.statusCode, 200);
  assert.equal(update.ExpressionAttributeValues[":b"], null);
});

test("an unseated caller gets 404, not 403", async () => {
  stubSend({ Item: ownedDraft(ME.sub) });
  const res = await handler(evt("POST", "/drafts/d1/seat-board", { draftId: "d1", body: { boardId: null }, claims: THEM }));
  assert.equal(res.statusCode, 404);
});

test("GET reports the effective board for your seat", async () => {
  const d = ownedDraft(ME.sub);
  d.boardId = "b-creator";
  stubSend({ Item: d });
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.equal(JSON.parse(res.body).yourBoardId, "b-creator");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/drafts.test.js`
Expected: the first four FAIL (no route); the last FAILS with `yourBoardId` `undefined`.

- [ ] **Step 3: Add the route**

Add `canMutate` to the `./lib/owner` import in `backend/src/drafts.js`, then add after the `/pause` block:

```js
    // POST /drafts/{draftId}/seat-board  { boardId: string | null }
    //
    // Which rankings the clock uses when it drafts for you. Lives here rather
    // than on the join screen because joining claims the seat instantly, with
    // no UI -- a chooser in front of that would leave the seat unclaimed while
    // somebody deliberates, which is exactly when a friend clicking the same
    // link takes the last one.
    if (method === "POST" && draftId && path.endsWith("/seat-board")) {
      if (!sub) return needsAuth();
      const body = event.body ? JSON.parse(event.body) : {};
      const raw = typeof body.boardId === "string" ? body.boardId.trim() : "";
      const boardId = raw.length > 0 && raw.length <= 64 ? raw : null;

      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;
      const i = (d.seats || []).findIndex((s) => s?.kind === "human" && s?.sub === sub);
      if (i < 0) return notFound();

      // A seat must not be pointed at rankings its holder does not own --
      // otherwise anyone in the draft could have the clock draft for them out
      // of a board they merely know the id of.
      if (boardId) {
        const b = await ddb.send(new GetCommand({ TableName: boardsTable, Key: { boardId } }));
        if (!b.Item || !canMutate(b.Item, sub)) return json(400, { error: "That board isn't yours" });
      }

      await ddb.send(
        new UpdateCommand({
          TableName: draftsTable,
          Key: { draftId },
          // Always writes the attribute, null included: once touched, this
          // seat's choice is authoritative and stops inheriting the draft's
          // board. See boardIdForTeam.
          UpdateExpression: `SET seats[${i}].boardId = :b, version = if_not_exists(version, :z) + :one`,
          ConditionExpression: `seats[${i}].#sub = :me`,
          ExpressionAttributeNames: { "#sub": "sub" },
          ExpressionAttributeValues: { ":b": boardId, ":me": sub, ":z": 0, ":one": 1 },
        })
      );

      return json(200, { ok: true, boardId });
    }
```

- [ ] **Step 4: Return the effective board on GET**

In the `GET /drafts/{draftId}` response, after `boardId: d.boardId || null,`:

```js
        // The board that would actually drive YOUR auto-pick, already
        // resolved -- the page shows a choice, not a three-state puzzle.
        // Other seats' boards are not exposed, for the same least-data
        // reason their `sub` is not.
        yourBoardId: boardIdForTeam(d, seatOf(d, sub)?.team ?? null),
```

- [ ] **Step 5: Declare the route**

In `backend/template.yaml`, after `PauseDraft`:

```yaml
        SeatBoard:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /drafts/{draftId}/seat-board
            Method: POST
            Auth:
              Authorizer: CognitoAuth
```

- [ ] **Step 6: Run the tests**

Run: `cd backend && node --test 'src/**/*.test.js'` then `cd backend && sam validate --lint`
Expected: all tests PASS; template valid.

- [ ] **Step 7: Mutation-test the ownership check**

Delete the `if (boardId) { ... }` ownership block. "a seat cannot be pointed at somebody else's board" must go **red**. Restore, confirm green. Then delete the `ConditionExpression` on the update and confirm "setting your seat's board writes only your seat" goes red.

- [ ] **Step 8: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js backend/template.yaml
git commit -m "feat: choose which board the clock drafts from"
```

---

### Task 7: The page renders the server's clock

**Files:**
- Create: `frontend/src/lib/clock.js`
- Create: `frontend/src/lib/clock.test.js`
- Modify: `frontend/src/pages/Draft.jsx`
- Modify: `frontend/tests/fixtures.js`
- Test: `frontend/tests/draft.spec.js`

**Note on this project's frontend testing.** There is no React component test
stack — no jsdom, no Testing Library, and `npm test` *is* Playwright. Unit
tests (`npm run test:unit` → `node --test "src/**/*.test.js"`) cover pure
modules under `src/lib/` only, and files must be `.js`, not `.jsx`, to match
that glob. So the arithmetic goes in a pure module with unit tests, and the
wiring is proved in Playwright. Do not add a component test framework.

**Interfaces:**
- Consumes: `pickDeadline`, `now`, `pausedAt` from `GET /drafts/{draftId}` (Task 1); `POST /expire` (Task 2).
- Produces: `frontend/src/lib/clock.js` exporting `skewFrom(serverNow, clientNow)`, `remainingSeconds(deadline, skew, clientNow)`, `expireDelayMs(seatIndex, step)`. Fixture `makeDraftState` gains `pickDeadline`, `now`, `pausedAt`, `pausedBy`, `yourBoardId`; `mockDraftApis` gains `/expire` and `/pause` routes.

- [ ] **Step 1: Write the failing unit tests**

Create `frontend/src/lib/clock.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { skewFrom, remainingSeconds, expireDelayMs } from "./clock.js";

test("skew is the server's clock minus this browser's", () => {
  assert.equal(skewFrom(1000, 400), 600);
  assert.equal(skewFrom(undefined, 400), 0, "a response without `now` must not shift the clock");
  assert.equal(skewFrom(null, 400), 0);
});

test("a browser running fast does not shorten the turn", () => {
  // Server says it is 1000; this browser thinks it is 3000, two seconds fast.
  const skew = skewFrom(1000, 3000);
  // Deadline is 30s after the server's now.
  assert.equal(remainingSeconds(31000, skew, 3000), 30);
  // Without the correction the same numbers read as 28 -- the fast browser
  // would hand back two seconds of somebody's turn.
  assert.equal(remainingSeconds(31000, 0, 3000), 28);
});

test("remaining time clamps at zero and never goes negative", () => {
  assert.equal(remainingSeconds(1000, 0, 99999), 0);
});

test("no deadline means no countdown, which is not the same as zero", () => {
  assert.equal(remainingSeconds(null, 0, 1000), null);
  assert.equal(remainingSeconds(undefined, 0, 1000), null);
});

test("expire calls are staggered by seat so they do not all arrive together", () => {
  assert.equal(expireDelayMs(0), 0);
  assert.equal(expireDelayMs(3), 750);
  assert.equal(expireDelayMs(-1), 0, "an unknown seat must not produce a negative delay");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — `Cannot find module './clock.js'`.

- [ ] **Step 3: Write `frontend/src/lib/clock.js`**

```js
/**
 * The clock, as arithmetic.
 *
 * Pure on purpose: this project has no component test stack, so anything that
 * needs real test coverage has to be reachable from node --test. The page
 * below is left with wiring only.
 */

/**
 * How far ahead the server's clock is of this browser's.
 *
 * Measured on every load rather than assumed to be zero, because a laptop
 * running two minutes fast would otherwise see every deadline already passed,
 * render 0, and hammer /expire against a clock that has not run out.
 */
export function skewFrom(serverNow, clientNow = Date.now()) {
  return typeof serverNow === "number" ? serverNow - clientNow : 0;
}

/**
 * Seconds left, or null when the draft carries no deadline at all -- a row
 * written before the clock shipped. Null and 0 must stay distinguishable:
 * one means "no clock here", the other means "time is up, call /expire".
 */
export function remainingSeconds(deadline, skew = 0, clientNow = Date.now()) {
  if (deadline == null) return null;
  return Math.max(0, Math.ceil((deadline - (clientNow + skew)) / 1000));
}

/**
 * Everyone watching notices zero in the same second. Staggering by seat means
 * they arrive in order rather than together: the losers still get a harmless
 * 409, but the logs stay readable.
 */
export function expireDelayMs(seatIndex, step = 250) {
  return Math.max(0, seatIndex) * step;
}
```

- [ ] **Step 4: Run the unit tests**

Run: `cd frontend && npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Teach the fixtures about the clock**

In `frontend/tests/fixtures.js`, add to `makeDraftState`'s destructured options, with comments in the style of the `inviteToken` and `seats` notes already there:

```js
  // Every real GET carries these now. pickDeadline defaults a full minute out
  // so existing tests render a running clock that never reaches zero -- a
  // fixture that expired mid-test would have the page firing /expire into
  // whatever else that test was asserting.
  pickDeadline = Date.now() + 60000,
  pausedAt = null,
  pausedBy = null,
  yourBoardId = null,
```

and to the returned `state` object:

```js
    pickDeadline,
    pausedAt,
    pausedBy,
    yourBoardId,
    // The page measures clock skew against this. A fixture omitting it would
    // silently exercise the zero-skew path only.
    now: Date.now(),
```

In `mockDraftApis(page, draftState)`, add routes for the two new endpoints. **Pause has to be stateful**, because several existing tests in `draft.spec.js` use "click Pause" as their stable way to reach `canManualPick === false`, and once pause is the server's state a mock that returns `{ok:true}` without changing what the GET serves leaves the page unpaused and breaks them:

```js
  // Pause is server state as of Phase 2. The GET route above must serve the
  // draft as it is NOW, so mutate the object the GET closes over rather than
  // answering ok and forgetting.
  page.route(`${API_BASE}/drafts/${DRAFT_ID}/pause`, async (r) => {
    const { paused } = JSON.parse(r.request().postData() || "{}");
    draftState.pausedAt = paused ? Date.now() : null;
    draftState.pausedBy = paused ? "me" : null;
    if (!paused) draftState.pickDeadline = Date.now() + 60000;
    return r.fulfill({ json: { ok: true, pausedAt: draftState.pausedAt } });
  });

  page.route(`${API_BASE}/drafts/${DRAFT_ID}/expire`, (r) =>
    r.fulfill({ status: 409, json: { error: "Clock has not expired" } })
  );
```

Confirm the GET route in `mockDraftApis` serves the live object (`r.fulfill({ json: draftState })` evaluated per request), not a snapshot taken when the mock was installed. If it captured a copy, change it to read `draftState` at request time.

- [ ] **Step 6: Run the existing Playwright suite before touching the page**

Run: `cd frontend && npm test`
Expected: PASS, same count as before the fixture change. This step exists to prove the fixture change alone broke nothing.

- [ ] **Step 7: Replace the clock in `Draft.jsx`**

Import the module:

```js
import { skewFrom, remainingSeconds, expireDelayMs } from "../lib/clock";
```

Retitle the constant — it is now only a display fallback:

```js
// Display fallback only. The server owns the clock; this is what the page
// shows for a draft written before pickDeadline existed.
const PICK_SECONDS = 60;
```

Add a skew ref beside the other refs:

```js
  const skewRef = useRef(0);
```

In the draft-loading function, immediately after the response lands:

```js
      skewRef.current = skewFrom(data.now);
```

Delete the "Reset timer on new pick" effect and the countdown effect, and replace both with one driven by the deadline. There is no reset-on-turn effect any more: the deadline already changed when the draft advanced, so there is nothing for the client to reset.

```js
  const deadline = draft?.pickDeadline ?? null;
  const serverPaused = draft?.pausedAt != null;

  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (!hasDraft || completed || serverPaused) {
      setSecondsLeft(0);
      return;
    }

    const tick = () => setSecondsLeft(remainingSeconds(deadline, skewRef.current) ?? PICK_SECONDS);
    tick();
    tickRef.current = setInterval(tick, 1000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [hasDraft, deadline, completed, serverPaused]);
```

Add the expire call, replacing the old "runs out of time → autoPick" effect:

```js
  const expire = async () => {
    try {
      await apiPost(`/drafts/${draftId}/expire`, {});
      await load();
    } catch (e) {
      // 409 is the ordinary outcome for everyone who lost the race, and for a
      // clock that turned out not to have expired. Re-read rather than
      // reporting it -- the board is the answer.
      if (e.status === 409) { await load(); return; }
      setErr(mutationErrorMessage(e, "Could not advance the clock"));
    }
  };

  const seatIndex = seats.findIndex((s) => s?.team === myTeam);

  useEffect(() => {
    if (!draft) return;
    if (serverPaused || busy || draft.completed) return;
    if (deadline == null) return;
    if (secondsLeft > 0) return;

    const t = setTimeout(expire, expireDelayMs(seatIndex));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, deadline, serverPaused, busy, draft?.completed, seatIndex]);
```

Delete the `shared` constant and both of its guards — the clock now runs for everyone. Leave the bot auto-pick effect exactly as it is.

Give the countdown element `data-testid="pick-countdown"` where it renders.

- [ ] **Step 8: Write the Playwright tests**

In `frontend/tests/draft.spec.js`, matching the idiom already in that file (`mockDraftApis(page, state)`, then `await signIn(page)`, then `await page.goto(...)`):

```js
test("the countdown runs in a shared draft", async ({ page }) => {
  // Phase 1 disabled the clock entirely whenever a second human was seated.
  // The regression this guards is that guard coming back.
  const seats = Array.from({ length: 12 }, (_, i) => {
    const team = i + 1;
    if (team === 1) return { team, sub: "me", kind: "human" };
    if (team === 2) return { team, sub: "them", kind: "human" };
    return { team, sub: null, kind: "bot" };
  });
  const state = makeDraftState({ seats, pickDeadline: Date.now() + 25000 });
  mockDraftApis(page, state);

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByTestId("pick-countdown")).toContainText(/2[0-5]/);
});

test("reaching zero asks the server to expire the clock, and does not auto-pick", async ({ page }) => {
  const state = makeDraftState({ pickDeadline: Date.now() - 1000 });
  mockDraftApis(page, state);

  let expires = 0;
  let autoPicks = 0;
  await page.route(`${API}/drafts/${DRAFT_ID}/expire`, (r) => {
    expires += 1;
    return r.fulfill({ status: 409, json: { error: "Clock has not expired" } });
  });
  await page.route(`${API}/drafts/${DRAFT_ID}/auto-pick`, (r) => {
    autoPicks += 1;
    return r.fulfill({ json: { ok: true } });
  });

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect.poll(() => expires).toBeGreaterThan(0);
  expect(autoPicks).toBe(0);
});

test("a draft with no stored deadline still renders, and asks nothing of the server", async ({ page }) => {
  // Rows created before this shipped carry no pickDeadline.
  const state = makeDraftState({ pickDeadline: null });
  mockDraftApis(page, state);
  let expires = 0;
  await page.route(`${API}/drafts/${DRAFT_ID}/expire`, (r) => {
    expires += 1;
    return r.fulfill({ status: 409, json: {} });
  });

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByTestId("big-board-row").first()).toBeVisible();
  expect(expires).toBe(0);
});
```

- [ ] **Step 9: Run everything**

Run: `cd frontend && npm run test:unit && npm run lint && npm test`
Expected: all PASS. Check Playwright's printed totals, not just the exit code.

- [ ] **Step 10: Mutation-test the skew correction**

In `clock.js`, change `deadline - (clientNow + skew)` to `deadline - clientNow`. The unit test "a browser running fast does not shorten the turn" must go **red**. Restore, confirm green.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/lib/clock.js frontend/src/lib/clock.test.js frontend/src/pages/Draft.jsx frontend/tests/fixtures.js frontend/tests/draft.spec.js
git commit -m "feat: render the server's clock, and ask it to enforce itself"
```

---

### Task 8: Pause becomes everyone's pause

**Files:**
- Modify: `frontend/src/pages/Draft.jsx`
- Test: `frontend/tests/draft.spec.js`

**Interfaces:**
- Consumes: `POST /drafts/{draftId}/pause` (Task 3); `pausedAt`/`pausedBy` from GET (Task 1); the stateful pause route added to `mockDraftApis` in Task 7.
- Produces: nothing exported.

- [ ] **Step 1: Write the failing Playwright tests**

```js
test("pausing posts to the server rather than stopping one browser", async ({ page }) => {
  const state = makeDraftState({});
  mockDraftApis(page, state);
  let posted = null;
  await page.route(`${API}/drafts/${DRAFT_ID}/pause`, async (r) => {
    posted = JSON.parse(r.request().postData() || "{}");
    state.pausedAt = Date.now();
    state.pausedBy = "me";
    return r.fulfill({ json: { ok: true, pausedAt: state.pausedAt } });
  });

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect.poll(() => posted?.paused).toBe(true);
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
});

test("a draft somebody else paused shows as paused here", async ({ page }) => {
  const state = makeDraftState({ pausedAt: Date.now(), pausedBy: "them" });
  mockDraftApis(page, state);

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(page.getByTestId("pick-countdown")).toHaveCount(0);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd frontend && npm test -- draft.spec.js`
Expected: FAIL — the button only flips local state, and a server-paused draft renders as running.

- [ ] **Step 3: Replace local pause with the server's**

In `frontend/src/pages/Draft.jsx`, delete `const [paused, setPaused] = useState(false);` and derive it:

```js
  // Pause is the draft's state, not this browser's. A pause that stopped only
  // one person's clock would be worse than none: everyone else keeps ticking,
  // and the person who paused gets auto-picked while they think.
  const paused = draft?.pausedAt != null;
```

Add the mutation:

```js
  const togglePause = async () => {
    setBusy(true);
    try {
      await apiPost(`/drafts/${draftId}/pause`, { paused: !paused });
      await load();
    } catch (e) {
      setErr(mutationErrorMessage(e, "Could not pause the draft"));
    } finally {
      setBusy(false);
    }
  };
```

Point the existing Pause/Resume button at `togglePause`. When `draft.pausedBy` is set and is not your own seat, render who paused it beside the label.

- [ ] **Step 4: Run everything**

Run: `cd frontend && npm run test:unit && npm run lint && npm test`
Expected: PASS — **including the pre-existing tests that click Pause to reach `canManualPick === false`.** If any of those fail, the stateful pause route from Task 7 Step 5 is not serving the mutated state; fix the fixture, not the test.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Draft.jsx frontend/tests/draft.spec.js
git commit -m "feat: pause stops everyone's clock, not just yours"
```

---

### Task 9: The seat board picker

**Files:**
- Create: `frontend/src/lib/seatBoard.js`
- Create: `frontend/src/lib/seatBoard.test.js`
- Modify: `frontend/src/pages/Draft.jsx`
- Test: `frontend/tests/draft.spec.js`

**Interfaces:**
- Consumes: `fetchMyBoards()` from `frontend/src/lib/me.js`, which returns `[{ id, name, format, season, updatedAt }]`; `yourBoardId` from GET (Task 6); `POST /seat-board` (Task 6).
- Produces: `frontend/src/lib/seatBoard.js` exporting `CONSENSUS` (`""`), `boardOptions(myBoards, yourBoardId)` → `[{ value, label }]`, and `boardIdFromValue(value)` → `string | null`.

- [ ] **Step 1: Write the failing unit tests**

Create `frontend/src/lib/seatBoard.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { boardOptions, boardIdFromValue, CONSENSUS } from "./seatBoard.js";

test("consensus is always offered, first", () => {
  const opts = boardOptions([], null);
  assert.equal(opts[0].value, CONSENSUS);
  assert.match(opts[0].label, /consensus/i);
});

test("your own boards are listed", () => {
  const opts = boardOptions([{ id: "b1", name: "Zero RB" }], null);
  assert.deepEqual(opts.map((o) => o.value), [CONSENSUS, "b1"]);
  assert.equal(opts[1].label, "Zero RB");
});

test("an inherited board you do not own is still offered, so the select is not blank", () => {
  // The seat inherits the draft's board, which belongs to whoever created it
  // and so is absent from your list. Without this entry the select renders
  // empty and quietly misreports what the clock will actually do.
  const opts = boardOptions([{ id: "b1", name: "Zero RB" }], "b-creator");
  assert.ok(opts.some((o) => o.value === "b-creator"));
  assert.match(opts.find((o) => o.value === "b-creator").label, /draft's board/i);
});

test("a board that IS yours is not offered twice", () => {
  const opts = boardOptions([{ id: "b1", name: "Zero RB" }], "b1");
  assert.equal(opts.filter((o) => o.value === "b1").length, 1);
});

test("an unnamed board still gets a label", () => {
  assert.equal(boardOptions([{ id: "b1" }], null)[1].label, "Untitled board");
});

test("the empty value means consensus, not 'unset'", () => {
  assert.equal(boardIdFromValue(""), null);
  assert.equal(boardIdFromValue("b1"), "b1");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — `Cannot find module './seatBoard.js'`.

- [ ] **Step 3: Write `frontend/src/lib/seatBoard.js`**

```js
/** The empty option's value. Distinct from "unset" -- see boardIdFromValue. */
export const CONSENSUS = "";

/**
 * The options for "Auto-pick from".
 *
 * Your own boards, plus consensus, plus -- when the seat currently inherits a
 * board that is not yours -- an entry for that board. A select whose value
 * matches no option renders blank, which here would mean the page showing
 * nothing while the clock quietly drafts from the creator's rankings.
 */
export function boardOptions(myBoards, yourBoardId) {
  const list = Array.isArray(myBoards) ? myBoards : [];
  const opts = [{ value: CONSENSUS, label: "Consensus rankings" }];
  for (const b of list) opts.push({ value: b.id, label: b.name || "Untitled board" });
  if (yourBoardId && !list.some((b) => b.id === yourBoardId)) {
    opts.push({ value: yourBoardId, label: "The draft's board" });
  }
  return opts;
}

/**
 * Null is a decision here, not an absence: it means "I chose consensus", and
 * the server stores it so the seat stops inheriting the draft's board.
 */
export function boardIdFromValue(value) {
  return value === CONSENSUS ? null : value;
}
```

- [ ] **Step 4: Run the unit tests**

Run: `cd frontend && npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Add the control to `Draft.jsx`**

```js
import { fetchMyBoards } from "../lib/me";
import { boardOptions, boardIdFromValue } from "../lib/seatBoard";
```

```js
  const [myBoards, setMyBoards] = useState([]);
  useEffect(() => {
    let alive = true;
    fetchMyBoards()
      .then((bs) => { if (alive) setMyBoards(bs); })
      // Losing this costs the picker, not the draft. Never surface it as a
      // draft error.
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const setSeatBoard = async (value) => {
    try {
      await apiPost(`/drafts/${draftId}/seat-board`, { boardId: boardIdFromValue(value) });
      await load();
    } catch (e) {
      setErr(mutationErrorMessage(e, "Could not change your board"));
    }
  };
```

In the header row, beside Pause:

```jsx
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                Auto-pick from
                <select
                  data-testid="seat-board"
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200"
                  value={draft.yourBoardId ?? ""}
                  onChange={(e) => setSeatBoard(e.target.value)}
                  disabled={busy || draft.completed}
                >
                  {boardOptions(myBoards, draft.yourBoardId).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
```

- [ ] **Step 6: Write the Playwright test**

```js
test("changing your board persists the choice", async ({ page }) => {
  const state = makeDraftState({ yourBoardId: null });
  mockDraftApis(page, state);
  await page.route(`${API}/me/boards`, (r) =>
    r.fulfill({ json: { boards: [{ id: "b1", name: "Zero RB" }] } })
  );
  let posted = null;
  await page.route(`${API}/drafts/${DRAFT_ID}/seat-board`, async (r) => {
    posted = JSON.parse(r.request().postData() || "{}");
    state.yourBoardId = posted.boardId;
    return r.fulfill({ json: { ok: true, boardId: posted.boardId } });
  });

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByTestId("seat-board").selectOption("b1");
  await expect.poll(() => posted?.boardId).toBe("b1");
});
```

If `mockDraftApis` does not already route `/me/boards`, add a default there returning `{ boards: [] }` so every other test in the file keeps a quiet console.

- [ ] **Step 7: Run everything**

Run: `cd frontend && npm run test:unit && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 8: Mutation-test the inherited-board option**

In `seatBoard.js`, delete the `if (yourBoardId && !list.some(...))` block. "an inherited board you do not own is still offered" must go **red**. Restore, confirm green.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/seatBoard.js frontend/src/lib/seatBoard.test.js frontend/src/pages/Draft.jsx frontend/tests/draft.spec.js
git commit -m "feat: choose the board your clock drafts from, mid-draft"
```

---

### Task 10: The whole feature, end to end

**Files:**
- Modify: `frontend/tests/draft.spec.js`
- Modify: the Draft page screenshot under `screenshots/` that `README.md` displays
- Test: the full suite

**Interfaces:**
- Consumes: everything above.
- Produces: no code interfaces. This is the whole-feature gate.

- [ ] **Step 1: Write the end-to-end test**

The one path no earlier task covers: a seat that actually gets picked for when its clock runs out, with the board driving the choice.

```js
test("a seat whose clock runs out is picked for, from its own board", async ({ page }) => {
  const state = makeDraftState({ pickDeadline: Date.now() - 1000, yourBoardId: "b1" });
  mockDraftApis(page, state);
  await page.route(`${API}/me/boards`, (r) =>
    r.fulfill({ json: { boards: [{ id: "b1", name: "Zero RB" }] } })
  );

  // The server's answer to /expire: it made the pick, so the next GET shows a
  // draft that has moved on.
  await page.route(`${API}/drafts/${DRAFT_ID}/expire`, (r) => {
    const picked = MOCK_PLAYERS[1];
    state.picks[0].playerId = picked.id;
    state.picks[0].player = picked;
    state.picked = [picked.id];
    state.currentIndex = 1;
    state.pickDeadline = Date.now() + 60000;
    return r.fulfill({ json: { ok: true, picked } });
  });

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);

  // The page asked, the server answered, and the board reflects it without
  // anybody clicking anything.
  await expect(page.getByTestId("draft-board")).toContainText(MOCK_PLAYERS[1].name);
});
```

Adjust the `getByTestId` selector to whichever the draft board panel actually uses in this file — grep `draft.spec.js` for the existing pick-log assertions and match them.

- [ ] **Step 2: Run the whole suite**

```bash
cd backend && node --test 'src/**/*.test.js'
cd ../frontend && npm run test:unit && npm run lint && npm test
```

Expected: all green. Record the exact counts in the task report. **A Playwright run that prints a partial count with exit 0 is not a pass** — this machine has produced "132 of 213 passed" with a zero exit before. Read the printed totals, not the exit code.

- [ ] **Step 3: Refresh the Draft page screenshot**

The Draft page header gained the board picker and its pause changed meaning, and `README.md` displays these screenshots. `draft.spec.js` already writes screenshots to `../../screenshots` (see the `SCREENSHOTS` constant at the top of that file) — regenerate the Draft page image through that same path and commit it with the code.

- [ ] **Step 4: Commit**

```bash
git add frontend/tests/draft.spec.js screenshots/
git commit -m "test: the shared clock, end to end"
```
