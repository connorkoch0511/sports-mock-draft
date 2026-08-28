# Sleeper League Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the draft bots understand real rosters — dedicated starters, FLEX, and bench — and let a user fill the New Draft form from their Sleeper league.

**Architecture:** A new pure `backend/src/lib/roster.js` turns a Sleeper `roster_positions` array into starter counts, FLEX count, and bench count, and answers "how much does this team need this position?" `drafts.js` stores `rosterSlots` on the draft and swaps its hardcoded targets and round-based K/DEF rule for that module. On the frontend, `lib/sleeper.js` calls Sleeper directly — CORS allows it — and maps a league plus its draft into form values.

**Tech Stack:** Node.js 24 (CommonJS) Lambdas, DynamoDB, AWS SAM, React 19 + Vite 7 + Tailwind 4 (ESM), `node:test`, Playwright.

**Source spec:** `docs/superpowers/specs/2026-08-28-sleeper-league-connection-design.md`
**API research:** `docs/superpowers/research/2026-08-28-sleeper-api-findings.md`

## Global Constraints

- **Backend is CommonJS** (`"type": "commonjs"`) — `require` / `module.exports`. **Frontend is ESM** — `import` / `export`. The two differ deliberately; do not mix them.
- **No new dependencies**, backend or frontend.
- **`rosterSlots` is additive.** Drafts already in DynamoDB have no such field and must keep working via `DEFAULT_ROSTER`.
- **Never read `league.settings.draft_rounds`.** It reads 3, 3, and 5 for real 15, 16, and 33-round drafts. Rounds come from `draft.settings.rounds`.
- **FLEX eligibility is RB, WR, TE.** Nothing else.
- **The import runs in the browser.** No Lambda proxy, no backend endpoint for Sleeper.
- **UI copy must not overclaim.** The lookup is unauthenticated — say "Find my leagues" and ask for a Sleeper username. Never "Connect account" or "Sign in."
- **Baseline is 51 Playwright tests, 6 frontend unit tests, 24 backend unit tests.** None may be weakened, skipped, or deleted.
- **Screenshots are committed baselines.** The Playwright suite rewrites `screenshots/*.png`; revert before committing.

---

## File Structure

**Backend — create**
- `backend/src/lib/roster.js` — roster parsing and need calculation
- `backend/src/lib/roster.test.js` — `node:test` units

**Backend — modify**
- `backend/src/drafts.js` — `rosterSlots` on create/read, rounds clamp, bot logic

**Frontend — create**
- `frontend/src/lib/sleeper.js` — Sleeper fetch helpers and the config mapping
- `frontend/src/lib/sleeper.test.js` — `node:test` units against real league shapes
- `frontend/tests/sleeper.spec.js` — end-to-end import flow

**Frontend — modify**
- `frontend/src/pages/NewDraft.jsx` — the import section

---

## Task 1: Roster model

The load-bearing logic. Pure, no I/O, test-first.

**Files:**
- Create: `backend/src/lib/roster.test.js`, `backend/src/lib/roster.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `DEFAULT_ROSTER: string[]`
  - `parseRosterSlots(slots) → { starters: {QB,RB,WR,TE,K,DEF}, flex: number, bench: number, unknown: string[] }`
  - `rosterNeed(counts, position, roster) → number`
  - `kDefBlocked(counts, roster) → boolean`
  - Task 2 consumes all four.

- [ ] **Step 1: Write the failing tests**

`backend/src/lib/roster.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const {
  DEFAULT_ROSTER,
  parseRosterSlots,
  rosterNeed,
  kDefBlocked,
} = require("./roster");

// The three real leagues this feature was designed against.
const ARCADE = ["QB","RB","RB","WR","WR","TE","FLEX","FLEX","K","DEF","BN","BN","BN","BN","BN"];
const JOES = ["QB","RB","RB","WR","WR","WR","TE","FLEX","K","DEF","BN","BN","BN","BN","BN","BN"];

function counts(o = {}) {
  return { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0, ...o };
}

test("parses a real 16-slot roster", () => {
  const r = parseRosterSlots(JOES);
  assert.deepStrictEqual(r.starters, { QB: 1, RB: 2, WR: 3, TE: 1, K: 1, DEF: 1 });
  assert.strictEqual(r.flex, 1);
  assert.strictEqual(r.bench, 6);
  assert.deepStrictEqual(r.unknown, []);
});

test("parses a roster with two FLEX slots", () => {
  const r = parseRosterSlots(ARCADE);
  assert.deepStrictEqual(r.starters, { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 });
  assert.strictEqual(r.flex, 2);
  assert.strictEqual(r.bench, 5);
});

test("unrecognised slots count as bench and are reported", () => {
  const r = parseRosterSlots(["QB", "SUPER_FLEX", "TAXI", "BN"]);
  assert.strictEqual(r.bench, 3);
  assert.deepStrictEqual(r.unknown, ["SUPER_FLEX", "TAXI"]);
});

test("an empty roster parses to zeroes rather than throwing", () => {
  const r = parseRosterSlots([]);
  assert.deepStrictEqual(r.starters, { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 });
  assert.strictEqual(r.flex, 0);
  assert.strictEqual(r.bench, 0);
});

test("DEFAULT_ROSTER reproduces the pre-feature hardcoded targets", () => {
  const r = parseRosterSlots(DEFAULT_ROSTER);
  assert.deepStrictEqual(r.starters, { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 });
  assert.strictEqual(r.flex, 0);
});

test("need equals the missing dedicated starters", () => {
  const r = parseRosterSlots(JOES);
  assert.strictEqual(rosterNeed(counts(), "RB", r), 2);
  assert.strictEqual(rosterNeed(counts({ RB: 1 }), "RB", r), 1);
  assert.strictEqual(rosterNeed(counts(), "WR", r), 3);
  assert.strictEqual(rosterNeed(counts(), "QB", r), 1);
});

test("FLEX adds no demand while dedicated slots are still unfilled", () => {
  const r = parseRosterSlots(JOES);
  // One RB short of the dedicated two: need reflects the dedicated gap only.
  assert.strictEqual(rosterNeed(counts({ RB: 1, WR: 3, TE: 1 }), "RB", r), 1);
});

test("FLEX opens demand for RB, WR and TE once dedicated slots are full", () => {
  const r = parseRosterSlots(JOES);
  const filled = counts({ QB: 1, RB: 2, WR: 3, TE: 1 });
  assert.strictEqual(rosterNeed(filled, "RB", r), 1);
  assert.strictEqual(rosterNeed(filled, "WR", r), 1);
  assert.strictEqual(rosterNeed(filled, "TE", r), 1);
});

test("FLEX never creates demand for QB, K or DEF", () => {
  const r = parseRosterSlots(JOES);
  const filled = counts({ QB: 1, RB: 2, WR: 3, TE: 1, K: 1, DEF: 1 });
  assert.strictEqual(rosterNeed(filled, "QB", r), 0);
  assert.strictEqual(rosterNeed(filled, "K", r), 0);
  assert.strictEqual(rosterNeed(filled, "DEF", r), 0);
});

test("a filled FLEX closes the demand it opened", () => {
  const r = parseRosterSlots(JOES);
  // The third RB fills the single FLEX slot.
  const filled = counts({ QB: 1, RB: 3, WR: 3, TE: 1 });
  assert.strictEqual(rosterNeed(filled, "RB", r), 0);
  assert.strictEqual(rosterNeed(filled, "WR", r), 0);
});

test("two FLEX slots take two extra players before closing", () => {
  const r = parseRosterSlots(ARCADE);
  const base = { QB: 1, RB: 2, WR: 2, TE: 1 };
  assert.strictEqual(rosterNeed(counts(base), "WR", r), 2);
  assert.strictEqual(rosterNeed(counts({ ...base, WR: 3 }), "WR", r), 1);
  assert.strictEqual(rosterNeed(counts({ ...base, WR: 4 }), "WR", r), 0);
});

test("need is zero everywhere once all starters are filled — bench is best-available", () => {
  const r = parseRosterSlots(JOES);
  const full = counts({ QB: 1, RB: 3, WR: 3, TE: 1, K: 1, DEF: 1 });
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    assert.strictEqual(rosterNeed(full, pos, r), 0, `${pos} should have no need`);
  }
});

test("K and DEF are blocked while any other starter is missing", () => {
  const r = parseRosterSlots(JOES);
  assert.strictEqual(kDefBlocked(counts(), r), true);
  assert.strictEqual(kDefBlocked(counts({ QB: 1, RB: 2, WR: 3 }), r), true);
});

test("K and DEF unblock only after the FLEX slot is also filled", () => {
  const r = parseRosterSlots(JOES);
  const startersNoFlex = counts({ QB: 1, RB: 2, WR: 3, TE: 1 });
  assert.strictEqual(kDefBlocked(startersNoFlex, r), true);

  const withFlex = counts({ QB: 1, RB: 3, WR: 3, TE: 1 });
  assert.strictEqual(kDefBlocked(withFlex, r), false);
});

test("does not mutate its inputs", () => {
  const r = parseRosterSlots(JOES);
  const c = counts({ RB: 1 });
  const snapshot = JSON.stringify(c);
  rosterNeed(c, "RB", r);
  kDefBlocked(c, r);
  assert.strictEqual(JSON.stringify(c), snapshot);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend/src && npm test`
Expected: FAIL — `Cannot find module './roster'`

- [ ] **Step 3: Write the implementation**

`backend/src/lib/roster.js`:

```js
// Slot labels that name a single position outright.
const DEDICATED = ["QB", "RB", "WR", "TE", "K", "DEF"];

// A FLEX slot accepts exactly these.
const FLEX_ELIGIBLE = ["RB", "WR", "TE"];

// Reproduces the roster the bots implicitly assumed before rosterSlots existed:
// QB 1, RB 2, WR 2, TE 1, K 1, DEF 1. Used for drafts stored without the field.
const DEFAULT_ROSTER = ["QB", "RB", "RB", "WR", "WR", "TE", "K", "DEF"];

/**
 * Turn a flat Sleeper roster_positions array into counts.
 * Unrecognised labels (SUPER_FLEX, TAXI, IDP slots) count as bench and are
 * reported, so an unfamiliar league degrades to something sane.
 */
function parseRosterSlots(slots) {
  const starters = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  let flex = 0;
  let bench = 0;
  const unknown = [];

  for (const raw of slots || []) {
    const slot = String(raw).toUpperCase();
    if (DEDICATED.includes(slot)) starters[slot] += 1;
    else if (slot === "FLEX") flex += 1;
    else if (slot === "BN") bench += 1;
    else {
      bench += 1;
      unknown.push(slot);
    }
  }

  return { starters, flex, bench, unknown };
}

// How many FLEX slots are already occupied by surplus RB/WR/TE.
function flexFilled(counts, roster) {
  return FLEX_ELIGIBLE.reduce(
    (n, pos) =>
      n + Math.max(0, (counts[pos] || 0) - (roster.starters[pos] || 0)),
    0
  );
}

/**
 * How badly a team needs one more player at `position`.
 *
 * Dedicated starters come first. Only once those are full does FLEX reopen
 * demand for RB/WR/TE. When every starter slot is accounted for the need is
 * zero, which is what makes bench picks fall through to best-available.
 */
function rosterNeed(counts, position, roster) {
  const dedicatedMissing = Math.max(
    0,
    (roster.starters[position] || 0) - (counts[position] || 0)
  );
  if (dedicatedMissing > 0) return dedicatedMissing;
  if (!FLEX_ELIGIBLE.includes(position)) return 0;
  return Math.max(0, roster.flex - flexFilled(counts, roster));
}

/**
 * True while any non-K/DEF starter slot is still empty, FLEX included.
 * Replaces a hardcoded `round <= 10`, which meant kickers in round 11 of a
 * 33-round draft.
 */
function kDefBlocked(counts, roster) {
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    if ((counts[pos] || 0) < (roster.starters[pos] || 0)) return true;
  }
  return flexFilled(counts, roster) < roster.flex;
}

module.exports = {
  DEFAULT_ROSTER,
  FLEX_ELIGIBLE,
  parseRosterSlots,
  rosterNeed,
  kDefBlocked,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend/src && npm test`
Expected: PASS — 39 tests total (24 existing plus 15 new), 0 failing

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/roster.js backend/src/lib/roster.test.js
git commit -m "Add roster model with FLEX and bench support"
```

---

## Task 2: Wire the roster into the draft engine

**Files:**
- Modify: `backend/src/drafts.js`

**Interfaces:**
- Consumes: `DEFAULT_ROSTER`, `parseRosterSlots`, `rosterNeed`, `kDefBlocked` from `./lib/roster`
- Produces: `POST /drafts` accepts `rosterSlots`; `GET /drafts/:id` returns it. Task 4's UI sends it.

- [ ] **Step 1: Import the roster module**

In `backend/src/drafts.js`, add below the existing `require` lines:

```js
const {
  DEFAULT_ROSTER,
  parseRosterSlots,
  rosterNeed,
  kDefBlocked,
} = require("./lib/roster");
```

- [ ] **Step 2: Delete needScore**

Remove the entire `needScore` function — the one declaring `const target = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 };` and its `earlyBoost` map. `rosterNeed` replaces it. Its early-round RB/WR boost was compensating for a roster model that had no FLEX; with FLEX modeled, that demand now comes from the roster itself.

- [ ] **Step 3: Rewrite pickBestForTeam**

Replace the whole `pickBestForTeam` function with:

```js
function pickBestForTeam(draft, teamNum, players) {
  const pickedSet = new Set(draft.picked || []);
  const counts = draft.__counts || { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  const roster = parseRosterSlots(draft.rosterSlots || DEFAULT_ROSTER);
  const blockKDef = kDefBlocked(counts, roster);

  let best = null;
  let bestScore = -Infinity;

  for (const p of players) {
    if (!p?.id) continue;
    if (pickedSet.has(p.id)) continue;

    // Rank dominates (lower rank = better)
    const base = p.rank != null ? (100000 - Number(p.rank)) : 0;

    // Roster need: starters first, then FLEX, then nothing — bench is
    // best-available.
    const needs = rosterNeed(counts, p.position, roster) * 500;

    // Hold K/DEF until every other starter slot is filled.
    const kDefPenalty =
      blockKDef && (p.position === "K" || p.position === "DEF") ? -20000 : 0;

    // Small tie-breaker (stable)
    const tiebreak = (p.name || "").length;

    const score = base + needs + kDefPenalty + tiebreak;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return best;
}
```

The `currentPick` and `round` locals are gone — nothing in the new scoring uses the round number. Removing them is the point of the change, not an oversight.

- [ ] **Step 4: Raise the rounds clamp and accept rosterSlots**

In the `POST /drafts` branch, replace the rounds clamp line:

```js
      const rounds = Math.max(1, Math.min(40, Number(body.rounds || 15)));
```

Then, immediately after the `userTeam` derivation in that same branch, add:

```js
      const rosterSlots = Array.isArray(body.rosterSlots)
        ? body.rosterSlots.slice(0, 60).map((s) => String(s).toUpperCase())
        : DEFAULT_ROSTER;
```

The `slice(0, 60)` bounds a hostile payload; the longest real roster seen is 33.

- [ ] **Step 5: Persist and return it**

In the same branch's `item` object literal, add `rosterSlots` immediately after the `userTeam,` line:

```js
        userTeam,
        rosterSlots,
```

Then in the `GET /drafts/{draftId}` branch's response object, add immediately after the `userTeam: d.userTeam || 1,` line:

```js
          rosterSlots: d.rosterSlots || DEFAULT_ROSTER,
```

The `|| DEFAULT_ROSTER` fallback is what keeps drafts already in DynamoDB working.

- [ ] **Step 6: Verify the module loads and units still pass**

Run: `cd backend/src && node -e "require('./drafts.js'); console.log('ok')"`
Expected: `ok`

Run: `cd backend/src && npm test`
Expected: PASS — 39 tests, 0 failing

- [ ] **Step 7: Confirm no round-based heuristics survive**

Run: `cd backend/src && grep -n "needScore\|round <= 10\|round <= 6" drafts.js`
Expected: no output

- [ ] **Step 8: Validate the template**

Run: `cd backend && sam validate --lint`
Expected: `template.yaml is a valid SAM Template`, exit 0

- [ ] **Step 9: Commit**

```bash
git add backend/src/drafts.js
git commit -m "Draft bots now use real roster slots instead of hardcoded targets"
```

---

## Task 3: Sleeper client

**Files:**
- Create: `frontend/src/lib/sleeper.test.js`, `frontend/src/lib/sleeper.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `fetchUser(username) → Promise<{ user_id, ... }>`
  - `fetchLeagues(userId, season) → Promise<league[]>`
  - `fetchLeagueDraft(leagueId) → Promise<draft|null>`
  - `toDraftConfig(league, draft, userId) → { teams, rounds, format, rosterSlots, userTeam, leagueName }`
  - Task 4's UI consumes all four.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/sleeper.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { toDraftConfig } from "./sleeper.js";

// Shapes captured from three real Sleeper leagues. Field names and value types
// are as the API actually returns them; only draft_order contents are synthetic,
// since that maps opaque user ids to slots.
const JOES = {
  name: "Average Joes 26'",
  total_rosters: 12,
  roster_positions: ["QB","RB","RB","WR","WR","WR","TE","FLEX","K","DEF","BN","BN","BN","BN","BN","BN"],
  scoring_settings: { rec: 0.5, pass_td: 4, rec_td: 6 },
  settings: { draft_rounds: 3, type: 0 },
};
const JOES_DRAFT = {
  type: "snake",
  settings: { rounds: 16, teams: 12, pick_timer: 60 },
  draft_order: { "865123803410374656": 7 },
};

const ARCADE = {
  name: "Arcade League",
  total_rosters: 10,
  roster_positions: ["QB","RB","RB","WR","WR","TE","FLEX","FLEX","K","DEF","BN","BN","BN","BN","BN"],
  scoring_settings: { rec: 1.0 },
  settings: { draft_rounds: 3, type: 0 },
};
const ARCADE_DRAFT = { type: "snake", settings: { rounds: 15, teams: 10 }, draft_order: null };

const USER = "865123803410374656";

test("maps a half-PPR league to the half-ppr format", () => {
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, USER).format, "half-ppr");
});

test("maps a full-PPR league to the ppr format", () => {
  assert.strictEqual(toDraftConfig(ARCADE, ARCADE_DRAFT, USER).format, "ppr");
});

test("maps a league with no reception scoring to standard", () => {
  const league = { ...JOES, scoring_settings: { pass_td: 4 } };
  assert.strictEqual(toDraftConfig(league, JOES_DRAFT, USER).format, "standard");
});

test("takes rounds from the draft, never from league.settings.draft_rounds", () => {
  // draft_rounds is 3 here; the real draft is 16 rounds.
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, USER).rounds, 16);
});

test("falls back to roster length when the draft has no round count", () => {
  const draft = { settings: {}, draft_order: null };
  assert.strictEqual(toDraftConfig(JOES, draft, USER).rounds, 16);
});

test("takes teams from total_rosters", () => {
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, USER).teams, 12);
  assert.strictEqual(toDraftConfig(ARCADE, ARCADE_DRAFT, USER).teams, 10);
});

test("carries roster_positions through verbatim", () => {
  const cfg = toDraftConfig(JOES, JOES_DRAFT, USER);
  assert.deepStrictEqual(cfg.rosterSlots, JOES.roster_positions);
  assert.strictEqual(cfg.rosterSlots.filter((s) => s === "BN").length, 6);
  assert.strictEqual(cfg.rosterSlots.filter((s) => s === "FLEX").length, 1);
});

test("reads the user's real draft slot from draft_order", () => {
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, USER).userTeam, 7);
});

test("defaults the slot to 1 when the draft order is not set", () => {
  assert.strictEqual(toDraftConfig(ARCADE, ARCADE_DRAFT, USER).userTeam, 1);
});

test("defaults the slot to 1 when the user is absent from draft_order", () => {
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, "someone-else").userTeam, 1);
});

test("ignores a slot outside the league's team count", () => {
  const draft = { ...JOES_DRAFT, draft_order: { [USER]: 99 } };
  assert.strictEqual(toDraftConfig(JOES, draft, USER).userTeam, 1);
});

test("carries the league name", () => {
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, USER).leagueName, "Average Joes 26'");
});

test("survives a league with no draft at all", () => {
  const cfg = toDraftConfig(JOES, null, USER);
  assert.strictEqual(cfg.rounds, 16);
  assert.strictEqual(cfg.userTeam, 1);
  assert.strictEqual(cfg.teams, 12);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — cannot find module `./sleeper.js`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/sleeper.js`:

```js
// Sleeper's read API needs no authentication and sends
// access-control-allow-origin: *, so the browser calls it directly. There is no
// backend proxy and no stored credential of any kind.
const BASE = "https://api.sleeper.app/v1";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper request failed (${res.status})`);
  return res.json();
}

/** Resolve a username to a Sleeper user. Throws if no such user exists. */
export async function fetchUser(username) {
  const name = String(username || "").trim();
  if (!name) throw new Error("Enter a Sleeper username");
  const user = await getJson(`${BASE}/user/${encodeURIComponent(name)}`);
  if (!user || !user.user_id) throw new Error(`No Sleeper user named "${name}"`);
  return user;
}

/** All of a user's NFL leagues for a season. */
export async function fetchLeagues(userId, season) {
  const leagues = await getJson(`${BASE}/user/${userId}/leagues/nfl/${season}`);
  return Array.isArray(leagues) ? leagues : [];
}

/** A league's draft, or null when none exists yet. */
export async function fetchLeagueDraft(leagueId) {
  const drafts = await getJson(`${BASE}/league/${leagueId}/drafts`);
  if (!Array.isArray(drafts) || drafts.length === 0) return null;
  return getJson(`${BASE}/draft/${drafts[0].draft_id}`);
}

/**
 * Map a league and its draft onto New Draft form values.
 * Pure — no network — so it is unit-tested against real league shapes.
 */
export function toDraftConfig(league, draft, userId) {
  const rosterSlots = Array.isArray(league?.roster_positions)
    ? league.roster_positions
    : [];

  // Scoring collapses to the three formats our ADP data actually has.
  const rec = league?.scoring_settings?.rec;
  const format = rec >= 1 ? "ppr" : rec === 0.5 ? "half-ppr" : "standard";

  // Rounds come from the DRAFT. league.settings.draft_rounds is a different
  // number entirely — it reads 3 for a 16-round draft.
  const rounds = Number(draft?.settings?.rounds) || rosterSlots.length || 15;

  const teams =
    Number(league?.total_rosters) || Number(draft?.settings?.teams) || 12;

  const slot = Number(draft?.draft_order?.[userId]);
  const userTeam =
    Number.isInteger(slot) && slot >= 1 && slot <= teams ? slot : 1;

  return {
    teams,
    rounds,
    format,
    rosterSlots,
    userTeam,
    leagueName: league?.name || "League",
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm run test:unit`
Expected: PASS — 19 tests (6 existing plus 13 new), 0 failing

- [ ] **Step 5: Verify the build**

Run: `cd frontend && npm run build`
Expected: `✓ built in <time>` with no errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/sleeper.js frontend/src/lib/sleeper.test.js
git commit -m "Add Sleeper client and league-to-draft-config mapping"
```

---

## Task 4: Import UI

**Files:**
- Modify: `frontend/src/pages/NewDraft.jsx`

**Interfaces:**
- Consumes: `fetchUser`, `fetchLeagues`, `fetchLeagueDraft`, `toDraftConfig` from `../lib/sleeper`
- Produces: testids `sleeper-username`, `sleeper-find`, `sleeper-leagues`, `sleeper-error`, `roster-summary`. Task 5 selects on all five.

- [ ] **Step 1: Add the imports and state**

In `frontend/src/pages/NewDraft.jsx`, add after the existing imports:

```jsx
import {
  fetchUser,
  fetchLeagues,
  fetchLeagueDraft,
  toDraftConfig,
} from "../lib/sleeper";
```

Then add after the existing `randomSlot` state line:

Then add a season constant beside the existing `DRAFT_YEAR`:

```jsx
// The Sleeper season to look leagues up in. This is deliberately NOT DRAFT_YEAR.
// DRAFT_YEAR is 2025 and is stored as metadata on the draft record; the ADP data
// the sync job loads is 2026 (ADP_YEAR in template.yaml). A user's 2025 and 2026
// Sleeper leagues are different leagues, so looking up 2025 would show last
// season's leagues while drafting them against this season's rankings.
const SLEEPER_SEASON = 2026;
```

and this state after the existing `randomSlot` line:

```jsx
  const [rosterSlots, setRosterSlots] = useState(null);
  const [username, setUsername] = useState("");
  const [leagues, setLeagues] = useState(null);
  const [sleeperErr, setSleeperErr] = useState("");
  const [finding, setFinding] = useState(false);
  const [importedFrom, setImportedFrom] = useState("");
```

`rosterSlots` starts `null`, meaning "not imported" — the backend then applies its default.

- [ ] **Step 2: Add the lookup and selection handlers**

Add after the `createDraft` function:

```jsx
  const findLeagues = async () => {
    setFinding(true);
    setSleeperErr("");
    setLeagues(null);
    try {
      const user = await fetchUser(username);
      const found = await fetchLeagues(user.user_id, SLEEPER_SEASON);
      if (found.length === 0) {
        setSleeperErr(`No ${SLEEPER_SEASON} leagues found for "${username}"`);
      }
      setLeagues(found.map((l) => ({ ...l, __userId: user.user_id })));
    } catch (e) {
      setSleeperErr(e.message || "Could not reach Sleeper");
    } finally {
      setFinding(false);
    }
  };

  const useLeague = async (league) => {
    setSleeperErr("");
    try {
      const draft = await fetchLeagueDraft(league.league_id);
      const cfg = toDraftConfig(league, draft, league.__userId);
      setTeams(cfg.teams);
      setRounds(cfg.rounds);
      setFormat(cfg.format);
      setSlot(cfg.userTeam);
      setRandomSlot(false);
      setRosterSlots(cfg.rosterSlots);
      setImportedFrom(cfg.leagueName);
      setLeagues(null);
    } catch (e) {
      setSleeperErr(e.message || "Could not load that league's draft");
    }
  };
```

- [ ] **Step 3: Send rosterSlots when creating the draft**

In `createDraft`, replace the `apiPost` call body:

```jsx
      const draft = await apiPost("/drafts", {
        teams,
        rounds,
        sport: "nfl",
        format,
        year: DRAFT_YEAR,
        userTeam,
        ...(rosterSlots ? { rosterSlots } : {}),
      });
```

Spreading conditionally means a non-imported draft sends no `rosterSlots` at all, and the backend applies its own default rather than receiving an empty array.

- [ ] **Step 4: Add the import section**

In the returned JSX, insert immediately after the closing `</div>` of the page header block (the one containing the `<h1>New mock draft</h1>`) and before `<div className="max-w-2xl space-y-6">`:

```jsx
      <div className="mb-6 max-w-2xl rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-5">
        <div className="text-sm font-semibold text-white">Import from Sleeper</div>
        <p className="mt-1 text-xs text-zinc-400">
          Enter a Sleeper username to pull a league's teams, rounds, scoring, roster
          slots, and your draft slot. Nothing is stored and no sign-in is needed.
        </p>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            data-testid="sleeper-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") findLeagues(); }}
            placeholder="Sleeper username"
            className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-300/60"
          />
          <button
            type="button"
            onClick={findLeagues}
            disabled={finding}
            data-testid="sleeper-find"
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
          >
            {finding ? "Finding…" : "Find my leagues"}
          </button>
        </div>

        {sleeperErr && (
          <div data-testid="sleeper-error" className="mt-3 text-sm text-rose-300">
            {sleeperErr}
          </div>
        )}

        {leagues && leagues.length > 0 && (
          <ul data-testid="sleeper-leagues" className="mt-3 space-y-1">
            {leagues.map((l) => (
              <li key={l.league_id}>
                <button
                  type="button"
                  onClick={() => useLeague(l)}
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-left text-sm text-zinc-200 hover:border-cyan-300/60"
                >
                  {l.name}
                  <span className="ml-2 text-xs text-zinc-500">
                    {l.total_rosters} teams
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {rosterSlots && (
          <div data-testid="roster-summary" className="mt-4 space-y-2">
            <div className="text-xs text-zinc-400">
              Roster imported from {importedFrom}
            </div>
            <div className="flex flex-wrap gap-1">
              {rosterSlots.map((s, i) => (
                <span
                  key={`${s}-${i}`}
                  className={`rounded-full border px-2 py-0.5 text-[10px] ${
                    s === "BN"
                      ? "border-zinc-800 text-zinc-500"
                      : "border-cyan-300/40 text-cyan-200"
                  }`}
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
```

- [ ] **Step 5: Verify the build**

Run: `cd frontend && npm run build`
Expected: `✓ built in <time>` with no errors

- [ ] **Step 6: Verify the existing suites still pass**

Run: `cd frontend && npm test`
Expected: `51 passed`

Run: `cd frontend && npm run test:unit`
Expected: 19 passing

- [ ] **Step 7: Revert regenerated screenshots**

Run: `cd /Users/connor/projects/sports-mock-draft && git checkout -- screenshots/`

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/NewDraft.jsx
git commit -m "Add Sleeper league import to the New Draft form"
```

---

## Task 5: End-to-end coverage

**Files:**
- Create: `frontend/tests/sleeper.spec.js`

**Interfaces:**
- Consumes: the testids from Task 4
- Produces: regression coverage. Terminal task.

- [ ] **Step 1: Write the spec**

`frontend/tests/sleeper.spec.js`:

```js
import { test, expect } from "@playwright/test";

const SLEEPER = "https://api.sleeper.app/v1";
const USER_ID = "865123803410374656";

const LEAGUE = {
  league_id: "1388274573291560960",
  name: "Average Joes 26'",
  total_rosters: 12,
  roster_positions: ["QB","RB","RB","WR","WR","WR","TE","FLEX","K","DEF","BN","BN","BN","BN","BN","BN"],
  scoring_settings: { rec: 0.5 },
  settings: { draft_rounds: 3 },
};

async function mockSleeper(page, { user = true, leagues = [LEAGUE] } = {}) {
  await page.route(`${SLEEPER}/user/*`, (route) =>
    user
      ? route.fulfill({ json: { user_id: USER_ID, username: "ck15" } })
      : route.fulfill({ status: 404, body: "null" })
  );
  await page.route(`${SLEEPER}/user/*/leagues/nfl/*`, (route) =>
    route.fulfill({ json: leagues })
  );
  await page.route(`${SLEEPER}/league/*/drafts`, (route) =>
    route.fulfill({ json: [{ draft_id: "d1" }] })
  );
  await page.route(`${SLEEPER}/draft/*`, (route) =>
    route.fulfill({
      json: {
        type: "snake",
        settings: { rounds: 16, teams: 12 },
        draft_order: { [USER_ID]: 7 },
      },
    })
  );
}

test("importing a league fills the form from its real settings", async ({ page }) => {
  await mockSleeper(page);
  await page.goto("/draft/new");

  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();

  await expect(page.getByTestId("sleeper-leagues")).toContainText("Average Joes 26'");
  await page.getByTestId("sleeper-leagues").getByRole("button").first().click();

  await expect(page.getByLabel("Teams")).toHaveValue("12");
  await expect(page.getByLabel("Rounds")).toHaveValue("16");
  await expect(page.getByLabel("ADP Format")).toHaveValue("half-ppr");
  await expect(page.getByTestId("slot-select")).toHaveValue("7");
  await expect(page.getByTestId("roster-summary")).toContainText("FLEX");
});

test("imported values remain editable", async ({ page }) => {
  await mockSleeper(page);
  await page.goto("/draft/new");

  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();
  await page.getByTestId("sleeper-leagues").getByRole("button").first().click();
  await expect(page.getByLabel("Teams")).toHaveValue("12");

  await page.getByLabel("Teams").fill("10");
  await expect(page.getByLabel("Teams")).toHaveValue("10");
});

test("the imported roster is sent when the draft is created", async ({ page }) => {
  let posted = null;
  await mockSleeper(page);
  await page.route("http://localhost:9999/drafts", async (route) => {
    posted = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ json: { draftId: "abc" } });
  });

  await page.goto("/draft/new");
  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();
  await page.getByTestId("sleeper-leagues").getByRole("button").first().click();
  await expect(page.getByTestId("roster-summary")).toBeVisible();

  await page.getByRole("button", { name: /Start Mock Draft/i }).click();

  await expect.poll(() => posted?.rosterSlots?.length).toBe(16);
  expect(posted.userTeam).toBe(7);
  expect(posted.rounds).toBe(16);
  expect(posted.format).toBe("half-ppr");
});

test("a draft created without importing sends no rosterSlots", async ({ page }) => {
  let posted = null;
  await page.route("http://localhost:9999/drafts", async (route) => {
    posted = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ json: { draftId: "abc" } });
  });

  await page.goto("/draft/new");
  await page.getByRole("button", { name: /Start Mock Draft/i }).click();

  await expect.poll(() => posted?.teams).toBe(12);
  expect(posted.rosterSlots).toBeUndefined();
});

test("an unknown username shows an error and leaves the form alone", async ({ page }) => {
  await mockSleeper(page, { user: false });
  await page.goto("/draft/new");

  await page.getByTestId("sleeper-username").fill("nobody");
  await page.getByTestId("sleeper-find").click();

  await expect(page.getByTestId("sleeper-error")).toBeVisible();
  await expect(page.getByLabel("Teams")).toHaveValue("12");
  await expect(page.getByTestId("roster-summary")).toHaveCount(0);
});

test("a user with no leagues shows an error", async ({ page }) => {
  await mockSleeper(page, { leagues: [] });
  await page.goto("/draft/new");

  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();

  await expect(page.getByTestId("sleeper-error")).toContainText("No 2026 leagues");
});
```

- [ ] **Step 2: Run the new spec**

Run: `cd frontend && npx playwright test sleeper.spec.js`
Expected: `6 passed`

If the "no leagues" test fails on the year in its message, check `SLEEPER_SEASON` in `NewDraft.jsx` and match the assertion to it rather than changing the source.

- [ ] **Step 3: Run everything**

Run: `cd frontend && npm test`
Expected: `57 passed` (51 existing plus 6 new)

Run: `cd frontend && npm run test:unit`
Expected: 19 passing

Run: `cd backend/src && npm test`
Expected: 39 passing

- [ ] **Step 4: Revert regenerated screenshots**

Run: `cd /Users/connor/projects/sports-mock-draft && git checkout -- screenshots/`

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/sleeper.spec.js
git commit -m "Add end-to-end coverage for Sleeper league import"
```

---

## Verification

After Task 5:

```bash
cd backend/src && npm test          # 39 unit tests
cd ../../frontend && npm run test:unit   # 19 unit tests
npm test                            # 57 Playwright tests
npm run build                       # clean build
cd ../backend && sam validate --lint     # exit 0
```

Deployment touches **both** halves this time: `cd backend && sam build && sam deploy` for the engine change, then `cd frontend && npm run deploy`.

## Notes for the implementer

- **Backend is CommonJS, frontend is ESM.** `roster.js` uses `require`/`module.exports`; `sleeper.js` uses `import`/`export`. Copying one style into the other file breaks it.
- **Never read `league.settings.draft_rounds`.** It is not the round count — it reads 3 for a 16-round draft. Rounds come from `draft.settings.rounds`.
- **`rosterSlots: null` in the UI means "not imported."** The create call omits the field entirely so the backend applies `DEFAULT_ROSTER`, rather than sending an empty array that would parse to a roster with no starters.
- **Do not add a manual roster editor.** Out of scope by decision; the roster comes from an import or the default.
- **Screenshots are committed baselines.** The Playwright suite rewrites them on every run; revert rather than committing the churn.
- **`SLEEPER_SEASON` and `DRAFT_YEAR` are different numbers on purpose.** `SLEEPER_SEASON`
  (2026) is which season's leagues to look up; `DRAFT_YEAR` (2025) is metadata stored on the
  draft record. They differ because `DRAFT_YEAR` is stale relative to the ADP data the sync
  job loads (`ADP_YEAR: 2026`). Using `DRAFT_YEAR` for the lookup would surface last
  season's leagues — genuinely different leagues, not just a different label — while
  drafting them against this season's rankings. Reconciling `DRAFT_YEAR` is a separate
  decision and is deliberately not part of this plan.
