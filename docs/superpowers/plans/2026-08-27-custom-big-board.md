# Custom Big Board + Draft Slot Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users build their own drag-ordered player rankings, save them under a shareable board ID, and choose which draft slot they occupy instead of always drafting from Team 1.

**Architecture:** A new `perfectpick-boards` DynamoDB table stores a materialized array of player IDs per board. A new `BoardsFunction` Lambda serves CRUD, reconciling the stored order against the live player pool on every read so nightly `syncPlayers` churn never strands a board. The frontend adds a `/board/:boardId` drag-reorder page and a slot picker on Home. Draft slot becomes a stored `userTeam` field, replacing 11 hardcoded `Team 1` literals in `Draft.jsx`.

**Tech Stack:** Node.js 20 (CommonJS) Lambdas, DynamoDB via `@aws-sdk/lib-dynamodb`, AWS SAM, React 19 + Vite 7 + React Router 7 + Tailwind 4, `@dnd-kit` for drag, `node:test` for unit tests, Playwright for end-to-end.

**Source spec:** `docs/superpowers/specs/2026-08-27-custom-big-board-design.md`

## Scope

This plan implements **phase 1 only** (boards CRUD, reconcile-on-read, drag editor) **plus draft slot selection**. It produces working, shippable software on its own.

Deliberately **out of scope**, each needing its own plan:
- Phase 2 — multi-source comparison (`?vs=` fan-out across FFC variants)
- Phase 3 — board drives the in-draft Big Board
- Phase 4 — external source adapters and the shared identity resolver

Two spec elements are deliberately deferred, and their absence here is intentional rather than an oversight:

- **`lib/resolver.js`** appears in the spec's Architecture table. Nothing in phase 1 consumes it, and extracting it now would be speculative. It belongs to the phase 4 plan.
- **The `sources` map on `perfectpick-players`** exists only to serve `?vs=` comparison. Phase 1 reads consensus rank from the existing `rank[format]` map, so no player-table change happens here at all. It belongs to the phase 2 plan.

## Global Constraints

- **Schema changes must be additive.** `adp` / `rank` / `tier` on `perfectpick-players` keep their exact current shape and meaning. `drafts.js:39-41` and `players.js:45-47` read them, and stored draft snapshots depend on them. Never re-key these maps.
- **Bots draft off consensus, never the user's board.** No task in this plan may feed board order into `pickBestForTeam()`.
- **No new backend runtime dependencies.** `backend/src/package.json` stays at `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb`.
- **Backend is CommonJS** (`"type": "commonjs"`). Use `require` / `module.exports`. Frontend is ESM.
- **Node 24** (`Runtime: nodejs24.x`). nodejs20.x passed AWS's creation-disabled date on 2026-06-01, so new functions cannot be created on it. `node:test` is built in — do not add a test runner.
- **Every board write is conditional on `version`.** Never read-modify-write without a `ConditionExpression`.
- **Existing drafts must keep working.** Read the slot as `d.userTeam || 1` everywhere.
- **CORS origin** is `https://d2kf4b52rvabfv.cloudfront.net`, set via the `ALLOWED_ORIGIN` env var. Never hardcode it in a handler.

---

## File Structure

**Backend — create**
- `backend/src/lib/http.js` — shared CORS headers and JSON response helpers
- `backend/src/lib/reconcile.js` — pure merge of stored order against live pool
- `backend/src/lib/reconcile.test.js` — `node:test` unit tests
- `backend/src/boards.js` — `BoardsFunction` handler

**Backend — modify**
- `backend/template.yaml` — boards table, `BoardsFunction`, CORS methods
- `backend/src/drafts.js` — `userTeam` on create/read; adopt `lib/http.js`
- `backend/src/players.js` — adopt `lib/http.js`
- `backend/src/package.json` — `test` script

**Frontend — create**
- `frontend/src/lib/boardRegistry.js` — localStorage board list
- `frontend/src/lib/snake.js` — pick-schedule computation for a slot
- `frontend/src/pages/Board.jsx` — drag-reorder editor
- `frontend/tests/board.spec.js` — board end-to-end
- `frontend/tests/slot.spec.js` — slot selection end-to-end

**Frontend — modify**
- `frontend/src/lib/api.js` — `apiPut`, `apiDelete`
- `frontend/src/App.jsx` — `/board/:boardId` route
- `frontend/src/pages/Home.jsx` — slot picker, board list
- `frontend/src/pages/Draft.jsx` — 11 `Team 1` literals → `draft.userTeam`
- `frontend/tests/fixtures.js` — board fixtures, `userTeam` in draft state
- `frontend/package.json` — `@dnd-kit` deps

---

## Task 1: Backend test harness and shared HTTP helpers

**Files:**
- Create: `backend/src/lib/http.js`
- Modify: `backend/src/package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `corsHeaders() -> object`, `json(statusCode, bodyObject) -> {statusCode, headers, body}`, `ALLOWED_METHODS` string constant. Every later backend task uses `json()` for responses.

- [ ] **Step 1: Create the shared HTTP helper**

`backend/src/lib/http.js`:

```js
const ALLOWED_METHODS = "GET,POST,PUT,DELETE,OPTIONS";

function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

module.exports = { ALLOWED_METHODS, corsHeaders, json };
```

- [ ] **Step 2: Add the test script**

In `backend/src/package.json`, replace the `scripts` block:

```json
  "scripts": {
    "test": "node --test"
  },
```

- [ ] **Step 3: Verify the runner works with no tests yet**

Run: `cd backend/src && npm test`
Expected: exits 0, reporting `tests 0` (no test files exist yet — this confirms the runner is wired).

- [ ] **Step 4: Commit**

```bash
git add backend/src/lib/http.js backend/src/package.json
git commit -m "Add shared HTTP helpers and node:test runner for backend"
```

---

## Task 2: Reconciliation module (TDD)

This is the load-bearing logic of the whole feature. Build it test-first.

**Files:**
- Create: `backend/src/lib/reconcile.test.js`
- Create: `backend/src/lib/reconcile.js`

**Interfaces:**
- Consumes: nothing
- Produces: `reconcile(storedOrder, livePool) -> { rows, changelog }` where
  - `storedOrder` is `string[]` of playerIds
  - `livePool` is `Array<{ playerId, name, position, team, consensusRank }>`
  - `rows` is `Array<{ playerId, name, position, team, myRank, consensusRank, delta, isNew }>`, `myRank` 1-based
  - `changelog` is `{ added: number, removed: number }`
  - Task 4 (`GET /boards/:id`) consumes this exact shape.

**Insertion rule — note the refinement:** a new player is inserted **after the last kept player whose consensus rank is better (lower)**, or at the front if there is none.

The spec phrased this as "before the first player whose consensus rank exceeds theirs." Those two rules are identical only when the list is already consensus-sorted — and a user board is precisely a list that isn't. If a user ranks a consensus-#300 sleeper at their #1, the spec's literal rule inserts every new player ahead of that sleeper, silently overriding the user's strongest opinion. "After the last better" preserves it. Implement the refined rule.

- [ ] **Step 1: Write the failing tests**

`backend/src/lib/reconcile.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { reconcile } = require("./reconcile");

function pool(...entries) {
  return entries.map(([playerId, consensusRank]) => ({
    playerId,
    name: `Player ${playerId}`,
    position: "WR",
    team: "SF",
    consensusRank,
  }));
}

test("empty stored order returns the full pool in consensus order", () => {
  const { rows, changelog } = reconcile([], pool(["b", 2], ["a", 1], ["c", 3]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["a", "b", "c"]);
  assert.deepStrictEqual(rows.map((r) => r.myRank), [1, 2, 3]);
  assert.ok(rows.every((r) => r.isNew));
  assert.deepStrictEqual(changelog, { added: 3, removed: 0 });
});

test("unchanged pool preserves user order exactly", () => {
  const { rows, changelog } = reconcile(["c", "a", "b"], pool(["a", 1], ["b", 2], ["c", 3]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["c", "a", "b"]);
  assert.ok(rows.every((r) => !r.isNew));
  assert.deepStrictEqual(changelog, { added: 0, removed: 0 });
});

test("delta is consensusRank minus myRank", () => {
  const { rows } = reconcile(["c", "a", "b"], pool(["a", 1], ["b", 2], ["c", 3]));
  const byId = Object.fromEntries(rows.map((r) => [r.playerId, r]));
  assert.strictEqual(byId.c.myRank, 1);
  assert.strictEqual(byId.c.consensusRank, 3);
  assert.strictEqual(byId.c.delta, 2);
  assert.strictEqual(byId.b.delta, -1);
});

test("a departed player is dropped and counted", () => {
  const { rows, changelog } = reconcile(["a", "gone", "b"], pool(["a", 1], ["b", 2]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["a", "b"]);
  assert.deepStrictEqual(changelog, { added: 0, removed: 1 });
});

test("a new player lands after the last kept player with a better consensus rank", () => {
  const { rows, changelog } = reconcile(["a", "b"], pool(["a", 1], ["b", 3], ["new", 2]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["a", "new", "b"]);
  assert.strictEqual(rows[1].isNew, true);
  assert.deepStrictEqual(changelog, { added: 1, removed: 0 });
});

test("a new player better than everything lands at the front", () => {
  const { rows } = reconcile(["a", "b"], pool(["a", 2], ["b", 3], ["new", 1]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["new", "a", "b"]);
});

test("user's top pick is not displaced by a higher-consensus newcomer", () => {
  // "sleeper" is consensus #300 but the user ranks them #1.
  const { rows } = reconcile(["sleeper", "star"], pool(["sleeper", 300], ["star", 1], ["new", 2]));
  assert.strictEqual(rows[0].playerId, "sleeper");
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["sleeper", "star", "new"]);
});

test("ties break by playerId for determinism", () => {
  const { rows } = reconcile([], pool(["z", 1], ["a", 1]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["a", "z"]);
});

// Defensive: loadPool filters unranked players out, but reconcile is a pure
// function and must stay total over its input domain.
test("players with a null consensus rank sort last", () => {
  const { rows } = reconcile([], pool(["a", null], ["b", 5]));
  assert.deepStrictEqual(rows.map((r) => r.playerId), ["b", "a"]);
});

test("does not mutate its inputs", () => {
  const stored = ["a", "b"];
  const live = pool(["a", 1], ["b", 2]);
  reconcile(stored, live);
  assert.deepStrictEqual(stored, ["a", "b"]);
  assert.strictEqual(live.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend/src && npm test`
Expected: FAIL — `Cannot find module './reconcile'`

- [ ] **Step 3: Write the implementation**

`backend/src/lib/reconcile.js`:

```js
const NO_RANK = Number.MAX_SAFE_INTEGER;

function rankOf(player) {
  return player.consensusRank == null ? NO_RANK : Number(player.consensusRank);
}

function byRankThenId(a, b) {
  const diff = rankOf(a) - rankOf(b);
  return diff !== 0 ? diff : String(a.playerId).localeCompare(String(b.playerId));
}

/**
 * Merge a user's saved board order with the live player pool.
 *
 * Kept players hold their saved order. Newcomers are inserted after the last
 * kept player with a better (lower) consensus rank, so a heavily reordered
 * board never has its top choices displaced. Departed players are dropped.
 */
function reconcile(storedOrder, livePool) {
  const poolById = new Map(livePool.map((p) => [String(p.playerId), p]));

  const kept = [];
  let removed = 0;
  for (const id of storedOrder) {
    const player = poolById.get(String(id));
    if (player) kept.push(player);
    else removed += 1;
  }

  const keptIds = new Set(kept.map((p) => String(p.playerId)));
  const missing = livePool
    .filter((p) => !keptIds.has(String(p.playerId)))
    .sort(byRankThenId);

  const merged = kept.map((player) => ({ player, isNew: false }));

  for (const newcomer of missing) {
    const newcomerRank = rankOf(newcomer);
    let insertAt = 0;
    for (let i = 0; i < merged.length; i++) {
      // <= (not <) so a tied newcomer lands after the existing player,
      // keeping the deterministic tie-break the test asserts.
      if (rankOf(merged[i].player) <= newcomerRank) insertAt = i + 1;
    }
    merged.splice(insertAt, 0, { player: newcomer, isNew: true });
  }

  const rows = merged.map(({ player, isNew }, index) => {
    const myRank = index + 1;
    const consensusRank = player.consensusRank == null ? null : Number(player.consensusRank);
    return {
      playerId: String(player.playerId),
      name: player.name,
      position: player.position,
      team: player.team,
      myRank,
      consensusRank,
      delta: consensusRank == null ? null : consensusRank - myRank,
      isNew,
    };
  });

  return { rows, changelog: { added: missing.length, removed } };
}

module.exports = { reconcile };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend/src && npm test`
Expected: PASS — `tests 10`, `pass 10`, `fail 0`

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/reconcile.js backend/src/lib/reconcile.test.js
git commit -m "Add board reconciliation with unit tests"
```

---

## Task 3: Boards table and BoardsFunction infrastructure

**Files:**
- Modify: `backend/template.yaml:36-44` (CORS), append after `SyncPlayersFunction` block ending at line 133

**Interfaces:**
- Consumes: nothing
- Produces: `perfectpick-boards` table (PK `boardId`), `BoardsFunction` with env vars `BOARDS_TABLE` / `PLAYERS_TABLE` / `ALLOWED_ORIGIN`, routes `POST /boards`, `GET|PUT|DELETE /boards/{boardId}`.

- [ ] **Step 1: Widen the CORS methods**

In `backend/template.yaml`, in `HttpApi.Properties.CorsConfiguration`, replace the `AllowMethods` line:

```yaml
        AllowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
```

- [ ] **Step 2: Add the boards table**

In `backend/template.yaml`, immediately after the `PlayersTable` block (which ends at the `AttributeName: playerId` / `KeyType: RANGE` lines) and before `HttpApi:`:

```yaml
  BoardsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: perfectpick-boards
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: boardId
          AttributeType: S
      KeySchema:
        - AttributeName: boardId
          KeyType: HASH
```

- [ ] **Step 3: Add BoardsFunction**

In `backend/template.yaml`, after the `SyncPlayersFunction` block and before `Outputs:`:

```yaml
  BoardsFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: boards.handler
      Environment:
        Variables:
          BOARDS_TABLE: !Ref BoardsTable
          PLAYERS_TABLE: !Ref PlayersTable
          ALLOWED_ORIGIN: "https://d2kf4b52rvabfv.cloudfront.net"
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref BoardsTable
        - DynamoDBReadPolicy:
            TableName: !Ref PlayersTable
      Events:
        CreateBoard:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /boards
            Method: POST
        GetBoard:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /boards/{boardId}
            Method: GET
        SaveBoard:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /boards/{boardId}
            Method: PUT
        DeleteBoard:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /boards/{boardId}
            Method: DELETE
```

- [ ] **Step 4: Create a stub handler so the template validates**

`backend/src/boards.js`:

```js
const { json } = require("./lib/http");

exports.handler = async () => json(501, { error: "Not implemented" });
```

- [ ] **Step 5: Validate the template**

Run: `cd backend && sam validate --lint`
Expected: `template.yaml is a valid SAM Template`

- [ ] **Step 6: Commit**

```bash
git add backend/template.yaml backend/src/boards.js
git commit -m "Add boards table and BoardsFunction infrastructure"
```

---

## Task 4: Boards handler — create and read

**Files:**
- Modify: `backend/src/boards.js`

**Interfaces:**
- Consumes: `json` from `lib/http.js` (Task 1), `reconcile` from `lib/reconcile.js` (Task 2)
- Produces:
  - `POST /boards` body `{ name, format, season, sport? }` → `201 { boardId }`
  - `GET /boards/:id` → `200 { boardId, name, sport, format, season, version, rows, changelog }`
  - Task 5 extends this same file with PUT and DELETE. Task 8's frontend client consumes these shapes.

- [ ] **Step 1: Write the handler**

Replace all of `backend/src/boards.js`:

```js
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");
const { json } = require("./lib/http");
const { reconcile } = require("./lib/reconcile");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ALLOWED_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const FORMATS = new Set(["standard", "half-ppr", "ppr"]);

async function loadPool(playersTable, sport, format) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: playersTable,
      KeyConditionExpression: "#s = :sport",
      ExpressionAttributeNames: { "#s": "sport" },
      ExpressionAttributeValues: { ":sport": sport },
    })
  );

  return (res.Items || [])
    .filter((p) => p && ALLOWED_POS.has(p.position))
    // Only ranked players belong on a big board. The table holds ~3,900 NFL
    // players; a few hundred have ADP. The rest are practice-squad depth that
    // would make the drag list unusable and show an empty delta on every row.
    .filter((p) => p.rank?.[format] != null)
    .map((p) => ({
      playerId: String(p.playerId || p.id),
      name: p.name,
      position: p.position,
      team: p.team,
      consensusRank: p.rank[format],
    }));
}

exports.handler = async (event) => {
  const boardsTable = process.env.BOARDS_TABLE;
  const playersTable = process.env.PLAYERS_TABLE;

  const method = event.requestContext?.http?.method;
  const boardId = event.pathParameters?.boardId;

  if (method === "OPTIONS") return json(200, {});

  try {
    if (method === "POST" && !boardId) {
      const body = event.body ? JSON.parse(event.body) : {};

      const format = String(body.format || "standard").toLowerCase();
      if (!FORMATS.has(format)) return json(400, { error: "Invalid format" });

      const name = String(body.name || "My Board").slice(0, 80);
      const sport = String(body.sport || "nfl").toLowerCase();
      const season = Number(body.season || 2026);

      const item = {
        boardId: randomUUID(),
        ownerId: "anon",
        name,
        sport,
        format,
        season,
        baseSource: "ffc",
        order: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
      };

      await ddb.send(new PutCommand({ TableName: boardsTable, Item: item }));
      return json(201, { boardId: item.boardId });
    }

    if (method === "GET" && boardId) {
      const res = await ddb.send(
        new GetCommand({ TableName: boardsTable, Key: { boardId } })
      );
      if (!res.Item) return json(404, { error: "Board not found" });

      const board = res.Item;
      const pool = await loadPool(playersTable, board.sport, board.format);
      const { rows, changelog } = reconcile(board.order || [], pool);

      return json(200, {
        boardId: board.boardId,
        name: board.name,
        sport: board.sport,
        format: board.format,
        season: board.season,
        version: board.version,
        rows,
        changelog,
      });
    }

    return json(404, { error: "Not found" });
  } catch (e) {
    return json(500, { error: e.message || "Server error" });
  }
};
```

- [ ] **Step 2: Verify the module loads cleanly**

Run: `cd backend/src && node -e "require('./boards.js'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Verify unit tests still pass**

Run: `cd backend/src && npm test`
Expected: PASS — `tests 10`, `fail 0`

- [ ] **Step 4: Commit**

```bash
git add backend/src/boards.js
git commit -m "Implement board create and reconciled read"
```

---

## Task 5: Boards handler — conditional save and delete

**Files:**
- Modify: `backend/src/boards.js`

**Interfaces:**
- Consumes: everything from Task 4
- Produces:
  - `PUT /boards/:id` body `{ order: string[], version: number }` → `200 { ok: true, version }` or `409 { error, currentVersion }`
  - `DELETE /boards/:id` → `200 { ok: true }`

- [ ] **Step 1: Add the UpdateCommand and DeleteCommand imports**

In `backend/src/boards.js`, replace the `@aws-sdk/lib-dynamodb` destructure:

```js
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
```

- [ ] **Step 2: Add the PUT and DELETE branches**

In `backend/src/boards.js`, insert immediately before the final `return json(404, { error: "Not found" });`:

```js
    if (method === "PUT" && boardId) {
      const body = event.body ? JSON.parse(event.body) : {};

      if (!Array.isArray(body.order)) {
        return json(400, { error: "order must be an array" });
      }
      if (body.order.length > 5000) {
        return json(400, { error: "order exceeds 5000 entries" });
      }

      const expectedVersion = Number(body.version);
      if (!Number.isInteger(expectedVersion)) {
        return json(400, { error: "version must be an integer" });
      }

      const order = body.order.map(String);
      if (new Set(order).size !== order.length) {
        return json(400, { error: "order contains duplicate playerIds" });
      }

      try {
        const res = await ddb.send(
          new UpdateCommand({
            TableName: boardsTable,
            Key: { boardId },
            UpdateExpression:
              "SET #o = :order, updatedAt = :now, version = :next",
            ConditionExpression: "attribute_exists(boardId) AND version = :expected",
            ExpressionAttributeNames: { "#o": "order" },
            ExpressionAttributeValues: {
              ":order": order,
              ":now": Date.now(),
              ":next": expectedVersion + 1,
              ":expected": expectedVersion,
            },
            ReturnValues: "ALL_NEW",
          })
        );
        return json(200, { ok: true, version: res.Attributes.version });
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") {
          const current = await ddb.send(
            new GetCommand({ TableName: boardsTable, Key: { boardId } })
          );
          if (!current.Item) return json(404, { error: "Board not found" });
          return json(409, {
            error: "Board changed since you loaded it",
            currentVersion: current.Item.version,
          });
        }
        throw e;
      }
    }

    if (method === "DELETE" && boardId) {
      await ddb.send(
        new DeleteCommand({ TableName: boardsTable, Key: { boardId } })
      );
      return json(200, { ok: true });
    }
```

Note `order` is a DynamoDB reserved word, which is why it goes through `ExpressionAttributeNames` as `#o`.

- [ ] **Step 3: Verify the module loads cleanly**

Run: `cd backend/src && node -e "require('./boards.js'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Validate the template still builds**

Run: `cd backend && sam validate --lint`
Expected: `template.yaml is a valid SAM Template`

- [ ] **Step 5: Commit**

```bash
git add backend/src/boards.js
git commit -m "Add conditional board save and delete"
```

---

## Task 6: Draft slot selection — backend

**Files:**
- Modify: `backend/src/drafts.js:170-200` (the `POST /drafts` branch), `backend/src/drafts.js:203-235` (the `GET /drafts/{draftId}` branch)

**Interfaces:**
- Consumes: nothing new
- Produces: `POST /drafts` accepts `userTeam`; `GET /drafts/:id` returns `userTeam`. Tasks 10 and 11 consume `draft.userTeam`.

- [ ] **Step 1: Accept and validate userTeam on create**

In `backend/src/drafts.js`, in the `POST /drafts` branch, immediately after the line `const rounds = Math.max(1, Math.min(30, Number(body.rounds || 15)));` add:

```js
      const requestedTeam = Number(body.userTeam || 1);
      const userTeam =
        Number.isInteger(requestedTeam) && requestedTeam >= 1 && requestedTeam <= teams
          ? requestedTeam
          : 1;
```

- [ ] **Step 2: Persist it**

In the same branch, in the `const item = {` object literal, add `userTeam` immediately after the `rounds,` line:

```js
        teams,
        rounds,
        userTeam,
```

- [ ] **Step 3: Return it on read**

In the `GET /drafts/{draftId}` branch, in the `body: JSON.stringify({` object, add immediately after the `rounds: d.rounds,` line:

```js
          userTeam: d.userTeam || 1,
```

The `|| 1` fallback is what keeps every draft already stored in DynamoDB working.

- [ ] **Step 4: Verify the module loads cleanly**

Run: `cd backend/src && node -e "require('./drafts.js'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add backend/src/drafts.js
git commit -m "Add userTeam draft slot to draft create and read"
```

---

## Task 7: Snake pick-schedule helper (TDD)

**Files:**
- Create: `frontend/src/lib/snake.test.js`
- Create: `frontend/src/lib/snake.js`
- Modify: `frontend/package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `picksForSlot(slot, teams, rounds) -> number[]` of overall pick numbers, and `largestGap(picks) -> number`. Task 9's Home picker renders both.

- [ ] **Step 1: Add a unit test script for the frontend**

In `frontend/package.json`, add to `scripts` (keep `test` as Playwright — these are separate runners):

```json
    "test:unit": "node --test \"src/**/*.test.js\"",
```

- [ ] **Step 2: Write the failing tests**

`frontend/src/lib/snake.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { picksForSlot, largestGap } from "./snake.js";

test("slot 1 in a 12-team snake gets picks 1 and 24", () => {
  const picks = picksForSlot(1, 12, 3);
  assert.deepStrictEqual(picks, [1, 24, 25]);
});

test("slot 3 in a 12-team snake", () => {
  const picks = picksForSlot(3, 12, 3);
  assert.deepStrictEqual(picks, [3, 22, 27]);
});

test("last slot picks back-to-back at the turn", () => {
  const picks = picksForSlot(12, 12, 2);
  assert.deepStrictEqual(picks, [12, 13]);
});

test("one round yields exactly one pick", () => {
  assert.deepStrictEqual(picksForSlot(5, 10, 1), [5]);
});

test("largestGap finds the longest wait between picks", () => {
  assert.strictEqual(largestGap([3, 22, 27]), 19);
});

test("largestGap of a single pick is zero", () => {
  assert.strictEqual(largestGap([7]), 0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — cannot find module `./snake.js`

- [ ] **Step 4: Write the implementation**

`frontend/src/lib/snake.js`:

```js
/** Overall pick numbers for a slot in a snake draft. */
export function picksForSlot(slot, teams, rounds) {
  const picks = [];
  for (let round = 1; round <= rounds; round++) {
    const indexInRound = round % 2 === 1 ? slot : teams - slot + 1;
    picks.push((round - 1) * teams + indexInRound);
  }
  return picks;
}

/** Largest number of picks between consecutive turns. */
export function largestGap(picks) {
  let max = 0;
  for (let i = 1; i < picks.length; i++) {
    max = Math.max(max, picks[i] - picks[i - 1]);
  }
  return max;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npm run test:unit`
Expected: PASS — `tests 6`, `fail 0`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/snake.js frontend/src/lib/snake.test.js frontend/package.json
git commit -m "Add snake pick-schedule helper with unit tests"
```

---

## Task 8: Frontend API client and board registry

**Files:**
- Modify: `frontend/src/lib/api.js:22-23`
- Create: `frontend/src/lib/boardRegistry.js`

**Interfaces:**
- Consumes: existing `req()` in `api.js`
- Produces: `apiPut(path, body)`, `apiDelete(path)`, and from `boardRegistry.js`: `listBoards() -> Array<{id,name,updatedAt}>`, `rememberBoard({id,name})`, `forgetBoard(id)`. Tasks 9 and 10 consume all of these.

- [ ] **Step 1: Add the PUT and DELETE helpers**

In `frontend/src/lib/api.js`, replace the final two export lines:

```js
export const apiGet = (path) => req(path);
export const apiPost = (path, body) => req(path, { method: "POST", body: JSON.stringify(body || {}) });
export const apiPut = (path, body) => req(path, { method: "PUT", body: JSON.stringify(body || {}) });
export const apiDelete = (path) => req(path, { method: "DELETE" });
```

- [ ] **Step 2: Create the board registry**

`frontend/src/lib/boardRegistry.js`:

```js
const KEY = "perfectpick.myBoards";

export function listBoards() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rememberBoard({ id, name }) {
  try {
    const boards = listBoards().filter((b) => b.id !== id);
    boards.unshift({ id, name, updatedAt: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(boards.slice(0, 50)));
  } catch {
    // Storage unavailable (private mode, quota). The board still exists
    // server-side and remains reachable by link.
  }
}

export function forgetBoard(id) {
  try {
    localStorage.setItem(KEY, JSON.stringify(listBoards().filter((b) => b.id !== id)));
  } catch {
    // See rememberBoard.
  }
}
```

Every access is wrapped because `localStorage` throws outright in some privacy modes rather than returning null.

- [ ] **Step 3: Verify the frontend still builds**

Run: `cd frontend && npm run build`
Expected: `built in <time>` with no errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.js frontend/src/lib/boardRegistry.js
git commit -m "Add PUT/DELETE api helpers and localStorage board registry"
```

---

## Task 9: Board editor page

**Files:**
- Create: `frontend/src/pages/Board.jsx`
- Modify: `frontend/package.json`, `frontend/src/App.jsx:1-17`

**Interfaces:**
- Consumes: `apiGet` / `apiPut` (Task 8), `usePageTitle` from `frontend/src/lib/usePageTitle.js`, `GET|PUT /boards/:id` (Tasks 4-5)
- Produces: route `/board/:boardId`. Task 11's Playwright spec drives this page.

- [ ] **Step 1: Install the drag dependencies**

Run: `cd frontend && npm install @dnd-kit/core@^6 @dnd-kit/sortable@^8 @dnd-kit/utilities@^3`
Expected: packages added to `dependencies` in `frontend/package.json`

- [ ] **Step 2: Create the page**

`frontend/src/pages/Board.jsx`:

```jsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { apiGet, apiPut } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";

const POS_COLORS = {
  QB: "text-rose-300", RB: "text-emerald-300", WR: "text-cyan-300",
  TE: "text-amber-300", K: "text-zinc-400", DEF: "text-violet-300",
};

function DeltaBadge({ delta }) {
  if (delta === null || delta === 0) {
    return <span className="text-xs text-zinc-600">—</span>;
  }
  const up = delta > 0;
  return (
    <span className={`text-xs tabular-nums ${up ? "text-emerald-400" : "text-rose-400"}`}>
      {up ? "+" : ""}{delta} {up ? "↑" : "↓"}
    </span>
  );
}

function Row({ row }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.playerId });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="board-row"
      data-player-id={row.playerId}
      className={`flex items-center gap-3 rounded-2xl border border-zinc-800/70 bg-zinc-950/60 px-3 py-2 ${
        isDragging ? "opacity-60 ring-1 ring-cyan-300/40" : ""
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${row.name}`}
        className="cursor-grab px-1 text-zinc-600 hover:text-zinc-300 active:cursor-grabbing"
      >
        ⠿
      </button>
      <span className="w-8 text-right text-sm tabular-nums text-zinc-500">{row.myRank}</span>
      <span className="flex-1 truncate text-sm text-zinc-100">
        {row.name}
        {row.isNew && (
          <span className="ml-2 rounded-full bg-cyan-300/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-cyan-300">
            New
          </span>
        )}
      </span>
      <span className={`w-10 text-xs ${POS_COLORS[row.position] || "text-zinc-400"}`}>
        {row.position}
      </span>
      <span className="w-10 text-xs text-zinc-500">{row.team}</span>
      <span className="w-16 text-right"><DeltaBadge delta={row.delta} /></span>
    </li>
  );
}

export default function Board() {
  const { boardId } = useParams();
  const [board, setBoard] = useState(null);
  const [rows, setRows] = useState([]);
  const [version, setVersion] = useState(null);
  const [status, setStatus] = useState("loading");
  const [err, setErr] = useState("");
  const saveTimer = useRef(null);

  usePageTitle(board ? board.name : "Board");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const load = useCallback(async () => {
    try {
      const data = await apiGet(`/boards/${boardId}`);
      setBoard(data);
      setRows(data.rows);
      setVersion(data.version);
      setStatus("idle");
      setErr("");
    } catch (e) {
      setErr(e.message || "Failed to load board");
      setStatus("error");
    }
  }, [boardId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const save = useCallback(async (nextRows, expectedVersion) => {
    setStatus("saving");
    try {
      const res = await apiPut(`/boards/${boardId}`, {
        order: nextRows.map((r) => r.playerId),
        version: expectedVersion,
      });
      setVersion(res.version);
      setStatus("saved");
    } catch (e) {
      if (String(e.message).includes("changed since")) {
        setErr("This board changed elsewhere. Reloading.");
        await load();
      } else {
        setErr(e.message || "Save failed");
        setStatus("error");
      }
    }
  }, [boardId, load]);

  function onDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = rows.findIndex((r) => r.playerId === active.id);
    const to = rows.findIndex((r) => r.playerId === over.id);
    if (from < 0 || to < 0) return;

    const moved = arrayMove(rows, from, to).map((r, i) => ({
      ...r,
      myRank: i + 1,
      delta: r.consensusRank === null ? null : r.consensusRank - (i + 1),
    }));

    setRows(moved);
    setStatus("dirty");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(moved, version), 800);
  }

  if (status === "loading") {
    return <div className="py-12 text-center text-zinc-400">Loading board…</div>;
  }
  if (!board) {
    return <div className="py-12 text-center text-rose-300" data-testid="board-error">{err}</div>;
  }

  return (
    <div className="py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{board.name}</h1>
          <p className="text-sm text-zinc-400">
            {board.format.toUpperCase()} · {board.season} · {rows.length} players
          </p>
        </div>
        <span data-testid="save-status" className="text-xs text-zinc-400">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : status === "dirty" ? "Unsaved" : ""}
        </span>
      </div>

      {(board.changelog.added > 0 || board.changelog.removed > 0) && (
        <div data-testid="changelog" className="mb-4 rounded-2xl border border-cyan-300/20 bg-cyan-300/5 px-4 py-2 text-sm text-cyan-200">
          {board.changelog.added} added, {board.changelog.removed} removed since you last opened this board.
        </div>
      )}

      {err && <div className="mb-4 text-sm text-rose-300">{err}</div>}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={rows.map((r) => r.playerId)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1">
            {rows.map((row) => <Row key={row.playerId} row={row} />)}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}
```

- [ ] **Step 3: Register the route**

In `frontend/src/App.jsx`, add the import after the `Results` import:

```jsx
import Board from "./pages/Board.jsx";
```

and add the route after the `/draft/:draftId/results` route:

```jsx
          <Route path="/board/:boardId" element={<Board />} />
```

- [ ] **Step 4: Verify the build**

Run: `cd frontend && npm run build`
Expected: `built in <time>` with no errors

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/pages/Board.jsx frontend/src/App.jsx
git commit -m "Add drag-reorder board editor page"
```

---

## Task 10: Home page — slot picker and board list

**Files:**
- Modify: `frontend/src/pages/Home.jsx`

**Interfaces:**
- Consumes: `picksForSlot` / `largestGap` (Task 7), `listBoards` / `rememberBoard` (Task 8), `apiPost` for `/boards` and `/drafts`
- Produces: `userTeam` sent on draft create; board creation entry point. Task 11 drives both.

- [ ] **Step 1: Add the imports and state**

In `frontend/src/pages/Home.jsx`, replace the import block at the top:

```jsx
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { apiDelete } from "../lib/api";
import { picksForSlot, largestGap } from "../lib/snake";
import { listBoards, rememberBoard, forgetBoard } from "../lib/boardRegistry";
```

Merge the two `../lib/api` imports into one line — `import { apiPost, apiDelete } from "../lib/api";` — rather than leaving two import statements for the same module.

Then, inside `Home()`, add after the `const [year, setYear] = useState(2025);` line:

```jsx
  const [slot, setSlot] = useState(1);
  const [randomSlot, setRandomSlot] = useState(false);
  const [boards, setBoards] = useState(() => listBoards());

  const safeSlot = Math.min(Math.max(1, slot), teams);
  const schedule = useMemo(
    () => picksForSlot(safeSlot, teams, rounds),
    [safeSlot, teams, rounds]
  );
```

- [ ] **Step 2: Send the slot when creating a draft**

In `frontend/src/pages/Home.jsx`, replace the `apiPost` call inside `createDraft`:

```jsx
      const userTeam = randomSlot
        ? Math.floor(Math.random() * teams) + 1
        : safeSlot;
      const draft = await apiPost("/drafts", {
        teams, rounds, sport: "nfl", format, year, userTeam,
      });
```

- [ ] **Step 3: Add the board creation and deletion handlers**

In `frontend/src/pages/Home.jsx`, add after the `createDraft` function:

```jsx
  const createBoard = async () => {
    setErr("");
    try {
      const name = `My ${format.toUpperCase()} Board`;
      const { boardId } = await apiPost("/boards", { name, format, season: year });
      rememberBoard({ id: boardId, name });
      setBoards(listBoards());
      nav(`/board/${boardId}`);
    } catch (e) {
      setErr(e.message || "Failed to create board");
    }
  };

  const deleteBoard = async (id) => {
    setErr("");
    try {
      await apiDelete(`/boards/${id}`);
    } catch (e) {
      setErr(e.message || "Failed to delete board");
    } finally {
      // Drop it locally either way — a board the server no longer has
      // should not linger in the list.
      forgetBoard(id);
      setBoards(listBoards());
    }
  };
```

This is what makes `DELETE /boards/:id` (Task 5), `apiDelete`, and `forgetBoard` (Task 8) reachable. Without it those three are dead code.

- [ ] **Step 4: Add the slot picker UI**

In `frontend/src/pages/Home.jsx`, inside the `<div className="grid gap-3 sm:grid-cols-2">` controls block, add after the existing Teams and Rounds labels:

```jsx
              <label className="space-y-1 sm:col-span-2">
                <div className="flex items-center justify-between text-sm text-zinc-300">
                  <span>Your draft slot</span>
                  <button
                    type="button"
                    onClick={() => setRandomSlot((v) => !v)}
                    data-testid="random-slot"
                    className={`rounded-full border px-3 py-0.5 text-xs ${
                      randomSlot
                        ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-200"
                        : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
                    }`}
                  >
                    Random
                  </button>
                </div>
                <select
                  data-testid="slot-select"
                  disabled={randomSlot}
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none focus:border-cyan-300/60 disabled:opacity-40"
                  value={safeSlot}
                  onChange={(e) => setSlot(Number(e.target.value))}
                >
                  {Array.from({ length: teams }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>Slot {n} of {teams}</option>
                  ))}
                </select>
                {!randomSlot && (
                  <div data-testid="pick-schedule" className="text-xs text-zinc-500">
                    Your picks: {schedule.slice(0, 8).join(", ")}
                    {schedule.length > 8 ? ", …" : ""}
                    {schedule.length > 1 && ` · ${largestGap(schedule)}-pick longest wait`}
                  </div>
                )}
              </label>
```

- [ ] **Step 5: Add the board list UI**

In `frontend/src/pages/Home.jsx`, insert immediately after the closing `</div>` of the block containing the "Start Mock Draft" button — the `<div className="flex flex-col gap-3 sm:flex-row sm:items-center">` block — and before the `</div>` that closes the hero column (`<div className="space-y-6">`):

```jsx
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-white">My boards</div>
                <button
                  type="button"
                  onClick={createBoard}
                  data-testid="create-board"
                  className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-600"
                >
                  + New board
                </button>
              </div>
              {boards.length === 0 ? (
                <div className="text-sm text-zinc-500">
                  No boards yet. Create one to rank players your way.
                </div>
              ) : (
                <ul className="space-y-1" data-testid="board-list">
                  {boards.map((b) => (
                    <li key={b.id} className="flex items-center gap-2">
                      <button
                        onClick={() => nav(`/board/${b.id}`)}
                        className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-left text-sm text-zinc-200 hover:border-zinc-600"
                      >
                        {b.name}
                      </button>
                      <button
                        onClick={() => deleteBoard(b.id)}
                        aria-label={`Delete ${b.name}`}
                        className="rounded-2xl border border-zinc-800 px-3 py-2 text-xs text-zinc-500 hover:border-rose-900/60 hover:text-rose-300"
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
```

- [ ] **Step 6: Verify the build**

Run: `cd frontend && npm run build`
Expected: `built in <time>` with no errors

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Home.jsx
git commit -m "Add draft slot picker and board list to Home"
```

---

## Task 11: Draft page — honor the user's slot

Replaces all 11 hardcoded `Team 1` references.

**Files:**
- Modify: `frontend/src/pages/Draft.jsx` lines 133, 141, 151, 165, 183, 199, 233, 245, 288, 361, 366

**Interfaces:**
- Consumes: `draft.userTeam` from `GET /drafts/:id` (Task 6)
- Produces: slot-aware clock, banner, and pick gating.

- [ ] **Step 1: Derive the user's team once**

In `frontend/src/pages/Draft.jsx`, immediately after the `const [paused, setPaused] = useState(...)` state declarations and before the first `useEffect`, add:

```jsx
  const myTeam = draft?.userTeam || 1;
  const isMyTurn = draft?.currentTeam === myTeam;
```

- [ ] **Step 2: Replace the timer-reset comparison (lines 133, 141-142)**

Replace:

```jsx
    if (draft.currentTeam === 1) setSecondsLeft(PICK_SECONDS);
  }, [draft?.draftId, draft?.currentIndex, draft?.currentTeam, draft?.completed]);
```

with:

```jsx
    if (isMyTurn) setSecondsLeft(PICK_SECONDS);
  }, [draft?.draftId, draft?.currentIndex, draft?.currentTeam, draft?.completed, isMyTurn]);
```

- [ ] **Step 3: Replace the bot auto-advance guard (line 151)**

Replace `if (draft.currentTeam !== 1) {` with:

```jsx
    if (!isMyTurn) {
```

and add `isMyTurn` to that effect's dependency array.

- [ ] **Step 4: Replace the countdown guard (line 165)**

Replace `if (draft.currentTeam !== 1) return;` with:

```jsx
    if (!isMyTurn) return;
```

and add `isMyTurn` to that effect's dependency array.

- [ ] **Step 5: Replace the timeout auto-pick (line 183)**

Replace `if (draft.currentTeam === 1 && secondsLeft === 0) {` with:

```jsx
    if (isMyTurn && secondsLeft === 0) {
```

and add `isMyTurn` to that effect's dependency array.

- [ ] **Step 6: Replace the pick gate (line 199)**

Replace the `canManualPick` assignment with:

```jsx
  const canManualPick = !paused && !busy && !draft.completed && isMyTurn;
```

- [ ] **Step 7: Replace the four UI strings (lines 233, 245, 288, 361, 366)**

- Line 233: `{draft.currentTeam === 1 && !draft.completed ? (` → `{isMyTurn && !draft.completed ? (`
- Line 245: `title="Auto-pick the current team (Team 1 too)"` → `title="Auto-pick for whichever team is on the clock"`
- Line 288: `? "You are on the clock (Team 1)"` → `` ? `You are on the clock (Team ${myTeam})` ``
- Line 361: `? "Click to draft for Team 1"` → `` ? `Click to draft for Team ${myTeam}` ``
- Line 366: `: "You can only draft when Team 1 is on the clock"` → `` : `You can only draft when Team ${myTeam} is on the clock` ``

Note lines 288, 361, and 366 change from string literals to template literals — the surrounding quotes become backticks.

- [ ] **Step 8: Confirm no hardcoded references remain**

Run: `cd frontend && grep -n "Team 1\|currentTeam === 1\|currentTeam !== 1" src/pages/Draft.jsx`
Expected: no output

- [ ] **Step 9: Verify the build**

Run: `cd frontend && npm run build`
Expected: `built in <time>` with no errors

- [ ] **Step 10: Commit**

```bash
git add frontend/src/pages/Draft.jsx
git commit -m "Honor the user's draft slot instead of hardcoding Team 1"
```

---

## Task 12: End-to-end tests

**Files:**
- Modify: `frontend/tests/fixtures.js`
- Create: `frontend/tests/board.spec.js`
- Create: `frontend/tests/slot.spec.js`

**Interfaces:**
- Consumes: everything above
- Produces: regression coverage. Terminal task.

- [ ] **Step 1: Add board fixtures**

Append to `frontend/tests/fixtures.js`:

```js
export const BOARD_ID = "test-board-xyz789";

export function makeBoardState({ order = null, added = 0, removed = 0 } = {}) {
  const source = order
    ? order.map((id) => MOCK_PLAYERS.find((p) => p.id === id))
    : MOCK_PLAYERS.slice(0, 10);

  return {
    boardId: BOARD_ID,
    name: "My PPR Board",
    sport: "nfl",
    format: "ppr",
    season: 2026,
    version: 1,
    changelog: { added, removed },
    rows: source.map((p, i) => ({
      playerId: p.id,
      name: p.name,
      position: p.position,
      team: p.team,
      myRank: i + 1,
      consensusRank: p.rank,
      delta: p.rank - (i + 1),
      isNew: false,
    })),
  };
}
```

Also add `userTeam: 1,` to the returned object in `makeDraftState` (after the `rounds: 15,` line) and `userTeam: 1,` in `makeCompletedDraft` (after `rounds: 3,`).

- [ ] **Step 2: Write the board spec**

`frontend/tests/board.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { BOARD_ID, makeBoardState } from "./fixtures.js";

async function mockBoard(page, state, { onSave } = {}) {
  await page.route(`**/boards/${BOARD_ID}`, async (route) => {
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() || "{}");
      onSave?.(body);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, version: body.version + 1 }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(state),
    });
  });
}

test("renders the board in saved order", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await page.goto(`/board/${BOARD_ID}`);

  const rows = page.getByTestId("board-row");
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toContainText("Christian McCaffrey");
});

test("shows the changelog when the pool has changed", async ({ page }) => {
  await mockBoard(page, makeBoardState({ added: 3, removed: 1 }));
  await page.goto(`/board/${BOARD_ID}`);

  await expect(page.getByTestId("changelog")).toContainText("3 added, 1 removed");
});

test("hides the changelog when nothing changed", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await page.goto(`/board/${BOARD_ID}`);

  await expect(page.getByTestId("changelog")).toHaveCount(0);
});

test("keyboard reorder saves the new order", async ({ page }) => {
  let saved = null;
  await mockBoard(page, makeBoardState(), { onSave: (body) => { saved = body; } });
  await page.goto(`/board/${BOARD_ID}`);

  await page.getByRole("button", { name: "Reorder Christian McCaffrey" }).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");

  await expect(page.getByTestId("save-status")).toContainText("Saved", { timeout: 5000 });
  expect(saved.order[0]).toBe("p2");
  expect(saved.order[1]).toBe("p1");
});

test("deleting a board removes it from the list", async ({ page }) => {
  let deleted = false;
  await page.route(`**/boards/${BOARD_ID}`, async (route) => {
    if (route.request().method() === "DELETE") {
      deleted = true;
      return route.fulfill({
        status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }),
      });
    }
    return route.fallback();
  });

  await page.goto("/");
  await page.evaluate((id) => {
    localStorage.setItem(
      "perfectpick.myBoards",
      JSON.stringify([{ id, name: "My PPR Board", updatedAt: Date.now() }])
    );
  }, BOARD_ID);
  await page.reload();

  await expect(page.getByTestId("board-list")).toContainText("My PPR Board");
  await page.getByRole("button", { name: "Delete My PPR Board" }).click();

  await expect(page.getByTestId("board-list")).toHaveCount(0);
  expect(deleted).toBe(true);
});

test("surfaces a conflict when the board changed elsewhere", async ({ page }) => {
  await page.route(`**/boards/${BOARD_ID}`, async (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Board changed since you loaded it", currentVersion: 7 }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeBoardState()),
    });
  });
  await page.goto(`/board/${BOARD_ID}`);

  await page.getByRole("button", { name: "Reorder Christian McCaffrey" }).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");

  await expect(page.getByText("changed elsewhere")).toBeVisible({ timeout: 5000 });
});
```

- [ ] **Step 3: Write the slot spec**

`frontend/tests/slot.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { DRAFT_ID, MOCK_PLAYERS, makeDraftState } from "./fixtures.js";

test("pick schedule updates with the selected slot", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("slot-select").selectOption("3");
  await expect(page.getByTestId("pick-schedule")).toContainText("3, 22, 27");
  await expect(page.getByTestId("pick-schedule")).toContainText("19-pick longest wait");
});

test("selected slot is sent when creating a draft", async ({ page }) => {
  let posted = null;
  await page.route("**/drafts", async (route) => {
    posted = JSON.parse(route.request().postData() || "{}");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ draftId: DRAFT_ID }),
    });
  });
  await page.route(`**/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...makeDraftState(), userTeam: 7 }),
    })
  );
  await page.route("**/players*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sport: "nfl", format: "standard", count: MOCK_PLAYERS.length, players: MOCK_PLAYERS }),
    })
  );

  await page.goto("/");
  await page.getByTestId("slot-select").selectOption("7");
  await page.getByRole("button", { name: "Start Mock Draft" }).click();

  await expect.poll(() => posted?.userTeam).toBe(7);
});

test("random slot disables the selector", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("random-slot").click();
  await expect(page.getByTestId("slot-select")).toBeDisabled();
  await expect(page.getByTestId("pick-schedule")).toHaveCount(0);
});

test("the clock belongs to the user's slot, not Team 1", async ({ page }) => {
  const state = { ...makeDraftState({ currentIndex: 6 }), userTeam: 7 };
  await page.route(`**/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) })
  );
  await page.route("**/players*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sport: "nfl", format: "standard", count: MOCK_PLAYERS.length, players: MOCK_PLAYERS }),
    })
  );

  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByText("You are on the clock (Team 7)")).toBeVisible();
});
```

`makeDraftState({ currentIndex: 6 })` puts overall pick 7 — team 7 in round 1 — on the clock.

- [ ] **Step 4: Run the full end-to-end suite**

Run: `cd frontend && npm test`
Expected: PASS — the 30 pre-existing tests plus 10 new ones (6 board, 4 slot), 40 passing, 0 failing.

If a pre-existing test fails, the `userTeam` fixture addition in Step 1 is the likely cause — verify `makeDraftState` still returns `currentTeam` unchanged.

- [ ] **Step 5: Run the unit suites**

Run: `cd backend/src && npm test && cd ../../frontend && npm run test:unit`
Expected: backend `pass 10`, frontend `pass 6`

- [ ] **Step 6: Commit**

```bash
git add frontend/tests/
git commit -m "Add end-to-end coverage for board editor and draft slot selection"
```

---

## Verification

After Task 12, all of the following must pass from a clean checkout:

```bash
cd backend/src && npm test          # 10 unit tests
cd ../../frontend && npm run test:unit   # 6 unit tests
npm test                            # 39 Playwright tests
npm run build                       # clean production build
cd ../backend && sam validate --lint     # valid template
```

Deployment is manual and unchanged: `cd backend && sam build && sam deploy`, then `cd frontend && npm run deploy`.

## Notes for the implementer

- **`order` is a DynamoDB reserved word.** It must always go through `ExpressionAttributeNames` as `#o`. Task 5 does this; keep it that way if you touch the update expression.
- **Do not "fix" `drafts.js` concurrency while you're in there.** The unconditional read-modify-write at `drafts.js:276` is a known, separately-tracked bug. Changing it here would put an unrelated behavioral change inside this diff.
- **The reconciliation insertion rule intentionally differs from the spec's wording.** See the rationale in Task 2. If you change it, the "user's top pick is not displaced" test is the one that will catch you.
- **`dnd-kit` keyboard sensor drives the tests.** Reordering in Playwright uses Space/Arrow/Space rather than simulated mouse drags, which are flaky. Keep the keyboard sensor registered.
