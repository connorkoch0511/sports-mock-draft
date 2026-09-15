# Run Baseline Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `detectRuns`' expected-rate baseline so a run means "other drafters departed from the board" rather than "this position is going fast", and re-derive the five constants from measurement.

**Architecture:** `detectRuns` stops comparing picks against the remaining startable pool and starts comparing them against the board as it stood when the window's picks were made — reconstructed by adding the window's own picks back to `available` and sorting by `compareRank`. `runFactor`, its gates, the reason text and the audit script are unchanged in shape.

**Tech Stack:** React 19 + Vite frontend, ES modules, `node --test` for unit tests. No new dependencies.

## Global Constraints

From `docs/superpowers/specs/2026-09-15-run-baseline-redesign.md`. Every task's requirements implicitly include these.

- **The board must be RECONSTRUCTED, never read live.** Comparing against the current top of the board makes the factor fire on its own aftermath: the window's picks already removed those players, so expected drops while observed rises. This is the single most important property in this plan.
- **`observed` is unchanged** — every pick at that position by **other teams**, over the window, counted without regard to startability, because it feeds a sentence the user verifies by counting the Draft Board.
- **`K` counts picks by ANY seat, including the user's own**, while `observed` counts only other teams'. This asymmetry is deliberate: both sides are shares, and the board lost those players regardless of who took them. Do not "fix" it.
- **Sorting uses `compareRank` from `./helpers.js`** — the same comparator `context.js` already uses, so the baseline sees the board in the engine's own order. It sorts unranked players last.
- **The engine forbids zero-weight reasons:** `score = base + every returned reason's weight`, enforced by an invariant test. A factor returns a weighted reason or `null`.
- Unit tests run from `frontend/` with **`npm run test:unit`** (NOT `npm test`, which is Playwright). Baseline before this work: **277 pass, 0 fail**.
- Lint from `frontend/` with `npm run lint`. Must stay clean.

## Stop and ask

- The engine's invariant test fails and the cause is not your own factor returning a zero weight.
- A test passes before you implement anything (it is testing nothing).
- The Task 2 acceptance check fails — scenario A does not collapse to near-zero. **That is a finding to report, not a number to tune toward.** It means the model is wrong, and the correct response is to stop and say so.

Do **not** stop merely because an existing test needs editing. Task 1 changes what the baseline means, so fixtures written against the old baseline will legitimately need new numbers. Change them, and name every one in your report with a sentence on why the new expectation is right.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/lib/pickAdvice/runs.js` | modify. The baseline computation — the whole change. |
| `frontend/src/lib/pickAdvice/runs.test.js` | modify. Fixtures re-based; three new tests. |
| `frontend/src/lib/pickAdvice/context.js` | modify. One line: drop `startable` from the `detectRuns` call. |
| `frontend/scripts/audit-runs.js` | modify. Report ranked-players-remaining per round. |
| `frontend/src/lib/pickAdvice/weights.js` | modify. Constants re-derived in Task 2. |

`frontend/src/lib/pickAdvice/factors.js` is **not** in this list. `runFactor` is unchanged.

---

### Task 1: Reconstruct the board

**Files:**
- Modify: `frontend/src/lib/pickAdvice/runs.js`
- Modify: `frontend/src/lib/pickAdvice/runs.test.js`
- Modify: `frontend/src/lib/pickAdvice/context.js`

**Interfaces:**
- Consumes: `compareRank(a, b)` from `frontend/src/lib/pickAdvice/helpers.js`, which takes two **player objects** (not entries) and sorts unranked last.
- Produces: `detectRuns({ made, mySlot, available })` → `Map<string, {count, window}>`. **The `startable` argument is removed.** `runFactor` continues to read `ctx.runs` and is untouched.

- [ ] **Step 1: Write the failing tests**

Add these three to `frontend/src/lib/pickAdvice/runs.test.js`. The existing `pick()` helper builds `{overall, round, team, playerId, player:{id, position}}`; these fixtures need ranks on the players too, so add this helper beside it:

```js
// A pick whose player carries a rank, so the reconstructed board can be sorted.
function rankedPick(team, id, position, rank) {
  return {
    overall: 0, round: 1, team, playerId: id,
    player: { id, position, rank },
  };
}

// Players still on the board, ranked.
function ranked(entries) {
  return entries.map(([id, position, rank]) => ({ id, position, rank }));
}
```

```js
test("picks that match the board are not a run", () => {
  // The board's best eight when these picks began were 5 RB and 3 WR, and
  // exactly 5 RB and 3 WR went. The board predicted it; there is nothing to
  // report. Under the OLD baseline this fired, because 5/8 RB observed beat
  // RB's share of the remaining startable pool.
  const made = [
    rankedPick(2, "rb1", "RB", 1), rankedPick(3, "rb2", "RB", 2),
    rankedPick(4, "wr1", "WR", 3), rankedPick(5, "rb3", "RB", 4),
    rankedPick(6, "rb4", "RB", 5), rankedPick(7, "wr2", "WR", 6),
    rankedPick(8, "rb5", "RB", 7), rankedPick(9, "wr3", "WR", 8),
  ];
  // Whatever is left is ranked below everything that just went.
  const available = ranked([
    ["te1", "TE", 9], ["te2", "TE", 10], ["qb1", "QB", 11], ["qb2", "QB", 12],
    ["wr9", "WR", 13], ["wr10", "WR", 14], ["rb9", "RB", 15], ["k1", "K", 16],
  ]);

  const runs = detectRuns({ made, mySlot: 1, available });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("picks that depart from the board are a run", () => {
  // The board's best eight were 1 TE and 7 others, and 5 TEs went. Nobody
  // taking the board's advice would have produced that.
  const made = [
    rankedPick(2, "te1", "TE", 1), rankedPick(3, "te2", "TE", 20),
    rankedPick(4, "wr1", "WR", 2), rankedPick(5, "te3", "TE", 21),
    rankedPick(6, "te4", "TE", 22), rankedPick(7, "wr2", "WR", 3),
    rankedPick(8, "te5", "TE", 23), rankedPick(9, "wr3", "WR", 4),
  ];
  const available = ranked([
    ["rb1", "RB", 5], ["rb2", "RB", 6], ["wr4", "WR", 7], ["rb3", "RB", 8],
    ["wr5", "WR", 9], ["rb4", "RB", 10], ["wr6", "WR", 11], ["rb5", "RB", 12],
  ]);

  const runs = detectRuns({ made, mySlot: 1, available });

  assert.deepStrictEqual(runs.get("TE"), { count: 5, window: 8 });
});

test("the board is reconstructed, not read live", () => {
  // THE LOAD-BEARING TEST. Five RBs went, and they were the board's five best
  // -- so this is not a run. But they are gone from `available` now, so an
  // implementation that reads the CURRENT top of the board sees zero RBs in
  // it, computes an expected RB share of 0, and fires on any observed share
  // at all. That is the factor firing on its own aftermath.
  const made = [
    rankedPick(2, "rb1", "RB", 1), rankedPick(3, "rb2", "RB", 2),
    rankedPick(4, "rb3", "RB", 3), rankedPick(5, "wr1", "WR", 4),
    rankedPick(6, "rb4", "RB", 5), rankedPick(7, "wr2", "WR", 6),
    rankedPick(8, "rb5", "RB", 7), rankedPick(9, "wr3", "WR", 8),
  ];
  // Not one running back near the top of what remains.
  const available = ranked([
    ["wr4", "WR", 9], ["wr5", "WR", 10], ["te1", "TE", 11], ["wr6", "WR", 12],
    ["qb1", "QB", 13], ["wr7", "WR", 14], ["te2", "TE", 15], ["qb2", "QB", 16],
    ["rb9", "RB", 80], ["rb10", "RB", 81],
  ]);

  const runs = detectRuns({ made, mySlot: 1, available });

  assert.strictEqual(
    runs.get("RB"),
    undefined,
    "reading the live board would make this fire on its own aftermath"
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npm run test:unit
```

Expected: the two "not a run" tests FAIL (the old baseline fires on both), and "picks that depart from the board are a run" may fail or pass depending on the old baseline's numbers. Record which failed and with what message.

**If all three pass before you change `runs.js`, stop and report it.**

- [ ] **Step 3: Replace the baseline**

In `frontend/src/lib/pickAdvice/runs.js`, three edits.

**(a)** Add to the imports:

```js
import { compareRank } from "./helpers.js";
```

**(b)** Change the signature — `startable` is gone — and its guard:

```js
export function detectRuns({ made, mySlot, available }) {
  const runs = new Map();
  if (!Array.isArray(made) || !Array.isArray(available)) return runs;
```

**(c)** The `others` / `window` / `counts` computation that follows is unchanged. Everything after it — from the comment `// How much of the startable board each position still represents.` through the closing brace of the `for (const [position, count] of counts)` loop — is deleted and replaced by:

```js
  // THE BOARD AS IT STOOD WHEN THESE PICKS BEGAN -- not as it stands now.
  //
  // Reading the current board makes the factor fire on its own aftermath:
  // the window's picks already removed those players, so a position that was
  // taken heavily is now absent from the top of what remains, its expected
  // share collapses toward zero, and any observed share at all beats it.
  //
  // So the picks go back on the board before the comparison. `takenSince`
  // counts picks by ANY seat, including the user's own, while `window` counts
  // only other teams' -- deliberate, because both sides are shares and the
  // board lost those players regardless of who took them.
  const windowStartIdx = made.indexOf(window[0]);
  const takenSince = made
    .slice(windowStartIdx === -1 ? 0 : windowStartIdx)
    .map((p) => p?.player)
    .filter(Boolean);
  const K = takenSince.length;
  if (K === 0) return runs;

  const boardThen = [...available, ...takenSince].sort(compareRank);
  const bestK = boardThen.slice(0, K);

  const expectedCounts = new Map();
  for (const player of bestK) {
    const position = player?.position;
    if (!position) continue;
    expectedCounts.set(position, (expectedCounts.get(position) || 0) + 1);
  }

  for (const [position, count] of counts) {
    if (count < RUN_MIN_COUNT) continue;

    // A position the board never offered cannot be departed from by taking
    // it -- but it is exactly what a genuine run looks like, so it fires
    // rather than being skipped. Expected 0 with a real observed share is the
    // strongest possible departure.
    const expected = (expectedCounts.get(position) || 0) / K;
    const observed = count / window.length;
    if (observed >= expected * RUN_MULTIPLE) {
      runs.set(position, { count, window: window.length });
    }
  }

  return runs;
}
```

Also update the guard on the first line of the function body — `startable` is gone:

```js
- [ ] **Step 4: Update the call site**

In `frontend/src/lib/pickAdvice/context.js`, change:

```js
  const runs = detectRuns({ made, mySlot, available, startable });
```

to:

```js
  const runs = detectRuns({ made, mySlot, available });
```

- [ ] **Step 5: Re-base the existing fixtures**

Several existing tests in `runs.test.js` and `pickAdvice.test.js` were written against the old baseline and will now fail.

**Expect this, specifically.** Those fixtures build players with no `rank` at all (`board({RB: 10, WR: 20, TE: 10})` and the `pick()` helper), so every player is unranked, `compareRank` leaves them in insertion order, and `boardThen`'s top K becomes whatever `available` happens to list first — which in `board()` is the running backs. The expected RB share comes out near 1.0 and the "should fire" tests stop firing. That is the fixtures being under-specified, not the implementation being wrong.

For each failing test: give its players ranks that make the intent explicit, and recompute the expectation by hand. **The test's NAME and INTENT must not change** — if "your own picks do not count toward a run" now needs different numbers to still be about own picks, change the numbers. If you find yourself changing what a test asserts rather than what it is given, stop and report it.

Record every fixture you re-based, with its old and new expected share.

- [ ] **Step 6: Run the tests**

```bash
cd frontend && npm run test:unit && npm run lint
```

Expected: PASS, 280 tests (277 + 3 new), 0 fail, lint clean.

- [ ] **Step 7: Verify the reconstruction is load-bearing**

Temporarily replace `boardThen` with the live board:

```js
  const boardThen = [...available].sort(compareRank);
```

Run `cd frontend && npm run test:unit`. **"the board is reconstructed, not read live" must go red.** Then edit it back by hand — **do NOT use `git checkout`** — and confirm with `git diff frontend/src/lib/pickAdvice/runs.js` that only your intended change remains.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/pickAdvice/runs.js frontend/src/lib/pickAdvice/runs.test.js frontend/src/lib/pickAdvice/context.js frontend/src/lib/pickAdvice.test.js
git commit -m "fix: a run is a departure from the board, not a fast position"
```

---

### Task 2: Audit the new baseline and settle the constants

**Files:**
- Modify: `frontend/scripts/audit-runs.js`
- Modify: `frontend/src/lib/pickAdvice/weights.js`

**Interfaces:**
- Consumes: `detectRuns({ made, mySlot, available })` from Task 1.
- Produces: measured constants and a report. The script is a measuring instrument; nothing imports it.

The first version of this factor passed 277 tests and was inverted. The audit is what found that. It is the acceptance gate, not a formality.

- [ ] **Step 1: Add ranked-players-remaining to the per-round report**

`frontend/scripts/audit-runs.js` already prints a by-round table. Add a column: how many players with a finite `rank` are still on the board at the start of that round — i.e. `available.filter((p) => Number.isFinite(p.rank)).length`, sampled once per round rather than per pick.

This exists because only 118 of the live pool's 889 players are ranked. While ranked players are on the board, `boardThen`'s top K is meaningful; once they are exhausted it is sorting an unranked tail and the baseline degrades. That degradation must be visible in the numbers rather than inferred.

- [ ] **Step 2: Run the acceptance check**

```bash
cd frontend && node scripts/audit-runs.js
```

**Scenario A must fire at or near 0%.** In scenario A every seat autopicks by consensus rank, so the picks *are* board order — observed equals expected and there is nothing to depart from.

- **If scenario A fires at or near 0%:** the model holds. Continue.
- **If scenario A fires meaningfully:** the model is wrong. **STOP and report it.** Do not tune constants to suppress it — the whole point of this redesign was that tuning a wrong baseline produces a right-looking headline over a wrong distribution. Report the rate, the by-round table, and five sampled reasons with the board state beside them.

- [ ] **Step 3: Read scenario B**

Scenario B has seats reaching within the top 6; those reaches are departures and should surface as runs. Judge it against the same thresholds the first audit used:

- **0%** → nothing detects departures; report and stop.
- **more than ~25%** → decoration by volume; raise `RUN_MULTIPLE` or `RUN_MIN_COUNT` and re-run.
- **any sampled text false** → correctness bug; report and stop, do not tune around it.
- **2–15% with true sampled texts, and not concentrated in rounds 1–4** → the model holds.

The distribution matters as much as the headline. The old model hit 12.5% overall while firing on 61% of round 2 and 0% of rounds 5–15. A headline in band over a lopsided distribution is the failure this redesign exists to fix.

- [ ] **Step 4: Verify twenty sampled sentences by hand**

For each sample, re-derive the count from the raw pick rows printed beside it — seat numbers visible, the user's own picks marked — rather than trusting the script's own filtered window. Confirm the sentence is literally true: the position, the count, the window length, and that the window excludes the user's own picks.

This is the check that would have caught `tierCliffFactor`, which shipped false in 3 of its 68 reasons.

- [ ] **Step 5: Settle the constants**

Start from `RUN_WINDOW` 8, `RUN_MIN_COUNT` 3, `RUN_MULTIPLE` 1.75, `RUN_WEIGHT` `{3: 1.5, 4: 2.5, 5: 3.5}`, `RUN_WEIGHT_MAX_COUNT` 5. `RUN_MIN_COUNT` must be reset to **3** before you begin — it was tuned to 5 to suppress a firing rate the old baseline produced, and carrying it over would hide whether this redesign worked.

Report the observed distribution of run sizes. `RUN_WEIGHT`'s 3 and 4 entries were unreachable under the old model; if they are still unreachable, say so and explain why rather than leaving dead entries undocumented.

- [ ] **Step 6: Record what was measured**

Replace the comment block above the constants in `weights.js` with what this audit measured: scenario A's rate, scenario B's rate, the by-round shape, the sample size, and the date (today is 2026-09-15). A future reader must be able to tell these numbers were checked rather than guessed.

- [ ] **Step 7: Confirm the suite is still green**

```bash
cd frontend && npm run test:unit && npm run lint && npx vite build
```

If changing a constant reddened a unit test, that test was pinning the constant — which is correct. Re-base its fixture, do not weaken its assertion.

- [ ] **Step 8: Commit**

```bash
git add frontend/scripts/audit-runs.js frontend/src/lib/pickAdvice/weights.js frontend/src/lib/pickAdvice/runs.test.js
git commit -m "test: re-audit the run factor against a reconstructed board"
```

---

## Done when

- `npm run test:unit` from `frontend/` is green with at least 280 tests; lint clean; `npx vite build` succeeds.
- The reconstruction is mutation-verified load-bearing (Task 1 Step 7).
- Scenario A fires at or near 0% — the acceptance check.
- Scenario B's firing rate is in band **and** not concentrated in rounds 1–4.
- Twenty sampled sentences hand-verified true.
- The audit reports ranked-players-remaining per round.
- `weights.js` records what was measured, not what was hypothesised.
