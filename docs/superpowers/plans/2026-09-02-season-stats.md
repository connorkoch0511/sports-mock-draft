# Season Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull last completed season's real production from Sleeper for every ranked player, so the app can reason about what players actually did.

**Architecture:** Three tasks. Task 1 extracts the stats logic into pure, exported helpers and tests them directly — `syncPlayers.js` currently exports only `handler`, so without this every test would have to stub both `fetch` and DynamoDB. Task 2 wires those helpers into the handler, including season detection and failure resilience. Task 3 exposes the stats through `players.js`.

**Tech Stack:** Node.js 24 (CommonJS), AWS SDK v3, AWS SAM, `node:test`.

## Global Constraints

- **The backend is CommonJS.** `require`/`module.exports` only. The frontend is ESM; mixing them is a defect.
- **No new dependencies.** No `backend/src/package.json` change. `fetch` is global in Node 24.
- **No frontend change.** Nothing under `frontend/` is touched, and nothing displays these stats yet.
- **The existing ADP merge, tiering, and item shape are untouched.** This work is additive only.
- **A failing stats fetch must not fail the sync.** A missing stat is a degraded experience; a failed sync is an empty player pool for every draft.
- **Absent source fields are omitted, never stored as zero.** A receiver with no rushing attempts and one with an unreported figure are different things.
- Tests run with `cd backend/src && npm test`. There is no `backend/package.json`.
- Existing suites must stay green: **106 backend unit**, 90 frontend unit, 127 Playwright.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `backend/src/syncPlayers.js` | Nightly player/ADP sync | Task 1 — pure helpers + exports; Task 2 — handler wiring |
| `backend/src/syncPlayers.test.js` | Sync tests | Task 1 — **new**; Task 2 — extended |
| `backend/src/players.js` | `GET /players` | Task 3 — stats passthrough |
| `backend/src/players.test.js` | `/players` tests | Task 3 — extended |

### Measured facts this plan depends on

| | |
|---|---|
| Stats endpoint | `https://api.sleeper.app/v1/stats/nfl/regular/{season}`, unauthenticated, ~1.9 MB |
| Join rate against our ranked pool | **269 of 269**, zero misses — both sides key on Sleeper ids |
| 2025 | complete: max `gp` 18 |
| 2026 | not started: max `gp` 0 |
| `/players` today | 436,463 raw / **51,698 gzipped** |
| With stats on all players | 657,034 raw / 85,756 gzipped — **1.7×** |
| With stats on ranked only | 493,012 raw / **60,872 gzipped — 1.2×** |

---

## Task 1: Pure stats helpers

**Files:**
- Modify: `backend/src/syncPlayers.js` (add helpers near the other module-scope functions, and a `module.exports` block)
- Create: `backend/src/syncPlayers.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces, used by Task 2 and by the tests:
  - `STATS_FIELDS` — the curated field list
  - `pickStats(raw)` → a curated object, or `null` when there is nothing worth keeping
  - `hasPlayedGames(statsByPlayer)` → boolean
  - `resolveStatsSeason(year, fetchSeason)` → `{ season, stats }`

**Background.** `syncPlayers.js` currently ends with `exports.handler = async () => {...}` and exports nothing else. Adding a `module.exports` block that also re-exports `handler` keeps the Lambda entry point working — **SAM invokes `syncPlayers.handler`, so breaking that export breaks the nightly job silently.**

`resolveStatsSeason` takes its fetcher as an argument so the season-detection logic can be tested without network access.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/syncPlayers.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const {
  STATS_FIELDS,
  pickStats,
  hasPlayedGames,
  resolveStatsSeason,
} = require("./syncPlayers");

test("pickStats keeps the curated fields", () => {
  const out = pickStats({
    gp: 17,
    rec_tgt: 129,
    rec_yd: 924,
    off_snp: 932,
    tm_off_snp: 1123,
    pts_ppr: 416.6,
  });

  assert.strictEqual(out.gp, 17);
  assert.strictEqual(out.rec_tgt, 129);
  assert.strictEqual(out.off_snp, 932);
  assert.strictEqual(out.tm_off_snp, 1123);
  assert.strictEqual(out.pts_ppr, 416.6);
});

test("pickStats omits a field the source does not have, rather than zeroing it", () => {
  // A receiver with no carries and a receiver whose carries went unreported are
  // different things. Storing 0 asserts the first.
  const out = pickStats({ gp: 17, rec_tgt: 129 });

  assert.ok(!("rush_att" in out), "absent fields must not appear at all");
  assert.strictEqual(out.rush_att, undefined);
});

test("pickStats drops fields outside the curated set", () => {
  const out = pickStats({ gp: 17, opp_off_yd: 5000, penalty_yd: 300, blk_kick_ret_td: 1 });

  assert.deepStrictEqual(Object.keys(out), ["gp"]);
});

test("pickStats returns null when nothing curated survives", () => {
  assert.strictEqual(pickStats({ opp_off_yd: 5000 }), null);
  assert.strictEqual(pickStats({}), null);
  assert.strictEqual(pickStats(null), null);
});

test("STATS_FIELDS covers the signals the feature was built for", () => {
  for (const f of ["gp", "pts_ppr", "rec_tgt", "off_snp", "tm_off_snp", "rec_rz_tgt"]) {
    assert.ok(STATS_FIELDS.includes(f), `${f} must be curated`);
  }
});

test("hasPlayedGames is false when nobody has played", () => {
  assert.strictEqual(hasPlayedGames({ "1": { gp: 0 }, "2": { gp: 0 } }), false);
  assert.strictEqual(hasPlayedGames({}), false);
  assert.strictEqual(hasPlayedGames(null), false);
});

test("hasPlayedGames is true as soon as one player has played", () => {
  assert.strictEqual(hasPlayedGames({ "1": { gp: 0 }, "2": { gp: 3 } }), true);
});

test("resolveStatsSeason uses the requested season when it has games", () => {
  const seasons = { 2025: { "1": { gp: 17 } } };
  return resolveStatsSeason(2025, async (y) => seasons[y] || {}).then((r) => {
    assert.strictEqual(r.season, 2025);
    assert.strictEqual(r.stats["1"].gp, 17);
  });
});

test("resolveStatsSeason falls back a season when the requested one has not started", () => {
  // Every September the new season exists as an endpoint but holds nothing.
  // A hardcoded year would silently serve an empty table.
  const seasons = { 2026: { "1": { gp: 0 } }, 2025: { "1": { gp: 17 } } };
  return resolveStatsSeason(2026, async (y) => seasons[y] || {}).then((r) => {
    assert.strictEqual(r.season, 2025, "should fall back to the completed season");
    assert.strictEqual(r.stats["1"].gp, 17);
  });
});

test("resolveStatsSeason reports the season it actually used", () => {
  const seasons = { 2026: {}, 2025: { "1": { gp: 17 } } };
  return resolveStatsSeason(2026, async (y) => seasons[y] || {}).then((r) => {
    assert.strictEqual(r.season, 2025);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend/src && npm test 2>&1 | tail -15
```

Expected: FAIL — the module exports none of these names, so the destructured requires are `undefined` and every test throws.

- [ ] **Step 3: Add the helpers**

In `backend/src/syncPlayers.js`, add near the other module-scope helpers:

```js
// The stats feed carries ~100 fields per player, most of them team, kicking or
// defensive columns irrelevant to drafting a skill player. These are the ones
// the app reasons about.
const STATS_FIELDS = [
  "gp",
  "pts_ppr", "pts_half_ppr", "pts_std", "pos_rank_ppr",
  "rec", "rec_tgt", "rec_yd", "rec_td", "rec_rz_tgt", "rec_air_yd",
  "rush_att", "rush_yd", "rush_td",
  "pass_att", "pass_yd", "pass_td", "pass_int",
  "off_snp", "tm_off_snp",
];

// Curate one player's stats. Absent fields are omitted rather than zeroed: a
// receiver with no carries and one whose carries went unreported are different
// things, and 0 asserts the first. Returns null when nothing survives, so the
// caller can skip the key entirely.
function pickStats(raw) {
  if (!raw || typeof raw !== "object") return null;

  const out = {};
  for (const f of STATS_FIELDS) {
    const v = raw[f];
    if (typeof v === "number" && Number.isFinite(v)) out[f] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Has anyone played yet? Every September the new season exists as an endpoint
// but holds nothing, so this is what stops the sync serving an empty table.
function hasPlayedGames(statsByPlayer) {
  if (!statsByPlayer || typeof statsByPlayer !== "object") return false;
  return Object.values(statsByPlayer).some(
    (s) => s && typeof s.gp === "number" && s.gp > 0
  );
}

// Take the requested season if it has real games, else the one before it. The
// fetcher is injected so the fallback can be tested without network access.
async function resolveStatsSeason(year, fetchSeason) {
  const primary = await fetchSeason(year);
  if (hasPlayedGames(primary)) return { season: year, stats: primary };

  const prior = await fetchSeason(year - 1);
  return { season: year - 1, stats: prior };
}
```

- [ ] **Step 4: Export them without breaking the Lambda entry point**

At the end of `backend/src/syncPlayers.js`, after the existing `exports.handler = ...`, add:

```js
// SAM invokes syncPlayers.handler, so it must remain exported. These are added
// for testing; the handler assignment above is unchanged.
module.exports.STATS_FIELDS = STATS_FIELDS;
module.exports.pickStats = pickStats;
module.exports.hasPlayedGames = hasPlayedGames;
module.exports.resolveStatsSeason = resolveStatsSeason;
```

Use `module.exports.X = ...` rather than replacing `module.exports` with an object literal — replacing it would drop `handler` and silently break the nightly job.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend/src && npm test 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: 116 tests, 116 pass, 0 fail (106 pre-existing + 10 added here).

- [ ] **Step 6: Confirm the Lambda entry point still resolves**

```bash
cd backend/src && node -e "
const m = require('./syncPlayers');
console.log('handler is', typeof m.handler);
console.log('pickStats is', typeof m.pickStats);
"
```

Expected: both print `function`. If `handler` is `undefined`, the nightly sync is broken — stop and fix the export.

- [ ] **Step 7: Commit**

```bash
git add backend/src/syncPlayers.js backend/src/syncPlayers.test.js
git commit -m "Add pure stats helpers to the player sync

The nightly sync has had no tests at all, which is notable for the job
with the widest blast radius in the app -- it rewrites the entire
players table unattended every day.

These helpers are pure and separately exported so they can be tested
without stubbing both fetch and DynamoDB: field curation, whether a
season has started, and season resolution with the fetcher injected.

Season detection matters because a hardcoded year goes stale every
September, when the new season exists as an endpoint but holds nothing.
Measured: 2025 has games (max gp 18) and 2026 does not (max gp 0).

Absent fields are omitted rather than zeroed. A receiver with no carries
and one whose carries went unreported are different things."
```

---

## Task 2: Wire stats into the sync

**Files:**
- Modify: `backend/src/syncPlayers.js` (the handler)
- Test: `backend/src/syncPlayers.test.js` (append)

**Interfaces:**
- Consumes: `pickStats` and `resolveStatsSeason` from Task 1.
- Produces: player items carrying `stats` and `statsSeason`, which Task 3 reads.

**Background.** The handler already does three things in order: fetch Sleeper's player dump, fetch FFC ADP per format, then merge ADP into the players. Stats become a fourth fetch and a fourth merge, placed **after** the ADP merge so a stats failure cannot interrupt it.

**The resilience requirement is the point of this task.** The sync runs unattended on `rate(1 day)` and rewrites the whole table. If Sleeper's stats endpoint is down or changes shape, the sync must still write players — without stats — rather than throwing. A missing stat degrades the experience; a failed sync empties the pool for every draft.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/syncPlayers.test.js`:

```js
// mergeStats is pure, so these need no fetch or DynamoDB stubbing. The
// handler's resilience -- that a stats failure cannot fail the sync -- is
// verified directly in Step 6 rather than through a mocked global fetch,
// which would test the mock more than the code.
test("mergeStats attaches curated stats to matching players", () => {
  const { mergeStats } = require("./syncPlayers");
  const players = [{ id: "1", name: "A" }, { id: "2", name: "B" }];
  const stats = { "1": { gp: 17, rec_tgt: 100, opp_off_yd: 9 } };

  mergeStats(players, stats, 2025);

  assert.deepStrictEqual(players[0].stats, { gp: 17, rec_tgt: 100 });
  assert.strictEqual(players[0].statsSeason, 2025);
});

test("mergeStats leaves a player with no stats entirely untouched", () => {
  const { mergeStats } = require("./syncPlayers");
  const players = [{ id: "2", name: "B" }];

  mergeStats(players, { "1": { gp: 17 } }, 2025);

  assert.ok(!("stats" in players[0]), "no empty stats object");
  assert.ok(!("statsSeason" in players[0]), "and no dangling season");
});

test("mergeStats does not disturb existing fields", () => {
  const { mergeStats } = require("./syncPlayers");
  const players = [{ id: "1", name: "A", adp: { ppr: 5 }, rank: { ppr: 3 } }];

  mergeStats(players, { "1": { gp: 17 } }, 2025);

  assert.deepStrictEqual(players[0].adp, { ppr: 5 });
  assert.deepStrictEqual(players[0].rank, { ppr: 3 });
  assert.strictEqual(players[0].name, "A");
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd backend/src && npm test 2>&1 | tail -12
```

Expected: FAIL — `mergeStats` is not exported and is `undefined`.

- [ ] **Step 3: Add the merge helper**

In `backend/src/syncPlayers.js`, beside the other stats helpers:

```js
// Attach curated stats to the players we have. Players absent from the feed
// get no `stats` key at all rather than an empty object, so the response can
// distinguish "no data" from "played but recorded nothing".
function mergeStats(players, statsByPlayer, season) {
  if (!statsByPlayer) return 0;

  let matched = 0;
  for (const pl of players) {
    const curated = pickStats(statsByPlayer[pl.id]);
    if (!curated) continue;
    pl.stats = curated;
    pl.statsSeason = season;
    matched += 1;
  }
  return matched;
}
```

and export it alongside the others:

```js
module.exports.mergeStats = mergeStats;
```

- [ ] **Step 4: Fetch stats in the handler, without letting them break it**

In `backend/src/syncPlayers.js`, add a fetcher beside `fetchFfcAdp`:

```js
async function fetchSeasonStats(season) {
  const url = `https://api.sleeper.app/v1/stats/nfl/regular/${season}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sleeper stats fetch failed (${season}): ${r.status}`);
  return r.json();
}
```

In the handler, read the season alongside the other env config:

```js
  const STATS_YEAR = Number(process.env.STATS_YEAR || ADP_YEAR);
```

and after the ADP merge completes, before the DynamoDB writes:

```js
  // 4) Season stats. Deliberately wrapped: this job rewrites the entire
  // players table unattended every day, so a Sleeper outage or a shape change
  // must degrade to players-without-stats rather than leaving every draft with
  // an empty pool.
  let statsSeason = null;
  let statsMatched = 0;
  try {
    const resolved = await resolveStatsSeason(STATS_YEAR, fetchSeasonStats);
    statsSeason = resolved.season;
    statsMatched = mergeStats(basePlayers, resolved.stats, resolved.season);
  } catch (e) {
    console.error("season stats unavailable, continuing without them:", e.message);
  }
```

Add both to the handler's returned body, beside `adpYear`:

```js
      statsSeason,
      statsMatched,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend/src && npm test 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: 119 tests, 119 pass, 0 fail (116 from Task 1 + 3 added here).

- [ ] **Step 6: Prove the resilience is real, not asserted**

The claim that a stats failure cannot break the sync is the whole reason this task is shaped the way it is. Verify it directly:

```bash
cd backend/src && node -e "
const m = require('./syncPlayers');
// resolveStatsSeason rejecting must not escape the handler's try/catch.
m.resolveStatsSeason(2026, async () => { throw new Error('down'); })
  .then(() => console.log('UNEXPECTED: should have rejected'))
  .catch(() => console.log('rejects as expected — the handler catches this'));
"
```

Expected: `rejects as expected`. Then confirm by reading the handler that the `resolveStatsSeason` call is inside the `try`, and that nothing after the `catch` depends on `statsSeason` being non-null.

- [ ] **Step 7: Validate the template still builds**

```bash
cd backend && sam validate --lint 2>&1 | tail -2
```

Expected: valid template. No template change was made — `STATS_YEAR` falls back to `ADP_YEAR`, so no new environment variable is required.

- [ ] **Step 8: Commit**

```bash
git add backend/src/syncPlayers.js backend/src/syncPlayers.test.js
git commit -m "Fetch season stats in the nightly sync

A fourth fetch and merge, placed after the ADP merge so a stats problem
cannot interrupt it, and wrapped so it cannot fail the run at all. This
job rewrites the entire players table unattended every day: a missing
stat is a degraded experience, a failed sync is an empty pool for every
draft.

Players absent from the stats feed get no stats key rather than an empty
object, so the response can tell 'no data' from 'played but recorded
nothing'. The season actually used is written to each item and returned
in the sync's own response, so a stale value is diagnosable without
reading logs.

No template change: STATS_YEAR falls back to ADP_YEAR."
```

---

## Task 3: Expose stats through `/players`

**Files:**
- Modify: `backend/src/players.js`
- Test: `backend/src/players.test.js` (append)

**Interfaces:**
- Consumes: the `stats` and `statsSeason` fields Task 2 writes.
- Produces: `stats` and `statsSeason` on ranked players in the `/players` response.

**Background.** `players.js` maps each item to seven fields and sorts by rank. Stats are added **only when the player is ranked and stats exist**.

**"Ranked" means ranked in the requested format.** `players.js` derives `rank` from `p.rank?.[format]`, and the rank sets genuinely differ — 223 players for standard, 272 for PPR. So the same player receives stats on a PPR request and not on a standard one. That is consistent with a format-specific response, and one of the tests below pins it precisely because it is surprising.

This rule is what holds the payload at 1.2× rather than 1.7×: measured, `/players` is 51,698 bytes gzipped today, 60,872 with stats on ranked players, and 85,756 with stats on everyone.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/players.test.js`:

```js
test("a ranked player with stats gets them, with the season", () => {
  stubPages([
    {
      Items: [
        {
          ...player("a", 1),
          stats: { gp: 17, rec_tgt: 129, pts_ppr: 416.6 },
          statsSeason: 2025,
        },
      ],
    },
  ]);

  return get().then(({ body }) => {
    assert.deepStrictEqual(body.players[0].stats, {
      gp: 17,
      rec_tgt: 129,
      pts_ppr: 416.6,
    });
    assert.strictEqual(body.players[0].statsSeason, 2025);
  });
});

test("an unranked player gets no stats, even when the item has them", () => {
  // This rule is what keeps the payload at 1.2x rather than 1.7x.
  const unranked = player("b", 0, { rank: {}, adp: {}, tier: {} });
  unranked.stats = { gp: 17 };
  unranked.statsSeason = 2025;

  stubPages([{ Items: [unranked] }]);

  return get().then(({ body }) => {
    assert.ok(!("stats" in body.players[0]), "unranked players carry no stats");
    assert.ok(!("statsSeason" in body.players[0]));
  });
});

test("a ranked player with no stats gets neither key", () => {
  stubPages([{ Items: [player("a", 1)] }]);

  return get().then(({ body }) => {
    assert.ok(!("stats" in body.players[0]));
    assert.ok(!("statsSeason" in body.players[0]));
  });
});

test("stats follow the format's own rank set, not a global one", () => {
  // Standard ranks 223 players and PPR ranks 272 in production, so the same
  // id legitimately carries stats on one format's response and not another's.
  const pprOnly = {
    ...player("a", 1),
    rank: { ppr: 5 },
    adp: { ppr: 5.5 },
    tier: { ppr: 1 },
    stats: { gp: 17 },
    statsSeason: 2025,
  };

  stubPages([{ Items: [pprOnly] }]);
  return get({ format: "ppr" }).then(({ body }) => {
    assert.strictEqual(body.players[0].statsSeason, 2025, "ranked in ppr, so stats appear");

    mock.restoreAll();
    stubPages([{ Items: [pprOnly] }]);
    return get({ format: "standard" }).then((res) => {
      assert.ok(
        !("stats" in res.body.players[0]),
        "not ranked in standard, so no stats on that response"
      );
    });
  });
});

test("the seven existing fields are unchanged when stats are present", () => {
  stubPages([
    { Items: [{ ...player("a", 1), stats: { gp: 17 }, statsSeason: 2025 }] },
  ]);

  return get().then(({ body }) => {
    const p = body.players[0];
    for (const k of ["id", "name", "position", "team", "rank", "adp", "tier"]) {
      assert.ok(k in p, `${k} must still be present`);
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd backend/src && npm test 2>&1 | tail -15
```

Expected: FAIL on the two tests that expect stats to appear. The three asserting stats are *absent* pass already — they guard against over-emitting once the field is added.

- [ ] **Step 3: Add the passthrough**

In `backend/src/players.js`, replace the `.map(...)` with one that adds the fields conditionally:

```js
  const players = items
    .map((p) => {
      const rank = p.rank?.[format] ?? null;
      const out = {
        id: p.id || p.playerId,
        name: p.name,
        position: p.position,
        team: p.team,
        rank,
        adp: p.adp?.[format] ?? null,
        tier: p.tier?.[format] ?? null,
      };

      // Stats ride along only for players ranked in THIS format. Measured, that
      // is the difference between a 1.2x and a 1.7x payload, and the unranked
      // remainder is depth nobody drafts.
      if (rank != null && p.stats) {
        out.stats = p.stats;
        out.statsSeason = p.statsSeason;
      }

      return out;
    })
    .sort((a, b) => (a.rank ?? 999999) - (b.rank ?? 999999));
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend/src && npm test 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: 124 tests, 124 pass, 0 fail (119 from Task 2 + 5 added here).

- [ ] **Step 5: Prove the ranked-only rule is load-bearing**

```bash
cd backend/src
sed -i '' 's/if (rank != null \&\& p.stats) {/if (p.stats) {/' players.js
npm test 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: FAIL — dropping the rank check must break the unranked-player test. If it does not, that test is not pinning the rule that holds the payload down.

Restore:

```bash
cd backend/src
sed -i '' 's/if (p.stats) {/if (rank != null \&\& p.stats) {/' players.js
grep -n "rank != null && p.stats" players.js
npm test 2>&1 | grep -E "^. (tests|pass|fail)"
```

Expected: the grep matches and 124 pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/players.js backend/src/players.test.js
git commit -m "Return season stats for ranked players

Stats ride along only for players ranked in the requested format.
Measured, that is the difference between a 1.2x and a 1.7x payload
against the 51,698 bytes gzipped /players ships today, and the ~3,600
unranked are depth the boards API already filters out.

Ranked is format-specific: standard covers 223 players and PPR 272, so
the same id legitimately carries stats on one format's response and not
another's. A test pins that, because it is the kind of thing a reader
would otherwise assume was a bug."
```

---

## Verification Summary

| Check | Command | Expected |
|---|---|---|
| Backend unit | `cd backend/src && npm test` | 124 pass |
| Frontend unit | `cd frontend && npm run test:unit` | 90 pass |
| Playwright | `cd frontend && npx playwright test` | 127 pass |
| SAM template | `cd backend && sam validate --lint` | exit 0 |
| Lambda entry point | `node -e "console.log(typeof require('./syncPlayers').handler)"` | `function` |

The frontend is untouched; its suites confirm the change stayed in the backend.

## Post-Deploy Verification (controller runs this, not a task)

This changes the sync and `/players`, so it needs a **backend deploy** and then a sync run.

1. Deploy, then invoke `SyncPlayersFunction` and confirm it returns `ok: true` with a
   plausible `statsSeason` and a non-zero `statsMatched`
2. `GET /players?format=ppr` — confirm a known ranked player carries `stats` and
   `statsSeason`
3. Confirm an unranked player in the same response carries neither
4. **Measure the payload** compressed and uncompressed against today's 51,698 gzipped, and
   compare against the 60,872 the local estimate predicted
5. Run a full draft — create, pick, auto-pick, sim to completion — proving the added fields
   did not disturb the draft path
