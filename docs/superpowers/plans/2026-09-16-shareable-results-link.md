# Shareable Results Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner of a finished mock draft share a read-only link that works for someone with no account.

**Architecture:** A new public `GET /drafts/{draftId}/shared?t=` returning a five-field projection built from what the results page actually reads. Two authenticated owner-only routes mint and revoke a `shareToken` that is deliberately separate from `inviteToken`. A public frontend route renders the shared view outside `RequireAuth`.

**Tech Stack:** Node 24 CommonJS Lambda behind API Gateway HttpApi, DynamoDB, `node --test`; React 19 + Vite frontend, Playwright e2e.

## Global Constraints

From `docs/superpowers/specs/2026-09-16-shareable-results-link-design.md`.

- **This is the app's first anonymous read path.** Treat every decision in it as security-relevant.
- **Never reuse `GET /drafts/{draftId}`.** Its projection contains `inviteToken` — the credential `/join` checks to grant a seat — plus `pausedBy` (a Cognito sub) and three caller-derived fields. A share link exposing it turns read-only into participant.
- **`shareToken` is a separate field from `inviteToken`.** One grants reading, the other grants joining.
- **The shared projection is exactly five fields:** `format`, `teams`, `rounds`, `rosterSlots`, `picks`. Built up from what the page reads, never subtracted down from the authenticated response.
- **All four failure cases return 404 with the same body:** no such draft; draft never shared; wrong token; revoked token. A 403 on a real-but-wrong token confirms the draft exists.
- **Both mutations are owner-only** via the existing `canMutate(item, sub)` from `backend/src/lib/owner.js`, and **refuse a draft that is not `completed`**.
- The token is `randomUUID()`, the generator `inviteToken` already uses.
- Backend tests: `cd backend/src && npm test`. Baseline **486 pass / 0 fail**.
- Frontend unit: `cd frontend && npm run test:unit` (**NOT** `npm test`, which is Playwright). Baseline **286 pass / 0 fail**.
- Frontend e2e: `cd frontend && npm test`. Baseline **335 passed**, total 335.

## Stop and ask

- Any 404 test passes before the route exists for a reason you cannot identify — a router catch-all will make a wrong implementation look right, and this project has already shipped a test that passed that way.
- The field-set assertion forces you to add a sixth field to the shared projection. That is a spec change, not an implementation detail.

Do **not** stop merely because an existing test needs editing: Task 1 and Task 2 both add routes, and `backend/src/template.test.js` asserts the *exact* sets of public, gated and mutating routes with `deepStrictEqual`. Those lists must be edited deliberately in the same task. Say in your report which you changed.

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/drafts.js` | modify. Three new route clauses. |
| `backend/src/drafts.test.js` | modify. The 404 matrix, the field-set assertion, owner and completed guards. |
| `backend/template.yaml` | modify. Three HttpApi events — one public, two gated. |
| `backend/src/template.test.js` | modify. `PUBLIC_READS` and the mutating-route list. |
| `frontend/src/pages/SharedResults.jsx` | **new.** The public view. |
| `frontend/src/App.jsx` | modify. One route, outside `RequireAuth`. |
| `frontend/src/pages/Results.jsx` | modify. The Share/Revoke control. |
| `frontend/src/lib/api.js` | unchanged — `apiGet` already omits the header when there is no token. |
| `frontend/tests/shared.spec.js` | **new.** |

---

### Task 1: The anonymous read endpoint

**Files:**
- Modify: `backend/src/drafts.js`
- Modify: `backend/src/drafts.test.js`
- Modify: `backend/template.yaml`
- Modify: `backend/src/template.test.js`

**Interfaces:**
- Produces: `GET /drafts/{draftId}/shared?t=<token>` returning `{format, teams, rounds, rosterSlots, picks}` or 404.

**THE ROUTING HAZARD — read this before writing code.** `drafts.js` already has:

```js
if (method === "GET" && draftId) {          // GET /drafts/{draftId}
```

API Gateway sets `pathParameters.draftId` for `/drafts/{draftId}/shared` too, so that clause **also matches the shared path**. If your new clause is placed after it, a shared request falls into the authenticated handler and returns the full projection — `inviteToken` included. **The `/shared` clause must come before it.** A test below pins this.

- [ ] **Step 1: Extend the test event helper to carry a query string**

`backend/src/drafts.test.js` defines `evt(method, path, { draftId, body, claims })`. It has no query support. Add it:

```js
function evt(method, path, { draftId, body, claims, query } = {}) {
  return {
    requestContext: {
      http: { method },
      ...(claims ? { authorizer: { jwt: { claims } } } : {}),
    },
    rawPath: path,
    pathParameters: draftId ? { draftId } : undefined,
    queryStringParameters: query,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
```

- [ ] **Step 2: Write the failing tests**

Append to `backend/src/drafts.test.js`. Note each 404 is its own test — a single test with four assertions passes against an implementation that 404s for one reason and leaks for another.

```js
const SHARED = "/drafts/d1/shared";

function sharedDraft(extra = {}) {
  return {
    draftId: "d1",
    completed: true,
    shareToken: "share-abc",
    inviteToken: "invite-xyz",
    pausedBy: "cognito-sub-of-someone",
    ownerSub: "alice",
    format: "ppr",
    teams: 12,
    rounds: 15,
    rosterSlots: ["QB", "RB", "RB", "WR", "WR", "TE", "K", "DEF"],
    picks: [{ overall: 1, round: 1, team: 1, playerId: "p1", player: { id: "p1", name: "A", position: "RB" } }],
    seats: [{ team: 1, sub: "alice", kind: "human" }],
    ...extra,
  };
}

test("shared results: a draft that does not exist is 404", async () => {
  stubSend({ Item: undefined });
  const res = await handler(evt("GET", SHARED, { draftId: "d1", query: { t: "share-abc" } }));
  assert.strictEqual(res.statusCode, 404);
});

test("shared results: a draft that was never shared is 404", async () => {
  stubSend({ Item: sharedDraft({ shareToken: undefined }) });
  const res = await handler(evt("GET", SHARED, { draftId: "d1", query: { t: "share-abc" } }));
  assert.strictEqual(res.statusCode, 404);
});

test("shared results: the wrong token is 404, not 403", async () => {
  // 403 would confirm the draft exists. Guessing an id must learn nothing.
  stubSend({ Item: sharedDraft() });
  const res = await handler(evt("GET", SHARED, { draftId: "d1", query: { t: "not-the-token" } }));
  assert.strictEqual(res.statusCode, 404);
});

test("shared results: no token at all is 404", async () => {
  stubSend({ Item: sharedDraft() });
  const res = await handler(evt("GET", SHARED, { draftId: "d1" }));
  assert.strictEqual(res.statusCode, 404);
});

test("shared results: the right token returns the results", async () => {
  stubSend({ Item: sharedDraft() });
  const res = await handler(evt("GET", SHARED, { draftId: "d1", query: { t: "share-abc" } }));
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.teams, 12);
  assert.strictEqual(body.picks.length, 1);
});

test("shared results: the payload is EXACTLY the five fields, and nothing else", async () => {
  // A field-set assertion, not a spot check. Checking `!body.inviteToken`
  // confirms today's known leak is absent; this fails when somebody adds a
  // sixth field next year, which is the leak nobody is looking for.
  stubSend({ Item: sharedDraft() });
  const res = await handler(evt("GET", SHARED, { draftId: "d1", query: { t: "share-abc" } }));
  const keys = Object.keys(JSON.parse(res.body)).sort();
  assert.deepStrictEqual(keys, ["format", "picks", "rosterSlots", "rounds", "teams"]);
});

test("shared results: the shared path never falls through to the authenticated handler", async () => {
  // GET /drafts/{draftId} matches `method === "GET" && draftId`, and
  // pathParameters.draftId is set for /drafts/{id}/shared too. If the shared
  // clause is ordered after it, this returns the FULL projection --
  // inviteToken included -- to an anonymous caller.
  stubSend({ Item: sharedDraft() });
  const res = await handler(evt("GET", SHARED, { draftId: "d1", query: { t: "share-abc" } }));
  const body = JSON.parse(res.body);
  assert.strictEqual(body.inviteToken, undefined, "an anonymous caller must never receive the invite token");
  assert.strictEqual(body.seats, undefined);
  assert.strictEqual(body.pausedBy, undefined);
});
```

- [ ] **Step 3: Run them and watch them fail for the right reason**

```bash
cd backend/src && npm test
```

Expected: the four 404 tests may PASS already (no route exists, so the handler falls through to its catch-all 404) and the three others FAIL.

**That is the trap this project has hit before.** A 404 test that passes via a catch-all proves nothing about the clause it names. For each of the four, confirm *after* implementing that it still passes, then mutate the specific condition it targets (e.g. change `d.shareToken !== token` to `false`) and confirm that test — and only that test — goes red. Record each mutation in your report.

- [ ] **Step 4: Implement the route**

In `backend/src/drafts.js`, add this **before** the existing `if (method === "GET" && draftId) {` clause:

```js
    // GET /drafts/{draftId}/shared?t=<token>  -- PUBLIC, no authorizer.
    //
    // MUST be ordered before `GET /drafts/{draftId}`: pathParameters.draftId is
    // set for this path too, so that clause would otherwise match and hand an
    // anonymous caller the full projection, inviteToken included.
    //
    // The projection below is built UP from what the results page reads, never
    // subtracted down from the authenticated one -- subtraction is how the next
    // field added upstream leaks.
    if (method === "GET" && draftId && path.endsWith("/shared")) {
      const token = (event.queryStringParameters || {}).t;
      const res = await ddb.send(
        new GetCommand({ TableName: draftsTable, Key: { draftId } })
      );
      const d = res.Item;
      // Four ways to be wrong, one answer: no draft, never shared, no token,
      // wrong token. A 403 on a real-but-wrong token would confirm the draft
      // exists, which is exactly what /join's comment refuses to do.
      if (!d || !d.shareToken || !token || d.shareToken !== token) return notFound();

      return json(200, {
        format: d.format || "standard",
        teams: d.teams,
        rounds: d.rounds,
        rosterSlots: d.rosterSlots?.length ? d.rosterSlots : DEFAULT_ROSTER,
        picks: d.picks || [],
      });
    }
```

- [ ] **Step 5: Declare the route in the template**

In `backend/template.yaml`, in the drafts function's `Events:`, add — **with no `Auth:` block**, which is what makes it public:

```yaml
        SharedResults:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /drafts/{draftId}/shared
            Method: GET
```

- [ ] **Step 6: Update the public-route list, deliberately**

`backend/src/template.test.js` asserts the exact set of public reads:

```js
const PUBLIC_READS = ["GET /players", "GET /players/{playerId}"];
```

Change it to:

```js
// GET /drafts/{draftId}/shared is the app's first anonymous read path. It is
// public on purpose and gated by an unguessable token rather than by the
// authorizer; the payload is five fields with nothing caller-derived in it.
const PUBLIC_READS = [
  "GET /drafts/{draftId}/shared",
  "GET /players",
  "GET /players/{playerId}",
];
```

- [ ] **Step 7: Run the backend suite**

```bash
cd backend/src && npm test
```

Expected: PASS, 493 tests (486 + 7 new), 0 fail.

- [ ] **Step 8: Mutation-check the four 404s**

For each, make the change, run, confirm the named test goes red and is the only one, then restore **by hand** (never `git checkout`):

| mutation in the new clause | must redden |
|---|---|
| drop `!d.shareToken` | "a draft that was never shared is 404" |
| change `d.shareToken !== token` to `false` | "the wrong token is 404, not 403" |
| drop `!token` | "no token at all is 404" |
| move the whole clause *after* `GET /drafts/{draftId}` | "never falls through to the authenticated handler" |

- [ ] **Step 9: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js backend/template.yaml backend/src/template.test.js
git commit -m "feat: a public, token-gated read of a finished draft's results"
```

---

### Task 2: Mint and revoke the share token

**Files:**
- Modify: `backend/src/drafts.js`
- Modify: `backend/src/drafts.test.js`
- Modify: `backend/template.yaml`
- Modify: `backend/src/template.test.js`

**Interfaces:**
- Consumes: the `shareToken` field Task 1 reads.
- Produces: `POST /drafts/{draftId}/share` → `{ shareToken }`; `DELETE /drafts/{draftId}/share` → `{ ok: true }`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/drafts.test.js`. Reuse the `sharedDraft()` helper from Task 1.

```js
const SHARE = "/drafts/d1/share";

test("share: only the owner can mint a token", async () => {
  stubSend({ Item: sharedDraft({ ownerSub: "alice" }) });
  const res = await handler(
    evt("POST", SHARE, { draftId: "d1", claims: { sub: "mallory" } })
  );
  // 404, not 403 -- same rule as delete: a non-owner learns nothing.
  assert.strictEqual(res.statusCode, 404);
});

test("share: an unfinished draft cannot be shared", async () => {
  stubSend({ Item: sharedDraft({ completed: false, shareToken: undefined }) });
  const res = await handler(
    evt("POST", SHARE, { draftId: "d1", claims: { sub: "alice" } })
  );
  assert.strictEqual(res.statusCode, 409);
});

test("share: minting twice returns the SAME token, it does not rotate", async () => {
  // A second click must not silently break a link already sent.
  stubSend({ Item: sharedDraft({ shareToken: "already-minted" }) });
  const res = await handler(
    evt("POST", SHARE, { draftId: "d1", claims: { sub: "alice" } })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).shareToken, "already-minted");
});

test("share: an anonymous caller cannot mint", async () => {
  stubSend({ Item: sharedDraft() });
  const res = await handler(evt("POST", SHARE, { draftId: "d1" }));
  assert.strictEqual(res.statusCode, 401);
});

test("revoke: only the owner can revoke", async () => {
  stubSend({ Item: sharedDraft({ ownerSub: "alice" }) });
  const res = await handler(
    evt("DELETE", SHARE, { draftId: "d1", claims: { sub: "mallory" } })
  );
  assert.strictEqual(res.statusCode, 404);
});

test("revoke: the owner removes the token", async () => {
  stubSend({ Item: sharedDraft({ ownerSub: "alice" }) });
  const res = await handler(
    evt("DELETE", SHARE, { draftId: "d1", claims: { sub: "alice" } })
  );
  assert.strictEqual(res.statusCode, 200);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend/src && npm test
```

Expected: FAIL. The catch-all will 404 the POSTs, so "only the owner can mint" and both revoke-404 cases may pass spuriously — the same trap as Task 1. The minting and 409 tests must fail.

- [ ] **Step 3: Implement both routes**

In `backend/src/drafts.js`, add near the other `/drafts/{draftId}/…` mutations (after the `/seat-board` clause is a good home, since it is the nearest owner-ish write):

```js
    // POST /drafts/{draftId}/share  -- mint a read-only share token.
    // DELETE /drafts/{draftId}/share -- revoke it.
    //
    // shareToken is deliberately NOT inviteToken. One grants reading a finished
    // draft; the other grants a SEAT. Reusing inviteToken here would turn every
    // share link into an invitation to join.
    if (draftId && path.endsWith("/share") && (method === "POST" || method === "DELETE")) {
      if (!sub) return needsAuth();

      const res = await ddb.send(
        new GetCommand({ TableName: draftsTable, Key: { draftId } })
      );
      const d = res.Item;
      // Not the owner reads the same as not there, matching DELETE /drafts.
      if (!d || !canMutate(d, sub)) return notFound();
      if (d.completed !== true) {
        return json(409, { error: "Only a finished draft can be shared" });
      }

      if (method === "DELETE") {
        await ddb.send(
          new UpdateCommand({
            TableName: draftsTable,
            Key: { draftId },
            UpdateExpression: "REMOVE shareToken",
          })
        );
        return json(200, { ok: true });
      }

      // Idempotent: a second click returns the token already in play rather
      // than rotating it and breaking a link that has been sent.
      const shareToken = d.shareToken || randomUUID();
      if (!d.shareToken) {
        await ddb.send(
          new UpdateCommand({
            TableName: draftsTable,
            Key: { draftId },
            UpdateExpression: "SET shareToken = :t",
            ExpressionAttributeValues: { ":t": shareToken },
          })
        );
      }
      return json(200, { shareToken });
    }
```

Confirm `UpdateCommand` and `canMutate` are already imported at the top of the file; add them to the existing imports if not.

- [ ] **Step 4: Declare both routes in the template**

In `backend/template.yaml`, beside `SharedResults`, **with** the authorizer this time:

```yaml
        ShareDraft:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /drafts/{draftId}/share
            Method: POST
            Auth:
              Authorizer: CognitoAuth
        UnshareDraft:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /drafts/{draftId}/share
            Method: DELETE
            Auth:
              Authorizer: CognitoAuth
```

- [ ] **Step 5: Update the mutating-route list**

`backend/src/template.test.js`'s "the expected mutating routes are all present" asserts an exact sorted list. Add, in sorted position:

```js
    "DELETE /drafts/{draftId}/share",
    ...
    "POST /drafts/{draftId}/share",
```

- [ ] **Step 6: Run the backend suite**

```bash
cd backend/src && npm test
```

Expected: PASS, 499 tests, 0 fail.

- [ ] **Step 7: Mutation-check the guards**

Restore by hand after each; never `git checkout`.

| mutation | must redden |
|---|---|
| drop `!canMutate(d, sub)` | "only the owner can mint" and "only the owner can revoke" |
| drop the `completed !== true` check | "an unfinished draft cannot be shared" |
| change `d.shareToken \|\| randomUUID()` to always `randomUUID()` | "minting twice returns the SAME token" |
| drop `if (!sub) return needsAuth()` | "an anonymous caller cannot mint" |

- [ ] **Step 8: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js backend/template.yaml backend/src/template.test.js
git commit -m "feat: mint and revoke a share token, owner-only, finished drafts only"
```

---

### Task 3: The public shared view

**Files:**
- Create: `frontend/src/pages/SharedResults.jsx`
- Modify: `frontend/src/App.jsx`
- Create: `frontend/tests/shared.spec.js`

**Interfaces:**
- Consumes: `GET /drafts/{draftId}/shared?t=<token>` from Task 1, returning `{format, teams, rounds, rosterSlots, picks}`.
- Produces: the route `/shared/:draftId`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/shared.spec.js`:

```js
import { test, expect } from "@playwright/test";

const API = "**/drafts/*/shared*";

const SHARED_BODY = {
  format: "ppr",
  teams: 2,
  rounds: 2,
  rosterSlots: ["QB", "RB"],
  picks: [
    { overall: 1, round: 1, team: 1, playerId: "p1", player: { id: "p1", name: "Ja'Marr Chase", position: "WR", team: "CIN" } },
    { overall: 2, round: 1, team: 2, playerId: "p2", player: { id: "p2", name: "Bijan Robinson", position: "RB", team: "ATL" } },
  ],
};

test("a signed-out visitor can read a shared result", async ({ page }) => {
  await page.route(API, (r) => r.fulfill({ json: SHARED_BODY }));
  await page.goto("/shared/d1?t=share-abc");

  await expect(page.getByText("Ja'Marr Chase")).toBeVisible();
  await expect(page.getByText("Bijan Robinson")).toBeVisible();
});

test("the shared view sends no Authorization header", async ({ page }) => {
  let auth = "unset";
  await page.route(API, (r) => {
    auth = r.request().headers()["authorization"] ?? null;
    return r.fulfill({ json: SHARED_BODY });
  });
  await page.goto("/shared/d1?t=share-abc");
  await expect(page.getByText("Ja'Marr Chase")).toBeVisible();

  expect(auth, "an anonymous read must not carry a bearer token").toBeNull();
});

test("a bad token shows a plain not-found, not a crash or a sign-in wall", async ({ page }) => {
  await page.route(API, (r) => r.fulfill({ status: 404, json: { error: "Not found" } }));
  await page.goto("/shared/d1?t=wrong");

  await expect(page.getByTestId("shared-missing")).toBeVisible();
  // It must not bounce to sign-in: the whole point is that a stranger can open it.
  await expect(page).toHaveURL(/\/shared\/d1/);
});

test("the shared view offers nothing that implies participation", async ({ page }) => {
  await page.route(API, (r) => r.fulfill({ json: SHARED_BODY }));
  await page.goto("/shared/d1?t=share-abc");
  await expect(page.getByText("Ja'Marr Chase")).toBeVisible();

  await expect(page.getByRole("button", { name: /copy invite/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /export|download/i })).toHaveCount(0);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx playwright test shared.spec.js --reporter=line
```

Expected: FAIL — the route does not exist, so React Router renders nothing matching and the text is absent.

- [ ] **Step 3: Write the page**

Create `frontend/src/pages/SharedResults.jsx`. Read `frontend/src/pages/Results.jsx` first and mirror how it renders picks — this page shows the same information with none of the owner controls.

```jsx
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * A finished draft, shown to someone who may have no account at all.
 *
 * This is the app's only anonymous read. It calls /drafts/:id/shared, which
 * returns five fields and nothing caller-derived -- deliberately NOT
 * /drafts/:id, whose projection carries inviteToken and would let a reader
 * join the draft.
 *
 * Every failure looks the same on purpose: a wrong token, a revoked token and
 * a draft that never existed all arrive here as a 404, because distinguishing
 * them would tell a stranger which draft ids are real.
 */
export default function SharedResults() {
  const { draftId } = useParams();
  const [params] = useSearchParams();
  const token = params.get("t") || "";
  const [draft, setDraft] = useState(null);
  const [missing, setMissing] = useState(false);
  usePageTitle("Draft results");

  useEffect(() => {
    let live = true;
    apiGet(`/drafts/${draftId}/shared?t=${encodeURIComponent(token)}`)
      .then((d) => live && setDraft(d))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [draftId, token]);

  if (missing) {
    return (
      <div data-testid="shared-missing" className="mx-auto max-w-lg p-8 text-center">
        <h1 className="text-xl font-semibold">This link is not available</h1>
        <p className="mt-2 text-sm text-zinc-400">
          It may have been turned off by whoever shared it, or it may never have
          existed.
        </p>
      </div>
    );
  }

  if (!draft) return <div className="p-8 text-sm text-zinc-400">Loading…</div>;

  const made = (draft.picks || []).filter((p) => p.player);

  return (
    <div data-testid="shared-results" className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">Draft results</h1>
      <p className="mt-1 text-sm text-zinc-400">
        {draft.teams} teams · {draft.rounds} rounds · {draft.format}
      </p>
      <ol className="mt-6 space-y-2">
        {made.map((p) => (
          <li
            key={p.overall}
            className="flex items-baseline gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/60 px-3 py-2"
          >
            <span className="w-14 shrink-0 tabular-nums text-xs text-zinc-500">
              {p.round}.{String(p.overall).padStart(2, "0")}
            </span>
            <span className="w-16 shrink-0 text-xs text-zinc-500">Team {p.team}</span>
            <span className="font-medium">{p.player.name}</span>
            <span className="text-xs text-zinc-400">
              {p.player.position}
              {p.player.team ? ` · ${p.player.team}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
```

- [ ] **Step 4: Register the route OUTSIDE RequireAuth**

In `frontend/src/App.jsx`, add the import and place the route beside the other unauthenticated ones (`/privacy`, `/terms`), **not** among the `RequireAuth`-wrapped block:

```jsx
import SharedResults from "./pages/SharedResults.jsx";
```

```jsx
              <Route path="/shared/:draftId" element={<SharedResults />} />
```

- [ ] **Step 5: Run the tests**

```bash
cd frontend && npx playwright test shared.spec.js --reporter=line
```

Expected: 4 passed.

- [ ] **Step 6: Lint and build**

```bash
cd frontend && npm run lint && npx vite build
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/SharedResults.jsx frontend/src/App.jsx frontend/tests/shared.spec.js
git commit -m "feat: a shared results page a signed-out visitor can read"
```

---

### Task 4: The Share control

**Files:**
- Modify: `frontend/src/pages/Results.jsx`
- Modify: `frontend/tests/shared.spec.js`

**Interfaces:**
- Consumes: `POST /drafts/{draftId}/share` → `{ shareToken }` and `DELETE /drafts/{draftId}/share` from Task 2; the `/shared/:draftId` route from Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/shared.spec.js`. Read the top of `frontend/tests/results.spec.js` first and reuse its existing sign-in and draft-mocking helpers rather than inventing new ones.

```js
test("the owner of a finished draft can create and copy a share link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/drafts/*/share", (r) =>
    r.fulfill({ json: { shareToken: "share-abc" } })
  );
  // Sign in and open a COMPLETED draft's results -- reuse results.spec.js's
  // helpers for both.
  await openCompletedResults(page);

  await page.getByRole("button", { name: /share/i }).click();
  const link = await page.getByTestId("share-link").inputValue();
  expect(link).toContain("/shared/");
  expect(link).toContain("t=share-abc");
});

test("revoking removes the link from the page", async ({ page }) => {
  await page.route("**/drafts/*/share", (r) =>
    r.request().method() === "DELETE"
      ? r.fulfill({ json: { ok: true } })
      : r.fulfill({ json: { shareToken: "share-abc" } })
  );
  await openCompletedResults(page);

  await page.getByRole("button", { name: /share/i }).click();
  await expect(page.getByTestId("share-link")).toBeVisible();

  await page.getByRole("button", { name: /revoke/i }).click();
  await expect(page.getByTestId("share-link")).toHaveCount(0);
});
```

`openCompletedResults` is not a helper you have to invent — `results.spec.js` builds this state from shared fixtures, and so does this. Put it at the top of `shared.spec.js`:

```js
import { DRAFT_ID, makeCompletedDraft } from "./fixtures.js";
import { signIn } from "./auth.js";

const API = "http://localhost:9999";

async function openCompletedResults(page) {
  await page.route(`${API}/drafts/${DRAFT_ID}`, (r) =>
    r.fulfill({ json: makeCompletedDraft() })
  );
  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}/results`);
}
```

Use `DRAFT_ID` in the share-route globs too, rather than `*`, so these tests cannot accidentally intercept a different draft's request.

- [ ] **Step 2: Run to verify they fail**

```bash
cd frontend && npx playwright test shared.spec.js --reporter=line
```

Expected: FAIL — no Share button exists.

- [ ] **Step 3: Add the control to the results page**

In `frontend/src/pages/Results.jsx`, add state and two handlers, and render the control **only when the draft is completed**. Match the file's existing button styling rather than inventing new classes.

```jsx
const [shareUrl, setShareUrl] = useState(null);

async function makeShareLink() {
  const { shareToken } = await apiPost(`/drafts/${draftId}/share`, {});
  setShareUrl(`${window.location.origin}/shared/${draftId}?t=${encodeURIComponent(shareToken)}`);
}

async function revokeShareLink() {
  await apiDelete(`/drafts/${draftId}/share`);
  setShareUrl(null);
}
```

```jsx
{draft?.completed && (
  <div className="flex items-center gap-2">
    {shareUrl ? (
      <>
        <input
          data-testid="share-link"
          readOnly
          value={shareUrl}
          className="w-72 rounded-xl border border-zinc-800 bg-zinc-950/70 px-2 py-1 text-xs"
          onFocus={(e) => e.target.select()}
        />
        <button type="button" onClick={() => navigator.clipboard.writeText(shareUrl)}>
          Copy
        </button>
        <button type="button" onClick={revokeShareLink}>
          Revoke
        </button>
      </>
    ) : (
      <button type="button" onClick={makeShareLink}>
        Share results
      </button>
    )}
  </div>
)}
```

`apiPost` and `apiDelete` both already exist in `frontend/src/lib/api.js` (lines 40 and 45) — import them alongside the `apiGet` that file already uses. **No change to `api.js` is needed**, so drop it from the commit in Step 6 if you did not touch it.

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx playwright test shared.spec.js results.spec.js --reporter=line
```

Expected: all passing.

- [ ] **Step 5: Lint and build**

```bash
cd frontend && npm run lint && npx vite build
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Results.jsx frontend/src/lib/api.js frontend/tests/shared.spec.js
git commit -m "feat: share and revoke a results link from the results page"
```

---

## Done when

- `cd backend/src && npm test` green with at least 499 tests.
- `cd frontend && npm run test:unit` green; `npm test` green with its total matching `--list`; lint clean; `vite build` succeeds.
- Every mutation in Task 1 Step 8 and Task 2 Step 7 reddens its named test, and only that test.
- The shared payload is asserted as an exact five-key set.
- A signed-out browser can open `/shared/:id?t=…` and read the results, sending no `Authorization` header.
- `PUBLIC_READS` lists exactly three routes, the new one added deliberately.
