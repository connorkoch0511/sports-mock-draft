# A Pick Length Per Draft — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a draft be created with a pick length other than sixty seconds, and carry an imported Sleeper league's real timer across.

**Architecture:** One new field on the draft, `pickSeconds`. `advanceDraft` already receives the whole draft, so reading the length from it hands the per-draft value to every caller — `/pick`, `/auto-pick`, `/expire`, sim-to-end and the scheduled clock — with no signature change and no caller edits. A missing field means sixty seconds, so nothing needs migrating.

**Tech Stack:** Node CommonJS Lambdas + DynamoDB (`node --test`), React 19 + Vite frontend (`node --test` for units, Playwright for e2e).

**Spec:** `docs/superpowers/specs/2026-09-10-configurable-pick-length-design.md`

## Global Constraints

- **The fallback is the migration.** Every read of the length is `draft.pickSeconds ?? PICK_SECONDS`. A draft written before this change must behave exactly as it does today.
- **Validation is a range, not the preset list:** an integer **30–86400** inclusive, rejected with 400 otherwise. An absent value defaults to 60 rather than erroring. The presets are a UI affordance; the range is the contract. The floor is 30 (not 15): the draft page polls every 3s and the `/expire` stagger adds up to 2.75s more, so a 15-second slot was mistimed by close to a fifth of its own length, and 30 is already the shortest preset offered. The ceiling is a full day, because Sleeper's "slow draft" leagues run pick timers of two to twenty-four hours (`pick_timer` 7200–86400) — all of which the original 3600-second ceiling rejected outright.
- **Mutation-test every guard:** delete it, run the covering test, confirm **red**, restore, confirm **green**. Record the evidence.
- Backend is CommonJS; frontend is ESM.
- No change to pause, to the scheduler, or to how the deadline is enforced.
- Never run `git stash`. Do not deploy from a task; Task 4 handles that.
- Read printed Playwright totals rather than the exit code — this machine has produced a partial count with a zero exit.

## File Structure

- `backend/src/lib/advance.js` — *modify.* Read the length from the draft.
- `backend/src/drafts.js` — *modify.* Validate and store `pickSeconds` at creation; return it on GET.
- `frontend/src/pages/NewDraft.jsx` — *modify.* The select, its state, the create payload, and applying an imported value.
- `frontend/src/lib/sleeper.js` — *modify.* Read `settings.pick_timer`.
- `frontend/src/pages/Draft.jsx` — *modify.* Use the draft's length as the display fallback.
- Tests alongside each.

---

### Task 1: The deadline comes from the draft

The whole backend behaviour change, in one small edit plus the tests that pin it.

**Files:**
- Modify: `backend/src/lib/advance.js`
- Test: `backend/src/lib/advance.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `advanceDraft` writes a deadline `(draft.pickSeconds ?? 60)` seconds past its base. Signature unchanged.

- [ ] **Step 1: Record the baseline**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Write the pass count into the report. It should rise by exactly the tests you add.

- [ ] **Step 2: Write the failing tests**

Append to `backend/src/lib/advance.test.js`:

```js
test("the deadline honours the draft's own pick length", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1, pickSeconds: 30 };
  const now = 1_000_000;
  await advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0, now });
  assert.equal(input.ExpressionAttributeValues[":d"], now + 30_000);
});

test("a draft written before pick lengths existed still gets sixty seconds", async () => {
  // The entire migration story: no backfill, because an absent field has a
  // correct meaning. If this passes without the fallback, it tests nothing.
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1 };
  const now = 1_000_000;
  await advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0, now });
  assert.equal(input.ExpressionAttributeValues[":d"], now + 60_000);
});

test("catch-up advances in the draft's own slot length", async () => {
  // What the scheduler's drain relies on: each catch-up pick consumes one
  // slot of missed time, and a slot is this draft's length, not 60s.
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const draft = { picks: [{ team: 1 }, { team: 2 }], picked: [], currentIndex: 1, pickSeconds: 30 };
  const base = 500_000;
  await advanceDraft({ ddb, table: "t", draftId: "d1", draft, expectedIndex: 0, deadlineBase: base });
  assert.equal(input.ExpressionAttributeValues[":d"], base + 30_000);
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `cd backend && node --test src/lib/advance.test.js 2>&1 | tail -12`
Expected: the two `pickSeconds: 30` tests FAIL (they get `+60_000`); the sixty-second one PASSES already, which is correct — it is pinning behaviour that must not change.

- [ ] **Step 4: Read the length from the draft**

In `backend/src/lib/advance.js`, replace:

```js
  const deadline = (deadlineBase ?? now) + PICK_MS;
```

with:

```js
  // Read from the draft, not the module constant: every caller already
  // passes the whole draft, so this hands /pick, /auto-pick, /expire,
  // sim-to-end and the scheduled clock the per-draft length without any of
  // them changing. A draft written before pick lengths existed has no field,
  // and 60 is exactly what it has always had -- which is why this feature
  // needs no backfill.
  const seconds = draft.pickSeconds ?? PICK_SECONDS;
  const deadline = (deadlineBase ?? now) + seconds * 1000;
```

Leave `PICK_SECONDS`, `PICK_MS` and the module's exports alone: the constant is now the default rather than the rule, and `drafts.js` and the frontend both still use it.

- [ ] **Step 5: Run the tests**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Expected: all pass, count up by three from Step 1.

- [ ] **Step 6: Mutation-test the fallback**

Change `draft.pickSeconds ?? PICK_SECONDS` to `draft.pickSeconds`. "a draft written before pick lengths existed still gets sixty seconds" must go **red** (the deadline becomes `NaN`). Restore, confirm green.

This is the guard that carries the whole no-migration claim. If it does not go red, the test is wrong.

- [ ] **Step 7: Commit**

```bash
git add backend/src/lib/advance.js backend/src/lib/advance.test.js
git commit -m "feat: the deadline comes from the draft, not a constant"
```

---

### Task 2: Creating a draft with a pick length

**Files:**
- Modify: `backend/src/drafts.js`
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: Task 1's reading of `draft.pickSeconds`.
- Produces: `POST /drafts` accepts `pickSeconds` (integer 30–86400, default 60, 400 otherwise) and stores it; `GET /drafts/{draftId}` returns it.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/drafts.test.js`, following that file's existing `evt`/`stubByTable` conventions:

```js
test("a draft is created with the pick length it was given", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.Item?.seats) put = cmd.input.Item;
    return {};
  });
  const res = await handler(
    evt("POST", "/drafts", { body: { teams: 12, rounds: 2, userTeam: 1, pickSeconds: 30 }, claims: ME })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(put.pickSeconds, 30);
  // The first deadline uses it too, not just later ones.
  assert.ok(put.pickDeadline - Date.now() <= 30_000);
});

test("a draft created without a pick length gets sixty seconds", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.Item?.seats) put = cmd.input.Item;
    return {};
  });
  await handler(evt("POST", "/drafts", { body: { teams: 12, rounds: 2, userTeam: 1 }, claims: ME }));
  assert.equal(put.pickSeconds, 60);
});

test("a pick length outside the allowed range is refused", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({}));
  for (const bad of [29, 86401, 0, -60, "sixty", 1.5]) {
    const res = await handler(
      evt("POST", "/drafts", { body: { teams: 12, rounds: 2, userTeam: 1, pickSeconds: bad }, claims: ME })
    );
    assert.equal(res.statusCode, 400, `${bad} should be refused`);
  }
});

test("the edges of the allowed range are accepted", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({}));
  for (const ok of [30, 86400]) {
    const res = await handler(
      evt("POST", "/drafts", { body: { teams: 12, rounds: 2, userTeam: 1, pickSeconds: ok }, claims: ME })
    );
    assert.equal(res.statusCode, 200, `${ok} should be accepted`);
  }
});
```

Note the `cmd.input.Item.seats` predicate rather than `Item.draftId`: `addMember` writes a row that also carries `draftId` immediately after the draft, and a `draftId` predicate would latch onto the membership row instead. The neighbouring tests in this file use `.seats` for exactly that reason.

Then, for the GET, append:

```js
test("GET returns the draft's pick length", async () => {
  const d = { ...ownedDraft(ME.sub), pickSeconds: 30 };
  stubByTable({ "drafts-test": { Item: d } });
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.equal(JSON.parse(res.body).pickSeconds, 30);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/drafts.test.js 2>&1 | tail -12`
Expected: the new tests FAIL. The range test will fail because everything currently returns 200; the others because the field is neither stored nor returned.

- [ ] **Step 3: Validate and store it**

In `drafts.js`'s `POST /drafts` block, beside the other body parsing (after `boardId`):

```js
      // A range, not the preset list the UI offers: an imported Sleeper
      // league can carry any timer its commissioner set, and the client is
      // not trusted for either. Absent is not an error -- it means the
      // caller does not care, and 60 is what every draft had before this
      // field existed.
      let pickSeconds = 60;
      if (body.pickSeconds !== undefined && body.pickSeconds !== null) {
        const n = Number(body.pickSeconds);
        if (!Number.isInteger(n) || n < 30 || n > 86400) {
          return json(400, { error: "pickSeconds must be a whole number of seconds between 30 and 86400" });
        }
        pickSeconds = n;
      }
```

In the item literal, beside the deadline:

```js
        pickSeconds,
        pickDeadline: Date.now() + pickSeconds * 1000,
```

replacing the existing `pickDeadline: Date.now() + PICK_MS,`. Leave the comment above it in place.

`PICK_MS` may now be unused in `drafts.js` — check, and remove it from the require only if nothing else there uses it. `npm run lint` in Step 5 is what proves this.

In the GET response object, beside `pickDeadline`:

```js
        pickSeconds: d.pickSeconds ?? PICK_SECONDS,
```

adding `PICK_SECONDS` to the `require` from `./lib/advance` if it is not already imported.

- [ ] **Step 4: Run the tests**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Expected: all pass, count up by five from Task 1's total.

- [ ] **Step 5: Lint**

Run: `cd ../frontend && npm run lint`
Expected: clean. This is what catches an `PICK_MS` import left dangling.

- [ ] **Step 6: Mutation-test the range guard**

Delete the `if (!Number.isInteger(n) || n < 30 || n > 86400)` block. "a pick length outside the allowed range is refused" must go **red**. Restore, confirm green.

Then change `n < 30` to `n < 0`. The same test must go **red** on the `29` case. Restore, confirm green — this proves the boundary is pinned, not just the concept.

- [ ] **Step 7: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js
git commit -m "feat: a draft carries the pick length it was created with"
```

---

### Task 3: Choosing it, and importing it

**Files:**
- Modify: `frontend/src/lib/sleeper.js`
- Modify: `frontend/src/pages/NewDraft.jsx`
- Modify: `frontend/src/pages/Draft.jsx`
- Test: `frontend/src/lib/sleeper.test.js`, `frontend/tests/sleeper.spec.js`

**Interfaces:**
- Consumes: Task 2's `POST /drafts` contract and `GET` field.
- Produces: no code interface. `data-testid="pick-seconds"` on the new select.

- [ ] **Step 1: Write the failing unit tests**

Append to `frontend/src/lib/sleeper.test.js`, matching its existing style:

The exported function is `toDraftConfig(league, draft, userId)` — **positional arguments**, not an options object — and `JOES_DRAFT` in this file already carries `pick_timer: 60`, so the first test needs no new fixture:

```js
test("a league's pick timer comes across", () => {
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, USER).pickSeconds, 60);
});

test("a non-preset timer comes across unchanged", () => {
  // 45 is not one of the presets the select offers. It must survive anyway:
  // snapping it would silently rewrite the setting the user just imported.
  const draft = { ...JOES_DRAFT, settings: { ...JOES_DRAFT.settings, pick_timer: 45 } };
  assert.strictEqual(toDraftConfig(JOES, draft, USER).pickSeconds, 45);
});

test("a league with no timer leaves the choice alone", () => {
  // Sleeper writes 0 for "no timer". This app has no untimed option, so 0
  // must not become 0 seconds -- it means "nothing learned, keep the
  // default", which the caller expresses by leaving its own state be.
  for (const timer of [0, undefined]) {
    const draft = { ...JOES_DRAFT, settings: { ...JOES_DRAFT.settings, pick_timer: timer } };
    assert.strictEqual(toDraftConfig(JOES, draft, USER).pickSeconds, null);
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd frontend && npm run test:unit 2>&1 | tail -8`
Expected: both FAIL — `cfg.pickSeconds` is `undefined`.

- [ ] **Step 3: Read the timer in the mapper**

In `frontend/src/lib/sleeper.js`, in the object `buildConfig` returns, add:

```js
    // Sleeper writes 0 for "no timer". This app has no untimed option, so 0
    // and a missing value both mean "nothing learned" -- null, so the caller
    // can leave its own default alone rather than being handed a number.
    pickSeconds: Number(draft?.settings?.pick_timer) > 0 ? Number(draft.settings.pick_timer) : null,
```

- [ ] **Step 4: Run the unit tests**

Run: `cd frontend && npm run test:unit 2>&1 | tail -8`
Expected: pass, count up by two.

- [ ] **Step 5: Add the control to New Draft**

In `frontend/src/pages/NewDraft.jsx`, add state beside the other settings:

```jsx
  const [pickSeconds, setPickSeconds] = useState(60);
```

Add the select after the ADP Format block (around line 400), matching that block's markup exactly. The presets run from 30 seconds to 24 hours — Sleeper's slow-draft leagues time out at two to twenty-four hours, and without the longer options an import from one of those would land on a lone "from your league" entry rather than a selectable preset. Hoist the `[seconds, label]` pairs to a module-scope constant and derive both the membership test and the `<option>` list from it, rather than writing the same list twice — a preset added to only one of the two used to render twice, once mislabelled "· from your league", with the custom entry winning selection:

```jsx
const PICK_SECONDS_PRESETS = [
  [30, "30 seconds"], [60, "1 minute"], [90, "90 seconds"], [120, "2 minutes"],
  [300, "5 minutes"], [600, "10 minutes"], [1800, "30 minutes"], [3600, "1 hour"],
  [7200, "2 hours"], [14400, "4 hours"], [28800, "8 hours"], [43200, "12 hours"],
  [86400, "24 hours"],
];
```

```jsx
        <label className="space-y-1 block">
          <div className="text-sm text-zinc-300">Seconds per pick</div>
          <select
            data-testid="pick-seconds"
            className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none"
            value={pickSeconds}
            onChange={(e) => setPickSeconds(Number(e.target.value))}
          >
            {/* An imported league's timer may not be one of ours. Rather than
                snap it to the nearest preset -- silently rewriting the setting
                the user just imported -- it joins the list, labelled. */}
            {!PICK_SECONDS_PRESETS.some(([s]) => s === pickSeconds) && (
              <option value={pickSeconds}>{pickSeconds} seconds · from your league</option>
            )}
            {PICK_SECONDS_PRESETS.map(([s, label]) => (
              <option key={s} value={s}>{label}</option>
            ))}
          </select>
        </label>
```

Send it on create, in `createDraft`'s `apiPost("/drafts", { ... })`:

```jsx
        pickSeconds,
```

And apply an imported one, in `applyConfig`:

```jsx
    // null means the league had no timer, or Sleeper reported 0 -- leave
    // whatever the user already chose rather than overwriting it.
    if (cfg.pickSeconds != null) setPickSeconds(cfg.pickSeconds);
```

- [ ] **Step 6: Use the draft's length on the draft page**

In `frontend/src/pages/Draft.jsx`, `const PICK_SECONDS = 60` is a display fallback used before the draft has loaded. Keep the constant, and prefer the draft's value where `secondsLeft` falls back to it:

```jsx
    const tick = () =>
      setSecondsLeft(
        remainingSeconds(deadline, skewRef.current) ?? (draft?.pickSeconds ?? PICK_SECONDS)
      );
```

Adapt to the actual name of the draft object in that scope. Do not change how the countdown itself is computed — it renders from the server's deadline and evaluates nothing.

- [ ] **Step 7: Write the Playwright test**

Append to `frontend/tests/sleeper.spec.js`, following its existing setup:

`mockSleeper`'s draft route returns `settings: { rounds: 16, teams: 12 }` with **no** `pick_timer`. Override it after calling `mockSleeper`, which is the pattern this file already uses twice ("Registered after mockSleeper, so this handler wins"). There is no `create-draft` test id — the button is reached by its accessible name, as the neighbouring test does.

```js
test("an imported league's pick timer is offered and sent", async ({ page }) => {
  let posted = null;
  await mockSleeper(page);
  // Registered after mockSleeper, so this handler wins: a league whose
  // timer is not one of our presets.
  await page.route(`${SLEEPER}/draft/*`, (route) =>
    route.fulfill({
      json: {
        type: "snake",
        settings: { rounds: 16, teams: 12, pick_timer: 45 },
        draft_order: { [USER_ID]: 7 },
      },
    })
  );
  await page.route("http://localhost:9999/drafts", async (route) => {
    posted = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ json: { draftId: "abc" } });
  });

  await signIn(page);
  await page.goto("/draft/new");
  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();
  await page.getByTestId("sleeper-leagues").getByRole("button").first().click();
  await expect(page.getByTestId("roster-summary")).toBeVisible();

  // Offered as its own option, selected, and not snapped to 30 or 60.
  await expect(page.getByTestId("pick-seconds")).toHaveValue("45");

  await page.getByRole("button", { name: /Start Mock Draft/i }).click();
  await expect.poll(() => posted?.pickSeconds).toBe(45);
});
```

- [ ] **Step 8: Run everything**

Run: `cd frontend && npm run test:unit && npm run lint && npm test 2>&1 | tail -3`
Expected: all green.

- [ ] **Step 9: Regenerate and look at the screenshot**

Run: `git status --short screenshots/` — `newdraft.png` should be among the changes.

Open it. Confirm the new select reads "1 minute" and sits with the other league settings, and that the page has not grown a scrollbar it did not have.

- [ ] **Step 10: Commit**

```bash
git add frontend/src screenshots/ frontend/tests
git commit -m "feat: choose the seconds per pick, or import your league's"
```

---

### Task 4: Ship it

**Files:** none.

- [ ] **Step 1: Full verification**

```bash
cd backend && node --test 'src/**/*.test.js'
cd ../frontend && npm run test:unit && npm run lint && npm test
```

Read the printed totals. Backend should be up by eight from where this branch started; frontend unit up by two; Playwright up by one.

- [ ] **Step 2: Deploy both halves, backend first**

The backend changes the API contract (a new accepted field, a new returned field) and the frontend sends it, so the backend goes first — as it did for the clock.

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

cd ../frontend && npm run deploy
```

Do not assign any of these to a shell variable named `GID` — zsh treats it as a special integer parameter and evaluates the client id as arithmetic.

- [ ] **Step 3: Confirm the live bundle**

Wait for the CloudFront invalidation to report `Completed`, then:

```bash
curl -s https://d2kf4b52rvabfv.cloudfront.net/index.html | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
ls dist/assets/*.js
```
The two must name the same file.

- [ ] **Step 4: Prove it end to end**

Create a draft with 30 seconds selected, then read it back:

```bash
aws dynamodb get-item --table-name perfectpick-drafts --region us-east-1 \
  --key '{"draftId":{"S":"YOUR_DRAFT_ID"}}' \
  --query "Item.pickSeconds.N" --output text
```
Expected: `30`. Then watch one pick expire and confirm the next deadline is 30 seconds out, not 60 — that is the whole feature in one number.

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill.
