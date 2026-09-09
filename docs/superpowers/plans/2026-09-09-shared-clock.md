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

Run: `cd backend && node --test src/`
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

Run: `cd backend && node --test src/`
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

Run: `cd backend && node --test src/`
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

Run: `cd backend && node --test src/`
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

Run: `cd backend && node --test src/`
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

Run: `cd backend && node --test src/` then `cd backend && sam validate --lint`
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
- Modify: `frontend/src/pages/Draft.jsx`
- Test: `frontend/src/pages/Draft.test.jsx`

**Interfaces:**
- Consumes: `pickDeadline`, `now`, `pausedAt` from `GET /drafts/{draftId}` (Task 1); `POST /expire` (Task 2).
- Produces: no exports; the page now calls `/expire` rather than `/auto-pick` on timeout.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/pages/Draft.test.jsx`, following the existing fixture idiom (`makeDraftState`, `mockDraftApis`):

```js
test("the countdown comes from the server's deadline, not a local 60", async () => {
  const state = makeDraftState({ pickDeadline: Date.now() + 12000, now: Date.now() });
  render(<Draft />, mockDraftApis(state));
  await screen.findByText(/0:12|12s/);
});

test("a fast client clock does not shorten the turn", async () => {
  // Client thinks it is two minutes later than the server does.
  const serverNow = Date.now() - 120000;
  const state = makeDraftState({ pickDeadline: serverNow + 30000, now: serverNow });
  render(<Draft />, mockDraftApis(state));
  // Without skew correction this renders 0 and fires /expire immediately.
  await screen.findByText(/0:30|30s/);
});

test("the countdown runs in a shared draft", async () => {
  const state = makeDraftState({
    pickDeadline: Date.now() + 20000,
    now: Date.now(),
    seats: [{ team: 1, kind: "human" }, { team: 2, kind: "human" }],
  });
  render(<Draft />, mockDraftApis(state));
  await screen.findByText(/0:20|20s/);
});

test("reaching zero calls /expire, not /auto-pick", async () => {
  const calls = [];
  const state = makeDraftState({ pickDeadline: Date.now() - 1, now: Date.now() });
  render(<Draft />, mockDraftApis(state, { onPost: (p) => calls.push(p) }));
  await waitFor(() => assert.ok(calls.some((p) => p.endsWith("/expire"))));
  assert.ok(!calls.some((p) => p.endsWith("/auto-pick")), "the timeout path no longer drafts directly");
});

test("a paused draft shows no countdown", async () => {
  const state = makeDraftState({ pickDeadline: Date.now() + 20000, now: Date.now(), pausedAt: Date.now() });
  render(<Draft />, mockDraftApis(state));
  assert.equal(screen.queryByTestId("pick-countdown"), null);
});
```

Extend `makeDraftState` so its default fixture carries `pickDeadline`, `now`, `pausedAt: null`, `pausedBy: null`, and `yourBoardId: null` — **the response shape the server actually returns.** Phase 1 lost two review cycles to fixtures that omitted fields the code read.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd frontend && npm test`
Expected: the new tests FAIL — the countdown still starts at 60 and the timeout still posts `/auto-pick`.

- [ ] **Step 3: Replace the clock**

In `frontend/src/pages/Draft.jsx`:

Keep `const PICK_SECONDS = 60;` but retitle its comment — it is now only a display fallback for a draft with no deadline stored (rows created before this shipped):

```js
// Display fallback only. The server owns the clock; this is what the page
// shows for a draft written before pickDeadline existed.
const PICK_SECONDS = 60;
```

Add a skew ref beside the other refs:

```js
  // The server's clock minus this browser's, measured on every load. A laptop
  // running two minutes fast would otherwise see every deadline already
  // passed and hammer /expire.
  const skewRef = useRef(0);
```

In the draft-loading function, immediately after the response lands:

```js
      if (typeof data.now === "number") skewRef.current = data.now - Date.now();
```

Replace the "Reset timer on new pick" effect and the countdown effect with a single one driven by the deadline:

```js
  const deadline = draft?.pickDeadline ?? null;
  const serverPaused = draft?.pausedAt != null;

  // One interval, driven by the server's deadline. No reset-on-turn effect:
  // the deadline already changed when the draft advanced, so there is nothing
  // for the client to reset.
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (!hasDraft || completed || serverPaused || deadline == null) {
      setSecondsLeft(0);
      return;
    }

    const remaining = () =>
      Math.max(0, Math.ceil((deadline - (Date.now() + skewRef.current)) / 1000));

    setSecondsLeft(remaining());
    tickRef.current = setInterval(() => setSecondsLeft(remaining()), 1000);
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
      // reporting it: the board is the answer.
      if (e.status === 409) { await load(); return; }
      setErr(mutationErrorMessage(e, "Could not advance the clock"));
    }
  };

  // Everyone watching notices zero at the same moment. Staggering by seat
  // index means they arrive in order instead of together -- the losers still
  // get a harmless 409, but the logs stay readable.
  const seatIndex = Math.max(0, seats.findIndex((s) => s?.team === myTeam));

  useEffect(() => {
    if (!draft) return;
    if (serverPaused || busy || draft.completed) return;
    if (deadline == null) return;
    if (secondsLeft > 0) return;

    const t = setTimeout(expire, seatIndex * 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, deadline, serverPaused, busy, draft?.completed, seatIndex]);
```

Delete the `shared` constant and both of its guards — the clock now runs for everyone. Leave the bot auto-pick effect exactly as it is.

Give the countdown element `data-testid="pick-countdown"` where it renders.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Mutation-test the skew correction**

Change `deadline - (Date.now() + skewRef.current)` to `deadline - Date.now()`. "a fast client clock does not shorten the turn" must go **red**. Restore, confirm green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Draft.jsx frontend/src/pages/Draft.test.jsx
git commit -m "feat: render the server's clock, and ask it to enforce itself"
```

---

### Task 8: Pause becomes everyone's pause

**Files:**
- Modify: `frontend/src/pages/Draft.jsx`
- Test: `frontend/src/pages/Draft.test.jsx`

**Interfaces:**
- Consumes: `POST /drafts/{draftId}/pause` (Task 3); `pausedAt`/`pausedBy` from GET (Task 1).
- Produces: nothing exported.

- [ ] **Step 1: Write the failing tests**

```js
test("the pause button posts to the server", async () => {
  const posts = [];
  render(<Draft />, mockDraftApis(makeDraftState(), { onPost: (p, b) => posts.push([p, b]) }));
  fireEvent.click(await screen.findByRole("button", { name: /pause/i }));
  await waitFor(() => assert.ok(posts.some(([p, b]) => p.endsWith("/pause") && b.paused === true)));
});

test("a draft paused by somebody else shows as paused here", async () => {
  const state = makeDraftState({ pausedAt: Date.now(), pausedBy: "user-them" });
  render(<Draft />, mockDraftApis(state));
  await screen.findByText(/paused/i);
  assert.equal(screen.queryByTestId("pick-countdown"), null);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd frontend && npm test`
Expected: FAIL — the button only flips local state, and a server-paused draft renders as running.

- [ ] **Step 3: Replace local pause with the server's**

In `frontend/src/pages/Draft.jsx`, delete `const [paused, setPaused] = useState(false);` and derive it:

```js
  // Pause is the draft's state, not this browser's. A pause that stopped only
  // one person's clock would be worse than none: everyone else keeps ticking
  // and the pauser gets auto-picked while they think.
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

Point the existing Pause/Resume button at `togglePause`, and render who paused it beside the label when `draft.pausedBy` is set and is not your own seat.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Draft.jsx frontend/src/pages/Draft.test.jsx
git commit -m "feat: pause stops everyone's clock, not just yours"
```

---

### Task 9: The seat board picker

**Files:**
- Modify: `frontend/src/pages/Draft.jsx`
- Test: `frontend/src/pages/Draft.test.jsx`

**Interfaces:**
- Consumes: `fetchMyBoards()` from `frontend/src/lib/me.js` (returns `[{ id, name, format, season, updatedAt }]`); `yourBoardId` from GET (Task 6); `POST /seat-board` (Task 6).
- Produces: nothing exported.

- [ ] **Step 1: Write the failing tests**

```js
test("the picker lists your boards and shows the seat's current choice", async () => {
  const state = makeDraftState({ yourBoardId: "b2" });
  render(<Draft />, mockDraftApis(state, {
    boards: [{ id: "b1", name: "Zero RB" }, { id: "b2", name: "Hero RB" }],
  }));
  const select = await screen.findByTestId("seat-board");
  assert.equal(select.value, "b2");
  assert.ok(screen.getByRole("option", { name: /zero rb/i }));
  assert.ok(screen.getByRole("option", { name: /consensus/i }));
});

test("changing it persists the choice", async () => {
  const posts = [];
  render(<Draft />, mockDraftApis(makeDraftState({ yourBoardId: null }), {
    boards: [{ id: "b1", name: "Zero RB" }],
    onPost: (p, b) => posts.push([p, b]),
  }));
  fireEvent.change(await screen.findByTestId("seat-board"), { target: { value: "b1" } });
  await waitFor(() => assert.ok(posts.some(([p, b]) => p.endsWith("/seat-board") && b.boardId === "b1")));
});

test("a board you do not own still renders as the current choice", async () => {
  // Inherited from the draft's board -- the creator's, which is not in your
  // list. Showing an empty select would be a lie about what the clock does.
  const state = makeDraftState({ yourBoardId: "b-creator" });
  render(<Draft />, mockDraftApis(state, { boards: [{ id: "b1", name: "Zero RB" }] }));
  const select = await screen.findByTestId("seat-board");
  assert.equal(select.value, "b-creator");
  assert.ok(screen.getByRole("option", { name: /draft's board/i }));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd frontend && npm test`
Expected: FAIL — no `seat-board` element exists.

- [ ] **Step 3: Add the picker**

In `frontend/src/pages/Draft.jsx`, import the helper:

```js
import { fetchMyBoards } from "../lib/me";
```

Load the list once:

```js
  const [myBoards, setMyBoards] = useState([]);
  useEffect(() => {
    let alive = true;
    fetchMyBoards()
      .then((bs) => { if (alive) setMyBoards(bs); })
      // A failure here costs the picker, not the draft. Never surface it as a
      // draft error.
      .catch(() => {});
    return () => { alive = false; };
  }, []);
```

Add the mutation and the control (place it in the header row, beside Pause):

```js
  const setSeatBoard = async (value) => {
    const boardId = value === "" ? null : value;
    try {
      await apiPost(`/drafts/${draftId}/seat-board`, { boardId });
      await load();
    } catch (e) {
      setErr(mutationErrorMessage(e, "Could not change your board"));
    }
  };
```

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
                  <option value="">Consensus rankings</option>
                  {myBoards.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                  {/* The seat can inherit the draft's board, which belongs to
                      whoever created it and so is absent from your list.
                      Without this the select would show blank and quietly
                      misreport what the clock will actually do. */}
                  {draft.yourBoardId && !myBoards.some((b) => b.id === draft.yourBoardId) && (
                    <option value={draft.yourBoardId}>The draft's board</option>
                  )}
                </select>
              </label>
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Mutation-test the inherited-board option**

Delete the trailing `{draft.yourBoardId && !myBoards.some(...) && ...}` option. "a board you do not own still renders as the current choice" must go **red**. Restore, confirm green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Draft.jsx frontend/src/pages/Draft.test.jsx
git commit -m "feat: choose the board your clock drafts from, mid-draft"
```

---

### Task 10: End-to-end, and the screenshot

**Files:**
- Modify: `frontend/e2e/draft.spec.js`
- Modify: the Draft page screenshot referenced by `README.md`
- Test: the full suite

**Interfaces:**
- Consumes: everything above.
- Produces: no code interfaces; this is the whole-feature gate.

- [ ] **Step 1: Write the end-to-end test**

In `frontend/e2e/draft.spec.js`, following the existing multiplayer fixtures:

```js
test("a timed-out seat is picked for, and both browsers agree", async ({ page, context }) => {
  // Two browser contexts in one shared draft, seats 1 and 2. Seat 2 lets the
  // clock run out; both pages must end up showing the same board.
  // ... set up via the existing shared-draft helpers, with pickDeadline
  // already in the past on the served fixture.
});

test("the countdown renders in a shared draft", async ({ page }) => {
  // Phase 1 disabled this entirely; the regression to guard is it coming back.
});

test("pausing stops the countdown for everyone in the draft", async ({ page, context }) => {
});
```

Write these out fully against the existing fixture helpers in that file — do not leave them as comments.

- [ ] **Step 2: Run the whole suite**

```bash
cd backend && node --test src/
cd ../frontend && npm test && npm run lint && npx playwright test
```

Expected: all green. Record the exact counts in the task report. **A Playwright run that prints a partial count with exit 0 is not a pass** — this machine has produced "132 of 213 passed" with a zero exit before. Check the printed totals, not the exit code alone.

- [ ] **Step 3: Refresh the Draft page screenshot**

The Draft page header changed (board picker, server-backed pause), and the README shows these screenshots. Regenerate the Draft page image the same way the existing ones were produced and commit it with the code.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/draft.spec.js README.md docs/
git commit -m "test: the shared clock, end to end"
```
