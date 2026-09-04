# Accounts as the Front Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign-in becomes the way in — drafts and boards are private to the
people in them, and the home page is a landing page signed out and a dashboard
signed in.

**Architecture:** Drafts gain a `seats` list; access is seat membership rather
than a scalar owner, so invitations later fill empty seats without changing the
check. The two read routes gain the Cognito authorizer. A GSI on `ownerId`
backs two new `/me` list routes, so the lists come from the account rather than
from `localStorage`. The frontend gates every app route behind `RequireAuth`
and splits `/` into a landing page and a dashboard.

**Tech Stack:** AWS SAM / CloudFormation, API Gateway HTTP API JWT authorizer,
Cognito, DynamoDB (+ GSI), Node 24 (`node --test`), React + Vite, Playwright.

## Global Constraints

- **404, never 403**, for a resource you cannot see, with a body byte-identical
  to a genuine not-found (`{"error":"Draft not found"}` /
  `{"error":"Board not found"}`). This rule now covers **reads** as well as
  mutations.
- **Every protected route is tested from three angles:** allowed, signed in but
  not permitted (404), and no claims at all (401). `DELETE /drafts/{draftId}`
  gets a fourth: seated but not the owner (404).
- **Seeing and acting in a draft go by seat. Deleting goes by `ownerId`.** An
  invited person must never be able to delete your draft.
- **`GET /players` and `GET /players/{playerId}` stay public.** Reference data,
  not user data.
- **`/player/:playerId` stays reachable signed out** — it is the one genuinely
  shareable page in the app.
- **An unconfigured build (no `VITE_COGNITO_*`) must stay usable**, exactly as
  `mustSignIn` already decides: no sign-in to offer means no gate. The server is
  the enforcement point either way.
- **No invented testimonials, usage numbers, or logos** on the landing page.
- Backend is CommonJS with `node --test`; frontend is ESM. Comments explain
  *why*.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/lib/owner.js` | Gains `buildSeats` and `isSeated`. Still the only place access is decided. |
| `backend/src/drafts.js` | Writes `seats` on create; reads and acts gate on `isSeated`; delete stays owner-only. |
| `backend/src/boards.js` | `GET` gains the owner check. |
| `backend/src/me.js` | Claim route deleted; `GET /me/drafts` and `GET /me/boards` added. |
| `backend/src/template.test.js` | Read routes split into an explicit gated list and public list. |
| `backend/template.yaml` | Authorizer on the two reads; `byOwner` GSI on both tables; two new routes. |
| `backend/scripts/purge-unowned.js` (new) | One-off: dump every unowned row to JSON, then delete it. |
| `frontend/src/components/RequireAuth.jsx` (new) | Gates a route; renders a sign-in prompt in place. |
| `frontend/src/pages/Landing.jsx` (new) | The signed-out front door. |
| `frontend/src/pages/Dashboard.jsx` (new) | The signed-in home. |
| `frontend/src/pages/Home.jsx` | Becomes a two-line chooser between those two. |
| `frontend/src/lib/me.js` (new) | `fetchMyDrafts()` / `fetchMyBoards()`. |
| `frontend/src/pages/MyDrafts.jsx`, `Boards.jsx` | Read the server instead of `localStorage`. |
| **Deleted** | `frontend/src/lib/claim.js`, `claim.test.js`, `useClaimOnSignIn.js`, `components/ClaimOnSignIn.jsx`, `lib/draftRegistry.js`, `draftRegistry.test.js`, `lib/boardRegistry.js`, `lib/useRememberDraft.js` |

---

### Task 1: Seats

**Files:**
- Modify: `backend/src/lib/owner.js`
- Test: `backend/src/lib/owner.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buildSeats(teams, userTeam, sub) -> Array<{team:number, sub:string|null, kind:"human"|"bot"}>`
  - `isSeated(draft, sub) -> boolean`

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/lib/owner.test.js`:

```js
const { buildSeats, isSeated } = require("./owner");

test("buildSeats gives one seat per team", () => {
  assert.strictEqual(buildSeats(12, 1, "me").length, 12);
});

test("buildSeats seats the creator at their own team", () => {
  const seats = buildSeats(4, 3, "me");
  assert.deepStrictEqual(seats[2], { team: 3, sub: "me", kind: "human" });
});

test("buildSeats fills every other team with a bot", () => {
  const seats = buildSeats(4, 3, "me");
  const bots = seats.filter((s) => s.kind === "bot");
  assert.strictEqual(bots.length, 3);
  assert.ok(bots.every((s) => s.sub === null));
});

test("buildSeats numbers teams from one, in order", () => {
  assert.deepStrictEqual(
    buildSeats(3, 1, "me").map((s) => s.team),
    [1, 2, 3]
  );
});

test("the person in a seat can see the draft", () => {
  assert.strictEqual(isSeated({ seats: buildSeats(4, 1, "me") }, "me"), true);
});

test("somebody in no seat cannot", () => {
  assert.strictEqual(isSeated({ seats: buildSeats(4, 1, "me") }, "them"), false);
});

// A bot seat carries sub: null. Without the kind check, a caller whose sub
// somehow read as null would match every bot seat in the table.
test("a null sub does not match the bot seats", () => {
  assert.strictEqual(isSeated({ seats: buildSeats(4, 1, "me") }, null), false);
});

test("a draft with no seats admits nobody", () => {
  assert.strictEqual(isSeated({}, "me"), false);
  assert.strictEqual(isSeated({ seats: [] }, "me"), false);
});

test("isSeated tolerates junk in the seats list", () => {
  const draft = { seats: [null, "nope", { kind: "human" }, { team: 2, sub: "me", kind: "human" }] };
  assert.strictEqual(isSeated(draft, "me"), true);
});

test("isSeated tolerates a missing draft", () => {
  assert.strictEqual(isSeated(undefined, "me"), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend/src && node --test lib/owner.test.js`
Expected: FAIL — `buildSeats is not a function`

- [ ] **Step 3: Implement**

Add to `backend/src/lib/owner.js`, above `module.exports`:

```js
/**
 * One seat per team: the creator in theirs, a bot in every other.
 *
 * A list rather than a scalar owner because invitations fill empty seats
 * later, and the access check below never has to change to accommodate them.
 */
function buildSeats(teams, userTeam, sub) {
  return Array.from({ length: teams }, (_, i) => {
    const team = i + 1;
    return team === userTeam
      ? { team, sub, kind: "human" }
      : { team, sub: null, kind: "bot" };
  });
}

/**
 * May this person see and act in this draft?
 *
 * The `kind` check is not redundant with the sub comparison: bot seats carry
 * `sub: null`, so without it a caller whose sub read as null would match
 * every bot seat in the table.
 */
function isSeated(draft, sub) {
  if (typeof sub !== "string" || sub.length === 0) return false;
  const seats = draft?.seats;
  if (!Array.isArray(seats)) return false;
  return seats.some((s) => s && s.kind === "human" && s.sub === sub);
}
```

And extend the exports line:

```js
module.exports = { ANON, subOf, isUnowned, canMutate, buildSeats, isSeated };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend/src && node --test lib/owner.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/owner.js backend/src/lib/owner.test.js
git commit -m "feat: seats, so a draft can hold more than one person later"
```

---

### Task 2: Drafts are private to the people seated in them

**Files:**
- Modify: `backend/src/drafts.js`
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: `buildSeats`, `isSeated` from Task 1; `subOf` already imported.
- Produces: draft items carrying `seats` alongside `ownerId`. `GET /drafts/{id}`
  requires a seat.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/drafts.test.js`. Note `ownedDraft` gains seats — replace the
existing helper with this one:

```js
function ownedDraft(ownerId, seatSub = ownerId) {
  return {
    draftId: "d1",
    ownerId,
    seats: [
      { team: 1, sub: seatSub, kind: "human" },
      { team: 2, sub: null, kind: "bot" },
    ],
    sport: "nfl",
    format: "standard",
    teams: 2,
    rounds: 1,
    userTeam: 1,
    picks: [
      { overall: 1, round: 1, team: 1, playerId: null, player: null },
      { overall: 2, round: 1, team: 2, playerId: null, player: null },
    ],
    picked: [],
    currentIndex: 0,
    version: 1,
  };
}

test("POST /drafts seats the creator", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    put = cmd.input;
    return {};
  });
  await handler(
    evt("POST", "/drafts", { body: { teams: 4, rounds: 1, userTeam: 2 }, claims: ME })
  );
  assert.strictEqual(put.Item.seats.length, 4);
  assert.deepStrictEqual(put.Item.seats[1], { team: 2, sub: "user-me", kind: "human" });
  assert.strictEqual(put.Item.seats.filter((s) => s.kind === "bot").length, 3);
  // ownerId survives: it is who created it, which is a different question
  // from who may act in it, and delete still turns on it.
  assert.strictEqual(put.Item.ownerId, "user-me");
});

test("GET of a draft now requires claims", async () => {
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1" }));
  assert.strictEqual(res.statusCode, 401);
});

test("GET by somebody with no seat is 404, worded as not-found", async () => {
  stubSend({ Item: ownedDraft("user-them") });
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});

test("GET by the person seated in it works", async () => {
  stubSend({ Item: ownedDraft("user-me") });
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(res.statusCode, 200);
});

// Access is the seat, not the ownerId -- this is the case that proves it, and
// the one invitations will rely on.
test("somebody seated but not the owner can read and pick", async () => {
  const draft = ownedDraft("user-them", "user-me");
  stubByTable({
    "drafts-test": { Item: draft },
    "players-test": {
      Item: {
        playerId: "p1", id: "p1", name: "Test Back", position: "RB", team: "SF",
        rank: { standard: 1 }, adp: { standard: 1 }, tier: { standard: 1 },
      },
    },
  });
  const read = await handler(evt("GET", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(read.statusCode, 200);
  const pick = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" }, claims: ME })
  );
  assert.strictEqual(pick.statusCode, 200);
});

test("picking without a seat is 404 even for the ownerId", async () => {
  // seats say user-them; ownerId says user-me. The seat decides.
  stubSend({ Item: { ...ownedDraft("user-me", "user-them") } });
  const res = await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" }, claims: ME })
  );
  assert.strictEqual(res.statusCode, 404);
});

// Delete stays owner-only on purpose: an invited person must not be able to
// destroy the draft they were invited to.
test("DELETE still turns on ownerId, not on the seat", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const res = await handler(evt("DELETE", "/drafts/d1", { draftId: "d1", claims: ME }));
  assert.strictEqual(res.statusCode, 200);
  assert.match(input.ConditionExpression, /ownerId = :me/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend/src && node --test drafts.test.js`
Expected: FAIL — no `seats` on the put, GET returns 200 without claims.

- [ ] **Step 3: Implement**

In `backend/src/drafts.js`, extend the import:

```js
const { subOf, canMutate, ANON, buildSeats, isSeated } = require("./lib/owner");
```

In the `POST /drafts` branch, add `seats` to the item, directly after `ownerId`:

```js
      const item = {
        draftId: id,
        ownerId: sub,
        // Who may act, as distinct from who created it. One human today; a
        // later phase fills the bot seats with invitations.
        seats: buildSeats(teams, userTeam, sub),
        sport,
```

Replace the `GET /drafts/{draftId}` branch's opening:

```js
    // GET /drafts/{draftId}
    if (method === "GET" && draftId) {
      if (!sub) return needsAuth();
      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      // Not seated is indistinguishable from not there. Reading a draft you
      // were not invited to is exactly what this phase closes.
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();
```

In each of `/pick`, `/auto-pick` and `/sim-to-end`, replace the guard line:

```js
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();
```

(That replaces `if (!res.Item || !canMutate(res.Item, sub)) return notFound();`.)

Leave the `DELETE` branch exactly as it is — it turns on `ownerId` and must
keep doing so. `canMutate` and `ANON` remain imported for it.

- [ ] **Step 4: Run the tests**

Run: `cd backend/src && node --test drafts.test.js`
Expected: PASS. Existing tests that GET without claims now 401 — add `claims: ME`
and give their fixtures seats via the updated `ownedDraft`. Read each before
changing it; if a test's purpose was the unauthenticated read path, that purpose
is what this task removes, so rewrite it to assert the new 401 rather than
silently converting it.

- [ ] **Step 5: Full backend suite**

Run: `cd backend/src && npm test`
Expected: `template.test.js` fails on the read-route assertion — Task 3 owns
that. Everything else passes.

- [ ] **Step 6: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js
git commit -m "feat: a draft is visible only to the people seated in it"
```

---

### Task 3: Gate the two reads, and tighten the route test

**Files:**
- Modify: `backend/template.yaml`
- Modify: `backend/src/template.test.js`
- Modify: `backend/src/boards.js`
- Test: `backend/src/boards.test.js`

**Interfaces:**
- Consumes: Task 2's seat check (already in `drafts.js`).
- Produces: `GET /drafts/{draftId}` and `GET /boards/{boardId}` carry
  `CognitoAuth`.

- [ ] **Step 1: Rewrite the read-route assertions**

The current test asserts *no* read route carries an authorizer. Two now do,
deliberately. Deleting that assertion would remove the guard that catches a read
being gated by accident, so replace it with two explicit lists.

In `backend/src/template.test.js`, replace the test named
`no read route carries an authorizer` with:

```js
// Reads are no longer uniformly public, so the guard becomes two explicit
// lists. A route moving between them fails this test in both directions --
// which is the point: gating a read by accident locks users out silently,
// and un-gating one exposes other people's drafts just as silently.
const GATED_READS = [
  "GET /boards/{boardId}",
  "GET /drafts/{draftId}",
  "GET /me/boards",
  "GET /me/drafts",
];
const PUBLIC_READS = ["GET /players", "GET /players/{playerId}"];

test("exactly the intended reads are gated", () => {
  const gated = httpRoutes(loadTemplate())
    .filter((r) => !MUTATING.has(r.method) && r.authorizer === "CognitoAuth")
    .map((r) => `${r.method} ${r.path}`)
    .sort();
  assert.deepStrictEqual(gated, GATED_READS);
});

test("exactly the intended reads are public", () => {
  const open = httpRoutes(loadTemplate())
    .filter((r) => !MUTATING.has(r.method) && r.authorizer === null)
    .map((r) => `${r.method} ${r.path}`)
    .sort();
  assert.deepStrictEqual(open, PUBLIC_READS);
});
```

Also update the mutating-route list in `the expected mutating routes are all
present` — `POST /me/claim` goes away in Task 5, so remove that line now and
expect this test to stay red until then:

```js
  assert.deepStrictEqual(found, [
    "DELETE /boards/{boardId}",
    "DELETE /drafts/{draftId}",
    "POST /boards",
    "POST /drafts",
    "POST /drafts/{draftId}/auto-pick",
    "POST /drafts/{draftId}/pick",
    "POST /drafts/{draftId}/sim-to-end",
    "PUT /boards/{boardId}",
  ]);
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd backend/src && node --test template.test.js`
Expected: FAIL — the reads are not gated yet and `/me/*` does not exist.

- [ ] **Step 3: Gate the two reads in the template**

In `backend/template.yaml`, add to the `Properties` of the `GetDraft` event
(under `DraftsFunction`) and the `GetBoard` event (under `BoardsFunction`):

```yaml
            Auth:
              Authorizer: CognitoAuth
```

`GetPlayers` and `GetPlayer` stay exactly as they are.

- [ ] **Step 4: Require the owner on GET /boards**

In `backend/src/boards.js`, replace the opening of the `GET` branch:

```js
    if (method === "GET" && boardId) {
      if (!sub) return needsAuth();
      const res = await ddb.send(
        new GetCommand({ TableName: boardsTable, Key: { boardId } })
      );
      if (!res.Item || !canMutate(res.Item, sub)) return notFound();
```

`canMutate` is already the right predicate here — a board has one owner, and it
already refuses the legacy `"anon"`. Extend the import if it is not already
present:

```js
const { subOf, canMutate, ANON } = require("./lib/owner");
```

Add to `backend/src/boards.test.js`:

```js
test("GET of a board now requires claims", async () => {
  const { code } = await status(event("GET", undefined, "b1"));
  assert.strictEqual(code, 401);
});

test("GET of somebody else's board is 404", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Item: { boardId: "b1", ownerId: "user-them", sport: "nfl", format: "ppr" },
  }));
  const res = await handler(event("GET", undefined, "b1", ME));
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Board not found" });
  mock.restoreAll();
});
```

- [ ] **Step 5: Run the tests**

Run: `cd backend/src && node --test boards.test.js && node --test template.test.js`
Expected: `boards.test.js` passes (fix existing GET tests by adding `ME` and an
`ownerId: "user-me"` to their fixtures). `template.test.js` still fails on the
two `/me/*` routes and the mutating list — Tasks 5 and 6 close those.

- [ ] **Step 6: Validate and commit**

```bash
cd backend && sam validate --lint
git add backend/template.yaml backend/src/template.test.js backend/src/boards.js backend/src/boards.test.js
git commit -m "feat: reading a draft or board requires being in it"
```

---

### Task 4: The purge script

**Files:**
- Create: `backend/scripts/purge-unowned.js`
- Test: `backend/scripts/purge-unowned.test.js`

**Interfaces:**
- Consumes: `ANON` from `backend/src/lib/owner.js`.
- Produces: a script run once, by hand, against production.

This runs **before** the read gate is deployed. Afterwards those rows are
unreachable and the dump is the only way back.

- [ ] **Step 1: Write the failing test for the pure part**

```js
// backend/scripts/purge-unowned.test.js
const test = require("node:test");
const assert = require("node:assert");
const { isPurgeable } = require("./purge-unowned");

test("a row with no ownerId is purgeable", () => {
  assert.strictEqual(isPurgeable({ draftId: "d1" }), true);
});

test("the legacy anon owner is purgeable", () => {
  assert.strictEqual(isPurgeable({ boardId: "b1", ownerId: "anon" }), true);
});

test("an empty ownerId is purgeable", () => {
  assert.strictEqual(isPurgeable({ ownerId: "" }), true);
});

// The whole safety property. A real owner means somebody signed in and
// claimed it, and deleting it would be destroying their work.
test("a row with a real owner is never purgeable", () => {
  assert.strictEqual(isPurgeable({ ownerId: "a1b2c3" }), false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd backend && node --test scripts/purge-unowned.test.js`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the script**

```js
// backend/scripts/purge-unowned.js
//
// One-off: delete every draft and board that nobody owns, after dumping them
// to a file. Run once, against production, BEFORE the read gate ships --
// afterwards these rows are unreachable and the dump is the only way back.
//
// Refuses to delete anything without --confirm, so a curious run is a dry run.
const fs = require("node:fs");
const path = require("node:path");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { ANON } = require("../src/lib/owner");

const TABLES = [
  { name: "perfectpick-drafts", key: "draftId" },
  { name: "perfectpick-boards", key: "boardId" },
];

/** Nobody owns this: no ownerId, an empty one, or the legacy placeholder. */
function isPurgeable(item) {
  const owner = item?.ownerId;
  return !owner || owner === ANON;
}

async function scanAll(ddb, TableName) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new ScanCommand({ TableName, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const outDir = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : path.join(require("node:os").homedir(), "perfectpick-purge-backups");

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(outDir, { recursive: true });

  for (const { name, key } of TABLES) {
    const all = await scanAll(ddb, name);
    const doomed = all.filter(isPurgeable);
    console.log(`${name}: ${all.length} rows, ${doomed.length} unowned`);

    if (doomed.length === 0) continue;

    const dump = path.join(outDir, `${name}-${stamp}.json`);
    fs.writeFileSync(dump, JSON.stringify(doomed, null, 2));
    // Read it back before deleting anything: a dump that did not land is the
    // difference between a cleanup and a data loss.
    const readBack = JSON.parse(fs.readFileSync(dump, "utf8"));
    if (readBack.length !== doomed.length) {
      throw new Error(`dump verification failed for ${name}`);
    }
    console.log(`  dumped ${readBack.length} rows to ${dump}`);

    if (!confirm) {
      console.log("  dry run -- pass --confirm to delete");
      continue;
    }
    for (const item of doomed) {
      await ddb.send(new DeleteCommand({ TableName: name, Key: { [key]: item[key] } }));
    }
    console.log(`  deleted ${doomed.length} rows`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { isPurgeable };
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && node --test scripts/purge-unowned.test.js`
Expected: PASS — 4 tests

- [ ] **Step 5: Dry-run it against production**

Run: `cd backend && node scripts/purge-unowned.js`
Expected: reports `perfectpick-drafts: 66 rows, 66 unowned` and
`perfectpick-boards: 3 rows, 3 unowned`, writes two dump files, and says
`dry run -- pass --confirm to delete`. **Do not pass `--confirm` yet** — that is
a deploy-time step, listed in Final Verification.

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/purge-unowned.js backend/scripts/purge-unowned.test.js
git commit -m "feat: a one-off purge of rows nobody owns, dump first"
```

---

### Task 5: Delete the claim feature

**Files:**
- Modify: `backend/src/me.js`, `backend/src/me.test.js`, `backend/template.yaml`
- Delete: `frontend/src/lib/claim.js`, `frontend/src/lib/claim.test.js`,
  `frontend/src/lib/useClaimOnSignIn.js`,
  `frontend/src/components/ClaimOnSignIn.jsx`
- Modify: `frontend/src/App.jsx`, `frontend/tests/auth.js`,
  `frontend/tests/auth.spec.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `POST /me/claim` no longer exists. `me.js` keeps its handler shell
  for Task 6.

Nothing can be unowned after Task 4, so no caller can ever have anything to
claim. This deletes the path rather than carrying it.

- [ ] **Step 1: Strip the claim route from `me.js`**

In `backend/src/me.js` delete `MAX_IDS`, `MAX_ID_LENGTH`, `validIds`,
`claimOne`, `claimAll`, the `UpdateCommand` import and the `ANON` import, and
replace the whole `if (method === "POST" && path.endsWith("/claim"))` block with
nothing. `parseBody` also goes — Task 6's routes take no body. The handler
becomes:

```js
exports.handler = async (event) => {
  const json = responder(event);
  const method = event.requestContext?.http?.method;
  const path = event.rawPath || event.requestContext?.http?.path || "";

  if (method === "OPTIONS") return json(200, {});

  const sub = subOf(event);
  if (!sub) return json(401, { error: "Sign in required" });

  try {
    return json(404, { error: "Not found" });
  } catch (e) {
    return json(500, { error: e.message || "Server error" });
  }
};
```

- [ ] **Step 2: Strip the claim tests**

In `backend/src/me.test.js`, delete every test about claiming, keeping only:

```js
test("a request without claims is 401", async () => {
  const res = await handler(event(undefined, undefined));
  assert.strictEqual(res.statusCode, 401);
});

test("an unknown path under /me is 404", async () => {
  const res = await handler({
    requestContext: { http: { method: "POST" }, authorizer: { jwt: { claims: ME } } },
    rawPath: "/me/nope",
  });
  assert.strictEqual(res.statusCode, 404);
});
```

and simplify the `event` helper to `(body, claims)` with no `draftIds`.

- [ ] **Step 3: Remove the route from the template**

In `backend/template.yaml`, delete the whole `Claim:` event from
`MeFunction.Properties.Events`. Leave `MeFunction` itself — Task 6 adds two
routes to it. A function with no events is briefly invalid to `sam deploy`, so
do not deploy between this task and Task 6.

- [ ] **Step 4: Delete the frontend claim path**

```bash
git rm frontend/src/lib/claim.js frontend/src/lib/claim.test.js \
       frontend/src/lib/useClaimOnSignIn.js \
       frontend/src/components/ClaimOnSignIn.jsx
```

In `frontend/src/App.jsx`, remove the `ClaimOnSignIn` import and its
`<ClaimOnSignIn />` element.

In `frontend/tests/auth.js`, remove the `**/me/claim` route mock and the comment
above it. In `frontend/tests/auth.spec.js`, delete the two tests
`signing in claims the boards this browser already made` and
`a draft opened from someone else's link is not claimed`.

- [ ] **Step 5: Run both suites**

Run: `cd backend/src && npm test`
Expected: `template.test.js`'s mutating list now passes; the two `/me/*` read
tests still fail until Task 6.

Run: `cd frontend && npm run lint && npm run test:unit`
Expected: lint clean; unit count drops by the six `claim.test.js` tests.

- [ ] **Step 6: Commit**

```bash
git add -A backend/src/me.js backend/src/me.test.js backend/template.yaml \
        frontend/src/App.jsx frontend/tests/auth.js frontend/tests/auth.spec.js \
        frontend/src/lib frontend/src/components
git commit -m "refactor: delete the claim path, which nothing can reach any more"
```

---

### Task 6: Your drafts and boards, from the server

**Files:**
- Modify: `backend/template.yaml`, `backend/src/me.js`
- Test: `backend/src/me.test.js`

**Interfaces:**
- Consumes: the `byOwner` GSI added here.
- Produces:
  - `GET /me/drafts` → `{ drafts: [{ id, teams, rounds, format, userTeam, boardId, completed, createdAt }] }`
  - `GET /me/boards` → `{ boards: [{ id, name, format, season, updatedAt }] }`
  Task 10 and Task 11 depend on exactly these key names.

**Listing goes by `ownerId` while access goes by seat.** They agree only
because a draft has one human seat today; see the spec. A test below pins that.

- [ ] **Step 1: Add the GSI to both tables**

In `backend/template.yaml`, `DraftsTable` becomes:

```yaml
  DraftsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: perfectpick-drafts
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: draftId
          AttributeType: S
        - AttributeName: ownerId
          AttributeType: S
      KeySchema:
        - AttributeName: draftId
          KeyType: HASH
      GlobalSecondaryIndexes:
        # "My drafts" is a query, not a scan. The projection deliberately
        # excludes `picks`, which is the whole draft board and would make every
        # list read as expensive as loading the draft itself.
        - IndexName: byOwner
          KeySchema:
            - AttributeName: ownerId
              KeyType: HASH
          Projection:
            ProjectionType: INCLUDE
            NonKeyAttributes:
              - teams
              - rounds
              - format
              - userTeam
              - boardId
              - currentIndex
              - createdAt
```

and `BoardsTable`:

```yaml
      AttributeDefinitions:
        - AttributeName: boardId
          AttributeType: S
        - AttributeName: ownerId
          AttributeType: S
      KeySchema:
        - AttributeName: boardId
          KeyType: HASH
      GlobalSecondaryIndexes:
        - IndexName: byOwner
          KeySchema:
            - AttributeName: ownerId
              KeyType: HASH
          Projection:
            ProjectionType: INCLUDE
            NonKeyAttributes:
              - name
              - format
              - season
              - updatedAt
```

Add the two routes to `MeFunction.Properties.Events`:

```yaml
        MyDrafts:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /me/drafts
            Method: GET
            Auth:
              Authorizer: CognitoAuth
        MyBoards:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /me/boards
            Method: GET
            Auth:
              Authorizer: CognitoAuth
```

- [ ] **Step 2: Write the failing tests**

Add to `backend/src/me.test.js`:

```js
const { QueryCommand } = require("@aws-sdk/lib-dynamodb");

function getEvent(rawPath, claims) {
  return {
    requestContext: {
      http: { method: "GET" },
      ...(claims ? { authorizer: { jwt: { claims } } } : {}),
    },
    rawPath,
  };
}

test("GET /me/drafts without claims is 401", async () => {
  const res = await handler(getEvent("/me/drafts"));
  assert.strictEqual(res.statusCode, 401);
});

test("GET /me/drafts queries the byOwner index for the caller", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return { Items: [] };
  });
  await handler(getEvent("/me/drafts", ME));
  assert.strictEqual(input.IndexName, "byOwner");
  assert.strictEqual(input.ExpressionAttributeValues[":me"], "user-me");
});

test("GET /me/drafts shapes each row for the list", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [
      { draftId: "d1", teams: 12, rounds: 15, format: "ppr", userTeam: 4,
        boardId: null, currentIndex: 3, createdAt: 1000 },
    ],
  }));
  const res = await handler(getEvent("/me/drafts", ME));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), {
    drafts: [
      { id: "d1", teams: 12, rounds: 15, format: "ppr", userTeam: 4,
        boardId: null, completed: false, createdAt: 1000 },
    ],
  });
});

test("a draft whose picks are all made reports completed", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [{ draftId: "d1", teams: 2, rounds: 2, format: "ppr", userTeam: 1,
              currentIndex: 4, createdAt: 1 }],
  }));
  const res = await handler(getEvent("/me/drafts", ME));
  assert.strictEqual(JSON.parse(res.body).drafts[0].completed, true);
});

test("GET /me/boards shapes each row for the list", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [{ boardId: "b1", name: "My PPR Board", format: "ppr", season: 2026, updatedAt: 5 }],
  }));
  const res = await handler(getEvent("/me/boards", ME));
  assert.deepStrictEqual(JSON.parse(res.body), {
    boards: [{ id: "b1", name: "My PPR Board", format: "ppr", season: 2026, updatedAt: 5 }],
  });
});

test("the newest draft comes first", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [
      { draftId: "old", teams: 2, rounds: 1, format: "ppr", userTeam: 1, currentIndex: 0, createdAt: 100 },
      { draftId: "new", teams: 2, rounds: 1, format: "ppr", userTeam: 1, currentIndex: 0, createdAt: 900 },
    ],
  }));
  const res = await handler(getEvent("/me/drafts", ME));
  assert.deepStrictEqual(JSON.parse(res.body).drafts.map((d) => d.id), ["new", "old"]);
});
```

- [ ] **Step 3: Run to see them fail**

Run: `cd backend/src && node --test me.test.js`
Expected: FAIL — every `/me/*` request 404s.

- [ ] **Step 4: Implement the two routes**

In `backend/src/me.js`, add the `QueryCommand` import and this above the handler:

```js
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");

// A page of the index is 1MB; nobody has that many drafts, but paging costs
// four lines and a surprise here would silently truncate somebody's list.
async function queryByOwner(TableName, sub) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName,
        IndexName: "byOwner",
        KeyConditionExpression: "ownerId = :me",
        ExpressionAttributeValues: { ":me": sub },
        ExclusiveStartKey,
      })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const byNewest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
```

and replace the `try` body:

```js
  try {
    if (method === "GET" && path.endsWith("/me/drafts")) {
      const items = await queryByOwner(process.env.DRAFTS_TABLE, sub);
      return json(200, {
        drafts: items.sort(byNewest).map((d) => ({
          id: d.draftId,
          teams: d.teams,
          rounds: d.rounds,
          format: d.format,
          userTeam: d.userTeam,
          boardId: d.boardId ?? null,
          // Derived rather than stored: picks is deliberately not projected
          // onto the index, and teams x rounds is the same number.
          completed: (d.currentIndex ?? 0) >= (d.teams || 0) * (d.rounds || 0),
          createdAt: d.createdAt ?? null,
        })),
      });
    }

    if (method === "GET" && path.endsWith("/me/boards")) {
      const items = await queryByOwner(process.env.BOARDS_TABLE, sub);
      return json(200, {
        boards: items
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .map((b) => ({
            id: b.boardId,
            name: b.name,
            format: b.format,
            season: b.season,
            updatedAt: b.updatedAt ?? null,
          })),
      });
    }

    return json(404, { error: "Not found" });
  } catch (e) {
    return json(500, { error: e.message || "Server error" });
  }
```

- [ ] **Step 5: Pin the listing/access invariant**

Add to `backend/src/drafts.test.js`:

```js
// Listing goes by ownerId; access goes by seats. Those give the same answer
// only while a draft has exactly one human seat. When invitations arrive this
// test fails, which is the intended alarm -- otherwise /me/drafts would
// silently omit drafts you were invited to.
test("a new draft has exactly one human seat, and it is the owner", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    put = cmd.input;
    return {};
  });
  await handler(evt("POST", "/drafts", { body: { teams: 8, rounds: 2 }, claims: ME }));
  const humans = put.Item.seats.filter((s) => s.kind === "human");
  assert.strictEqual(humans.length, 1);
  assert.strictEqual(humans[0].sub, put.Item.ownerId);
});
```

- [ ] **Step 6: Run everything and validate**

Run: `cd backend/src && npm test`
Expected: PASS, all of it, including `template.test.js`.

Run: `cd backend && sam validate --lint`
Expected: valid.

- [ ] **Step 7: Commit**

```bash
git add backend/template.yaml backend/src/me.js backend/src/me.test.js backend/src/drafts.test.js
git commit -m "feat: your drafts and boards come from your account, not this browser"
```

---

### Task 7: RequireAuth

**Files:**
- Create: `frontend/src/components/RequireAuth.jsx`
- Create: `frontend/src/lib/gatedRoutes.test.js`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: `useAuth()` (`configured`, `signedIn`, `loading`, `signIn`).
- Produces: `<RequireAuth>{children}</RequireAuth>`.

- [ ] **Step 1: Write the failing test for the decision**

The component is JSX and this repo has no jsdom, so the *decision* is extracted
as a pure function and tested; the rendering is covered by Playwright in Task 12.

```js
// frontend/src/lib/gatedRoutes.test.js
import test from "node:test";
import assert from "node:assert";
import { gateState } from "./gatedRoutes.js";

test("signed in, the page renders", () => {
  assert.strictEqual(gateState({ configured: true, signedIn: true, loading: false }), "allow");
});

test("signed out, the page is replaced by a prompt", () => {
  assert.strictEqual(gateState({ configured: true, signedIn: false, loading: false }), "prompt");
});

// Without this, a signed-in user sees the sign-in prompt flash on every load
// while oidc-client-ts reads its session out of storage.
test("while auth is still loading, neither is shown", () => {
  assert.strictEqual(gateState({ configured: true, signedIn: false, loading: true }), "wait");
});

// A build with no Cognito variables has no sign-in to offer, so gating would
// leave the app with no way in at all. Same rule as mustSignIn.
test("an unconfigured build is not gated", () => {
  assert.strictEqual(gateState({ configured: false, signedIn: false, loading: false }), "allow");
});

test("missing fields do not throw", () => {
  assert.strictEqual(gateState({}), "allow");
  assert.strictEqual(gateState(undefined), "allow");
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — cannot find `./gatedRoutes.js`

- [ ] **Step 3: Write the decision and the component**

```js
// frontend/src/lib/gatedRoutes.js
/**
 * Should this route render, wait, or ask the visitor to sign in?
 *
 * "wait" exists because AuthProvider resolves the stored session
 * asynchronously: without it a signed-in user sees the sign-in prompt flash on
 * every single page load, which reads as being logged out at random.
 */
export function gateState({ configured, signedIn, loading } = {}) {
  if (!configured) return "allow";
  if (loading) return "wait";
  return signedIn ? "allow" : "prompt";
}
```

```jsx
// frontend/src/components/RequireAuth.jsx
import { useAuth } from "../lib/authContext.js";
import { gateState } from "../lib/gatedRoutes.js";

/**
 * Renders the prompt in place rather than redirecting, so the URL survives.
 * signIn already carries a returnTo, so the visitor lands where they meant to.
 */
export default function RequireAuth({ children }) {
  const { configured, signedIn, loading, signIn } = useAuth();
  const state = gateState({ configured, signedIn, loading });

  if (state === "allow") return children;
  if (state === "wait") {
    return <div className="p-8 text-sm text-zinc-500">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-md py-20 text-center" data-testid="auth-gate">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to continue</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Your drafts and boards are tied to your account, so they follow you to
        any device — and nobody else can open them.
      </p>
      <button
        type="button"
        onClick={signIn}
        data-testid="auth-gate-signin"
        className="mt-6 rounded-2xl bg-gradient-to-r from-cyan-300 to-sky-300 px-5 py-3 font-semibold text-black"
      >
        Sign in with Google
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Wrap the gated routes**

In `frontend/src/App.jsx`, import it and wrap every route except `/`,
`/auth/callback` and `/player/:playerId`:

```jsx
import RequireAuth from "./components/RequireAuth.jsx";
```

```jsx
              <Route path="/" element={<Home />} />
              <Route path="/draft/new" element={<RequireAuth><NewDraft /></RequireAuth>} />
              <Route path="/drafts" element={<RequireAuth><MyDrafts /></RequireAuth>} />
              <Route path="/draft/:draftId" element={<RequireAuth><Draft /></RequireAuth>} />
              <Route path="/draft/:draftId/results" element={<RequireAuth><Results /></RequireAuth>} />
              <Route path="/board/:boardId" element={<RequireAuth><Board /></RequireAuth>} />
              <Route path="/boards" element={<RequireAuth><Boards /></RequireAuth>} />
              <Route path="/player/:playerId" element={<Player />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
```

- [ ] **Step 5: Run and commit**

Run: `cd frontend && npm run lint && npm run test:unit`
Expected: lint clean, tests pass.

```bash
git add frontend/src/lib/gatedRoutes.js frontend/src/lib/gatedRoutes.test.js \
        frontend/src/components/RequireAuth.jsx frontend/src/App.jsx
git commit -m "feat: the app asks you to sign in, in place, rather than redirecting"
```

---

### Task 8: The landing page

**Files:**
- Create: `frontend/src/pages/Landing.jsx`
- Modify: `frontend/src/components/NavBar.jsx`

**Interfaces:**
- Consumes: `useAuth()` for `signIn`.
- Produces: `<Landing />`, the signed-out `/`.

The pitch is the board: *draft off your board, not theirs.* Every claim below
points at something that exists — no invented numbers, testimonials or logos.

- [ ] **Step 1: Write the page**

```jsx
// frontend/src/pages/Landing.jsx
import { useAuth } from "../lib/authContext.js";
import { usePageTitle } from "../lib/usePageTitle";

function Step({ n, title, children }) {
  return (
    <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-6">
      <div className="font-mono text-xs text-cyan-300">{n}</div>
      <div className="mt-2 text-sm font-semibold text-white">{title}</div>
      <p className="mt-1 text-sm text-zinc-400">{children}</p>
    </div>
  );
}

export default function Landing() {
  const { signIn, configured } = useAuth();
  usePageTitle("PerfectPick");

  return (
    <div className="relative min-h-full w-full overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1000px_500px_at_20%_10%,rgba(34,211,238,0.18),transparent_60%),radial-gradient(900px_500px_at_80%_20%,rgba(59,130,246,0.16),transparent_55%)]" />
        <div className="absolute inset-0 opacity-[0.12] [background-image:linear-gradient(to_right,rgba(255,255,255,0.10)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.10)_1px,transparent_1px)] [background-size:64px_64px]" />
      </div>

      <div className="relative mx-auto max-w-5xl px-6 py-20">
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
          Draft off your board,
          <span className="block bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent">
            not theirs.
          </span>
        </h1>

        <p className="mt-6 max-w-xl text-lg text-zinc-300">
          Rank the players your way, then run your league's draft against your
          own board — with the reasons for every pick shown, not hidden.
        </p>

        {configured && (
          <button
            type="button"
            onClick={signIn}
            data-testid="landing-signin"
            className="mt-8 inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-cyan-300 to-sky-300 px-6 py-3 font-semibold text-black shadow-[0_10px_40px_rgba(34,211,238,0.20)]"
          >
            Sign in with Google
          </button>
        )}

        <div className="mt-16 grid gap-4 sm:grid-cols-3">
          <Step n="01" title="Build your board">
            Drag players into the order you actually believe in. Your board is
            yours, on every device you sign in from.
          </Step>
          <Step n="02" title="Draft off it">
            Import your Sleeper league or set it up by hand, then draft from
            your real pick slot against roster-aware auto-picks.
          </Step>
          <Step n="03" title="See where you disagree">
            Every recommendation shows its reasons — the open roster slot, last
            season's finish, the reach against ADP.
          </Step>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Hide the app nav when signed out**

The nav is a hamburger: `LINKS` is mapped inside the `{open && (` block at
`NavBar.jsx:79`, behind the toggle button above it. Signed out, every one of
those links leads straight to a sign-in prompt, so the **toggle and the menu
both** hide — leaving a toggle that opens a menu of identical doors would be
worse than leaving it out.

Extend the existing `useAuth()` destructure to include `signedIn`, and add
below it:

```jsx
  // Signed out, every app link leads to the same sign-in prompt. An
  // unconfigured build has no sign-in to offer, so it keeps its nav -- the
  // same rule mustSignIn already follows.
  const showAppLinks = !configured || signedIn;
```

Then wrap the toggle button and the `{open && (<nav …>)}` block together:

```jsx
      {showAppLinks && (
        <>
          <button
            ref={toggleRef}
            type="button"
            data-testid="nav-toggle"
            aria-label="Menu"
            aria-expanded={open}
            aria-controls="nav-menu"
            onClick={() => setOpen((v) => !v)}
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-lg leading-none text-zinc-200 hover:border-zinc-600"
          >
            ☰
          </button>

          {open && (
            // ... the existing <nav id="nav-menu"> block, unchanged ...
          )}
        </>
      )}
```

- [ ] **Step 3: Verify and commit**

Run: `cd frontend && npm run lint`
Expected: clean.

```bash
git add frontend/src/pages/Landing.jsx frontend/src/components/NavBar.jsx
git commit -m "feat: a landing page that pitches the board, not the simulator"
```

---

### Task 9: The dashboard

**Files:**
- Create: `frontend/src/lib/me.js`
- Create: `frontend/src/pages/Dashboard.jsx`
- Modify: `frontend/src/pages/Home.jsx`

**Interfaces:**
- Consumes: `GET /me/drafts` and `GET /me/boards` from Task 6.
- Produces: `fetchMyDrafts() -> Promise<Array>`, `fetchMyBoards() -> Promise<Array>`.

- [ ] **Step 1: The data module**

```js
// frontend/src/lib/me.js
import { apiGet } from "./api";

/** Your drafts, newest first. The server decides what "yours" means. */
export async function fetchMyDrafts() {
  const data = await apiGet("/me/drafts");
  return Array.isArray(data?.drafts) ? data.drafts : [];
}

export async function fetchMyBoards() {
  const data = await apiGet("/me/boards");
  return Array.isArray(data?.boards) ? data.boards : [];
}
```

- [ ] **Step 2: The dashboard**

```jsx
// frontend/src/pages/Dashboard.jsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchMyDrafts, fetchMyBoards } from "../lib/me";
import { usePageTitle } from "../lib/usePageTitle";

const FORMAT_LABEL = { standard: "Standard", "half-ppr": "Half PPR", ppr: "PPR" };

export default function Dashboard() {
  const [drafts, setDrafts] = useState(null);
  const [boards, setBoards] = useState(null);
  const [err, setErr] = useState("");
  usePageTitle("Home");

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchMyDrafts(), fetchMyBoards()])
      .then(([d, b]) => {
        if (cancelled) return;
        setDrafts(d);
        setBoards(b);
      })
      .catch((e) => {
        if (!cancelled) setErr(e.message || "Could not load your drafts");
      });
    return () => { cancelled = true; };
  }, []);

  const inProgress = (drafts || []).filter((d) => !d.completed);

  return (
    <div className="py-10">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Your drafts</h1>
        <Link
          to="/draft/new"
          data-testid="dashboard-new-draft"
          className="rounded-2xl bg-gradient-to-r from-cyan-300 to-sky-300 px-4 py-2 font-semibold text-black"
        >
          + New draft
        </Link>
      </div>

      {err && <div data-testid="dashboard-error" className="mb-4 text-sm text-rose-300">{err}</div>}

      {drafts === null && !err ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : inProgress.length === 0 ? (
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-8 text-center text-sm text-zinc-500">
          Nothing in progress. Start a draft and pick up where you leave off.
        </div>
      ) : (
        <ul className="space-y-1" data-testid="dashboard-drafts">
          {inProgress.slice(0, 5).map((d) => (
            <li key={d.id}>
              <Link
                to={`/draft/${d.id}`}
                className="block rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-zinc-200 hover:border-zinc-600"
              >
                {FORMAT_LABEL[d.format] || d.format} · {d.teams} teams · {d.rounds} rounds
                <span className="ml-2 text-xs text-zinc-500">Pick {d.userTeam}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-10 mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Your boards</h2>
        <Link to="/boards" className="text-sm text-cyan-300">All boards</Link>
      </div>

      {boards && boards.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2" data-testid="dashboard-boards">
          {boards.slice(0, 4).map((b) => (
            <li key={b.id}>
              <Link
                to={`/board/${b.id}`}
                className="block rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-zinc-200 hover:border-zinc-600"
              >
                {b.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-6 text-center text-sm text-zinc-500">
          No boards yet. <Link to="/boards" className="text-cyan-300">Build one</Link> and draft off it.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: `Home.jsx` becomes the chooser**

Replace the entire contents of `frontend/src/pages/Home.jsx`:

```jsx
import { useAuth } from "../lib/authContext.js";
import Landing from "./Landing.jsx";
import Dashboard from "./Dashboard.jsx";

/**
 * One route, two pages: the pitch for a visitor, your work once you are in.
 * An unconfigured build has no session to read, so it gets the landing page.
 */
export default function Home() {
  const { configured, signedIn } = useAuth();
  return configured && signedIn ? <Dashboard /> : <Landing />;
}
```

- [ ] **Step 4: Verify and commit**

Run: `cd frontend && npm run lint && npm run test:unit`
Expected: clean.

```bash
git add frontend/src/lib/me.js frontend/src/pages/Dashboard.jsx frontend/src/pages/Home.jsx
git commit -m "feat: signed in, home is your drafts and boards"
```

---

### Task 10: The list pages read the account

**Files:**
- Modify: `frontend/src/pages/MyDrafts.jsx`, `frontend/src/pages/Boards.jsx`
- Delete: `frontend/src/lib/draftRegistry.js`, `draftRegistry.test.js`,
  `frontend/src/lib/boardRegistry.js`, `frontend/src/lib/useRememberDraft.js`
- Modify: `frontend/src/pages/Draft.jsx`, `frontend/src/pages/NewDraft.jsx`

**Interfaces:**
- Consumes: `fetchMyDrafts`, `fetchMyBoards` from Task 9.
- Produces: no `localStorage` registry anywhere.

- [ ] **Step 1: Delete the registries and their callers**

```bash
git rm frontend/src/lib/draftRegistry.js frontend/src/lib/draftRegistry.test.js \
       frontend/src/lib/boardRegistry.js frontend/src/lib/useRememberDraft.js
```

In `frontend/src/pages/Draft.jsx`, remove the `useRememberDraft` import and its
call. In `frontend/src/pages/NewDraft.jsx`, remove the `rememberDraft` import
and the whole `rememberDraft({...})` call in `createDraft` — the server records
the draft the moment it is created, which is what the registry was imitating.

- [ ] **Step 2: `MyDrafts.jsx` reads the server**

Replace its data source. Remove the `listDrafts` / `forgetDraft` / `listBoards`
imports and the `forget` handler and its button entirely — "Forget" removed a
draft from a browser-local list that no longer exists. Then:

```jsx
import { fetchMyDrafts, fetchMyBoards } from "../lib/me";
```

```jsx
  const [drafts, setDrafts] = useState(null);
  const [boards, setBoards] = useState([]);

  const load = useCallback(() => {
    Promise.all([fetchMyDrafts(), fetchMyBoards()])
      .then(([d, b]) => { setDrafts(d); setBoards(b); })
      .catch((e) => setErr(e.message || "Could not load your drafts"));
  }, []);

  useEffect(() => { load(); }, [load]);
```

Render `Loading…` while `drafts === null`. The delete handler keeps its
`e.status === 404` branch but calls `load()` instead of the registry:

```jsx
    } catch (e) {
      if (e.status === 404) { load(); return; }
      setErr(e.message || "Failed to delete draft");
    }
```

and on success it also calls `load()`. The `d.owned` condition on the Delete
button goes away — every draft the server returns is one you own.

- [ ] **Step 3: `Boards.jsx` reads the server**

Replace the `boardRegistry` import with the server one:

```jsx
import { fetchMyBoards } from "../lib/me";
```

Replace the state initialiser — `useState(() => listBoards())` becomes a null
sentinel so the page can tell "still loading" from "you have none" — and add a
loader:

```jsx
  const [boards, setBoards] = useState(null);

  const load = useCallback(() => {
    fetchMyBoards()
      .then(setBoards)
      .catch((e) => setErr(e.message || "Could not load your boards"));
  }, []);

  useEffect(() => { load(); }, [load]);
```

(`useCallback` and `useEffect` join the existing `useState` import from React.)

In `createBoard`, replace `rememberBoard({ id: boardId, name, format });` and
the `setBoards(listBoards())` beneath it with nothing — the navigation to
`/board/${boardId}` leaves the page anyway, and the server already has it.

In `deleteBoard`, replace both `forgetBoard(b.id); setBoards(listBoards());`
pairs — the success path and the `e.status === 404` branch — with `load();`.

Render a loading state, since `boards` now starts null:

```jsx
      {boards === null ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : boards.length === 0 ? (
```

leaving the existing empty-state and list branches after it.

- [ ] **Step 4: Verify and commit**

Run: `cd frontend && npm run lint && npm run test:unit`
Expected: clean; the unit count drops by `draftRegistry.test.js`'s tests.

```bash
git add -A frontend/src
git commit -m "refactor: the lists come from your account, not this browser"
```

---

### Task 11: The end-to-end suite

**Files:**
- Modify: every spec under `frontend/tests/` that opens an app page
- Create: `frontend/tests/landing.spec.js`
- Modify: `frontend/tests/fixtures.js`

**Interfaces:**
- Consumes: `signIn` from `frontend/tests/auth.js`.

Almost every spec navigates to `/draft/:id` or `/boards` while signed out, and
that is no longer reachable. This is the same churn as the Phase 2 pass, wider.

- [ ] **Step 1: Add `signIn` wherever a spec opens a gated page**

For every spec file under `frontend/tests/` except `player.spec.js` and
`home.spec.js`, add `import { signIn } from "./auth.js";` and
`await signIn(page);` before the first `page.goto` of each test that opens
`/draft/*`, `/drafts`, `/board/*` or `/boards`. `signIn` uses `addInitScript`,
so it must precede the navigation.

Read each test before changing it. If a test's purpose was to assert
signed-out behaviour, that purpose has changed — rewrite it to assert the gate
rather than converting it silently, and say so in the report.

- [ ] **Step 2: Mock the two new list routes in fixtures**

Any signed-in page load of `/` now calls `/me/drafts` and `/me/boards`. Add to
`frontend/tests/auth.js`'s `signIn`, beside the existing routes:

```js
  await page.route("**/me/drafts", (route) => route.fulfill({ json: { drafts: [] } }));
  await page.route("**/me/boards", (route) => route.fulfill({ json: { boards: [] } }));
```

A spec that cares about list contents registers its own handler after calling
`signIn`; Playwright's last-registered route wins.

- [ ] **Step 3: New specs for the front door**

```js
// frontend/tests/landing.spec.js
import { test, expect } from "@playwright/test";
import { signIn } from "./auth.js";
import { DRAFT_ID } from "./fixtures.js";

test.describe("signed out", () => {
  test("the landing page pitches the board", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Draft off your board/i })).toBeVisible();
    await expect(page.getByTestId("landing-signin")).toBeVisible();
  });

  test("the app nav is not offered", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "My Drafts" })).toHaveCount(0);
  });

  test("a gated url prompts in place and keeps the url", async ({ page }) => {
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("auth-gate")).toBeVisible();
    expect(page.url()).toContain(`/draft/${DRAFT_ID}`);
  });

  test("a player page is still public", async ({ page }) => {
    await page.route("**/players/p1", (r) =>
      r.fulfill({ json: { id: "p1", name: "Christian McCaffrey", position: "RB", team: "SF" } })
    );
    await page.goto("/player/p1");
    await expect(page.getByTestId("auth-gate")).toHaveCount(0);
  });
});

test.describe("signed in", () => {
  test("home is the dashboard, from the server", async ({ page }) => {
    await signIn(page);
    await page.route("**/me/drafts", (r) =>
      r.fulfill({ json: { drafts: [
        { id: "d1", teams: 12, rounds: 15, format: "ppr", userTeam: 4, boardId: null, completed: false, createdAt: 2 },
      ] } })
    );
    await page.goto("/");
    await expect(page.getByTestId("dashboard-drafts")).toContainText("12 teams");
  });

  // The point of cross-device history: the list is the account's, not this
  // browser's. Nothing is seeded into localStorage here.
  test("the dashboard shows drafts this browser never made", async ({ page }) => {
    await signIn(page);
    await page.route("**/me/boards", (r) =>
      r.fulfill({ json: { boards: [{ id: "b9", name: "Board From My Phone", format: "ppr", season: 2026, updatedAt: 1 }] } })
    );
    await page.goto("/");
    await expect(page.getByTestId("dashboard-boards")).toContainText("Board From My Phone");
  });
});
```

- [ ] **Step 4: Run the suite until green**

Run: `cd frontend && npm test`
Expected: all passing. Run it in the foreground; it takes about four minutes.

- [ ] **Step 5: Screenshots**

`home.png` is now the landing page and every other screenshot is taken signed
in. Confirm the regenerated set looks right — open `home.png` and `drafts.png`
at minimum — then include `screenshots/` in the commit.

- [ ] **Step 6: Commit**

```bash
git add frontend/tests screenshots
git commit -m "test: the suite signs in, and the landing page has its own spec"
```

---

### Task 12: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the opening and the feature list**

The README opens by calling PerfectPick "a modern, serverless fantasy football
mock draft simulator". Lead with the board instead, matching the landing page:
rank players your way, draft off your own board, see the reasons behind every
pick. Add sign-in to the feature list and say plainly that drafts and boards are
private to the people in them.

- [ ] **Step 2: Correct what is now false**

Search for and fix: any statement that a draft link can be shared with someone
who is not in the draft; any mention of `POST /me/claim` or of claiming
pre-account drafts (the whole "What happens to drafts and boards made before
accounts existed" section goes — those rows are deleted by Task 4's script);
and the screenshot captions if the images changed.

Add a line to the deploy section noting that `backend/scripts/purge-unowned.js`
runs once, before the read gate is deployed.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: the board is the pitch, and drafts are private"
```

---

## Final Verification

- [ ] `cd backend/src && npm test` — all backend tests.
- [ ] `cd backend && sam validate --lint`.
- [ ] `cd frontend && npm run lint && npm run test:unit`.
- [ ] `cd frontend && npm test` — the full Playwright suite.
- [ ] `git status --short` — clean.

**Deploy order, and it matters:**

1. `cd backend && node scripts/purge-unowned.js` — dry run, read the counts.
2. `node scripts/purge-unowned.js --confirm` — dump and delete. **Before** the
   read gate ships; afterwards those rows are unreachable.
3. `sam deploy --parameter-overrides GoogleClientId=... GoogleClientSecret=$(aws ssm get-parameter --name /perfectpick/google-client-secret --with-decryption --query Parameter.Value --output text)`
   — the GSI backfills asynchronously; `/me/drafts` may return an incomplete
   list for a minute or two on a large table, which this one is not.
4. `cd frontend && npm run deploy`.
5. Sign in, confirm the dashboard lists your drafts, and confirm a signed-out
   private window sees the landing page at `/` and the gate on a draft URL.
