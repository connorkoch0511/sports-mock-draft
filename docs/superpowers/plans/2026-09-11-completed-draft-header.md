# Completed Draft Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A completed draft's header stops offering the seven controls that cannot do anything, and the draft id pill goes from every draft.

**Architecture:** Pure presentation change in one file, `frontend/src/pages/Draft.jsx`. Seven controls move from rendered-and-disabled (or rendered-unconditionally) to not rendered when `draft.completed`. No new state, no restructuring of the flex row, no backend change.

**Tech Stack:** React 19, Vite, Playwright (`frontend/tests/`), Tailwind classes inline.

**Spec:** `docs/superpowers/specs/2026-09-11-completed-draft-header-design.md`

## Global Constraints

- Every control keeps its existing `data-testid`, className string, and position among its siblings. The only change is whether it renders.
- Absent, not disabled: assertions use `toHaveCount(0)`, never `not.toBeVisible()`.
- Two controls already have their own render condition — Sim to End (`humans > 1 ? null : …`) and the notify toggle (`notifyState !== "unsupported" && …`). Add the completed condition **alongside** those, never replacing them.
- The backend's own completed-draft guards do not change. `POST /pause` still answers 409.
- Playwright on this machine silently truncates when the laptop sleeps. Run the suite as `caffeinate -i npm test` from `frontend/`, and compare the printed total against `npx playwright test --list` (`Total: N tests`). **Never trust the exit code** — every dishonest run exited 0.
- Only one Playwright run at a time.

---

### Task 1: Remove the draft id pill

The pill spends ~36 characters of a tight flex row on an identifier that is already in the address bar. Sharing is covered by Copy invite link. It goes from every draft, completed or not — this is the headroom that keeps the live header on one line.

**Files:**
- Modify: `frontend/src/pages/Draft.jsx:656`
- Test: `frontend/tests/draft.spec.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on. Task 2 touches the same file but different lines.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/draft.spec.js`, inside the existing `test.describe("Draft page", …)` block, after the test named `"shows View Results button when draft is completed"`:

```js
  // The id is in the address bar already, and "Copy invite link" is how a
  // draft actually gets shared -- this pill was ~36 characters of a row that
  // has repeatedly run out of width (see boarddraft.spec.js's no-wrap tests).
  test("the header does not spend a row on the draft id", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);

    // Anchor first: toHaveCount(0) passes just as happily on a page that
    // never rendered, so prove the header is up before asserting absence.
    await expect(page.getByTestId("my-team")).toBeVisible();
    await expect(page.getByText(`Draft: ${DRAFT_ID}`)).toHaveCount(0);
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx playwright test tests/draft.spec.js -g "does not spend a row on the draft id"
```

Expected: FAIL — `Expected: 0, Received: 1`, because the pill is still rendered.

- [ ] **Step 3: Delete the pill**

In `frontend/src/pages/Draft.jsx`, delete this single line (it sits between the `my-team` span and the `current-pick` span):

```jsx
              <Pill>Draft: {draftId}</Pill>
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd frontend && npx playwright test tests/draft.spec.js -g "does not spend a row on the draft id"
```

Expected: PASS, 1 passed.

- [ ] **Step 5: Confirm `Pill` and `draftId` are both still used**

Deleting the only use of an import would leave a lint error.

```bash
cd frontend && grep -c "<Pill>" src/pages/Draft.jsx && grep -c "draftId" src/pages/Draft.jsx
```

Expected: both counts well above zero (`Pill` still renders the status and the teams/rounds pills; `draftId` is used in fetches, the results link and the invite URL). If either were zero, remove the now-dead import or variable.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Draft.jsx frontend/tests/draft.spec.js
git commit -m "fix: drop the draft id pill from the draft header"
```

---

### Task 2: Hide the seven inert controls on a completed draft

On a completed draft the header keeps four things — the `✅ Completed` badge, View Results →, "Your Team: N", and "N teams · N rounds". The other seven either cannot act or describe nothing, and a greyed-out control on a terminal state promises a return that never comes.

**Files:**
- Modify: `frontend/src/pages/Draft.jsx` (seven edits in the header's flex row, roughly lines 466-658)
- Test: `frontend/tests/draft.spec.js`

**Interfaces:**
- Consumes: Task 1 already removed the draft id pill from this row; do not re-add it.
- Produces: nothing later tasks depend on.

`completed` below is the existing local at `Draft.jsx:318`
(`const completed = draft?.completed ?? false;`) — do not introduce a new
one. The old code in these steps reads `draft.completed` in places; both
refer to the same thing, and the new code standardises on `completed`.

- [ ] **Step 1: Write the failing tests**

Add both tests to `frontend/tests/draft.spec.js`, immediately after the test Task 1 added. The first asserts absence on a completed draft; the second asserts presence on a live one, so the condition cannot be inverted without a failure.

```js
  // The seven header controls that cannot act once the last pick is in.
  // Keyed the way a user finds them: button text, or the testid where the
  // control has no visible text of its own.
  const INERT_WHEN_COMPLETED = [
    ["Pause", (page) => page.getByRole("button", { name: "Pause" })],
    ["seat-board", (page) => page.getByTestId("seat-board")],
    ["Auto Pick", (page) => page.getByRole("button", { name: "Auto Pick" })],
    ["Sim to End", (page) => page.getByRole("button", { name: "Sim to End" })],
    ["copy-invite", (page) => page.getByTestId("copy-invite")],
    ["notify-toggle", (page) => page.getByTestId("notify-toggle")],
    ["current-pick", (page) => page.getByTestId("current-pick")],
  ];

  // Disabled says "not now"; absent says "not ever". A finished draft is the
  // second case, and greying these out spent a whole row saying so. Absence
  // is the assertion -- toHaveCount(0), not not.toBeVisible() -- because a
  // control that is merely invisible is still a control.
  test("a completed draft offers none of the controls it cannot act on", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    const completedState = { ...state, currentIndex: state.picks.length, completed: true };

    page.route(`${API}/players*`, async (route) => {
      await route.fulfill({ json: { players: MOCK_PLAYERS } });
    });
    page.route(`${API}/drafts/${DRAFT_ID}`, async (route) => {
      await route.fulfill({ json: completedState });
    });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);

    // What the header keeps. Also the anchor: these prove the header
    // rendered, so the absences below mean something.
    await expect(page.getByRole("link", { name: /View Results/i })).toBeVisible();
    await expect(page.getByTestId("my-team")).toBeVisible();
    await expect(page.getByText("✅ Completed")).toBeVisible();

    for (const [label, locate] of INERT_WHEN_COMPLETED) {
      await expect(locate(page), `${label} should not render on a completed draft`).toHaveCount(0);
    }

    // Task 1 removed this unconditionally; a conditional re-introduction
    // would slip past the live-draft test that covers it.
    await expect(page.getByText(`Draft: ${DRAFT_ID}`)).toHaveCount(0);
  });

  // The other half of the pair: without this, inverting the condition (or
  // rendering `false` where `completed` was meant) would leave the suite green
  // while the live header lost every control on it.
  test("a live draft still offers all of them", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);

    for (const [label, locate] of INERT_WHEN_COMPLETED) {
      await expect(locate(page), `${label} should render on a live draft`).toHaveCount(1);
    }
  });
```

- [ ] **Step 2: Run them and watch the first fail**

```bash
cd frontend && npx playwright test tests/draft.spec.js -g "controls it cannot act on|a live draft still offers"
```

Expected: the completed-draft test FAILS (several `Expected: 0, Received: 1`, one per control still rendered); the live-draft test PASSES already. If the live one fails, stop — the fixture or a locator is wrong, not the feature.

- [ ] **Step 3: Wrap Pause**

Pause is `disabled={busy}` today — it never had a completed guard, which is why clicking it on a finished draft gets the backend's 409. Replace:

```jsx
              <button
                onClick={togglePause}
                disabled={busy}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
              >
                {paused ? "Resume" : "Pause"}
              </button>
```

with:

```jsx
              {!completed && (
                <button
                  onClick={togglePause}
                  disabled={busy}
                  className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                >
                  {paused ? "Resume" : "Pause"}
                </button>
              )}
```

- [ ] **Step 4: Wrap the board select**

Keep the long explanatory comment above the `<select>` exactly where it is — it documents the header-wrap fix and is still true. Replace the element itself:

```jsx
              <select
                data-testid="seat-board"
                aria-label="Auto-pick from"
                title="Auto-pick from"
                className="max-w-[3rem] truncate rounded-lg border border-zinc-700 bg-zinc-900 px-1 py-1 text-xs text-zinc-200"
                value={draft.yourBoardId ?? ""}
                onChange={(e) => setSeatBoard(e.target.value)}
                disabled={busy || draft.completed}
              >
                {boardOptions(myBoards, draft.yourBoardId).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
```

with:

```jsx
              {!completed && (
                <select
                  data-testid="seat-board"
                  aria-label="Auto-pick from"
                  title="Auto-pick from"
                  className="max-w-[3rem] truncate rounded-lg border border-zinc-700 bg-zinc-900 px-1 py-1 text-xs text-zinc-200"
                  value={draft.yourBoardId ?? ""}
                  onChange={(e) => setSeatBoard(e.target.value)}
                  disabled={busy}
                >
                  {boardOptions(myBoards, draft.yourBoardId).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}
```

Note `disabled={busy || draft.completed}` became `disabled={busy}`: an unrendered control needs no disabling.

- [ ] **Step 5: Wrap Auto Pick**

Replace:

```jsx
              <button
                onClick={autoPick}
                disabled={paused || busy || draft.completed || !autoPickAllowed}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                title="Auto-pick for whichever team is on the clock"
              >
                Auto Pick
              </button>
```

with:

```jsx
              {!completed && (
                <button
                  onClick={autoPick}
                  disabled={paused || busy || !autoPickAllowed}
                  className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                  title="Auto-pick for whichever team is on the clock"
                >
                  Auto Pick
                </button>
              )}
```

- [ ] **Step 6: Add the completed condition to Sim to End**

Sim to End already hides itself when a second human is seated. That guard stays — it is what stops one person simulating away other people's picks. Keep its comment. Change only the condition:

```jsx
              {humans > 1 ? null : (
```

becomes:

```jsx
              {humans > 1 || completed ? null : (
```

and inside that button, drop the now-redundant term:

```jsx
                  disabled={paused || busy || draft.completed}
```

becomes:

```jsx
                  disabled={paused || busy}
```

- [ ] **Step 7: Wrap Copy invite link**

Nobody joins a finished draft. Replace:

```jsx
              <button
                type="button"
                data-testid="copy-invite"
                onClick={() =>
                  navigator.clipboard.writeText(
                    `${window.location.origin}/draft/${draftId}/join?t=${draft.inviteToken}`
                  )
                }
                className="rounded-2xl border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
              >
                Copy invite link
              </button>
```

with:

```jsx
              {!completed && (
                <button
                  type="button"
                  data-testid="copy-invite"
                  onClick={() =>
                    navigator.clipboard.writeText(
                      `${window.location.origin}/draft/${draftId}/join?t=${draft.inviteToken}`
                    )
                  }
                  className="rounded-2xl border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
                >
                  Copy invite link
                </button>
              )}
```

- [ ] **Step 8: Add the completed condition to the notify toggle**

There is no turn left to be notified about. This control already hides itself where push is unsupported; that guard stays. Keep its long comment. Change only the condition:

```jsx
              {notifyState !== "unsupported" && (
```

becomes:

```jsx
              {notifyState !== "unsupported" && !completed && (
```

- [ ] **Step 9: Wrap the current-pick pill**

A finished draft has no current pick; the label is a frozen last-known value. Replace:

```jsx
              <span data-testid="current-pick">
                <Pill>{currentPickLabel}</Pill>
              </span>
```

with:

```jsx
              {!completed && (
                <span data-testid="current-pick">
                  <Pill>{currentPickLabel}</Pill>
                </span>
              )}
```

- [ ] **Step 10: Run both tests and watch them pass**

```bash
cd frontend && npx playwright test tests/draft.spec.js -g "controls it cannot act on|a live draft still offers"
```

Expected: 2 passed.

- [ ] **Step 11: Prove the pair actually catches an inversion**

House rule: a guard is only covered if deleting it turns a test red. Temporarily change Step 9's `{!completed && (` to `{completed && (`, re-run the two tests above, and confirm the **live** test fails (`current-pick should render on a live draft`). Then restore `!completed` and re-run to green.

Expected: inverted → 1 failed; restored → 2 passed.

- [ ] **Step 12: Run the two header no-wrap tests**

These measure `seat-board` against `current-pick` on live drafts — both controls still render there, so both should pass untouched. If either fails, the row's geometry moved and that is a real finding.

```bash
cd frontend && npx playwright test tests/boarddraft.spec.js -g "does not push the header onto an extra line|widest possible countdown"
```

Expected: 2 passed.

- [ ] **Step 13: Run the whole suite under caffeinate**

```bash
cd frontend && npx playwright test --list | tail -1
cd frontend && caffeinate -i npm test
```

Compare the printed pass count to the `Total: N tests` from `--list`. They must match. A run that takes much longer than ~7 minutes is suspect — re-run rather than debug its "failures".

Expected: N passed, 0 failed, totals equal.

- [ ] **Step 14: Check the screenshot the suite just rewrote**

`tests/draft.spec.js` writes `screenshots/draft.png` on every run, against a live paused draft. Its only change should be the draft id pill's disappearance.

```bash
git status --short screenshots/
```

Expected: `M screenshots/draft.png`. Open it and confirm the header still reads sensibly. If any other screenshot changed, look at why before committing it.

- [ ] **Step 15: Commit**

```bash
git add frontend/src/pages/Draft.jsx frontend/tests/draft.spec.js screenshots/draft.png
git commit -m "fix: a completed draft stops offering controls it cannot act on"
```

---

## After both tasks

Remove this entry from the accepted-items list on the status artifact — this change resolves it:

> Pause stays clickable on a finished draft — clicking it gets the backend's 409 and a generic banner.
