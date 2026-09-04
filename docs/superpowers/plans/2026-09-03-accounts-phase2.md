# Accounts Phase 2 — Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every draft and board has an owner, and only that owner can change it —
shared links become read-only rather than read-write.

**Architecture:** API Gateway's native Cognito JWT authorizer sits on every
mutating route; no token is verified by code in this project. Handlers read
`sub` from `event.requestContext.authorizer.jwt.claims`, write it as `ownerId`
on create, and compare it on every mutation. A resource owned by somebody else
answers exactly like one that does not exist. `POST /me/claim` adopts the
drafts and boards this browser created before accounts existed, by conditional
write, so the first claimant wins.

**Tech Stack:** AWS SAM / CloudFormation, API Gateway HTTP API JWT authorizer,
Cognito, DynamoDB, Node 24 (`node --test`), React + Vite, Playwright.

## Global Constraints

- **404, never 403,** for a resource owned by somebody else. The body must be
  byte-identical to the genuine not-found body (`{"error":"Draft not found"}` /
  `{"error":"Board not found"}`). A distinguishable response is an existence
  oracle for an id-guessing probe.
- **Every protected route is tested from three angles:** the owner (allowed), a
  different signed-in user (404), and no claims at all (401). A route tested
  only on its happy path is how an unprotected route ships green.
- **Viewing stays unauthenticated:** `GET /drafts/{draftId}`,
  `GET /boards/{boardId}`, `GET /players`, `GET /players/{playerId}` carry no
  authorizer and read no claims.
- **`ownerId: "anon"` counts as unowned.** Today's `boards.js` writes that
  literal on every create, so `attribute_not_exists(ownerId)` alone would leave
  every existing board unclaimable. One helper decides this, in one place.
- **The claim is conditional and non-destructive:** an already-owned resource
  cannot be stolen, and the endpoint reports that it changed nothing.
- **Frontend gating is UX, not enforcement.** The server is the only thing that
  decides ownership; the UI only avoids offering buttons that would 401.
- **No token verification code.** PKCE, signature checks, and issuer validation
  belong to `oidc-client-ts` and API Gateway respectively.

## Deploy prerequisite (blocking, manual, cannot be automated here)

Phase 1 created Cognito behind a `HasGoogle` condition so it could ship before
the Google setup existed. **Phase 2 removes that condition** — the JWT
authorizer references the user pool, so the pool must exist for the stack to
deploy at all. Before deploying this phase, the account owner must complete
the four steps already written in `README.md` ("Sign in with Google"): create
the Google OAuth client, put the secret in SSM, deploy with
`GoogleClientId`/`GoogleClientSecret`, register the Cognito redirect URI, and
put `VITE_COGNITO_*` into `frontend/.env.production`.

Deploying this phase's backend **before** that is done will fail at
CloudFormation with a missing-parameter error, which is the intended outcome:
a half-configured deploy that accepted mutations without an authorizer would be
the vulnerability this phase exists to close.

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/lib/owner.js` (new) | The only place that answers "who is this request" and "may they change this item". Pure, no AWS SDK. |
| `backend/src/lib/owner.test.js` (new) | Unit tests for the above. |
| `backend/src/template.test.js` (new) | Reads `template.yaml` and asserts every mutating route carries the authorizer and no read route does. |
| `backend/src/me.js` (new) | `POST /me/claim`. Phase 3 will add `/me/drafts` and `/me/boards` here. |
| `backend/src/me.test.js` (new) | Claim tests, including the theft case. |
| `backend/template.yaml` | Authorizer definition, per-route attachment, CORS `authorization` header, `MeFunction`, Cognito made unconditional. |
| `backend/src/drafts.js` | Writes `ownerId` on create; enforces on pick / auto-pick / sim-to-end / delete. |
| `backend/src/boards.js` | Writes the real `ownerId` on create (replacing `"anon"`); enforces on PUT / DELETE. |
| `backend/src/lib/http.js` | `Access-Control-Allow-Headers` gains `authorization`. |
| `frontend/src/lib/authGate.js` (new) | `mustSignIn({ configured, signedIn })` — one pure rule, used by both create buttons. |
| `frontend/src/lib/claim.js` (new) | Which local ids are claimable, and the once-per-account marker. Pure. |
| `frontend/src/lib/useClaimOnSignIn.js` (new) | The effect that POSTs the claim when a user becomes active. |
| `frontend/src/components/ClaimOnSignIn.jsx` (new) | Mounts that hook inside `AuthProvider`; renders nothing. |
| `frontend/src/lib/AuthProvider.jsx` | Publishes `signedIn` and `sub` alongside `user`/`name`. |
| `frontend/src/lib/api.js` | Attaches the HTTP status to thrown errors, so a caller can tell 404 from 500. |
| `frontend/src/pages/NewDraft.jsx`, `frontend/src/pages/Boards.jsx` | Create is gated behind sign-in; delete forgets locally on a 404. |
| `frontend/src/pages/MyDrafts.jsx` | Delete forgets locally on a 404. |
| `frontend/tests/auth.js` (new) | `signIn(page)` — seeds a Cognito session in `localStorage`, mocks the claim call. |
| `frontend/playwright.config.js` | The test build is auth-configured, so the signed-in path is reachable at all. |

---

### Task 1: The ownership helper

**Files:**
- Create: `backend/src/lib/owner.js`
- Test: `backend/src/lib/owner.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ANON` — the string `"anon"`.
  - `subOf(event) -> string | null` — the caller's Cognito `sub`, or null.
  - `isUnowned(item) -> boolean` — true when `ownerId` is absent, empty, or `"anon"`.
  - `canMutate(item, sub) -> boolean` — true only when `sub` is a non-empty
    string and `item.ownerId === sub`.

- [ ] **Step 1: Write the failing tests**

```js
// backend/src/lib/owner.test.js
const test = require("node:test");
const assert = require("node:assert");
const { ANON, subOf, isUnowned, canMutate } = require("./owner");

function evt(claims) {
  return claims === undefined
    ? {}
    : { requestContext: { authorizer: { jwt: { claims } } } };
}

test("subOf reads the sub claim API Gateway passes", () => {
  assert.strictEqual(subOf(evt({ sub: "user-1", email: "a@b.c" })), "user-1");
});

test("subOf is null with no authorizer on the event", () => {
  assert.strictEqual(subOf(evt()), null);
});

test("subOf is null for an undefined event", () => {
  assert.strictEqual(subOf(undefined), null);
});

test("subOf is null when the claims carry no sub", () => {
  assert.strictEqual(subOf(evt({ email: "a@b.c" })), null);
});

test("subOf is null for an empty-string sub", () => {
  assert.strictEqual(subOf(evt({ sub: "" })), null);
});

test("subOf is null for a non-string sub", () => {
  assert.strictEqual(subOf(evt({ sub: 42 })), null);
});

test("an item with no ownerId is unowned", () => {
  assert.strictEqual(isUnowned({ draftId: "d1" }), true);
});

// boards.js has written this literal on every create since the board editor
// shipped, so it is the common case for existing data, not a curiosity.
test("the legacy \"anon\" ownerId counts as unowned", () => {
  assert.strictEqual(isUnowned({ ownerId: ANON }), true);
});

test("an empty-string ownerId is unowned", () => {
  assert.strictEqual(isUnowned({ ownerId: "" }), true);
});

test("an item with a real ownerId is owned", () => {
  assert.strictEqual(isUnowned({ ownerId: "user-1" }), false);
});

test("isUnowned tolerates a missing item", () => {
  assert.strictEqual(isUnowned(undefined), true);
});

test("the owner may mutate", () => {
  assert.strictEqual(canMutate({ ownerId: "user-1" }, "user-1"), true);
});

test("a different signed-in user may not mutate", () => {
  assert.strictEqual(canMutate({ ownerId: "user-1" }, "user-2"), false);
});

test("nobody may mutate an unowned item -- it is frozen until claimed", () => {
  assert.strictEqual(canMutate({ ownerId: ANON }, "user-1"), false);
  assert.strictEqual(canMutate({}, "user-1"), false);
});

test("a null sub may not mutate an item whose ownerId is somehow null", () => {
  assert.strictEqual(canMutate({ ownerId: null }, null), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend/src && node --test lib/owner.test.js`
Expected: FAIL — `Cannot find module './owner'`

- [ ] **Step 3: Write the implementation**

```js
// backend/src/lib/owner.js
/**
 * Who is asking, and may they change this?
 *
 * Both questions live here so that "owned by somebody else" cannot mean one
 * thing in drafts.js and another in boards.js. The token itself is verified by
 * API Gateway's Cognito authorizer before the Lambda runs; by the time these
 * claims exist they have already been checked, so this module only reads them.
 */

// boards.js wrote this literal as ownerId on every board created before
// accounts existed. It means "nobody", and treating it as a real owner would
// make every one of those boards permanently unclaimable.
const ANON = "anon";

/** The caller's Cognito subject, or null when the route is unauthenticated. */
function subOf(event) {
  const sub = event?.requestContext?.authorizer?.jwt?.claims?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}

function isUnowned(item) {
  const owner = item?.ownerId;
  return !owner || owner === ANON;
}

/**
 * Deliberately not "the owner OR anybody if it is unowned": an unowned draft
 * is readable but frozen, and the way to thaw it is POST /me/claim, which is
 * a conditional write. Letting a mutation adopt it as a side effect would make
 * the first person to send a pick its owner.
 */
function canMutate(item, sub) {
  if (typeof sub !== "string" || sub.length === 0) return false;
  if (isUnowned(item)) return false;
  return item.ownerId === sub;
}

module.exports = { ANON, subOf, isUnowned, canMutate };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend/src && node --test lib/owner.test.js`
Expected: PASS — 15 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/owner.js backend/src/lib/owner.test.js
git commit -m "feat: the one place that decides who owns a resource"
```

---

### Task 2: The authorizer, and a test that no route escapes it

**Files:**
- Modify: `backend/template.yaml`
- Modify: `backend/src/lib/http.js:12-14` (the `Access-Control-Allow-Headers` value)
- Modify: `backend/src/package.json` (add a `devDependencies` block)
- Test: `backend/src/template.test.js` (create)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: an HTTP API authorizer named `CognitoAuth`, attached to every
  mutating route. Later tasks assume `event.requestContext.authorizer.jwt.claims`
  is populated for those routes and absent for the read routes.

- [ ] **Step 1: Add the YAML parser the test needs**

`template.yaml` is the source of truth for which routes are protected, so the
test has to read the real file. Nothing in this repo can parse YAML yet.

Edit `backend/src/package.json`, adding a `devDependencies` block after
`dependencies` (SAM packages with `--production`, so a devDependency does not
reach the Lambda):

```json
  "devDependencies": {
    "yaml": "^2.6.1"
  }
```

Run: `cd backend/src && npm install`
Expected: `added 1 package`

- [ ] **Step 2: Write the failing test**

```js
// backend/src/template.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

// CloudFormation's short tags (!Ref, !Sub, !GetAtt) are not standard YAML.
// Stripping the tag leaves the value itself, which is all this test reads --
// it asks which routes exist and whether they carry an authorizer, never what
// a !Ref resolves to.
function loadTemplate() {
  const raw = fs.readFileSync(
    path.resolve(__dirname, "../template.yaml"),
    "utf8"
  );
  return YAML.parse(raw.replace(/!(?:[A-Za-z]+)(?=[\s[])/g, ""));
}

/** Every HttpApi event in the template, flattened to one row per route. */
function httpRoutes(tpl) {
  const rows = [];
  for (const [fnName, fn] of Object.entries(tpl.Resources || {})) {
    if (fn.Type !== "AWS::Serverless::Function") continue;
    for (const [evtName, evt] of Object.entries(fn.Properties?.Events || {})) {
      if (evt.Type !== "HttpApi") continue;
      const p = evt.Properties || {};
      rows.push({
        fnName,
        evtName,
        method: String(p.Method || "").toUpperCase(),
        path: p.Path,
        authorizer: p.Auth?.Authorizer ?? null,
      });
    }
  }
  return rows;
}

const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"]);

test("the API defines a Cognito JWT authorizer", () => {
  const tpl = loadTemplate();
  const auth = tpl.Resources.HttpApi.Properties.Auth;
  assert.ok(auth.Authorizers.CognitoAuth, "CognitoAuth authorizer is missing");
  assert.strictEqual(
    auth.Authorizers.CognitoAuth.IdentitySource,
    "$request.header.Authorization"
  );
});

// No DefaultAuthorizer: reads must stay public, and a default would protect
// them by accident the moment someone forgets to opt one out.
test("the API declares no DefaultAuthorizer", () => {
  const tpl = loadTemplate();
  assert.strictEqual(
    tpl.Resources.HttpApi.Properties.Auth.DefaultAuthorizer,
    undefined
  );
});

// The whole point of this file. A human adding a route will forget the Auth
// block; this list will not.
test("every mutating route carries the Cognito authorizer", () => {
  const unprotected = httpRoutes(loadTemplate())
    .filter((r) => MUTATING.has(r.method) && r.authorizer !== "CognitoAuth")
    .map((r) => `${r.method} ${r.path} (${r.fnName}.${r.evtName})`);
  assert.deepStrictEqual(unprotected, []);
});

test("no read route carries an authorizer", () => {
  const protectedReads = httpRoutes(loadTemplate())
    .filter((r) => !MUTATING.has(r.method) && r.authorizer !== null)
    .map((r) => `${r.method} ${r.path}`);
  assert.deepStrictEqual(protectedReads, []);
});

// Named explicitly rather than only by rule, so that deleting a route's Auth
// block AND its entry here takes two deliberate edits.
test("the expected mutating routes are all present", () => {
  const found = httpRoutes(loadTemplate())
    .filter((r) => MUTATING.has(r.method))
    .map((r) => `${r.method} ${r.path}`)
    .sort();
  assert.deepStrictEqual(found, [
    "DELETE /boards/{boardId}",
    "DELETE /drafts/{draftId}",
    "POST /boards",
    "POST /drafts",
    "POST /drafts/{draftId}/auto-pick",
    "POST /drafts/{draftId}/pick",
    "POST /drafts/{draftId}/sim-to-end",
    "POST /me/claim",
    "PUT /boards/{boardId}",
  ]);
});

// A signed-in request is preflighted because of its Authorization header. With
// the header missing from the CORS allow-list the browser blocks the request
// before it is ever sent, and every signed-in mutation fails with no server
// log to show for it.
test("CORS allows the Authorization header", () => {
  const tpl = loadTemplate();
  const allowed =
    tpl.Resources.HttpApi.Properties.CorsConfiguration.AllowHeaders.map((h) =>
      String(h).toLowerCase()
    );
  assert.ok(allowed.includes("authorization"));
  assert.ok(allowed.includes("content-type"));
});

// Phase 1 shipped Cognito behind a condition so it could deploy with no Google
// credentials. Phase 2's authorizer references the pool, so a conditional pool
// would mean a stack that deploys with mutations wide open.
test("Cognito is no longer conditional", () => {
  const tpl = loadTemplate();
  assert.strictEqual(tpl.Conditions, undefined);
  for (const [name, res] of Object.entries(tpl.Resources)) {
    assert.strictEqual(res.Condition, undefined, `${name} is still conditional`);
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend/src && node --test template.test.js`
Expected: FAIL — no `Auth` on `HttpApi`, `POST /me/claim` missing, `Conditions` present.

- [ ] **Step 4: Remove the `HasGoogle` condition from the template**

In `backend/template.yaml`:

Delete the whole `Conditions:` block and its comment:

```yaml
# Cognito is only created once a Google client id is supplied. Until then the
# stack deploys exactly as it does today, so this phase cannot break a deploy
# that has not been configured yet.
Conditions:
  HasGoogle: !Not [!Equals [!Ref GoogleClientId, ""]]
```

Delete the line `Condition: HasGoogle` from `UserPool`,
`UserPoolGoogleProvider`, `UserPoolClient`, `UserPoolDomain`, and from the
`UserPoolId`, `UserPoolClientId`, and `AuthDomain` outputs.

Remove `Default: ""` from both `GoogleClientId` and `GoogleClientSecret`, so a
deploy without them fails loudly at CloudFormation instead of building a pool
with an empty client id:

```yaml
Parameters:
  GoogleClientId:
    Type: String
    Description: >-
      OAuth 2.0 client ID from the Google Cloud project. Required: the API's
      JWT authorizer references the user pool this creates.
  GoogleClientSecret:
    Type: String
    NoEcho: true
    Description: >-
      OAuth 2.0 client secret. NoEcho keeps it out of console output and stack
      events. Pass it at deploy time from SSM; never commit it.
```

- [ ] **Step 5: Define the authorizer and widen CORS**

Replace the `HttpApi` resource in `backend/template.yaml` with:

```yaml
  HttpApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      # No DefaultAuthorizer on purpose. Reads stay public -- a shared link
      # must still open -- so protection is opted into route by route, and
      # template.test.js is what makes sure nobody forgets to opt in.
      Auth:
        Authorizers:
          CognitoAuth:
            IdentitySource: "$request.header.Authorization"
            JwtConfiguration:
              issuer: !Sub "https://cognito-idp.${AWS::Region}.amazonaws.com/${UserPool}"
              audience:
                - !Ref UserPoolClient
      CorsConfiguration:
        AllowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
        # A signed-in request is preflighted because of its Authorization
        # header; without it here the browser refuses to send the real request.
        AllowHeaders: ["content-type", "authorization"]
        AllowOrigins:
          - "https://d2kf4b52rvabfv.cloudfront.net"
```

- [ ] **Step 6: Attach the authorizer to every mutating route**

Add this block to the `Properties` of each mutating `HttpApi` event in
`backend/template.yaml` — `CreateDraft`, `Pick`, `AutoPick`, `SimToEnd`,
`DeleteDraft` (in `DraftsFunction`), and `CreateBoard`, `SaveBoard`,
`DeleteBoard` (in `BoardsFunction`):

```yaml
            Auth:
              Authorizer: CognitoAuth
```

For example, `CreateDraft` becomes:

```yaml
        CreateDraft:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /drafts
            Method: POST
            Auth:
              Authorizer: CognitoAuth
```

Leave `GetDraft`, `GetBoard`, `GetPlayers`, and `GetPlayer` exactly as they are.

`POST /me/claim` is added in Task 5; until then the "expected mutating routes"
test stays red on that one line, which is the correct signal.

- [ ] **Step 7: Align the Lambda's own CORS header**

In `backend/src/lib/http.js`, in `corsHeaders()`:

```js
    "Access-Control-Allow-Headers": "content-type,authorization",
```

- [ ] **Step 8: Run the template test and the full backend suite**

Run: `cd backend/src && node --test template.test.js`
Expected: PASS except `the expected mutating routes are all present`, which
fails on the missing `POST /me/claim` until Task 5.

Run: `cd backend/src && npm test`
Expected: the existing 173 tests still pass. `lib/http.test.js` may assert the
old `Access-Control-Allow-Headers` value; if it does, update that expectation
to `content-type,authorization` — it is the assertion that is stale, not the
code.

- [ ] **Step 9: Validate the template**

Run: `cd backend && sam validate --lint`
Expected: `template.yaml is a valid SAM Template`

- [ ] **Step 10: Commit**

```bash
git add backend/template.yaml backend/src/template.test.js \
        backend/src/package.json backend/src/package-lock.json \
        backend/src/lib/http.js backend/src/lib/http.test.js
git commit -m "feat: a Cognito authorizer on every mutating route, and a test that keeps it there"
```

---

### Task 3: Drafts get an owner, and enforce it

**Files:**
- Modify: `backend/src/drafts.js`
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: `subOf`, `canMutate` from `backend/src/lib/owner.js` (Task 1).
- Produces: draft items carrying `ownerId: <sub>`; `POST /drafts` responds 401
  without claims; the four mutating draft routes respond 404 for a draft owned
  by anyone else.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/drafts.test.js`. Note the new `claims` option on `evt()` —
update the existing `evt` helper in that file to accept it:

```js
// Replace the existing evt() helper with this one. `claims` is exactly the
// shape API Gateway's JWT authorizer puts on the event, which is the boundary
// this code actually depends on -- Cognito itself cannot run locally.
function evt(method, path, { draftId, body, claims } = {}) {
  return {
    requestContext: {
      http: { method },
      ...(claims ? { authorizer: { jwt: { claims } } } : {}),
    },
    rawPath: path,
    pathParameters: draftId ? { draftId } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

const ME = { sub: "user-me", email: "me@example.com" };
const THEM = { sub: "user-them", email: "them@example.com" };

function ownedDraft(ownerId) {
  return {
    draftId: "d1",
    ownerId,
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

test("POST /drafts without claims is 401", async () => {
  const res = await handler(evt("POST", "/drafts", { body: { teams: 12 } }));
  assert.strictEqual(res.statusCode, 401);
});

test("POST /drafts stores the caller's sub as ownerId", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    put = cmd.input;
    return {};
  });
  const res = await handler(
    evt("POST", "/drafts", { body: { teams: 2, rounds: 1 }, claims: ME })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(put.Item.ownerId, "user-me");
});

for (const [name, path, suffix] of [
  ["pick", "/drafts/d1/pick", "/pick"],
  ["auto-pick", "/drafts/d1/auto-pick", "/auto-pick"],
  ["sim-to-end", "/drafts/d1/sim-to-end", "/sim-to-end"],
]) {
  test(`${name} without claims is 401`, async () => {
    const res = await handler(
      evt("POST", path, { draftId: "d1", body: { playerId: "p1" } })
    );
    assert.strictEqual(res.statusCode, 401);
    assert.ok(suffix);
  });

  test(`${name} on someone else's draft is 404, worded as not-found`, async () => {
    stubSend({ Item: ownedDraft("user-them") });
    const res = await handler(
      evt("POST", path, { draftId: "d1", body: { playerId: "p1" }, claims: ME })
    );
    assert.strictEqual(res.statusCode, 404);
    // Byte-identical to a genuine miss: a distinguishable body confirms the id
    // exists, which is precisely what an id-guessing probe is looking for.
    assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
  });

  test(`${name} on an unclaimed legacy draft is 404 -- readable but frozen`, async () => {
    stubSend({ Item: ownedDraft(undefined) });
    const res = await handler(
      evt("POST", path, { draftId: "d1", body: { playerId: "p1" }, claims: ME })
    );
    assert.strictEqual(res.statusCode, 404);
  });
}

test("the owner can pick", async () => {
  stubByTable({
    "drafts-test": { Item: ownedDraft("user-me") },
    "players-test": {
      Item: {
        playerId: "p1",
        id: "p1",
        name: "Test Back",
        position: "RB",
        team: "SF",
        rank: { standard: 1 },
        adp: { standard: 1 },
        tier: { standard: 1 },
      },
    },
  });
  const res = await handler(
    evt("POST", "/drafts/d1/pick", {
      draftId: "d1",
      body: { playerId: "p1" },
      claims: ME,
    })
  );
  assert.strictEqual(res.statusCode, 200);
});

test("GET of a draft needs no claims at all -- sharing still works", async () => {
  stubSend({ Item: ownedDraft("user-them") });
  const res = await handler(evt("GET", "/drafts/d1", { draftId: "d1" }));
  assert.strictEqual(res.statusCode, 200);
});

test("DELETE without claims is 401", async () => {
  const res = await handler(evt("DELETE", "/drafts/d1", { draftId: "d1" }));
  assert.strictEqual(res.statusCode, 401);
});

test("DELETE deletes only on a matching ownerId", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  const res = await handler(
    evt("DELETE", "/drafts/d1", { draftId: "d1", claims: ME })
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(input.ConditionExpression, "ownerId = :me");
  assert.strictEqual(input.ExpressionAttributeValues[":me"], "user-me");
});

test("DELETE of someone else's draft is 404", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    const e = new Error("The conditional request failed");
    e.name = "ConditionalCheckFailedException";
    throw e;
  });
  const res = await handler(
    evt("DELETE", "/drafts/d1", { draftId: "d1", claims: THEM })
  );
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Draft not found" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend/src && node --test drafts.test.js`
Expected: FAIL — 401s come back as 200s, other-owner mutations succeed.

- [ ] **Step 3: Implement ownership in `drafts.js`**

Add the import beside the existing ones at the top of `backend/src/drafts.js`:

```js
const { subOf, canMutate } = require("./lib/owner");
```

Inside `exports.handler`, immediately after `const json = responder(event);`
and the `OPTIONS` early return, add:

```js
  // Read once. The authorizer has already verified the token by the time this
  // runs; an absent sub means the route was reached without one, which is a
  // 401 rather than a crash.
  const sub = subOf(event);

  // A resource owned by somebody else answers exactly like one that does not
  // exist. A 403 would confirm the id is real.
  const notFound = () => json(404, { error: "Draft not found" });
  const needsAuth = () => json(401, { error: "Sign in required" });
```

In the `POST /drafts` branch, as its first statement:

```js
      if (!sub) return needsAuth();
```

and add `ownerId: sub,` to the `item` object, directly after `draftId: id,`:

```js
      const item = {
        draftId: id,
        ownerId: sub,
        sport,
```

In each of the three `POST /drafts/{draftId}/...` branches (`/pick`,
`/auto-pick`, `/sim-to-end`), add the guard as the first statement of the
branch, and replace the not-found check that follows the `GetCommand`:

```js
      if (!sub) return needsAuth();
      // ... existing GetCommand ...
      if (!res.Item || !canMutate(res.Item, sub)) return notFound();
```

(That replaces each existing `if (!res.Item) return json(404, { error: "Draft not found" });`.)

Replace the `DELETE` branch entirely:

```js
    // DELETE /drafts/{draftId}
    if (method === "DELETE" && draftId) {
      if (!sub) return needsAuth();
      try {
        await ddb.send(
          new DeleteCommand({
            TableName: draftsTable,
            Key: { draftId },
            // One round trip instead of read-then-delete, and no window
            // between the ownership check and the delete.
            ConditionExpression: "ownerId = :me",
            ExpressionAttributeValues: { ":me": sub },
          })
        );
        return json(200, { ok: true });
      } catch (e) {
        // Covers all three of: already gone, owned by someone else, never
        // claimed. The client cannot tell them apart, which is the point.
        if (e.name === "ConditionalCheckFailedException") return notFound();
        throw e;
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend/src && node --test drafts.test.js`
Expected: PASS

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend/src && npm test`
Expected: PASS, except `template.test.js`'s route list (still awaiting Task 5).
Existing draft tests that mutate without claims will now 401 — update those to
pass `claims: ME`, since requiring a signed-in caller is the change being made.

- [ ] **Step 6: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js
git commit -m "feat: drafts have an owner, and only the owner can change one"
```

---

### Task 4: Boards get a real owner, and enforce it

**Files:**
- Modify: `backend/src/boards.js`
- Test: `backend/src/boards.test.js`

**Interfaces:**
- Consumes: `subOf`, `canMutate` from `backend/src/lib/owner.js` (Task 1).
- Produces: board items carrying the caller's `sub` as `ownerId` instead of the
  literal `"anon"`; `PUT`/`DELETE /boards/{boardId}` 404 for anyone else, and
  `PUT` still 409s the owner on a version mismatch.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/boards.test.js`, updating the existing `event()` helper to
accept claims:

```js
// Replace the existing event() helper.
function event(method, body, boardId, claims) {
  return {
    requestContext: {
      http: { method },
      ...(claims ? { authorizer: { jwt: { claims } } } : {}),
    },
    pathParameters: boardId ? { boardId } : undefined,
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
        ? body
        : JSON.stringify(body),
  };
}

const ME = { sub: "user-me", email: "me@example.com" };

test("POST /boards without claims is 401", async () => {
  const { code } = await status(event("POST", { format: "ppr" }));
  assert.strictEqual(code, 401);
});

test("POST /boards stores the caller's sub, not the anon literal", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    put = cmd.input;
    return {};
  });
  const res = await handler(event("POST", { format: "ppr" }, undefined, ME));
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(put.Item.ownerId, "user-me");
  mock.restoreAll();
});

test("PUT without claims is 401", async () => {
  const { code } = await status(
    event("PUT", { order: ["p1"], version: 1 }, "b1")
  );
  assert.strictEqual(code, 401);
});

test("PUT requires a matching ownerId in its condition", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return { Attributes: { version: 2 } };
  });
  const res = await handler(
    event("PUT", { order: ["p1"], version: 1 }, "b1", ME)
  );
  assert.strictEqual(res.statusCode, 200);
  assert.match(input.ConditionExpression, /ownerId = :me/);
  assert.strictEqual(input.ExpressionAttributeValues[":me"], "user-me");
  mock.restoreAll();
});

test("PUT on someone else's board is 404, not 409", async () => {
  let call = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    call += 1;
    if (call === 1) {
      const e = new Error("The conditional request failed");
      e.name = "ConditionalCheckFailedException";
      throw e;
    }
    // The follow-up Get that decides which failure this was.
    return { Item: { boardId: "b1", ownerId: "user-them", version: 1 } };
  });
  const res = await handler(
    event("PUT", { order: ["p1"], version: 1 }, "b1", ME)
  );
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Board not found" });
  mock.restoreAll();
});

test("PUT by the owner at a stale version is still a 409 with the current one", async () => {
  let call = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    call += 1;
    if (call === 1) {
      const e = new Error("The conditional request failed");
      e.name = "ConditionalCheckFailedException";
      throw e;
    }
    return { Item: { boardId: "b1", ownerId: "user-me", version: 7 } };
  });
  const res = await handler(
    event("PUT", { order: ["p1"], version: 1 }, "b1", ME)
  );
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(JSON.parse(res.body).currentVersion, 7);
  mock.restoreAll();
});

test("DELETE without claims is 401", async () => {
  const { code } = await status(event("DELETE", undefined, "b1"));
  assert.strictEqual(code, 401);
});

test("DELETE of someone else's board is 404", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    const e = new Error("The conditional request failed");
    e.name = "ConditionalCheckFailedException";
    throw e;
  });
  const res = await handler(event("DELETE", undefined, "b1", ME));
  assert.strictEqual(res.statusCode, 404);
  mock.restoreAll();
});
```

If `boards.test.js` does not already import `mock`, add it to the requires at
the top of the file:

```js
const { mock } = require("node:test");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend/src && node --test boards.test.js`
Expected: FAIL — 401s come back as 201/200, `ownerId` is `"anon"`.

- [ ] **Step 3: Implement ownership in `boards.js`**

Add the import at the top of `backend/src/boards.js`:

```js
const { subOf } = require("./lib/owner");
```

Inside `exports.handler`, after the `OPTIONS` early return:

```js
  const sub = subOf(event);
  const notFound = () => json(404, { error: "Board not found" });
  const needsAuth = () => json(401, { error: "Sign in required" });
```

In the `POST` branch, as its first statement:

```js
      if (!sub) return needsAuth();
```

and change the item's owner from the placeholder to the real one:

```js
        boardId: randomUUID(),
        ownerId: sub,
```

In the `PUT` branch, add the guard as its first statement:

```js
      if (!sub) return needsAuth();
```

extend the `UpdateCommand`'s condition and values:

```js
            ConditionExpression:
              "attribute_exists(boardId) AND version = :expected AND ownerId = :me",
            ExpressionAttributeNames: { "#o": "order" },
            ExpressionAttributeValues: {
              ":order": order,
              ":now": Date.now(),
              ":next": expectedVersion + 1,
              ":expected": expectedVersion,
              ":me": sub,
            },
```

and widen the failure handling, which now has three cases to tell apart rather
than two:

```js
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") {
          const current = await ddb.send(
            new GetCommand({ TableName: boardsTable, Key: { boardId } })
          );
          if (!current.Item) return notFound();
          // Not yours -- including a legacy board nobody has claimed. Same
          // answer as a board that isn't there, deliberately.
          if (current.Item.ownerId !== sub) return notFound();
          return json(409, {
            error: "Board changed since you loaded it",
            currentVersion: current.Item.version,
          });
        }
        throw e;
      }
```

Replace the `DELETE` branch:

```js
    if (method === "DELETE" && boardId) {
      if (!sub) return needsAuth();
      try {
        await ddb.send(
          new DeleteCommand({
            TableName: boardsTable,
            Key: { boardId },
            ConditionExpression: "ownerId = :me",
            ExpressionAttributeValues: { ":me": sub },
          })
        );
        return json(200, { ok: true });
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") return notFound();
        throw e;
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend/src && node --test boards.test.js`
Expected: PASS. Existing tests that POST/PUT/DELETE without claims now 401 —
add `ME` to those calls; the new requirement is the point of the change.

- [ ] **Step 5: Commit**

```bash
git add backend/src/boards.js backend/src/boards.test.js
git commit -m "feat: boards have a real owner, replacing the anon placeholder"
```

---

### Task 5: The claim endpoint

**Files:**
- Create: `backend/src/me.js`
- Create: `backend/src/me.test.js`
- Modify: `backend/template.yaml` (add `MeFunction`)

**Interfaces:**
- Consumes: `subOf`, `ANON` from `backend/src/lib/owner.js` (Task 1); the
  `CognitoAuth` authorizer from Task 2.
- Produces: `POST /me/claim`, body `{ draftIds: string[], boardIds: string[] }`,
  responding
  `{ claimed: { drafts: string[], boards: string[] }, skipped: { drafts: string[], boards: string[] } }`.
  The frontend (Task 7) depends on exactly these key names.

- [ ] **Step 1: Write the failing tests**

```js
// backend/src/me.test.js
const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { handler } = require("./me");

process.env.DRAFTS_TABLE = "drafts-test";
process.env.BOARDS_TABLE = "boards-test";

const ME = { sub: "user-me", email: "me@example.com" };

function event(body, claims) {
  return {
    requestContext: {
      http: { method: "POST" },
      ...(claims ? { authorizer: { jwt: { claims } } } : {}),
    },
    rawPath: "/me/claim",
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function conditionalFailure() {
  const e = new Error("The conditional request failed");
  e.name = "ConditionalCheckFailedException";
  return e;
}

test.afterEach(() => mock.restoreAll());

test("claiming without claims is 401", async () => {
  const res = await handler(event({ draftIds: ["d1"] }));
  assert.strictEqual(res.statusCode, 401);
});

test("a successful claim reports the ids it took", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({}));
  const res = await handler(
    event({ draftIds: ["d1", "d2"], boardIds: ["b1"] }, ME)
  );
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), {
    claimed: { drafts: ["d1", "d2"], boards: ["b1"] },
    skipped: { drafts: [], boards: [] },
  });
});

test("the claim sets ownerId to the caller only when nobody owns it", async () => {
  let input = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    input = cmd.input;
    return {};
  });
  await handler(event({ draftIds: ["d1"] }, ME));
  assert.strictEqual(input.ExpressionAttributeValues[":me"], "user-me");
  assert.match(input.ConditionExpression, /attribute_not_exists\(ownerId\)/);
  // The legacy boards literal has to be claimable too, or every board created
  // before accounts existed stays frozen forever.
  assert.strictEqual(input.ExpressionAttributeValues[":anon"], "anon");
});

// The case the spec calls out by name: an id somebody else already owns must
// change nothing and say so.
test("claiming an already-owned resource steals nothing and reports it skipped", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    throw conditionalFailure();
  });
  const res = await handler(event({ draftIds: ["d1"], boardIds: ["b1"] }, ME));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), {
    claimed: { drafts: [], boards: [] },
    skipped: { drafts: ["d1"], boards: ["b1"] },
  });
});

test("an empty claim is a 200 that did nothing", async () => {
  const res = await handler(event({}, ME));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), {
    claimed: { drafts: [], boards: [] },
    skipped: { drafts: [], boards: [] },
  });
});

test("a non-array draftIds is a 400, not a 500", async () => {
  const res = await handler(event({ draftIds: "d1" }, ME));
  assert.strictEqual(res.statusCode, 400);
});

test("more ids than the registries can hold is a 400", async () => {
  const res = await handler(
    event({ draftIds: Array.from({ length: 51 }, (_, i) => `d${i}`) }, ME)
  );
  assert.strictEqual(res.statusCode, 400);
});

test("a malformed body is a 400", async () => {
  const res = await handler({
    requestContext: {
      http: { method: "POST" },
      authorizer: { jwt: { claims: ME } },
    },
    body: "not json",
  });
  assert.strictEqual(res.statusCode, 400);
});

test("an unknown path under /me is 404", async () => {
  const res = await handler({
    requestContext: {
      http: { method: "POST" },
      authorizer: { jwt: { claims: ME } },
    },
    rawPath: "/me/nope",
    body: "{}",
  });
  assert.strictEqual(res.statusCode, 404);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend/src && node --test me.test.js`
Expected: FAIL — `Cannot find module './me'`

- [ ] **Step 3: Write `me.js`**

```js
// backend/src/me.js
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { responder } = require("./lib/http");
const { subOf, ANON } = require("./lib/owner");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Matches the 50-entry cap on both browser registries, so a legitimate claim
// always fits and anything larger is not one of ours.
const MAX_IDS = 50;
const MAX_ID_LENGTH = 64;

function parseBody(event) {
  if (!event.body) return {};
  try {
    const parsed = JSON.parse(event.body);
    const isObject =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    return isObject ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_IDS) return undefined;
  const ids = value.filter(
    (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH
  );
  // De-duplicated: the same id twice would be one claim and one "skipped",
  // which reads as a failure that did not happen.
  return [...new Set(ids)];
}

/**
 * Take ownership of one item, if and only if nobody has it.
 *
 * The condition is the whole security property: the write is what decides,
 * not a read before it, so two people claiming the same id at the same moment
 * cannot both win. `ANON` is here because boards.js wrote that literal as a
 * placeholder owner before this phase.
 */
async function claimOne(table, key, sub) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression: "SET ownerId = :me",
        ConditionExpression:
          "attribute_exists(#pk) AND (attribute_not_exists(ownerId) OR ownerId = :anon)",
        ExpressionAttributeNames: { "#pk": Object.keys(key)[0] },
        ExpressionAttributeValues: { ":me": sub, ":anon": ANON },
      })
    );
    return true;
  } catch (e) {
    // Already owned, or gone. Either way this claim took nothing, and the
    // caller is told exactly that.
    if (e.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

async function claimAll(table, ids, keyFor, sub) {
  const results = await Promise.all(
    ids.map((id) => claimOne(table, keyFor(id), sub))
  );
  return {
    claimed: ids.filter((_, i) => results[i]),
    skipped: ids.filter((_, i) => !results[i]),
  };
}

exports.handler = async (event) => {
  const json = responder(event);
  const method = event.requestContext?.http?.method;
  const path = event.rawPath || event.requestContext?.http?.path || "";

  if (method === "OPTIONS") return json(200, {});

  const sub = subOf(event);
  if (!sub) return json(401, { error: "Sign in required" });

  try {
    if (method === "POST" && path.endsWith("/claim")) {
      const body = parseBody(event);
      if (body === undefined) return json(400, { error: "Invalid JSON body" });

      const draftIds = validIds(body.draftIds);
      const boardIds = validIds(body.boardIds);
      if (draftIds === undefined || boardIds === undefined) {
        return json(400, {
          error: `draftIds and boardIds must be arrays of at most ${MAX_IDS} ids`,
        });
      }

      const drafts = await claimAll(
        process.env.DRAFTS_TABLE,
        draftIds,
        (draftId) => ({ draftId }),
        sub
      );
      const boards = await claimAll(
        process.env.BOARDS_TABLE,
        boardIds,
        (boardId) => ({ boardId }),
        sub
      );

      return json(200, {
        claimed: { drafts: drafts.claimed, boards: boards.claimed },
        skipped: { drafts: drafts.skipped, boards: boards.skipped },
      });
    }

    return json(404, { error: "Not found" });
  } catch (e) {
    return json(500, { error: e.message || "Server error" });
  }
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend/src && node --test me.test.js`
Expected: PASS — 10 tests

- [ ] **Step 5: Add `MeFunction` to the template**

Add to `backend/template.yaml`, after `BoardsFunction`:

```yaml
  MeFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: me.handler
      Environment:
        Variables:
          DRAFTS_TABLE: !Ref DraftsTable
          BOARDS_TABLE: !Ref BoardsTable
          ALLOWED_ORIGIN: "https://d2kf4b52rvabfv.cloudfront.net"
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref DraftsTable
        - DynamoDBCrudPolicy:
            TableName: !Ref BoardsTable
      Events:
        Claim:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /me/claim
            Method: POST
            Auth:
              Authorizer: CognitoAuth
```

- [ ] **Step 6: Run the template test and validate**

Run: `cd backend/src && node --test template.test.js`
Expected: PASS — all seven tests, including the full mutating-route list.

Run: `cd backend && sam validate --lint`
Expected: `template.yaml is a valid SAM Template`

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend/src && npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/src/me.js backend/src/me.test.js backend/template.yaml
git commit -m "feat: POST /me/claim adopts the drafts and boards this browser made"
```

---

### Task 6: The frontend asks you to sign in before creating

**Files:**
- Create: `frontend/src/lib/authGate.js`
- Create: `frontend/src/lib/authGate.test.js`
- Modify: `frontend/src/lib/AuthProvider.jsx`
- Modify: `frontend/src/lib/api.js`
- Modify: `frontend/src/pages/NewDraft.jsx`
- Modify: `frontend/src/pages/Boards.jsx`
- Modify: `frontend/src/pages/MyDrafts.jsx`

**Interfaces:**
- Consumes: `useAuth()` from `frontend/src/lib/authContext.js`.
- Produces:
  - `mustSignIn({ configured, signedIn }) -> boolean`.
  - `useAuth()` additionally returns `signedIn: boolean` and `sub: string | null`
    (Task 7 depends on `sub`).
  - Errors thrown by `api.js` carry `err.status: number`.

- [ ] **Step 1: Write the failing unit tests**

```js
// frontend/src/lib/authGate.test.js
import test from "node:test";
import assert from "node:assert";
import { mustSignIn } from "./authGate.js";

test("a signed-out user on a configured build must sign in", () => {
  assert.strictEqual(mustSignIn({ configured: true, signedIn: false }), true);
});

test("a signed-in user does not", () => {
  assert.strictEqual(mustSignIn({ configured: true, signedIn: true }), false);
});

// A build with no Cognito variables has no sign-in to offer, so gating there
// would leave the app with no way to create anything at all. The server is
// still the enforcement point either way -- this gate only decides whether to
// offer a button that would 401.
test("an unconfigured build offers no gate, because it can offer no sign-in", () => {
  assert.strictEqual(mustSignIn({ configured: false, signedIn: false }), false);
});

test("missing fields are treated as unconfigured rather than throwing", () => {
  assert.strictEqual(mustSignIn({}), false);
  assert.strictEqual(mustSignIn(undefined), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — cannot find `./authGate.js`

- [ ] **Step 3: Write the gate**

```js
// frontend/src/lib/authGate.js
/**
 * Should this action ask the user to sign in first?
 *
 * One rule, in one place, because "when is a button gated" is exactly the sort
 * of question that drifts between two pages. This is UX only: the API decides
 * ownership, and a build that skips this gate simply gets a 401 instead of a
 * prompt.
 */
export function mustSignIn({ configured, signedIn } = {}) {
  return Boolean(configured) && !signedIn;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Publish `signedIn` and `sub` from the provider**

In `frontend/src/lib/AuthProvider.jsx`, extend the import and the memoised
value:

```js
import { getUserManager, isAuthConfigured, idTokenOf, displayNameOf, isActive } from "./auth";
```

```js
  const value = useMemo(
    () => ({
      user,
      name: displayNameOf(user),
      signedIn: isActive(user),
      // The Cognito subject: the id the API writes as ownerId, and the key the
      // claim marker is stored under.
      sub: isActive(user) ? user.profile?.sub ?? null : null,
      loading,
      configured: isAuthConfigured,
```

Mirror the two new keys in the context default in
`frontend/src/lib/authContext.js`, so a consumer rendered outside the provider
sees the same shape:

```js
export const AuthContext = createContext({
  user: null,
  name: null,
  signedIn: false,
  sub: null,
  loading: false,
  configured: false,
  signIn: () => {},
  signOut: () => {},
});
```

- [ ] **Step 6: Give thrown API errors their status**

In `frontend/src/lib/api.js`, replace the throw in `req()`:

```js
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `HTTP ${res.status}`);
    // Callers need to tell "it is gone or not yours" from "the server broke".
    // A delete, in particular, should stop offering a retry for a draft that
    // no longer exists.
    err.status = res.status;
    throw err;
  }
```

- [ ] **Step 7: Gate creating a draft**

In `frontend/src/pages/NewDraft.jsx`, add the imports:

```js
import { useAuth } from "../lib/authContext.js";
import { mustSignIn } from "../lib/authGate.js";
```

Inside the component, beside the existing state:

```js
  const { configured, signedIn, signIn } = useAuth();
  const needsSignIn = mustSignIn({ configured, signedIn });
```

Replace the create button (`frontend/src/pages/NewDraft.jsx:333-339`):

```jsx
          <button
            onClick={needsSignIn ? signIn : createDraft}
            disabled={loading}
            data-testid="start-draft"
            className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-cyan-300 to-sky-300 px-5 py-3 font-semibold text-black shadow-[0_10px_40px_rgba(34,211,238,0.20)] disabled:opacity-50"
          >
            {loading
              ? "Creating…"
              : needsSignIn
              ? "Sign in to draft"
              : "Start Mock Draft"}
          </button>
```

and replace the tip text beside it so the reason is visible before the click:

```jsx
          <div className="text-xs text-zinc-400">
            {needsSignIn
              ? "Drafts are saved to your account, so they follow you to any device."
              : (
                <>
                  Tip: Once inside the draft, use{" "}
                  <span className="text-zinc-200">Auto Pick</span> to simulate quickly.
                </>
              )}
          </div>
```

- [ ] **Step 8: Gate creating a board**

In `frontend/src/pages/Boards.jsx`, add the same two imports, then inside the
component:

```js
  const { configured, signedIn, signIn } = useAuth();
  const needsSignIn = mustSignIn({ configured, signedIn });
```

Replace the create button (`frontend/src/pages/Boards.jsx:81-88`):

```jsx
          <button
            type="button"
            onClick={needsSignIn ? signIn : createBoard}
            data-testid="create-board"
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-600"
          >
            {needsSignIn ? "Sign in to create" : "+ New board"}
          </button>
```

- [ ] **Step 9: Stop offering a retry for a delete that cannot succeed**

`DELETE` is no longer idempotent — a draft that is already gone, or was never
yours, answers 404. Both mean "stop listing it locally".

In `frontend/src/pages/Boards.jsx`, in `deleteBoard`'s catch:

```js
    } catch (e) {
      // 404 means gone or not yours. Either way the local entry is a dead
      // link, so drop it rather than inviting a retry that cannot work.
      if (e.status === 404) {
        forgetBoard(b.id);
        setBoards(listBoards());
        return;
      }
      setErr(e.message || "Failed to delete board");
    }
```

The same shape in `frontend/src/pages/MyDrafts.jsx:63-65`, whose delete handler
already imports `forgetDraft` and `listDrafts`:

```js
    } catch (e) {
      if (e.status === 404) {
        forgetDraft(d.id);
        setDrafts(listDrafts());
        return;
      }
      setErr(e.message || "Failed to delete draft");
    }
```

- [ ] **Step 10: Lint and run the unit tests**

Run: `cd frontend && npm run lint && npm run test:unit`
Expected: no lint errors; unit tests pass.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/lib/authGate.js frontend/src/lib/authGate.test.js \
        frontend/src/lib/AuthProvider.jsx frontend/src/lib/authContext.js \
        frontend/src/lib/api.js frontend/src/pages/NewDraft.jsx \
        frontend/src/pages/Boards.jsx frontend/src/pages/MyDrafts.jsx
git commit -m "feat: creating a draft or board asks you to sign in first"
```

---

### Task 7: Claim this browser's drafts and boards on sign-in

**Files:**
- Create: `frontend/src/lib/claim.js`
- Create: `frontend/src/lib/claim.test.js`
- Create: `frontend/src/lib/useClaimOnSignIn.js`
- Create: `frontend/src/components/ClaimOnSignIn.jsx`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: `useAuth().sub` (Task 6), `apiPost` from `frontend/src/lib/api.js`,
  `listDrafts` / `listBoards` from the two registries, and `POST /me/claim`
  (Task 5).
- Produces:
  - `claimableIds({ drafts, boards }) -> { draftIds: string[], boardIds: string[] }`
  - `claimKey(sub) -> string`
  - `<ClaimOnSignIn />` — renders nothing, claims once per account per browser.

- [ ] **Step 1: Write the failing unit tests**

```js
// frontend/src/lib/claim.test.js
import test from "node:test";
import assert from "node:assert";
import { claimableIds, claimKey } from "./claim.js";

test("only drafts this browser created are offered", () => {
  const { draftIds } = claimableIds({
    drafts: [
      { id: "mine", owned: true },
      { id: "opened-from-a-link", owned: false },
      { id: "also-mine", owned: true },
    ],
    boards: [],
  });
  assert.deepStrictEqual(draftIds, ["mine", "also-mine"]);
});

// The board registry only ever records a board at the moment this browser
// creates one, so every entry is a creation -- there is no `owned` flag to
// consult and none is needed.
test("every remembered board is offered", () => {
  const { boardIds } = claimableIds({
    drafts: [],
    boards: [{ id: "b1" }, { id: "b2" }],
  });
  assert.deepStrictEqual(boardIds, ["b1", "b2"]);
});

test("corrupt registry entries are dropped rather than sent", () => {
  const { draftIds, boardIds } = claimableIds({
    drafts: [null, { owned: true }, { id: 7, owned: true }, { id: "ok", owned: true }],
    boards: [undefined, { id: "" }, { id: "b1" }],
  });
  assert.deepStrictEqual(draftIds, ["ok"]);
  assert.deepStrictEqual(boardIds, ["b1"]);
});

test("the lists are capped at what the endpoint accepts", () => {
  const drafts = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, owned: true }));
  const { draftIds } = claimableIds({ drafts, boards: [] });
  assert.strictEqual(draftIds.length, 50);
});

test("missing lists yield empty lists, not a throw", () => {
  assert.deepStrictEqual(claimableIds({}), { draftIds: [], boardIds: [] });
});

test("the marker is per account, so a second sign-in claims its own ids", () => {
  assert.notStrictEqual(claimKey("user-a"), claimKey("user-b"));
  assert.match(claimKey("user-a"), /user-a/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — cannot find `./claim.js`

- [ ] **Step 3: Write `claim.js`**

```js
// frontend/src/lib/claim.js
/**
 * Which of this browser's ids are worth offering to POST /me/claim.
 *
 * Only ids the local registries recorded as *created here* are ever sent --
 * never every id this browser has seen. Sending the latter would be asking to
 * own drafts somebody shared with you, and while the server's conditional
 * write would refuse, asking at all is the wrong shape.
 */

// Matches MAX_IDS in backend/src/me.js and the registries' own cap.
const MAX_IDS = 50;

function ids(list, predicate) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (e) =>
        e && typeof e === "object" && typeof e.id === "string" && e.id.length > 0
    )
    .filter(predicate)
    .map((e) => e.id)
    .slice(0, MAX_IDS);
}

export function claimableIds({ drafts, boards } = {}) {
  return {
    draftIds: ids(drafts, (d) => Boolean(d.owned)),
    // Every remembered board was created by this browser: rememberBoard is
    // called from exactly one place, immediately after POST /boards.
    boardIds: ids(boards, () => true),
  };
}

export function claimKey(sub) {
  return `perfectpick.claimed.${sub}`;
}

export function hasClaimed(sub) {
  try {
    return localStorage.getItem(claimKey(sub)) !== null;
  } catch {
    // Storage unavailable. Claiming again is harmless -- the server's write is
    // conditional and idempotent in effect -- so fail towards trying.
    return false;
  }
}

export function markClaimed(sub) {
  try {
    localStorage.setItem(claimKey(sub), String(Date.now()));
  } catch {
    // See hasClaimed.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Write the hook and its mount point**

```js
// frontend/src/lib/useClaimOnSignIn.js
import { useEffect } from "react";
import { useAuth } from "./authContext.js";
import { apiPost } from "./api.js";
import { listDrafts } from "./draftRegistry.js";
import { listBoards } from "./boardRegistry.js";
import { claimableIds, hasClaimed, markClaimed } from "./claim.js";

/**
 * The moment you sign in, the drafts and boards you made before you had an
 * account become yours.
 *
 * Once per account per browser: the marker is only written after the call
 * succeeds, so a failure retries on the next load rather than silently losing
 * the one chance to claim.
 */
export function useClaimOnSignIn() {
  const { signedIn, sub } = useAuth();

  useEffect(() => {
    if (!signedIn || !sub) return;
    if (hasClaimed(sub)) return;

    const { draftIds, boardIds } = claimableIds({
      drafts: listDrafts(),
      boards: listBoards(),
    });
    if (draftIds.length === 0 && boardIds.length === 0) {
      // Nothing to claim is a settled question, not a pending one.
      markClaimed(sub);
      return;
    }

    let cancelled = false;
    apiPost("/me/claim", { draftIds, boardIds })
      .then(() => {
        if (!cancelled) markClaimed(sub);
      })
      .catch(() => {
        // Left unmarked on purpose: the next load tries again. Nothing here is
        // worth interrupting the page for -- an unclaimed draft is still
        // readable, and the user did not ask for this.
      });

    return () => {
      cancelled = true;
    };
  }, [signedIn, sub]);
}
```

```jsx
// frontend/src/components/ClaimOnSignIn.jsx
import { useClaimOnSignIn } from "../lib/useClaimOnSignIn.js";

/**
 * A mount point for the claim effect, rendered inside <AuthProvider> so it can
 * read the context App itself provides. Renders nothing.
 */
export default function ClaimOnSignIn() {
  useClaimOnSignIn();
  return null;
}
```

- [ ] **Step 6: Mount it**

In `frontend/src/App.jsx`, add the import and render it as the first child of
`<AuthProvider>`:

```jsx
import ClaimOnSignIn from "./components/ClaimOnSignIn.jsx";
```

```jsx
    <AuthProvider>
      <ClaimOnSignIn />
      <div className="flex h-dvh flex-col bg-[#070A0F] text-white">
```

- [ ] **Step 7: Lint and run the unit tests**

Run: `cd frontend && npm run lint && npm run test:unit`
Expected: no lint errors; unit tests pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/claim.js frontend/src/lib/claim.test.js \
        frontend/src/lib/useClaimOnSignIn.js \
        frontend/src/components/ClaimOnSignIn.jsx frontend/src/App.jsx
git commit -m "feat: signing in claims the drafts and boards you already made"
```

---

### Task 8: End-to-end, with sign-in mocked rather than driven

**Files:**
- Modify: `frontend/playwright.config.js`
- Create: `frontend/tests/auth.js`
- Modify: `frontend/tests/auth.spec.js`
- Modify: `frontend/tests/newdraft.spec.js`, `slot.spec.js`, `boarddraft.spec.js`,
  `mydrafts.spec.js`, `sleeper.spec.js`, `board.spec.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `signIn(page, { sub })` in `frontend/tests/auth.js`, used by any
  spec that creates a draft or board.

- [ ] **Step 1: Make the test build auth-configured**

Until now the e2e build had no Cognito variables, so the signed-in path was
unreachable and the gate could not be tested at all. In
`frontend/playwright.config.js`:

```js
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_API_BASE_URL: "http://localhost:9999",
      // A pool that does not exist. Nothing here ever reaches Cognito: the
      // tests seed a session directly and never redirect, which is the point
      // -- driving Google's consent screen in CI is not a test of this app.
      VITE_COGNITO_AUTHORITY:
        "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test",
      VITE_COGNITO_CLIENT_ID: "test-client-id",
    },
  },
```

- [ ] **Step 2: Write the sign-in helper**

```js
// frontend/tests/auth.js
export const AUTHORITY =
  "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test";
export const CLIENT_ID = "test-client-id";
export const ID_TOKEN = "test-id-token";

/**
 * Sign in without Cognito.
 *
 * oidc-client-ts reads its session from this one localStorage key, so writing
 * it before the app boots is a complete sign-in as far as the app is
 * concerned. `expires_at` is far in the future because an expired user is
 * treated as signed out.
 */
export async function signIn(page, { sub = "user-me", email = "me@example.com" } = {}) {
  const key = `oidc.user:${AUTHORITY}:${CLIENT_ID}`;
  const value = JSON.stringify({
    id_token: ID_TOKEN,
    access_token: "test-access-token",
    token_type: "Bearer",
    scope: "openid email profile",
    profile: { sub, email },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  await page.addInitScript(
    ([k, v]) => window.localStorage.setItem(k, v),
    [key, value]
  );

  // Signing in triggers a claim of whatever this browser made. Every spec that
  // signs in would otherwise see an unmocked request to a dead API base.
  await page.route("**/me/claim", (route) =>
    route.fulfill({
      json: { claimed: { drafts: [], boards: [] }, skipped: { drafts: [], boards: [] } },
    })
  );
}
```

- [ ] **Step 3: Rewrite `auth.spec.js` for the new reality**

```js
// frontend/tests/auth.spec.js
import { test, expect } from "@playwright/test";
import { DRAFT_ID, makeDraftState, mockDraftApis } from "./fixtures.js";
import { signIn, ID_TOKEN } from "./auth.js";

test.describe("signed out", () => {
  test("viewing a shared draft needs no account", async ({ page }) => {
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
    await expect(page.getByTestId("sign-in")).toBeVisible();
  });

  test("no request carries an Authorization header", async ({ page }) => {
    let headers = null;
    await page.route("**/players*", (route) => {
      headers = route.request().headers();
      return route.fulfill({ json: { players: [] } });
    });

    await page.goto("/boards");
    await page.waitForTimeout(300);

    if (headers) {
      expect(Object.keys(headers)).not.toContain("authorization");
    }
  });

  test("creating a board offers sign-in instead of failing", async ({ page }) => {
    let posted = false;
    await page.route("**/boards", (route) => {
      posted = true;
      return route.fulfill({ json: { boardId: "b1" } });
    });

    await page.goto("/boards");
    await expect(page.getByTestId("create-board")).toHaveText("Sign in to create");
    // The button is a sign-in, so nothing is created and no 401 is provoked.
    expect(posted).toBe(false);
  });

  test("creating a draft offers sign-in instead of failing", async ({ page }) => {
    await page.goto("/draft/new");
    await expect(page.getByTestId("start-draft")).toHaveText("Sign in to draft");
  });

  test("the callback page explains a failure instead of hanging", async ({ page }) => {
    await page.goto("/auth/callback");
    await expect(page.getByTestId("auth-error")).toBeVisible();
    await expect(page.getByRole("link", { name: "← Back to PerfectPick" })).toBeVisible();
  });
});

test.describe("signed in", () => {
  test("the nav shows who you are", async ({ page }) => {
    await signIn(page);
    await page.goto("/boards");
    await expect(page.getByTestId("auth-user")).toHaveText("me@example.com");
  });

  test("requests carry the bearer token", async ({ page }) => {
    await signIn(page);
    let headers = null;
    await page.route("**/players*", (route) => {
      headers = route.request().headers();
      return route.fulfill({ json: { players: [] } });
    });

    await page.goto("/boards");
    await page.waitForTimeout(300);

    if (headers) {
      expect(headers["authorization"]).toBe(`Bearer ${ID_TOKEN}`);
    }
  });

  test("creating a board is offered again", async ({ page }) => {
    await signIn(page);
    await page.goto("/boards");
    await expect(page.getByTestId("create-board")).toHaveText("+ New board");
  });

  test("signing in claims the boards this browser already made", async ({ page }) => {
    await signIn(page);
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "perfectpick.myBoards",
        JSON.stringify([{ id: "b-old", name: "Old", format: "ppr" }])
      );
    });

    let claimed = null;
    await page.route("**/me/claim", (route) => {
      claimed = route.request().postDataJSON();
      return route.fulfill({
        json: { claimed: { drafts: [], boards: ["b-old"] }, skipped: { drafts: [], boards: [] } },
      });
    });

    await page.goto("/boards");
    await expect.poll(() => claimed).not.toBeNull();
    expect(claimed.boardIds).toContain("b-old");
  });

  test("a draft opened from someone else's link is not claimed", async ({ page }) => {
    await signIn(page);
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "perfectpick.myDrafts",
        JSON.stringify([
          { id: "d-mine", owned: true, teams: 12, rounds: 15, format: "ppr", userTeam: 1 },
          { id: "d-theirs", owned: false, teams: 12, rounds: 15, format: "ppr", userTeam: 1 },
        ])
      );
    });

    let claimed = null;
    await page.route("**/me/claim", (route) => {
      claimed = route.request().postDataJSON();
      return route.fulfill({
        json: { claimed: { drafts: ["d-mine"], boards: [] }, skipped: { drafts: [], boards: [] } },
      });
    });

    await page.goto("/drafts");
    await expect.poll(() => claimed).not.toBeNull();
    expect(claimed.draftIds).toEqual(["d-mine"]);
  });
});
```

- [ ] **Step 4: Sign in wherever a spec creates something**

Add `import { signIn } from "./auth.js";` and `await signIn(page);` before the
navigation that precedes each create click:

- `frontend/tests/newdraft.spec.js:41` and `:51`
- `frontend/tests/slot.spec.js:39`
- `frontend/tests/boarddraft.spec.js:45` and `:61`
- `frontend/tests/mydrafts.spec.js:477`
- `frontend/tests/sleeper.spec.js:82` and `:98`
- `frontend/tests/board.spec.js` — wherever `create-board` is clicked

`signIn` uses `addInitScript`, so it must be called **before** the `page.goto`
whose page state it applies to.

- [ ] **Step 5: Run the e2e suite**

Run: `cd frontend && npm test`
Expected: PASS. Two categories of expected failure to fix as you go:
1. A spec that clicks a create button without signing in — add `signIn`.
2. A spec asserting the nav has no auth controls — the test build is now
   configured, so it does. Update the expectation.

- [ ] **Step 6: Refresh the screenshots**

The nav now carries a sign-in control in every screenshot, and `newdraft.png`
shows the gated button. The screenshot tests write straight into
`../../screenshots`, so Step 5 has already regenerated them.

Run: `git status --short screenshots`
Expected: modified PNGs.

Review them (`open screenshots/newdraft.png screenshots/boards.png`) and
confirm the nav renders correctly signed out, then include them in the commit.

- [ ] **Step 7: Commit**

```bash
git add frontend/playwright.config.js frontend/tests screenshots
git commit -m "test: sign-in is mocked, not driven, and every create path signs in first"
```

---

### Task 9: Say what changed, for whoever deploys it

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document that sign-in is now required to create**

Under the existing "Sign in with Google" section in `README.md`, replace the
sentence explaining that auth is optional with the Phase 2 reality:

```markdown
Signing in is **required to create** a draft or a board, and to change or
delete one you own. Viewing stays open to anyone with the link: a shared draft
opens for a signed-out visitor, who simply cannot change it.

Because the API's authorizer references the Cognito user pool, the four steps
below are no longer optional — a deploy without `GoogleClientId` and
`GoogleClientSecret` now fails at CloudFormation rather than quietly shipping
an API that accepts anonymous writes.
```

- [ ] **Step 2: Document what happens to drafts made before accounts existed**

Add after the four setup steps:

```markdown
**What happens to drafts and boards made before accounts existed**

They have no owner, so they are readable but frozen: the links still open, and
nothing is deleted, but picks and edits are refused until somebody claims them.
Signing in claims them automatically — the browser sends the ids it recorded as
its own creations to `POST /me/claim`, and each is adopted only if nobody owns
it yet. A draft you opened from somebody else's link is never sent.

Somebody who is mid-draft and never signs in cannot finish that draft. That is
the direct cost of requiring an owner from birth, and it is worth knowing
before you deploy rather than after.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: sign-in is required to create, and what that means for old drafts"
```

---

## Final verification

- [ ] `cd backend/src && npm test` — all backend tests, including
      `template.test.js`'s route enumeration and the three-angle route tests.
- [ ] `cd backend && sam validate --lint` — the template is valid.
- [ ] `cd frontend && npm run lint` — clean.
- [ ] `cd frontend && npm run test:unit` — all frontend unit tests.
- [ ] `cd frontend && npm test` — the full Playwright suite, screenshots
      regenerated.
- [ ] `git status --short` — nothing unintended left behind.

**Deploy is a separate, manual step and is blocked on the Google setup.** Do
not deploy this phase until `README.md`'s four sign-in steps are complete;
until then `sam deploy` will correctly refuse for want of `GoogleClientId`.
