# Positional Run Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one scoring factor to the frontend advice engine that raises startable players at a position which is being drafted faster than the remaining startable board predicts.

**Architecture:** A pure `detectRuns()` module computes a `Map` of position → `{count, window}` for positions that cleared the test. `buildContext` calls it once and exposes the result as `ctx.runs`. A `runFactor` in the existing `FACTORS` array reads `ctx.runs` and returns a weighted reason, gated exactly like `scarcityFactor`. No new UI surface — the advice card renders whatever reasons come back.

**Tech Stack:** React 19 + Vite frontend, ES modules, `node --test` for unit tests. No new dependencies.

## Global Constraints

Copied from `docs/superpowers/specs/2026-09-15-positional-run-detection-design.md`. Every task's requirements implicitly include these.

- **The engine's invariant is absolute:** `score = base + every returned reason's weight`. A factor returns a reason carrying the exact weight it contributed, or returns `null`. **Never return a reason with weight 0** — the engine deliberately does not filter them, so a zero-weight reason fails the existing invariant test.
- **Factors receive a FROZEN `entry`.** Mutating it throws. A factor moves a score only by returning a reason.
- **The reason sentence must be literally true of the Draft Board.** It says "by other teams" because your own picks are excluded, and it counts **every** pick at that position in the window, not only startable ones.
- **Your own picks never count toward a run** — filter on `Number(p.team) !== mySlot`.
- **The expected rate is computed over `startable`, never the whole pool.** A raw share over the whole pool is dominated by ~891 undraftable running backs.
- **The factor is gated exactly like `scarcityFactor`:** requires `ctx.nextOverall`, `ctx.gap > 0`, `entry.index < ctx.gap`, and the candidate being in `ctx.startable.get(position)`.
- **Reason text follows the neighbouring factors' style:** numerals and the position code (`RBs`), matching scarcity's `the 7 RBs this league can start`. The spec's prose example said "running backs"; the code uses the position code for consistency with every other reason on the card.
- Unit tests run from `frontend/` with **`npm run test:unit`** (NOT `npm test`, which is Playwright). Baseline before this work: **262 tests, 262 pass, 0 fail**.
- Lint from `frontend/` with `npm run lint`. Must stay clean.

## Stop and ask

Stop and ask the controller if:

- The engine's invariant test starts failing and the cause is not obviously your own new factor returning a zero weight.
- You cannot make a test fail for the right reason before implementing (a test that passes immediately is testing nothing).

Do **not** stop merely because an existing test needs editing — Task 2 adds a factor to a shared array and some existing assertions about reason lists may legitimately need updating. Change them, and say plainly in your report which ones you changed and why.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/lib/pickAdvice/runs.js` | **new.** `detectRuns()` — the whole run computation, pure, no engine knowledge. |
| `frontend/src/lib/pickAdvice/runs.test.js` | **new.** Direct unit tests for `detectRuns()`. |
| `frontend/src/lib/pickAdvice/weights.js` | modify. The four constants. |
| `frontend/src/lib/pickAdvice/context.js` | modify. Call `detectRuns`, expose `ctx.runs`. |
| `frontend/src/lib/pickAdvice/factors.js` | modify. `runFactor`, registered in `FACTORS`. |
| `frontend/src/lib/pickAdvice.test.js` | modify. End-to-end tests through `adviseOnPick`. |
| `frontend/scripts/audit-runs.js` | **new.** Task 4 only. Live-data firing-rate audit. |

**One deviation from the spec, noted deliberately.** The spec says "Three files, all existing" and puts the computation in `context.js`. This plan puts it in a new `runs.js` instead. The reason is testability: `buildContext` has no test file of its own and is only exercised through `adviseOnPick`, so a run computation living inside it could only be tested by constructing whole drafts — which is what makes the Task 2 fixtures as elaborate as they are. A pure function in its own module is tested directly with eight small cases, and `context.js` gains one import and one line. If you disagree, the alternative is to inline `detectRuns` into `context.js` and move `runs.test.js`'s cases into `pickAdvice.test.js` as full-draft fixtures; that is more test code for the same coverage.

---

### Task 1: The run computation

**Files:**
- Create: `frontend/src/lib/pickAdvice/runs.js`
- Create: `frontend/src/lib/pickAdvice/runs.test.js`
- Modify: `frontend/src/lib/pickAdvice/weights.js` (append constants)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `detectRuns({ made, mySlot, available, startable })` → `Map<string, {count: number, window: number}>`. Only positions that cleared the test are present. Also exports from `weights.js`: `RUN_WINDOW` (8), `RUN_MIN_COUNT` (3), `RUN_MULTIPLE` (1.75), `RUN_WEIGHT` (`{3: 1.5, 4: 2.5, 5: 3.5}`), `RUN_WEIGHT_MAX_COUNT` (5).

Argument shapes, which you will not otherwise know:
- `made` — array of picks that carry a player: `{ overall, round, team, playerId, player }`. `player` is a full player object with `.id`, `.position`, `.name`.
- `mySlot` — the user's team number (1-based), or `null`.
- `available` — array of player objects still on the board (already excludes taken players).
- `startable` — `Map<position, Set<string>>`. The Set holds **stringified** player ids.

- [ ] **Step 1: Add the constants to `weights.js`**

Append to `frontend/src/lib/pickAdvice/weights.js`:

```js
// A position going faster than the board predicts is an argument for taking
// one before they are gone. Only a DEPARTURE from the expected rate counts:
// rounds 1-3 are running-back heavy by nature, and a factor that fires on
// every early pick moves scores for something that is not news.
//
// These five numbers are a hypothesis, not a result. scarcityFactor shipped
// firing ZERO times on live data and tierCliffFactor shipped false in 3 of
// its 68 reasons -- both read correctly and passed their tests. Task 4 of
// the plan that introduced this audits the firing rate against real drafts
// before these are considered settled.
export const RUN_WINDOW = 8; // picks by OTHER teams to look back over
export const RUN_MIN_COUNT = 3; // 1 of 2 picks is a 50% share and is not a run
export const RUN_MULTIPLE = 1.75; // how far observed must exceed expected
export const RUN_WEIGHT = { 3: 1.5, 4: 2.5, 5: 3.5 };
export const RUN_WEIGHT_MAX_COUNT = 5; // counts above this take the 5 weight
```

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/lib/pickAdvice/runs.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { detectRuns } from "./runs.js";

// A pick that carries a player. `team` is the seat that made it.
function pick(team, id, position) {
  return { overall: 0, round: 1, team, playerId: id, player: { id, position } };
}

// startable: every id passed is startable at its position.
function startableOf(players) {
  const m = new Map();
  for (const p of players) {
    if (!m.has(p.position)) m.set(p.position, new Set());
    m.get(p.position).add(String(p.id));
  }
  return m;
}

// A board with `n` startable players at each listed position.
function board(counts) {
  const out = [];
  let id = 1000;
  for (const [position, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) out.push({ id: id++, position });
  }
  return out;
}

test("a position going far above its expected rate is a run", () => {
  // 8 picks by others, 5 of them RB. Observed 5/8 = 0.625.
  // Board left: 10 RB of 40 startable -> expected 0.25. 0.625 >= 0.4375. Fires.
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "RB"), pick(4, 3, "WR"), pick(5, 4, "RB"),
    pick(6, 5, "RB"), pick(7, 6, "TE"), pick(8, 7, "RB"), pick(9, 8, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

  assert.deepStrictEqual(runs.get("RB"), { count: 5, window: 8 });
});

test("a position going at its expected rate is not a run", () => {
  // 2 RB of 8 = 0.25 observed, against 0.25 expected. Not a departure --
  // and below RUN_MIN_COUNT anyway.
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "WR"), pick(4, 3, "WR"), pick(5, 4, "WR"),
    pick(6, 5, "RB"), pick(7, 6, "TE"), pick(8, 7, "WR"), pick(9, 8, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("your own picks do not count toward a run", () => {
  // Seat 1 is the user and took three of the four RBs. Without the filter
  // this is 4 RB of 8; with it, 1 RB of 5, which is not a run.
  const made = [
    pick(1, 1, "RB"), pick(1, 2, "RB"), pick(1, 3, "RB"), pick(2, 4, "RB"),
    pick(3, 5, "WR"), pick(4, 6, "WR"), pick(5, 7, "TE"), pick(6, 8, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("the count includes picks of players nobody would start", () => {
  // Four RBs taken, only one of them startable. The sentence this feeds has
  // to be true of the Draft Board, so all four count. Startable governs the
  // EXPECTED rate, never the observed count.
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const startable = startableOf(available);
  const made = [
    pick(2, 9001, "RB"), pick(3, 9002, "RB"), pick(4, 9003, "RB"),
    pick(5, 9004, "RB"), pick(6, 10, "WR"), pick(7, 11, "WR"),
    pick(8, 12, "TE"), pick(9, 13, "WR"),
  ];
  const runs = detectRuns({ made, mySlot: 1, available, startable });

  assert.deepStrictEqual(runs.get("RB"), { count: 4, window: 8 });
});

test("only the last RUN_WINDOW picks are considered", () => {
  // Six RBs, but all of them older than the window, followed by 8 non-RB
  // picks by others. Nothing should be running.
  const made = [
    ...Array.from({ length: 6 }, (_, i) => pick(2, i + 1, "RB")),
    pick(2, 20, "WR"), pick(3, 21, "WR"), pick(4, 22, "WR"), pick(5, 23, "TE"),
    pick(6, 24, "WR"), pick(7, 25, "WR"), pick(8, 26, "TE"), pick(9, 27, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("window reports how many picks it actually saw, not RUN_WINDOW", () => {
  // Only four picks have been made. A reason built from this must say
  // "of the last 4", never "of the last 8".
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "RB"), pick(4, 3, "RB"), pick(5, 4, "WR"),
  ];
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

  assert.deepStrictEqual(runs.get("RB"), { count: 3, window: 4 });
});

test("a position with no startable players left never runs", () => {
  // Expected share is 0, so any observed share is infinitely above it.
  // Firing here would be meaningless: there is nobody left worth the urgency.
  const available = board({ WR: 20, TE: 10 }); // no RBs left at all
  const made = [
    pick(2, 1, "RB"), pick(3, 2, "RB"), pick(4, 3, "RB"), pick(5, 4, "RB"),
    pick(6, 5, "WR"), pick(7, 6, "WR"), pick(8, 7, "TE"), pick(9, 8, "WR"),
  ];
  const runs = detectRuns({
    made, mySlot: 1, available, startable: startableOf(available),
  });

  assert.strictEqual(runs.get("RB"), undefined);
});

test("no picks yet means no runs, and does not throw", () => {
  const available = board({ RB: 10, WR: 20, TE: 10 });
  const runs = detectRuns({
    made: [], mySlot: 1, available, startable: startableOf(available),
  });

  assert.strictEqual(runs.size, 0);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd frontend && npm run test:unit
```

Expected: FAIL. `Cannot find module './runs.js'` — the module does not exist yet.

- [ ] **Step 4: Write the implementation**

Create `frontend/src/lib/pickAdvice/runs.js`:

```js
import { RUN_WINDOW, RUN_MIN_COUNT, RUN_MULTIPLE } from "./weights.js";

/**
 * Positions being drafted faster than the remaining startable board predicts.
 *
 * Two populations, deliberately different, and conflating them is the whole
 * trap this module exists to avoid:
 *
 *   - The COUNT is over every pick in the window, startable or not, because
 *     the sentence it feeds ("4 of the last 8 picks by other teams were RBs")
 *     has to be true of the Draft Board a user can count. A reason a user can
 *     disprove by counting is worse than no reason.
 *
 *   - The EXPECTED rate is over `startable` only. Asking what share of the
 *     whole remaining board is running backs gets an answer dominated by the
 *     ~891 nobody would ever start, and nothing would ever look like a
 *     departure from it. This is the same mistake that made scarcityFactor
 *     fire zero times on live data.
 *
 * Returns a Map holding ONLY positions that cleared the test. A position that
 * is not running is absent rather than present-with-a-false-flag, so a caller
 * cannot accidentally read a non-run as a run.
 */
export function detectRuns({ made, mySlot, available, startable }) {
  const runs = new Map();
  if (!Array.isArray(made) || !Array.isArray(available) || !startable) return runs;

  // A run is evidence about what OTHER drafters are doing. Counting your own
  // picks makes a feedback loop: take backs in back-to-back rounds (normal at
  // a turn) and the engine cites your own picks as proof backs are flying,
  // then recommends a third.
  const others =
    mySlot == null ? made : made.filter((p) => Number(p?.team) !== mySlot);
  const window = others.slice(-RUN_WINDOW);
  if (window.length === 0) return runs;

  const counts = new Map();
  for (const p of window) {
    const position = p?.player?.position;
    if (!position) continue;
    counts.set(position, (counts.get(position) || 0) + 1);
  }

  // How much of the startable board each position still represents.
  let totalStartableLeft = 0;
  const startableLeft = new Map();
  for (const [position, ids] of startable) {
    let n = 0;
    for (const player of available) {
      if (ids.has(String(player.id))) n += 1;
    }
    startableLeft.set(position, n);
    totalStartableLeft += n;
  }
  if (totalStartableLeft === 0) return runs;

  for (const [position, count] of counts) {
    if (count < RUN_MIN_COUNT) continue;

    const left = startableLeft.get(position) || 0;
    // Nobody left worth hurrying for. An expected share of zero would make
    // every observed share infinitely above it, which is not a signal.
    if (left === 0) continue;

    const expected = left / totalStartableLeft;
    const observed = count / window.length;
    if (observed >= expected * RUN_MULTIPLE) {
      runs.set(position, { count, window: window.length });
    }
  }

  return runs;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd frontend && npm run test:unit
```

Expected: PASS, 270 tests (262 baseline + 8 new), 0 fail.

- [ ] **Step 6: Lint**

```bash
cd frontend && npm run lint
```

Expected: clean, no output.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/pickAdvice/runs.js frontend/src/lib/pickAdvice/runs.test.js frontend/src/lib/pickAdvice/weights.js
git commit -m "feat: detect a position going faster than the board predicts"
```

---

### Task 2: Wire it into the engine

**Files:**
- Modify: `frontend/src/lib/pickAdvice/context.js`
- Modify: `frontend/src/lib/pickAdvice/factors.js`
- Modify: `frontend/src/lib/pickAdvice.test.js`

**Interfaces:**
- Consumes: `detectRuns({ made, mySlot, available, startable })` → `Map<string, {count, window}>` and `RUN_WEIGHT` / `RUN_WEIGHT_MAX_COUNT` from Task 1.
- Produces: `ctx.runs` (that same Map) and a `runFactor` registered in `FACTORS`, emitting reasons of `kind: "run"`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/pickAdvice.test.js`. It already defines the helpers these use — `player(id, extra)`, `makeDraft({teams, rounds, userTeam, rosterSlots, made})`, and `STARTERS`. `makeDraft`'s `made` is an array of **player objects**, assigned to `picks[0..n-1]` in snake order, so which seat made a pick follows from its position in the array.

The draft state below is chosen so the user has a real gap. In a 12-team snake, team 1 picks at overall 1, 24 and 25, then not again until 48. With 24 picks made the user is on the clock at overall 25 with **gap 23** — wide enough that the `entry.index < ctx.gap` gate is not what is being tested. The user made overall 1 and 24, so the window of other teams' picks is overall 2–23, and its last eight are overall 16–23.

```js
// Enough startable depth at every position for a 12-team league, interleaved
// so the top of the board is not a single position, plus a tail nobody starts.
function runPool() {
  const out = [];
  let rank = 1;
  for (let i = 0; i < 30; i++) {
    out.push(player(`rb${i}`, { position: "RB", rank: rank++, tier: 1 }));
    out.push(player(`wr${i}`, { position: "WR", rank: rank++, tier: 1 }));
  }
  for (let i = 0; i < 15; i++) {
    out.push(player(`te${i}`, { position: "TE", rank: rank++, tier: 1 }));
    out.push(player(`qb${i}`, { position: "QB", rank: rank++, tier: 1 }));
  }
  for (let i = 0; i < 12; i++) {
    out.push(player(`k${i}`, { position: "K", rank: rank++, tier: 1 }));
    out.push(player(`def${i}`, { position: "DEF", rank: rank++, tier: 1 }));
  }
  return out;
}

// 24 picks, overall 1..24. Team 1 (the user) made overall 1 and overall 24 --
// the snake's turn -- so "other teams" is overall 2..23, and the last eight of
// those (overall 16..23) hold five RBs.
function madeWithRunOnRB(pool) {
  const byId = new Map(pool.map((p) => [p.id, p]));
  const seq = [
    // overall 1..15. Deliberately RB-free, so the run is entirely inside
    // the window and cannot be an artefact of the whole draft's shape.
    "wr0", "wr1", "te0", "qb0", "wr2", "te1", "wr3", "qb1",
    "wr4", "te2", "wr5", "qb2", "wr6", "te3", "wr7",
    // overall 16..23 -- the window. Five RBs of eight.
    "rb0", "rb1", "wr8", "rb2", "rb3", "te4", "rb4", "wr9",
    // overall 24 -- the user's own pick at the turn. Excluded from the window.
    "qb3",
  ];
  return seq.map((id) => byId.get(id));
}

function runAdvice() {
  const players = runPool();
  const draft = makeDraft({
    teams: 12,
    rounds: 15,
    userTeam: 1,
    rosterSlots: STARTERS,
    made: madeWithRunOnRB(players),
  });
  return adviseOnPick({ players, draft, boardRows: null, myTeam: 1 });
}

test("a run on a position is a reason, with a countable sentence", () => {
  const run = runAdvice()
    .reasonsFor("rb5")
    .find((r) => r.kind === "run");

  assert.ok(run, "five of the last eight picks by other teams were RBs");
  assert.ok(run.weight > 0, "a run reason must carry weight");
  // The sentence has to be true of the Draft Board: five RBs, eight picks.
  assert.strictEqual(
    run.text,
    "5 of the last 8 picks by other teams were RBs."
  );
});

test("a run does not lift a player nobody will reach before your next pick", () => {
  // gap is 23, so rb28 sits far outside the window of players expected to go.
  // Urgency cannot apply to someone who will still be there either way.
  const run = runAdvice()
    .reasonsFor("rb28")
    .find((r) => r.kind === "run");

  assert.strictEqual(run, undefined);
});

test("the run's weight is the one the count maps to", () => {
  // Pins the weight table to the factor. Without this the factor could
  // return any positive number and every other assertion here still passes.
  const run = runAdvice()
    .reasonsFor("rb5")
    .find((r) => r.kind === "run");

  assert.strictEqual(run.weight, RUN_WEIGHT[5]);
});
```

Add `RUN_WEIGHT` to this file's imports:

```js
import { RUN_WEIGHT } from "./pickAdvice/weights.js";
```

**Why the own-picks case is not tested here.** It is tested in Task 1 (`runs.test.js`, "your own picks do not count toward a run") and deliberately not repeated at this level. Putting five RBs in the user's own hands needs a 2-team draft, which produces a gap of 3 — so the assertion would pass because the `entry.index < ctx.gap` gate excluded the candidate, not because the own-picks filter worked. A test that passes for the wrong reason is worse than no test.

**On the third gate.** `runFactor` also requires the candidate to be startable at his position, and that gate is deliberately **not** isolated here: with gap 23, every RB inside the gap window is also inside the startable window, so no fixture can vary one without the other. It is covered instead by `runs.test.js`'s "a position with no startable players left never runs" and by the gate being the same line scarcity already uses. Do not invent a contrived pool to isolate it — say in your report that it is covered indirectly.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npm run test:unit
```

Expected: FAIL — no reason with `kind: "run"` is produced, so `assert.ok(run, ...)` fails on the first test.

**If the first test passes before you implement anything, stop and tell the controller.** It would mean the assertion is not testing what it claims.

- [ ] **Step 3: Expose `ctx.runs` in `context.js`**

Add the import at the top of `frontend/src/lib/pickAdvice/context.js`:

```js
import { detectRuns } from "./runs.js";
```

Then, immediately before the `return {` near the end of `buildContext`, add:

```js
  // Momentum, which scarcity cannot see: scarcity presumes a uniform gap's
  // worth of the board disappears, and says nothing about WHICH positions are
  // going. `available` and `startable` are already computed above.
  const runs = detectRuns({ made, mySlot, available, startable });
```

And add `runs` to the returned object, after `survivors`:

```js
    survivors,
    runs,
  };
```

- [ ] **Step 4: Add `runFactor` to `factors.js`**

Add to the imports from `./weights.js` at the top of `frontend/src/lib/pickAdvice/factors.js`: `RUN_WEIGHT` and `RUN_WEIGHT_MAX_COUNT`.

Add the factor immediately after `scarcityFactor` (it shares scarcity's gates, and sitting next to it is how a future reader learns that):

```js
/**
 * A position going faster than the remaining startable board predicts.
 *
 * The gates are scarcityFactor's, for the same reason: this is an argument
 * for URGENCY, and urgency only applies to a startable player who might
 * actually be gone by the time you pick again. A run is not a reason to take
 * someone nobody else will reach.
 *
 * The sentence is the plain countable fact and says "by other teams", because
 * the user's own picks are excluded from the window -- without those three
 * words the number would not match the rows on the Draft Board.
 */
function runFactor(entry, ctx) {
  if (!ctx.nextOverall || ctx.gap <= 0) return null;
  const position = entry.player.position;
  if (!position) return null;

  const run = ctx.runs?.get(position);
  if (!run) return null;

  if (entry.index >= ctx.gap) return null;
  if (!ctx.startable.get(position)?.has(String(entry.player.id))) return null;

  const weight = RUN_WEIGHT[Math.min(run.count, RUN_WEIGHT_MAX_COUNT)] ?? 0;
  // The engine does not filter zero-weight reasons -- it fails an invariant
  // test on them -- so a count that maps to nothing returns nothing.
  if (weight === 0) return null;

  return {
    kind: "run",
    weight,
    text: `${run.count} of the last ${run.window} picks by other teams were ${position}s.`,
  };
}
```

Register it in the `FACTORS` array, after `scarcityFactor`:

```js
export const FACTORS = [
  valueFactor,
  needFactor,
  scarcityFactor,
  runFactor,
  tierCliffFactor,
  availabilityFactor,
  depthChartFactor,
  productionFactors,
];
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd frontend && npm run test:unit
```

Expected: PASS, 273 tests, 0 fail.

Some existing assertions about reason lists may now legitimately need updating, because `FACTORS` gained an entry. Update them, and **name every one you changed in your report** with a sentence on why the change is correct rather than convenient.

- [ ] **Step 6: Verify the engine's own invariant still holds**

The existing invariant test (no zero-weight reasons, `score === base + sum(weights)`) is in `frontend/src/lib/pickAdvice.test.js`. It must pass unchanged. If it fails, `runFactor` is returning a zero weight somewhere — fix the factor, never the invariant.

- [ ] **Step 7: Lint and build**

```bash
cd frontend && npm run lint && npx vite build
```

Expected: lint clean, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/pickAdvice/context.js frontend/src/lib/pickAdvice/factors.js frontend/src/lib/pickAdvice.test.js
git commit -m "feat: a run on a position argues for taking one"
```

---

### Task 3: Mutation-check every constant

**Files:**
- Modify: `frontend/src/lib/pickAdvice/runs.test.js` (only if a mutation survives)

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: no new exports. A record, in the task report, of which test caught which mutation.

A constant no test pins is a constant anyone can edit to anything. Four constants govern this feature and each must be load-bearing.

- [ ] **Step 1: Mutate each constant in turn and record what goes red**

For each of the four, make the change, run `cd frontend && npm run test:unit`, record which test names failed, then **restore the original value before moving to the next**. Restore by editing the value back by hand — do NOT use `git checkout`, which will also discard the rest of your uncommitted work.

| # | Change in `weights.js` | Must turn red |
|---|---|---|
| 1 | `RUN_WINDOW` 8 → 20 | "only the last RUN_WINDOW picks are considered" |
| 2 | `RUN_MIN_COUNT` 3 → 1 | "a position going at its expected rate is not a run" |
| 3 | `RUN_MULTIPLE` 1.75 → 0.5 | "a position going at its expected rate is not a run" |
| 4 | `RUN_WEIGHT` `{3: 1.5, ...}` → `{3: 0, 4: 0, 5: 0}` | at least one test in `pickAdvice.test.js` asserting a run reason exists |

- [ ] **Step 2: Add a test for any mutation that survived**

If a mutation did **not** turn a test red, that constant is unpinned. Write a test that fails under the mutated value and passes under the real one, then re-run the mutation to confirm it now goes red.

- [ ] **Step 3: Confirm the suite is green with all four restored**

```bash
cd frontend && npm run test:unit && npm run lint
```

Expected: 273 tests (or more, if Step 2 added any), 0 fail, lint clean.

Confirm with `git diff frontend/src/lib/pickAdvice/weights.js` that the four constants are back to `8`, `3`, `1.75`, and `{3: 1.5, 4: 2.5, 5: 3.5}`. **A mutation left in the tree is the worst outcome of this task.**

- [ ] **Step 4: Commit (only if Step 2 added tests)**

```bash
git add frontend/src/lib/pickAdvice/runs.test.js
git commit -m "test: pin the run constants that nothing was holding"
```

If no mutation survived, there is nothing to commit. Say so in your report.

---

### Task 4: Audit the firing rate against real drafts

**Files:**
- Create: `frontend/scripts/audit-runs.js`
- Modify: `frontend/src/lib/pickAdvice/weights.js` (only if the audit says the numbers are wrong)

**Interfaces:**
- Consumes: `detectRuns` from Task 1, `adviseOnPick` from the existing engine.
- Produces: a printed report. This script is a measuring instrument, not shipped behaviour — it is not imported by the app.

This is the task the spec calls a requirement rather than a nicety. `scarcityFactor` shipped **firing zero times on live data**. `tierCliffFactor` shipped **false in 3 of its 68 reasons**. Both read correctly and passed their tests. The five constants from Task 1 are a hypothesis and this is where they meet evidence.

- [ ] **Step 1: Write the audit script**

Create `frontend/scripts/audit-runs.js`. It must:

1. Fetch the real player pool from the live API:
   `https://6q48e144hf.execute-api.us-east-1.amazonaws.com/players` (a public route — no auth needed). Fall back to a clear error if the fetch fails; do not silently audit an empty pool.
2. Simulate complete 12-team, 15-round snake drafts where every seat autopicks by consensus rank, building the same `draft` shape `adviseOnPick` expects (`{teams, rounds, picks, picked, currentIndex, rosterSlots, userTeam}` — copy the shape from `frontend/tests/fixtures.js`).
3. At **every** pick in each draft, call `adviseOnPick` and record whether a `kind: "run"` reason came back, for which position, and with what text.
4. Print:
   - total picks evaluated
   - how many produced a run reason, as a count and a percentage
   - the breakdown by position
   - the breakdown by round
   - **20 sampled reason texts, with the actual last-N picks by other teams beside each**, so the claim can be checked by eye

- [ ] **Step 2: Run it**

```bash
cd frontend && node scripts/audit-runs.js
```

- [ ] **Step 3: Judge the result against these thresholds**

- **Fires on 0% of picks** → the same failure scarcity shipped with. The constants are wrong; report and stop.
- **Fires on more than ~25% of picks** → it is decoration by volume. Raise `RUN_MULTIPLE` or `RUN_MIN_COUNT` and re-run.
- **Any sampled text is false** against the picks printed beside it → a correctness bug, not a tuning problem. Report and stop; do not tune around it.
- **Fires in a plausible 2–15% band with true sampled texts** → the hypothesis survived. Record the numbers.

- [ ] **Step 4: Record the findings in the file that carries the numbers**

Whatever the outcome, replace the "hypothesis, not a result" paragraph in `weights.js` with what was actually measured — the firing rate, the sample size, and the date. A future reader must be able to tell these numbers were checked rather than guessed.

- [ ] **Step 5: Commit**

```bash
git add frontend/scripts/audit-runs.js frontend/src/lib/pickAdvice/weights.js
git commit -m "test: audit how often a run actually fires"
```

---

## Done when

- `npm run test:unit` from `frontend/` is green, with no fewer than 273 tests.
- `npm run lint` is clean and `npx vite build` succeeds.
- All four constants are mutation-checked and restored.
- The audit has been run against the real player pool and its findings are written into `weights.js`.
- No `kind: "run"` reason ever carries weight 0, and the engine's invariant test passes untouched.
