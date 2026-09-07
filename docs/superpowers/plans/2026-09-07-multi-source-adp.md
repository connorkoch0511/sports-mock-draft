# Multi-source ADP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show ESPN's and Yahoo's ADP beside our own on every row where a player is ranked or drafted, so disagreement between sources is visible at a glance.

**Architecture:** Two new pure adapter modules normalise ESPN's and Yahoo's public ADP feeds into the exact map shape `backend/src/sync/adp.js` already produces. The daily `syncPlayers` Lambda fetches both, each wrapped independently, and writes a new additive `adpBySource` field per player. The API passes it through untouched, and two frontend surfaces render it.

**Tech Stack:** Node 22 CommonJS (backend, `node --test`), React 19 + Vite ESM (frontend, `node --test` for unit, Playwright for e2e), AWS SAM.

## Global Constraints

- **Additive only.** `p.adp[format]` is never changed, renamed, or removed. The new field is `p.adpBySource`.
- **Source keys are exactly `espn` and `yahoo`.** Lowercase, no other spelling.
- **`adpBySource` has NO format dimension.** It is `{ espn: number, yahoo: number }`. Neither service publishes per-format ADP.
- **A source with no number for a player is ABSENT from the map**, never `null`, never `0`.
- **Never guess a join.** Exact normalised match or nothing. A wrong join shows another player's number.
- **Each source fails independently.** One source failing must leave the other source and our own ADP intact, exactly as the existing stats block degrades.
- **Our rank stays the default sort.** `frontend/src/lib/boardOrder.js` is NOT modified by this plan.
- **ESPN and Yahoo numbers are platform-wide**, not per scoring format. UI must not imply otherwise.
- **Fetch depth is the top 300 per source.**
- Backend is CommonJS (`require`). Frontend is ESM (`import`). Comments explain *why*.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/sync/adpMap.js` (new) | The earliest-pick-wins rule and the DEF/K fallbacks, in one place, shared by both new adapters. |
| `backend/src/sync/adpEspn.js` (new) | Fetch ESPN's feed; convert its numeric ids and rows into the shared map shape. |
| `backend/src/sync/adpYahoo.js` (new) | Fetch Yahoo's feed (3 pages); flatten its irregular JSON into the shared map shape. |
| `backend/src/syncPlayers.js` | Call both, wrapped independently; write `adpBySource`. |
| `backend/template.yaml` | Memory headroom for the larger payload. |
| `backend/src/players.js`, `drafts.js`, `boards.js`, `lib/reconcile.js` | Pass `adpBySource` through to the client. |
| `frontend/src/lib/adpSources.js` (new) | One place that decides how the trio is formatted and ordered. |
| `frontend/src/components/draft/BigBoardPanel.jsx` | Render the trio in the draft pool. |
| `frontend/src/pages/Board.jsx` | Render the trio in the board editor. |

---

### Task 1: ESPN adapter

**Files:**
- Create: `backend/src/sync/adpMap.js`
- Create: `backend/src/sync/adpEspn.js`
- Test: `backend/src/syncPlayers.test.js` (append — this is where `buildFfcMap` is already tested; `node --test` discovers `backend/src/*.test.js` only, so do NOT create `sync/*.test.js`)

**Interfaces:**
- Consumes: `FETCH_TIMEOUT_MS` from `./http`; `ALLOWED`, `normName`, `normTeam` from `./normalize`.
- Produces:
  - `newAdpMaps()` → `{ byStrict: Map, defByTeam: Map, kByName: Map }` and `putAdp(maps, { pos, team, nameKey, adp })` from `backend/src/sync/adpMap.js`. **Task 2 uses both** — they are the shared insertion rules, so the earliest-wins and DEF/K logic exists once rather than once per source.
  - `fetchEspnAdp({ year, limit })` → array of raw ESPN row objects.
  - `buildEspnMap(rows)` → the same map shape `buildFfcMap` returns, so `syncPlayers` consumes every source identically.

The shipped `buildFfcMap` in `backend/src/sync/adp.js` is **not** refactored to use the helper. It works, it is tested, and this feature has no reason to touch it.

**Background the implementer needs.** ESPN returns **numeric** position and team ids and no string form anywhere in the payload. The tables below were derived empirically on 7 Sep 2026 by cross-referencing 300 ESPN players against Sleeper by name; every team id resolved unambiguously. Team codes here are raw Sleeper-style codes and MUST be passed through `normTeam` (which maps e.g. `WAS` → `WSH`), because the Sleeper side of the join does the same. ESPN's `draftRanksByRankType` contains `STANDARD`/`PPR` keys — those are **ranks, not ADP**; ignore them. The only ADP is `ownership.averageDraftPosition`.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/syncPlayers.test.js`:

```js
const { buildEspnMap } = require("./sync/adpEspn");

// ESPN ships numeric ids and no string form, so the whole adapter hinges on
// these tables being right. A wrong entry produces a MISS, not a wrong player,
// because the key is position + team + name together.
test("espn rows map onto the shared key shape", () => {
  const rows = [
    { player: { fullName: "Jahmyr Gibbs", defaultPositionId: 2, proTeamId: 8, ownership: { averageDraftPosition: 1.32 } } },
    { player: { fullName: "Ja'Marr Chase", defaultPositionId: 3, proTeamId: 4, ownership: { averageDraftPosition: 4.23 } } },
  ];
  const { byStrict } = buildEspnMap(rows);
  assert.strictEqual(byStrict.get("RB|DET|jahmyr gibbs"), 1.32);
  assert.strictEqual(byStrict.get("WR|CIN|jamarr chase"), 4.23);
});

// Verified live: D/ST is defaultPositionId 16, named "Texans D/ST", and
// carries proTeamId. It joins by team, which is why defByTeam exists.
test("espn defences land in defByTeam, keyed by team", () => {
  const rows = [
    { player: { fullName: "Texans D/ST", defaultPositionId: 16, proTeamId: 34, ownership: { averageDraftPosition: 92.6 } } },
  ];
  const { defByTeam } = buildEspnMap(rows);
  assert.strictEqual(defByTeam.get("HOU"), 92.6);
});

test("espn rows without a usable adp are skipped, not stored as zero", () => {
  const rows = [
    { player: { fullName: "Nobody", defaultPositionId: 2, proTeamId: 8, ownership: {} } },
    { player: { fullName: "Ghost", defaultPositionId: 2, proTeamId: 8 } },
    { player: null },
  ];
  const { byStrict } = buildEspnMap(rows);
  assert.strictEqual(byStrict.size, 0);
});

// An unknown id must not invent a player at a bogus key.
test("an unknown espn position or team id is dropped", () => {
  const rows = [
    { player: { fullName: "Someone", defaultPositionId: 99, proTeamId: 8, ownership: { averageDraftPosition: 5 } } },
    { player: { fullName: "Other", defaultPositionId: 2, proTeamId: 999, ownership: { averageDraftPosition: 6 } } },
  ];
  const { byStrict } = buildEspnMap(rows);
  assert.strictEqual(byStrict.size, 0);
});

// Mirrors buildFfcMap: the earliest pick wins when a player appears twice.
test("the lowest espn adp wins for a repeated player", () => {
  const rows = [
    { player: { fullName: "Jahmyr Gibbs", defaultPositionId: 2, proTeamId: 8, ownership: { averageDraftPosition: 4 } } },
    { player: { fullName: "Jahmyr Gibbs", defaultPositionId: 2, proTeamId: 8, ownership: { averageDraftPosition: 1.32 } } },
  ];
  assert.strictEqual(buildEspnMap(rows).byStrict.get("RB|DET|jahmyr gibbs"), 1.32);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd backend/src && node --test syncPlayers.test.js`
Expected: FAIL — `Cannot find module './sync/adpEspn'`.

- [ ] **Step 3: Write the adapter**

First create `backend/src/sync/adpMap.js`:

```js
// The rules for putting an ADP into the lookup maps, in one place.
//
// Every source disagrees about field names but agrees about these rules, so
// they live here rather than once per adapter: earliest pick wins, defences
// are found by team because their names never match, and kickers get a
// name-only fallback because their team moves more often than they do.

const { ALLOWED } = require("./normalize");

function newAdpMaps() {
  return {
    byStrict: new Map(),  // pos|team|name
    defByTeam: new Map(), // team -> adp
    kByName: new Map(),   // nameKey -> adp
  };
}

function keepLowest(map, key, adp) {
  const prev = map.get(key);
  // Lowest wins: a player listed twice was drafted earliest at the lower
  // number, and that is the pick people are actually reasoning about.
  if (prev == null || adp < prev) map.set(key, adp);
}

function putAdp(maps, { pos, team, nameKey, adp }) {
  if (!pos || !team || !adp || Number.isNaN(adp)) return;

  if (pos === "DEF") {
    keepLowest(maps.defByTeam, team, adp);
    return;
  }

  if (pos === "K" && nameKey) keepLowest(maps.kByName, nameKey, adp);

  if (!ALLOWED.has(pos) || !nameKey) return;
  keepLowest(maps.byStrict, `${pos}|${team}|${nameKey}`, adp);
}

module.exports = { newAdpMaps, putAdp };
```

Then create `backend/src/sync/adpEspn.js`:

```js
// Average draft position from ESPN's public fantasy read API, and the lookup
// maps that join it onto Sleeper's players.
//
// The endpoint needs no authentication of any kind -- verified 7 Sep 2026.

const { FETCH_TIMEOUT_MS } = require("./http");
const { normName, normTeam } = require("./normalize");
const { newAdpMaps, putAdp } = require("./adpMap");

// ESPN sends numeric ids and NO string abbreviation anywhere in the payload,
// so these tables are not a convenience -- nothing joins without them. Derived
// by cross-referencing 300 ESPN players against Sleeper by name; every team id
// resolved with no ambiguity. Ids 31 and 32 are unused by ESPN.
const ESPN_POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF" };

const ESPN_TEAM = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR",
  15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI",
  22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS",
  29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

async function fetchEspnAdp({ year, limit }) {
  // sortDraftRanks orders the response so `limit` takes the players people
  // actually draft rather than an arbitrary slice.
  const filter = JSON.stringify({
    players: { limit, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "PPR" } },
  });

  const url =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${encodeURIComponent(year)}` +
    `/segments/0/leaguedefaults/3?view=kona_player_info`;

  const r = await fetch(url, {
    headers: { "x-fantasy-filter": filter },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`ESPN ADP fetch failed: ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.players) ? j.players : [];
}

function buildEspnMap(rows) {
  const maps = newAdpMaps();

  for (const row of rows) {
    const p = row?.player;
    if (!p) continue;

    const adp = p.ownership?.averageDraftPosition != null
      ? Number(p.ownership.averageDraftPosition)
      : null;

    const pos = ESPN_POS[p.defaultPositionId];
    const rawTeam = ESPN_TEAM[p.proTeamId];
    // An id we do not recognise is dropped rather than keyed on something
    // invented -- a bogus key would sit in the map forever matching nobody.
    if (!pos || !rawTeam) continue;

    putAdp(maps, {
      pos,
      team: normTeam(rawTeam),
      nameKey: normName(p.fullName),
      adp,
    });
  }

  return maps;
}

module.exports = { fetchEspnAdp, buildEspnMap, ESPN_POS, ESPN_TEAM };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd backend/src && node --test syncPlayers.test.js`
Expected: PASS, and every pre-existing test in the file still passes.

- [ ] **Step 5: Pin it against a real captured payload**

Hand-written fixtures prove the adapter does what you meant. They cannot catch
ESPN changing shape, which is the failure this feature is actually exposed to.
Capture three real players, stripping the `stats` array — it is the bulk of the
9.8MB and the adapter never reads it, and `backend/src/` is the deployed Lambda
bundle:

```bash
mkdir -p backend/src/sync/__fixtures__
curl -s -H 'x-fantasy-filter: {"players":{"limit":3,"sortDraftRanks":{"sortPriority":1,"sortAsc":true,"value":"PPR"}}}' \
  'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leaguedefaults/3?view=kona_player_info' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [r['player'].pop('stats',None) for r in d['players']]; json.dump({'players':d['players'][:3]}, open('backend/src/sync/__fixtures__/espn-adp.json','w'), indent=2)"
```

Then append this test:

```js
const espnFixture = require("./sync/__fixtures__/espn-adp.json");

// Real captured response, not a hand-written shape. If ESPN moves the ADP or
// renames a field, this is what notices.
test("the espn adapter reads a real captured payload", () => {
  const { byStrict, defByTeam } = buildEspnMap(espnFixture.players);
  assert.ok(byStrict.size + defByTeam.size >= 3, "every captured player should map");
  for (const adp of byStrict.values()) {
    assert.ok(adp > 0 && adp < 400, `implausible adp ${adp}`);
  }
});
```

Run: `cd backend/src && node --test syncPlayers.test.js` — PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/sync/adpMap.js backend/src/sync/adpEspn.js backend/src/sync/__fixtures__/espn-adp.json backend/src/syncPlayers.test.js
git commit -m "feat: ESPN ADP adapter"
```

---

### Task 2: Yahoo adapter

**Files:**
- Create: `backend/src/sync/adpYahoo.js`
- Test: `backend/src/syncPlayers.test.js` (append)

**Interfaces:**
- Consumes: `FETCH_TIMEOUT_MS` from `./http`; `normName`, `normTeam`, `toAppPos`, `sleep` from `./normalize`; **`newAdpMaps` and `putAdp` from `./adpMap` (created in Task 1)** — do not re-implement the earliest-wins or DEF/K rules here.
- Produces: `fetchYahooAdp({ count, pages })` → flat array of Yahoo player objects. `buildYahooMap(players)` → `{ byStrict, defByTeam, kByName }` — same shape as Task 1 and as `buildFfcMap`.

**Background the implementer needs.** Yahoo's JSON is deeply and irregularly nested: objects keyed by numeric strings, and arrays holding a mix of objects and metadata. Do NOT index by a fixed path — flatten defensively. Verified live 7 Sep 2026: no authentication, and `count=100` is honoured (it is not capped at 25), so three pages give 300. Fields that matter: `full` (name), `display_position` (e.g. `"RB"`), `editorial_team_abbr` (**mixed case**, e.g. `"Det"`), `average_pick` (the ADP).

- [ ] **Step 1: Write the failing test**

Append to `backend/src/syncPlayers.test.js`:

```js
const { buildYahooMap, flattenYahooPlayer } = require("./sync/adpYahoo");

// Yahoo nests a player as an array of mixed objects, so the flattener -- not a
// fixed path -- is what makes this readable.
test("a yahoo player flattens out of its nested shape", () => {
  const raw = [
    [
      { player_key: "470.p.40059" },
      { player_id: "40059" },
      { name: { full: "Jahmyr Gibbs", first: "Jahmyr" } },
      { editorial_team_abbr: "Det" },
      { display_position: "RB" },
    ],
    { draft_analysis: { average_pick: "1.3" } },
  ];
  const flat = flattenYahooPlayer(raw);
  assert.strictEqual(flat.full, "Jahmyr Gibbs");
  assert.strictEqual(flat.display_position, "RB");
  assert.strictEqual(flat.editorial_team_abbr, "Det");
  assert.strictEqual(flat.average_pick, "1.3");
});

// "Det" must become "DET" or nothing joins.
test("yahoo mixed-case teams are normalised", () => {
  const { byStrict } = buildYahooMap([
    { full: "Jahmyr Gibbs", display_position: "RB", editorial_team_abbr: "Det", average_pick: "1.3" },
  ]);
  assert.strictEqual(byStrict.get("RB|DET|jahmyr gibbs"), 1.3);
});

test("yahoo defences land in defByTeam", () => {
  const { defByTeam } = buildYahooMap([
    { full: "Houston", display_position: "DEF", editorial_team_abbr: "Hou", average_pick: "92.6" },
  ]);
  assert.strictEqual(defByTeam.get("HOU"), 92.6);
});

test("a yahoo row with no average_pick is skipped", () => {
  const { byStrict } = buildYahooMap([
    { full: "Nobody", display_position: "RB", editorial_team_abbr: "Det" },
    { full: "Ghost", display_position: "RB", editorial_team_abbr: "Det", average_pick: "-" },
  ]);
  assert.strictEqual(byStrict.size, 0);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd backend/src && node --test syncPlayers.test.js`
Expected: FAIL — `Cannot find module './sync/adpYahoo'`.

- [ ] **Step 3: Write the adapter**

Create `backend/src/sync/adpYahoo.js`:

```js
// Average draft position from Yahoo's public read-only fantasy API, and the
// lookup maps that join it onto Sleeper's players.
//
// The endpoint needs no authentication -- verified 7 Sep 2026. This is NOT the
// OAuth fantasy API; it is the public game-level draft analysis feed.

const { FETCH_TIMEOUT_MS } = require("./http");
const { normName, normTeam, toAppPos, sleep } = require("./normalize");
const { newAdpMaps, putAdp } = require("./adpMap");

const BASE = "https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/game/nfl/players";

/**
 * Yahoo nests a player as an array of mixed objects and objects keyed by
 * numeric strings. Walking it and collecting every scalar is far more robust
 * than indexing a path that shifts whenever they add a field.
 */
function flattenYahooPlayer(node) {
  const flat = {};
  const walk = (x) => {
    if (Array.isArray(x)) {
      for (const y of x) walk(y);
    } else if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) {
        if (v && typeof v === "object") walk(v);
        else if (flat[k] === undefined) flat[k] = v;
      }
    }
  };
  walk(node);
  return flat;
}

async function fetchYahooPage({ start, count }) {
  const url =
    `${BASE};position=ALL;start=${start};count=${count};sort=rank_season;out=draft_analysis?format=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Yahoo ADP fetch failed: ${r.status}`);
  const j = await r.json();

  const game = j?.fantasy_content?.game;
  const block = Array.isArray(game)
    ? game.find((part) => part && typeof part === "object" && part.players)
    : null;
  const players = block?.players;
  if (!players) return [];

  const n = Number(players.count) || 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const rec = players[String(i)]?.player;
    if (rec) out.push(flattenYahooPlayer(rec));
  }
  return out;
}

async function fetchYahooAdp({ count, pages }) {
  const all = [];
  for (let page = 0; page < pages; page++) {
    all.push(...(await fetchYahooPage({ start: page * count, count })));
    // Spaced like the FFC loop, so three quick calls do not look like a scrape.
    if (page < pages - 1) await sleep(250);
  }
  return all;
}

function buildYahooMap(players) {
  const maps = newAdpMaps();

  for (const p of players) {
    putAdp(maps, {
      pos: toAppPos(p.display_position),
      team: normTeam(p.editorial_team_abbr),
      nameKey: normName(p.full),
      // Yahoo sends ADP as a string, and "-" for a player nobody drafted --
      // Number("-") is NaN, which putAdp drops.
      adp: Number(p?.average_pick),
    });
  }

  return maps;
}

module.exports = { fetchYahooAdp, buildYahooMap, flattenYahooPlayer };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd backend/src && node --test syncPlayers.test.js`
Expected: PASS.

- [ ] **Step 5: Pin it against a real captured payload**

Yahoo's nesting is the part most likely to shift under you, so the flattener
needs a real response and not a shape you invented:

```bash
mkdir -p backend/src/sync/__fixtures__
curl -s 'https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/game/nfl/players;position=ALL;start=0;count=3;sort=rank_season;out=draft_analysis?format=json' \
  -o backend/src/sync/__fixtures__/yahoo-adp.json
```

Then append this test. It exercises the real page-parsing path, not just the
flattener, by pulling the players block out of the captured document exactly as
`fetchYahooPage` does:

```js
const yahooFixture = require("./sync/__fixtures__/yahoo-adp.json");

test("the yahoo adapter reads a real captured payload", () => {
  const game = yahooFixture.fantasy_content.game;
  const block = game.find((part) => part && typeof part === "object" && part.players);
  const n = Number(block.players.count);
  const flat = [];
  for (let i = 0; i < n; i++) flat.push(flattenYahooPlayer(block.players[String(i)].player));

  assert.ok(flat.every((f) => f.full), "every captured player should have a name");
  const { byStrict, defByTeam } = buildYahooMap(flat);
  assert.ok(byStrict.size + defByTeam.size >= 1);
});
```

Run: `cd backend/src && node --test syncPlayers.test.js` — PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/sync/adpYahoo.js backend/src/sync/__fixtures__/yahoo-adp.json backend/src/syncPlayers.test.js
git commit -m "feat: Yahoo ADP adapter"
```

---

### Task 3: Wire both sources into the daily sync

**Files:**
- Modify: `backend/src/syncPlayers.js`
- Modify: `backend/template.yaml` (`SyncPlayersFunction` → `MemorySize`)
- Test: `backend/src/syncPlayers.test.js` (append)

**Interfaces:**
- Consumes: `fetchEspnAdp`/`buildEspnMap` (Task 1), `fetchYahooAdp`/`buildYahooMap` (Task 2).
- Produces: every player row written to DynamoDB may now carry `adpBySource: { espn?: number, yahoo?: number }`. Absent sources are absent keys.

**Background the implementer needs.** `syncPlayers` rewrites the entire players table daily. The season-stats block is already deliberately wrapped so a Sleeper outage degrades to players-without-stats rather than an empty pool — read that block's comment before writing this one, and follow it. Measured payload sizes: ESPN at `limit: 300` is **9.8 MB**, and the Sleeper dump the job already parses is **14.6 MB**. The function currently runs at `MemorySize: 512`, which is why this task raises it.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/syncPlayers.test.js`:

```js
const { attachAdpBySource } = require("./syncPlayers");

// The whole point of a source map: a hit becomes a number, a miss becomes an
// absent key -- never null and never 0, both of which would render as a real
// ADP of zero on the row.
test("a matched player gets the source number, an unmatched one gets no key", () => {
  const players = [
    { position: "RB", team: "DET", nameKey: "jahmyr gibbs", adp: {} },
    { position: "WR", team: "CIN", nameKey: "nobody at all", adp: {} },
  ];
  const maps = {
    espn: { byStrict: new Map([["RB|DET|jahmyr gibbs", 1.32]]), defByTeam: new Map(), kByName: new Map() },
  };
  attachAdpBySource(players, maps);
  assert.deepStrictEqual(players[0].adpBySource, { espn: 1.32 });
  assert.strictEqual(players[1].adpBySource, undefined);
});

test("a defence matches by team and a kicker by name", () => {
  const players = [
    { position: "DEF", team: "HOU", nameKey: "houston texans", adp: {} },
    { position: "K", team: "BAL", nameKey: "justin tucker", adp: {} },
  ];
  const maps = {
    espn: {
      byStrict: new Map(),
      defByTeam: new Map([["HOU", 92.6]]),
      kByName: new Map([["justin tucker", 140.2]]),
    },
  };
  attachAdpBySource(players, maps);
  assert.deepStrictEqual(players[0].adpBySource, { espn: 92.6 });
  assert.deepStrictEqual(players[1].adpBySource, { espn: 140.2 });
});

// One source dying must not take the other with it.
test("sources are independent", () => {
  const players = [{ position: "RB", team: "DET", nameKey: "jahmyr gibbs", adp: {} }];
  const maps = {
    espn: { byStrict: new Map([["RB|DET|jahmyr gibbs", 1.32]]), defByTeam: new Map(), kByName: new Map() },
    yahoo: null, // what a failed fetch leaves behind
  };
  attachAdpBySource(players, maps);
  assert.deepStrictEqual(players[0].adpBySource, { espn: 1.32 });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd backend/src && node --test syncPlayers.test.js`
Expected: FAIL — `attachAdpBySource is not a function`.

- [ ] **Step 3: Implement**

In `backend/src/syncPlayers.js`, add to the requires at the top:

```js
const { fetchEspnAdp, buildEspnMap } = require("./sync/adpEspn");
const { fetchYahooAdp, buildYahooMap } = require("./sync/adpYahoo");
```

Add this function at module scope (outside `exports.handler`), and export it:

```js
// Top 300 per source. A 12-team, 16-round draft is 192 picks, so 300 covers
// everything anyone drafts; below that nobody consults an ADP, and ESPN's
// payload is 9.8MB at this depth already.
const ADP_SOURCE_DEPTH = 300;
const YAHOO_PAGE = 100; // verified: Yahoo honours count=100, so 3 pages

/**
 * Hang each source's number off the player it actually matches.
 *
 * A miss leaves the key ABSENT rather than null or 0: both of those would
 * reach the UI as a genuine ADP, and a player nobody has ranked would appear
 * to be the first pick of the draft.
 */
function attachAdpBySource(players, maps) {
  for (const pl of players) {
    const bySource = {};
    for (const [source, m] of Object.entries(maps)) {
      // A failed fetch leaves null here; the other sources carry on.
      if (!m) continue;
      const team = normTeam(pl.team);
      let adp = m.byStrict.get(`${pl.position}|${team}|${pl.nameKey}`);
      if (adp == null && pl.position === "DEF") adp = m.defByTeam.get(team);
      if (adp == null && pl.position === "K") adp = m.kByName.get(pl.nameKey);
      if (adp != null) bySource[source] = adp;
    }
    if (Object.keys(bySource).length > 0) pl.adpBySource = bySource;
  }
}

module.exports.attachAdpBySource = attachAdpBySource;
```

Inside `exports.handler`, immediately after the existing step 3 loop that merges FFC ADP into `basePlayers`, add:

```js
  // 3b) ESPN and Yahoo ADP. Wrapped one source at a time, on the same
  // reasoning as the stats block below: this job rewrites the whole table
  // unattended every night, so an outage or a shape change at a third party
  // must cost that one column and nothing else.
  const sourceMaps = {};
  try {
    sourceMaps.espn = buildEspnMap(await fetchEspnAdp({ year: ADP_YEAR, limit: ADP_SOURCE_DEPTH }));
  } catch (e) {
    console.error("ESPN ADP unavailable:", e.message);
    sourceMaps.espn = null;
  }
  try {
    sourceMaps.yahoo = buildYahooMap(
      await fetchYahooAdp({ count: YAHOO_PAGE, pages: Math.ceil(ADP_SOURCE_DEPTH / YAHOO_PAGE) })
    );
  } catch (e) {
    console.error("Yahoo ADP unavailable:", e.message);
    sourceMaps.yahoo = null;
  }
  attachAdpBySource(basePlayers, sourceMaps);
```

In `backend/template.yaml`, under `SyncPlayersFunction`, change `MemorySize: 512` to:

```yaml
      # 512 was sized before this job also parsed ESPN's ADP payload, which is
      # 9.8MB at the depth we fetch, on top of Sleeper's 14.6MB dump.
      MemorySize: 1024
```

- [ ] **Step 4: Run the tests**

Run: `cd backend/src && npm test`
Expected: all pass, including `template.test.js`.

- [ ] **Step 5: Add the coverage check**

A wrong entry in ESPN's numeric tables does not throw and does not fail any
test above — it produces a column of dashes, quietly. Nothing in the unit tests
can see that, because they supply their own ids. This script is the guard, and
it is the reason the spec calls for one.

It lives under `backend/src/scripts/` because the AWS SDK is vendored at
`backend/src/node_modules`, and a sibling directory cannot resolve it — the
same reason `purge-unowned.js` sits there.

Create `backend/src/scripts/checkAdpCoverage.js`:

```js
// How much of the pool each ADP source actually joins onto.
//
// Run by hand after touching an adapter or its lookup tables. A wrong team or
// position id is invisible in unit tests -- it produces a miss, not an error --
// and shows up here as a coverage number falling off a cliff.
//
//   cd backend/src && node scripts/checkAdpCoverage.js

const { fetchEspnAdp, buildEspnMap } = require("../sync/adpEspn");
const { fetchYahooAdp, buildYahooMap } = require("../sync/adpYahoo");
const { normName, normTeam, toAppPos } = require("../sync/normalize");

const FLOOR = 0.8; // of the top 200 Sleeper players carrying an FFC rank

async function main() {
  const dump = await (await fetch("https://api.sleeper.app/v1/players/nfl")).json();
  const pool = Object.values(dump)
    .filter((p) => p.active && p.team && ["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.position))
    .slice(0, 200);

  const maps = {
    espn: buildEspnMap(await fetchEspnAdp({ year: 2026, limit: 300 })),
    yahoo: buildYahooMap(await fetchYahooAdp({ count: 100, pages: 3 })),
  };

  let bad = false;
  for (const [source, m] of Object.entries(maps)) {
    let hit = 0;
    for (const pl of pool) {
      const team = normTeam(pl.team);
      const pos = toAppPos(pl.position);
      const nameKey = normName(pl.full_name || pl.last_name || "");
      const found =
        m.byStrict.get(`${pos}|${team}|${nameKey}`) ??
        (pos === "DEF" ? m.defByTeam.get(team) : undefined) ??
        (pos === "K" ? m.kByName.get(nameKey) : undefined);
      if (found != null) hit++;
    }
    const rate = hit / pool.length;
    console.log(`${source}: ${hit}/${pool.length} (${(rate * 100).toFixed(1)}%)`);
    if (rate < FLOOR) {
      console.error(`  ${source} is below the ${FLOOR * 100}% floor -- check its lookup tables.`);
      bad = true;
    }
  }
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Run: `cd backend/src && node scripts/checkAdpCoverage.js`

Expected: both sources print a rate and the process exits 0. **If either is
below the floor, stop and report it rather than lowering the floor** — a low
rate means the join is wrong, and lowering the number would hide exactly the
defect this exists to catch. Record both percentages in your report.

- [ ] **Step 6: Commit**

```bash
git add backend/src/syncPlayers.js backend/src/syncPlayers.test.js backend/src/scripts/checkAdpCoverage.js backend/template.yaml
git commit -m "feat: fetch ESPN and Yahoo ADP in the daily sync"
```

---

### Task 4: Carry `adpBySource` through the API

**Files:**
- Modify: `backend/src/players.js` (two object literals, at roughly lines 18-27 and 98-106)
- Modify: `backend/src/drafts.js` (two object literals, at roughly lines 46-54 and 74-82)
- Modify: `backend/src/boards.js` (the pool `.map(...)` at roughly lines 76-82)
- Modify: `backend/src/lib/reconcile.js` (the `rows` map at roughly lines 46-58)
- Test: `backend/src/players.test.js`, `backend/src/drafts.test.js`, `backend/src/boards.test.js`

**Interfaces:**
- Consumes: `p.adpBySource` written by Task 3.
- Produces: every player/row object the API returns carries `adpBySource` when the stored player has one, and omits it otherwise.

**Background the implementer needs.** Board rows carry **no ADP at all** today — `boards.js` builds the pool with only `playerId/name/position/team/consensusRank`, and `reconcile.js` passes those through. Adding `adpBySource` to board rows is therefore introducing ADP to that surface for the first time, which is deliberate: it is where boards get ranked. `adpBySource` must ride through BOTH files or it never reaches the editor.

- [ ] **Step 1: Write the failing tests**

In `backend/src/players.test.js`:

```js
test("a player's per-source ADP reaches the client", () => {
  const out = toClient(
    { playerId: "1", name: "Jahmyr Gibbs", position: "RB", team: "DET",
      adp: { ppr: 1.4 }, adpBySource: { espn: 1.32, yahoo: 1.3 } },
    "ppr"
  );
  assert.deepStrictEqual(out.adpBySource, { espn: 1.32, yahoo: 1.3 });
});

test("a player with no per-source ADP does not gain an empty one", () => {
  const out = toClient({ playerId: "1", name: "X", position: "RB", team: "DET", adp: { ppr: 1.4 } }, "ppr");
  assert.strictEqual(out.adpBySource, undefined);
});
```

`players.js` exports its mapper as `toDetail(p, format)` (`module.exports.toDetail` at the foot of the file), so require that directly: `const { toDetail } = require("./players");`. Its second mapping site, inside `exports.handler`, is a separate object literal and needs the same line added.

In `backend/src/boards.test.js`:

```js
test("board rows carry per-source ADP", async () => {
  // Build the pool the way the neighbouring tests in this file do, with a
  // player carrying adpBySource, then assert it survives onto the row.
  const rows = poolFromItems([
    { playerId: "1", name: "Jahmyr Gibbs", position: "RB", team: "DET",
      rank: { ppr: 1 }, adpBySource: { espn: 1.32 } },
  ], "ppr");
  assert.deepStrictEqual(rows[0].adpBySource, { espn: 1.32 });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd backend/src && npm test`
Expected: the new assertions fail — `undefined` where the map was expected.

- [ ] **Step 3: Implement**

In each of the four files, add one line to the object literal, immediately after the existing `adp:` line (or after `consensusRank:` in `boards.js`/`reconcile.js`):

```js
      // Spread as-is: it has no format dimension, because neither ESPN nor
      // Yahoo publishes one. Absent stays absent -- an empty object would
      // render as a source that exists but has no opinion.
      ...(p.adpBySource ? { adpBySource: p.adpBySource } : {}),
```

In `backend/src/lib/reconcile.js` the source object is `player`, so use `player.adpBySource` there. `reconcile.js` must also receive it: `boards.js` puts `adpBySource` on the pool objects it builds, and `reconcile` copies it onto each row.

- [ ] **Step 4: Run the tests**

Run: `cd backend/src && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/players.js backend/src/drafts.js backend/src/boards.js backend/src/lib/reconcile.js backend/src/players.test.js backend/src/drafts.test.js backend/src/boards.test.js
git commit -m "feat: carry per-source ADP through the API"
```

---

### Task 5: Frontend formatter

**Files:**
- Create: `frontend/src/lib/adpSources.js`
- Test: `frontend/src/lib/adpSources.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SOURCE_LABELS` — `[{ key: "ours", label: "ours" }, { key: "espn", label: "esp" }, { key: "yahoo", label: "yah" }]`, in display order.
  - `adpTrio(ourAdp, adpBySource)` → `[{ key, label, value, text }]` where `value` is a number or `null` and `text` is the formatted number or `"—"`.
  - `PLATFORM_WIDE_NOTE` — the exact string `"ESPN and Yahoo publish one ADP for their whole platform, not one per scoring format."`

**Background the implementer needs.** One module decides formatting and order so the draft pool and the board editor cannot drift apart. Values are shown to one decimal place, matching how `ADP 40.1` already reads on the draft row.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/adpSources.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { adpTrio, PLATFORM_WIDE_NOTE } from "./adpSources.js";

test("all three sources render in a fixed order", () => {
  const trio = adpTrio(40.1, { espn: 28.4, yahoo: 55 });
  assert.deepStrictEqual(trio.map((t) => t.label), ["ours", "esp", "yah"]);
  assert.deepStrictEqual(trio.map((t) => t.text), ["40.1", "28.4", "55.0"]);
});

// A missing source must read as absent, never as a number.
test("a missing source is a dash, not a zero", () => {
  const trio = adpTrio(40.1, { espn: 28.4 });
  assert.deepStrictEqual(trio.map((t) => t.text), ["40.1", "28.4", "—"]);
});

test("no per-source data at all still shows our own number", () => {
  const trio = adpTrio(40.1, undefined);
  assert.deepStrictEqual(trio.map((t) => t.text), ["40.1", "—", "—"]);
});

test("a player nobody has an ADP for is all dashes", () => {
  assert.deepStrictEqual(adpTrio(null, undefined).map((t) => t.text), ["—", "—", "—"]);
});

// 0 is not a real ADP, and treating it as one would put the player first.
test("a zero is treated as no number", () => {
  assert.strictEqual(adpTrio(0, { espn: 0 })[0].text, "—");
  assert.strictEqual(adpTrio(0, { espn: 0 })[1].text, "—");
});

test("the platform-wide note says what it means", () => {
  assert.match(PLATFORM_WIDE_NOTE, /whole platform/);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — cannot find `./adpSources.js`.

- [ ] **Step 3: Implement**

Create `frontend/src/lib/adpSources.js`:

```js
/**
 * How a player's ADP reads, wherever it is shown.
 *
 * One module so the draft pool and the board editor cannot drift into showing
 * the same numbers in different orders or with different labels.
 */

// Order is fixed and ours comes first, because ours is the one that tracks the
// league's scoring format and is the number the board is sorted by.
export const SOURCE_LABELS = [
  { key: "ours", label: "ours" },
  { key: "espn", label: "esp" },
  { key: "yahoo", label: "yah" },
];

export const PLATFORM_WIDE_NOTE =
  "ESPN and Yahoo publish one ADP for their whole platform, not one per scoring format.";

export function adpTrio(ourAdp, adpBySource) {
  const src = adpBySource ?? {};
  return SOURCE_LABELS.map(({ key, label }) => {
    const raw = key === "ours" ? ourAdp : src[key];
    // 0 is not a draft position. Treating it as one would sort the player to
    // the very top, which is the most misleading thing this could do.
    const value = typeof raw === "number" && raw > 0 ? raw : null;
    return { key, label, value, text: value == null ? "—" : value.toFixed(1) };
  });
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd frontend && npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/adpSources.js frontend/src/lib/adpSources.test.js
git commit -m "feat: one place that formats a player's ADP across sources"
```

---

### Task 6: Render the trio in the draft pool

**Files:**
- Modify: `frontend/src/components/draft/BigBoardPanel.jsx`
- Test: `frontend/tests/draft.spec.js`

**Interfaces:**
- Consumes: `adpTrio`, `PLATFORM_WIDE_NOTE` from `frontend/src/lib/adpSources.js` (Task 5); `p.adpBySource` from the API (Task 4).
- Produces: a `data-testid="adp-trio"` element per pool row.

**Background the implementer needs.** The row's second line currently reads `ADP 40.1` with an optional coloured delta after it. Find it by searching `BigBoardPanel.jsx` for `ADP ${p.adp}`. Keep the delta exactly as it is — it is the difference against your board and is unrelated to this change.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/draft.spec.js` (follow the file's existing mock/sign-in helpers):

`draft.spec.js` already imports `makeDraftState`, `mockDraftApis`, `DRAFT_ID` from `./fixtures.js` and `signIn` from `./auth.js`, and its tests live inside `test.describe("Draft page", ...)`. Add this there.

`mockDraftApis` fulfils `/players*` from the module-level `MOCK_PLAYERS`, which a test cannot parameterise. Register your own `/players*` route **after** it: Playwright tries handlers in reverse registration order, which `fixtures.js` relies on and documents for its own drill-down route.

Every test in this file clicks **Pause** straight after loading, because the draft clock otherwise auto-picks mid-assertion. Do the same.

```js
  test("the pool shows every source's ADP, and a dash where a source has none", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);
    // Registered last, so it wins over the fixture's own /players* route.
    await page.route("**/players*", (r) =>
      r.fulfill({ json: { players: [
        { id: "p1", name: "Ja'Marr Chase", position: "WR", team: "CIN", rank: 1, adp: 4.2, tier: 1, adpBySource: { espn: 4.2, yahoo: 3.5 } },
        { id: "p2", name: "Jaylen Waddle", position: "WR", team: "MIA", rank: 40, adp: 40.1, tier: 4, adpBySource: { espn: 28.4 } },
      ] } })
    );

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    const rows = page.getByTestId("adp-trio");
    await expect(rows.first()).toHaveText(/ours\s*4\.2.*esp\s*4\.2.*yah\s*3\.5/s);
    await expect(rows.nth(1)).toHaveText(/ours\s*40\.1.*esp\s*28\.4.*yah\s*—/s);
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd frontend && npx playwright test tests/draft.spec.js --workers=1`
Expected: FAIL — no element with test id `adp-trio`.

- [ ] **Step 3: Implement**

Add the import beside the other lib imports in `BigBoardPanel.jsx`:

```js
import { adpTrio, PLATFORM_WIDE_NOTE } from "../../lib/adpSources";
```

Replace the second line of the row — the element containing `ADP ${p.adp}` — with:

```jsx
                  <div className="text-xs text-zinc-400">
                    {/*
                      All three inline rather than one number: the point of the
                      feature is seeing where the sources disagree, and a
                      player one service likes a round earlier than another is
                      only visible if both are on screen at once.
                    */}
                    <span data-testid="adp-trio" title={PLATFORM_WIDE_NOTE}>
                      {adpTrio(p.adp, p.adpBySource).map((s, i) => (
                        <span key={s.key}>
                          {i > 0 ? <span className="mx-1 text-zinc-600">·</span> : null}
                          <span className="text-zinc-500">{s.label} </span>
                          <span className="tabular-nums">{s.text}</span>
                        </span>
                      ))}
                    </span>
                    {p.delta != null && p.delta !== 0 ? (
                      <span className={p.delta > 0 ? "ml-1 text-emerald-400" : "ml-1 text-rose-400"}>
                        {p.delta > 0 ? `+${p.delta}` : p.delta}
                      </span>
                    ) : null}
                  </div>
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx playwright test tests/draft.spec.js --workers=1`
Expected: PASS, and every pre-existing test in the file still passes.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/draft/BigBoardPanel.jsx frontend/tests/draft.spec.js
git commit -m "feat: show every source's ADP in the draft pool"
```

---

### Task 7: Render the trio in the board editor

**Files:**
- Modify: `frontend/src/pages/Board.jsx`
- Test: `frontend/tests/board.spec.js`

**Interfaces:**
- Consumes: `adpTrio`, `PLATFORM_WIDE_NOTE` (Task 5); `row.adpBySource` from `GET /boards/{boardId}` (Task 4).
- Produces: a `data-testid="adp-trio"` element per board row.

**Background the implementer needs.** Board rows have never shown ADP, so this adds a line rather than replacing one. Rows carry `myRank`, `consensusRank` and `delta`; `consensusRank` is a rank over the board's population and is NOT an ADP — do not pass it to `adpTrio` as our number. Our ADP for a board row is `row.adp` if present, otherwise `null`, which renders as a dash. Keep the existing drag handle behaviour untouched: the row is draggable everywhere except the player's name.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/board.spec.js`:

```js
test("board rows show every source's ADP", async ({ page }) => {
  const state = makeBoardState();
  state.rows[0].adpBySource = { espn: 4.2, yahoo: 3.5 };
  state.rows[0].adp = 4.4;
  await mockBoard(page, state);
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  await expect(page.getByTestId("adp-trio").first())
    .toHaveText(/ours\s*4\.4.*esp\s*4\.2.*yah\s*3\.5/s);
});

test("a board row with no per-source ADP shows dashes, not zeros", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);
  await expect(page.getByTestId("adp-trio").first()).toContainText("—");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd frontend && npx playwright test tests/board.spec.js --workers=1`
Expected: FAIL — no `adp-trio` element.

- [ ] **Step 3: Implement**

Add the import in `Board.jsx`:

```js
import { adpTrio, PLATFORM_WIDE_NOTE } from "../lib/adpSources";
```

In the row component, below the existing name/rank line, add:

```jsx
              {/*
                Boards have never shown ADP. It belongs here because this is
                where ranking decisions get made -- the whole reason to see
                several sources is to decide where a player goes.
              */}
              <div
                data-testid="adp-trio"
                title={PLATFORM_WIDE_NOTE}
                className="text-xs text-zinc-500"
              >
                {adpTrio(row.adp ?? null, row.adpBySource).map((s, i) => (
                  <span key={s.key}>
                    {i > 0 ? <span className="mx-1 text-zinc-700">·</span> : null}
                    <span>{s.label} </span>
                    <span className="tabular-nums text-zinc-400">{s.text}</span>
                  </span>
                ))}
              </div>
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx playwright test tests/board.spec.js --workers=1`
Expected: PASS, including the existing drag and rename tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Board.jsx frontend/tests/board.spec.js
git commit -m "feat: show every source's ADP in the board editor"
```

---

### Task 8: Sort the pool by a source, and document it

**Files:**
- Modify: `frontend/src/components/draft/BigBoardPanel.jsx`
- Modify: `README.md`
- Test: `frontend/tests/draft.spec.js`
- Regenerate: `screenshots/draft.png`, `screenshots/board.png`

**Interfaces:**
- Consumes: `SOURCE_LABELS`, `adpTrio` (Task 5).
- Produces: nothing later tasks rely on.

**Background the implementer needs.** `frontend/src/lib/boardOrder.js` must NOT be modified. It gives every player one ordinal — `myRank` when they are on the board, consensus `rank` otherwise — and that stays the default. This task adds a control that re-sorts the already-built list; picking a source changes the ORDER only, never a displayed number. Players with no number for the chosen source sort to the bottom, the same way the existing rank sort pushes nulls down.

This repo keeps screenshots in the README, so a page whose UI changed gets its screenshot regenerated and committed.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/draft.spec.js`:

Add inside `test.describe("Draft page", ...)`, using the same fixtures and the same Pause click as Task 6. Assert order through `adp-trio` rather than inventing a row test id — it already appears once per row, in row order.

```js
  test("sorting by a source reorders the pool without changing the numbers", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);
    await page.route("**/players*", (r) =>
      r.fulfill({ json: { players: [
        { id: "p1", name: "Ja'Marr Chase", position: "WR", team: "CIN", rank: 1, adp: 4.2, tier: 1, adpBySource: { espn: 30.0 } },
        { id: "p2", name: "Jaylen Waddle", position: "WR", team: "MIA", rank: 40, adp: 40.1, tier: 4, adpBySource: { espn: 2.0 } },
      ] } })
    );

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    // Default is our rank, so Chase leads.
    await expect(page.getByTestId("adp-trio").first()).toHaveText(/ours\s*4\.2/);

    await page.getByTestId("adp-sort").selectOption("espn");

    // ESPN has Waddle far earlier, so he leads now -- and every number shown is
    // the same number as before. Only the order moved.
    await expect(page.getByTestId("adp-trio").first()).toHaveText(/ours\s*40\.1.*esp\s*2\.0/s);
    await expect(page.getByText("Jaylen Waddle").first()).toBeVisible();
  });

  test("a player with no number for the chosen source sorts last", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);
    await page.route("**/players*", (r) =>
      r.fulfill({ json: { players: [
        { id: "p1", name: "Has None", position: "WR", team: "CIN", rank: 1, adp: 4.2, tier: 1 },
        { id: "p2", name: "Has One", position: "WR", team: "MIA", rank: 40, adp: 40.1, tier: 4, adpBySource: { espn: 2.0 } },
      ] } })
    );

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();
    await page.getByTestId("adp-sort").selectOption("espn");

    // The one with no ESPN number is last, not first -- an absent number must
    // never sort as if it were zero.
    await expect(page.getByTestId("adp-trio").last()).toHaveText(/ours\s*4\.2.*esp\s*—/s);
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd frontend && npx playwright test tests/draft.spec.js --workers=1`
Expected: FAIL — no `adp-sort` control.

- [ ] **Step 3: Implement**

In `BigBoardPanel.jsx`, add state beside the existing panel state:

```js
  const [adpSort, setAdpSort] = useState("ours");
```

Add the control above the list, beside the existing filters:

```jsx
        <label className="text-xs text-zinc-400">
          Sort by{" "}
          <select
            data-testid="adp-sort"
            value={adpSort}
            onChange={(e) => setAdpSort(e.target.value)}
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
          >
            <option value="ours">our rank</option>
            <option value="espn">ESPN ADP</option>
            <option value="yahoo">Yahoo ADP</option>
          </select>
        </label>
```

Sort the already-built list just before rendering. Do not change how the list is built:

```js
  // Between filtering and paging, deliberately. `pagedPlayers` is one page of
  // 50, so sorting that would only shuffle the page you happen to be on and
  // look broken the moment you turned it. `advice` below keeps reading
  // `filtered`, because scarcity is about which players remain, not the order
  // they are listed in.
  const sorted = useMemo(() => {
    if (adpSort === "ours") return filtered;
    return [...filtered].sort(
      (a, b) =>
        // A player the chosen source has no number for sorts last, the same
        // way the existing rank sort pushes nulls to the bottom.
        (a.adpBySource?.[adpSort] ?? Number.POSITIVE_INFINITY) -
        (b.adpBySource?.[adpSort] ?? Number.POSITIVE_INFINITY)
    );
  }, [filtered, adpSort]);
```

Then change the two lines that page the list — currently `BigBoardPanel.jsx:66-67` — to read from `sorted` instead of `filtered`:

```js
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pagedPlayers = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
```

Leave the `advice` memo and the `filtered` memo exactly as they are.

Changing the sort must also send you back to page one, for the same reason changing the filter already does — the panel has a comment at `BigBoardPanel.jsx:45` explaining that rule. Follow whatever mechanism that comment describes, applying it to `adpSort` as well as the filter inputs.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx playwright test tests/draft.spec.js --workers=1`
Expected: PASS.

- [ ] **Step 5: Document and refresh screenshots**

Add to the README feature list, in the existing one-line voice, after the **Custom Big Boards** entry:

```markdown
- **Every source's ADP** — See our ADP, ESPN's and Yahoo's side by side while you rank and while you draft, so a player one service likes a round earlier than another is obvious. Our rank stays the default order; sort by any source when you want to
```

Then regenerate the screenshots whose pages changed:

```bash
cd frontend && npx playwright test --workers=1
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/draft/BigBoardPanel.jsx frontend/tests/draft.spec.js README.md screenshots/
git commit -m "feat: sort the pool by any source's ADP"
```

---

## Final Verification

- [ ] `cd backend/src && npm test` — all pass. The count rises from 271 by the tests added in Tasks 1-4.
- [ ] `cd frontend && npm run test:unit` — all pass, including the new `adpSources` suite.
- [ ] `cd frontend && npm run lint` — clean.
- [ ] `cd frontend && npm test -- --workers=1` — the full Playwright suite.
- [ ] `git status --short` — clean.

**Note on running Playwright here:** browser launches time out under load on this machine, and a failing test is a different one on each run. Re-run any red test on its own before believing it; see `.superpowers/sdd/progress.md`.

**Deploying** is both halves this time, unlike the last project: `cd backend && sam build && sam deploy` (the sync Lambda and `MemorySize` changed), then `cd frontend && npm run deploy`. Do NOT use `sam deploy --guided` — it offers to write answers into `backend/samconfig.toml`, which this repo tracks in git, and that file would then carry `NoEcho` parameter values in plaintext.

The new ADP columns appear only after the next daily sync runs, or after `SyncPlayersFunction` is invoked manually.
