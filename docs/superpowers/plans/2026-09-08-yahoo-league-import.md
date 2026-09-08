# Yahoo League Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up a mock draft from a real Yahoo league — teams, rounds, scoring, roster slots and your draft slot — without retyping any of it, and without storing anything about the Yahoo account.

**Architecture:** The person signs in at Yahoo and returns to a callback route with a one-time code. That code goes to a Lambda — the only place the client secret exists — which trades it for an access token, fetches the leagues, maps them onto the shape the New Draft form already understands, and discards the token. Nothing about the Yahoo account is persisted anywhere.

**Tech Stack:** React 19 + Vite + React Router (ESM, `node --test` for unit, Playwright for e2e), Node 22 CommonJS Lambda, AWS SAM.

## Global Constraints

- **Nothing about a Yahoo account is stored, ever.** No table, no token in the browser, no token in a response body, no token in a log line.
- The access token exists only inside a single Lambda invocation.
- **The client secret lives only in the Lambda.** It is a `NoEcho` template parameter read from SSM at deploy. It must never reach the browser and never enter git.
- **Never `sam deploy --guided`** — it offers to write parameter values into `backend/samconfig.toml`, which this repo tracks.
- `state` is a real CSRF guard: generated, stored, compared, and cleared. A callback whose `state` does not match is refused before its code is sent anywhere.
- Yahoo import maps onto the **existing** shape `toDraftConfig` produces: `{ teams, rounds, format, rosterSlots, userTeam, leagueName }`. No second vocabulary.
- Scoring collapses to the three formats the ADP data carries: `standard`, `half-ppr`, `ppr`.
- Declining at Yahoo is not an error and shows no error.
- Frontend is ESM, backend is CommonJS. Comments explain *why*.

---

## Why this plan stops at Task 5

Tasks 1 through 4 do not depend on any Yahoo response shape, so they can be
built and proven today. Task 5 captures real payloads and **requires the Yahoo
app to exist**, which only Connor can create.

The remaining work — the mapper and its wiring — is deliberately **not written
yet**. Writing it now would mean inventing Yahoo's field names and nesting,
which is precisely what the spec forbids building on, and the multi-source ADP
work is the evidence: two of its design decisions came from what live probes
returned and contradicted what would otherwise have been assumed. Task 5 ends
by extending this plan from real data.

## Prerequisite for Task 5 onwards (Connor)

1. Register a Yahoo developer app with **Fantasy Sports read** permission.
2. Redirect URI: `https://d2kf4b52rvabfv.cloudfront.net/yahoo/callback`.
3. `aws ssm put-parameter --name /perfectpick/yahoo-client-secret --type SecureString --value 'THE_SECRET'`
4. Note the client id — it is not secret and is passed as a plain parameter.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/lib/yahoo.js` (new) | The authorise URL, and `state`: make it, keep it, check it, clear it. No secret, no Yahoo calls. |
| `frontend/src/pages/YahooCallback.jsx` (new) | The `/yahoo/callback` route. Checks `state`, hands the code to our API, returns to New Draft with the leagues. |
| `frontend/src/App.jsx` | Registers the route. |
| `frontend/src/pages/NewDraft.jsx` | An *Import from Yahoo* panel beside Sleeper's, and the copy fix. |
| `backend/src/yahoo.js` (new) | `POST /yahoo/leagues`. The only holder of the client secret. |
| `backend/template.yaml` | The function, its route, and the two new parameters. |

---

### Task 1: `state`, and the authorise URL

**Files:**
- Create: `frontend/src/lib/yahoo.js`
- Test: `frontend/src/lib/yahoo.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `beginYahooAuth(clientId, redirectUri)` → the authorise URL as a string, having stored a fresh `state` in `sessionStorage` under the key `yahoo_oauth_state`.
  - `takeStoredState()` → the stored `state`, removing it. Returns `null` when absent.
  - `YAHOO_STATE_KEY` — the exact string `"yahoo_oauth_state"`.

**Background the implementer needs.** `state` is the whole CSRF defence for this flow. Without the check, someone can hand a person a crafted callback URL and have *their* Yahoo account imported into that person's session. It is generated with `crypto.randomUUID()`, kept in `sessionStorage` (not `localStorage` — it must not outlive the tab), and **removed when read**, so a callback cannot be replayed by going back.

`sessionStorage` throws in some privacy modes, so every access is wrapped. A failure to store must mean the flow refuses to start rather than continuing without a guard.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/yahoo.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { beginYahooAuth, takeStoredState, YAHOO_STATE_KEY } from "./yahoo.js";

// node:test has no browser storage, so stand one up.
function fakeSessionStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

test("the authorise url carries the parameters Yahoo needs", () => {
  globalThis.sessionStorage = fakeSessionStorage();
  const url = new URL(beginYahooAuth("client-123", "https://example.test/yahoo/callback"));

  assert.strictEqual(url.origin + url.pathname, "https://api.login.yahoo.com/oauth2/request_auth");
  assert.strictEqual(url.searchParams.get("client_id"), "client-123");
  assert.strictEqual(url.searchParams.get("redirect_uri"), "https://example.test/yahoo/callback");
  assert.strictEqual(url.searchParams.get("response_type"), "code");
  assert.ok(url.searchParams.get("state"), "a state must be present");
});

test("the state in the url is the state that was stored", () => {
  globalThis.sessionStorage = fakeSessionStorage();
  const url = new URL(beginYahooAuth("c", "https://example.test/cb"));
  assert.strictEqual(url.searchParams.get("state"), globalThis.sessionStorage.getItem(YAHOO_STATE_KEY));
});

// Two runs must not collide, or the guard proves nothing.
test("every attempt gets its own state", () => {
  globalThis.sessionStorage = fakeSessionStorage();
  const a = new URL(beginYahooAuth("c", "https://example.test/cb")).searchParams.get("state");
  const b = new URL(beginYahooAuth("c", "https://example.test/cb")).searchParams.get("state");
  assert.notStrictEqual(a, b);
});

// Reading consumes it, so a callback cannot be replayed by navigating back.
test("the stored state can only be taken once", () => {
  globalThis.sessionStorage = fakeSessionStorage();
  beginYahooAuth("c", "https://example.test/cb");
  const first = takeStoredState();
  assert.ok(first);
  assert.strictEqual(takeStoredState(), null);
});

test("no stored state reads as null rather than throwing", () => {
  globalThis.sessionStorage = fakeSessionStorage();
  assert.strictEqual(takeStoredState(), null);
});

// Privacy modes throw on storage. Starting a flow whose guard cannot be stored
// would leave the callback with nothing to compare against.
test("a storage that throws refuses to start the flow", () => {
  globalThis.sessionStorage = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };
  assert.throws(() => beginYahooAuth("c", "https://example.test/cb"), /could not start/i);
  assert.strictEqual(takeStoredState(), null);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — cannot find `./yahoo.js`.

- [ ] **Step 3: Implement**

Create `frontend/src/lib/yahoo.js`:

```js
/**
 * Starting the Yahoo sign-in, and the CSRF guard that makes it safe.
 *
 * No secret lives here and no Yahoo API is called from here. The browser's
 * only jobs are to send the person to Yahoo and to prove, when they come back,
 * that the reply belongs to the request this tab made.
 */

const AUTHORISE = "https://api.login.yahoo.com/oauth2/request_auth";

export const YAHOO_STATE_KEY = "yahoo_oauth_state";

// sessionStorage rather than localStorage: the guard has no business
// outliving the tab that created it. Both throw outright in some privacy
// modes, so every access is wrapped.
function store(value) {
  try {
    sessionStorage.setItem(YAHOO_STATE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function takeStoredState() {
  try {
    const value = sessionStorage.getItem(YAHOO_STATE_KEY);
    // Removed on read, so returning to the callback URL a second time cannot
    // replay it.
    sessionStorage.removeItem(YAHOO_STATE_KEY);
    return value;
  } catch {
    return null;
  }
}

export function beginYahooAuth(clientId, redirectUri) {
  const state = crypto.randomUUID();
  if (!store(state)) {
    // Refusing is the point. Sending someone to Yahoo with a state we cannot
    // check later means the callback has nothing to compare against, which is
    // the same as having no CSRF guard at all.
    throw new Error("Could not start Yahoo sign-in: this browser is blocking session storage.");
  }

  const url = new URL(AUTHORISE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd frontend && npm run test:unit`
Expected: PASS. Then `npm run lint` — clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/yahoo.js frontend/src/lib/yahoo.test.js
git commit -m "feat: the Yahoo authorise url, and its CSRF guard"
```

---

### Task 2: The callback route

**Files:**
- Create: `frontend/src/pages/YahooCallback.jsx`
- Modify: `frontend/src/App.jsx`
- Test: `frontend/tests/yahoo.spec.js`

**Interfaces:**
- Consumes: `takeStoredState`, `YAHOO_STATE_KEY` from `frontend/src/lib/yahoo.js` (Task 1); `apiPost` from `frontend/src/lib/api.js`.
- Produces: the route `/yahoo/callback`, which on success navigates to `/draft/new` with `state: { yahooLeagues }` — an array of draft configs that Task 4's panel renders.

**A trap this codebase has hit before.** React StrictMode double-invokes
effects in development, and `takeStoredState()` is a ONE-TIME read: the first
invocation consumes the state and the second finds nothing, so a perfectly
valid callback gets rejected. Guard the read with a `useRef` so it happens
once per mount. This project has met the same class of bug before, in
`AuthProvider`, where StrictMode masked a real ordering fault rather than
causing one — worth reading that file's comment.

**Background the implementer needs.** `frontend/src/pages/AuthCallback.jsx` is the existing Cognito callback and the pattern to follow — read it first, including its comment about why a failure must be visible ("a blank screen after clicking Sign in is indistinguishable from the app being broken"). The same reasoning applies here.

Declining at Yahoo is **not** an error: Yahoo returns with `error=access_denied` and the person simply goes back to New Draft with nothing shown. Only genuine failures show a message.

Register the route beside `/auth/callback` in `App.jsx`. It needs `RequireAuth`, because exchanging the code calls our API as the signed-in user.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/yahoo.spec.js`, following the mock/sign-in helpers the other specs use (`signIn` from `./auth.js`):

```js
import { test, expect } from "@playwright/test";
import { signIn } from "./auth.js";

const API = "http://localhost:9999";

// Puts a known state in the tab, so the callback has something to match.
async function seedState(page, value) {
  await page.addInitScript(
    ([v]) => window.sessionStorage.setItem("yahoo_oauth_state", v),
    [value]
  );
}

// What this route owns: verifying the state, sending the code, and handing the
// result on. RENDERING the leagues belongs to the New Draft panel, so this
// asserts the code reached our API and the person arrived where the panel
// lives -- not what that panel shows.
test("a callback whose state matches sends the code and returns to New Draft", async ({ page }) => {
  let sentCode = null;
  await page.route(`${API}/yahoo/leagues`, (r) => {
    sentCode = r.request().postDataJSON().code;
    return r.fulfill({ json: { leagues: [{ leagueName: "Dynasty", teams: 12, rounds: 15, format: "ppr", rosterSlots: [], userTeam: 3 }] } });
  });
  await seedState(page, "the-state");
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=the-state");

  await expect(page).toHaveURL(/\/draft\/new$/);
  await expect.poll(() => sentCode).toBe("abc");
  await expect(page.getByTestId("yahoo-error")).toHaveCount(0);
});

// The whole point of the guard: a crafted callback must not reach our API.
test("a callback whose state does not match is refused, and nothing is sent", async ({ page }) => {
  let called = false;
  await page.route(`${API}/yahoo/leagues`, (r) => { called = true; return r.fulfill({ json: { leagues: [] } }); });
  await seedState(page, "the-real-state");
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=an-attackers-state");

  await expect(page.getByTestId("yahoo-error")).toContainText(/could not be verified/i);
  expect(called).toBe(false);
});

// Changing your mind is not a failure.
test("declining at Yahoo returns quietly, with no error", async ({ page }) => {
  await signIn(page);
  await page.goto("/yahoo/callback?error=access_denied&state=whatever");

  await expect(page).toHaveURL(/\/draft\/new$/);
  await expect(page.getByTestId("yahoo-error")).toHaveCount(0);
});

test("a failure at our API says so rather than showing a blank page", async ({ page }) => {
  await page.route(`${API}/yahoo/leagues`, (r) => r.fulfill({ status: 502, json: { message: "Could not reach Yahoo just now" } }));
  await seedState(page, "s");
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=s");

  await expect(page.getByTestId("yahoo-error")).toContainText(/could not reach yahoo/i);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd frontend && npx playwright test tests/yahoo.spec.js --workers=1`
Expected: FAIL — the route does not exist.

- [ ] **Step 3: Implement**

Create `frontend/src/pages/YahooCallback.jsx`:

```jsx
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiPost } from "../lib/api";
import { takeStoredState } from "../lib/yahoo";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * Completes the return from Yahoo.
 *
 * Modelled on AuthCallback: a failure here must be visible, because a blank
 * screen after signing in is indistinguishable from the app being broken.
 */
export default function YahooCallback() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [err, setErr] = useState("");
  usePageTitle("Importing from Yahoo");

  useEffect(() => {
    let alive = true;
    const expected = takeStoredState();
    const code = params.get("code");
    const returned = params.get("state");

    // Declining is a choice, not a failure. Straight back, nothing said.
    if (params.get("error")) {
      nav("/draft/new", { replace: true });
      return;
    }

    // Compared before the code is sent anywhere: a crafted callback must not
    // reach our API at all, or it could import an attacker's leagues into
    // this person's session.
    if (!code || !returned || !expected || returned !== expected) {
      setErr("That Yahoo sign-in could not be verified. Please try again.");
      return;
    }

    apiPost("/yahoo/leagues", { code })
      .then((data) => {
        if (!alive) return;
        nav("/draft/new", { replace: true, state: { yahooLeagues: data.leagues || [] } });
      })
      .catch((e) => {
        if (alive) setErr(e.message || "Could not reach Yahoo just now");
      });

    return () => { alive = false; };
  }, [params, nav]);

  if (err) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div data-testid="yahoo-error" className="rounded-2xl border border-rose-800/40 bg-rose-950/20 px-4 py-3 text-sm text-rose-200">
          {err}
        </div>
      </div>
    );
  }

  return <div className="mx-auto max-w-2xl p-6 text-sm text-zinc-400">Importing your Yahoo leagues…</div>;
}
```

In `frontend/src/App.jsx`, add the import beside the other page imports and the route beside `/auth/callback`:

```jsx
              <Route path="/yahoo/callback" element={<RequireAuth><YahooCallback /></RequireAuth>} />
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx playwright test tests/yahoo.spec.js --workers=1`
Expected: PASS. Then `npm run lint` — clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/YahooCallback.jsx frontend/src/App.jsx frontend/tests/yahoo.spec.js
git commit -m "feat: the Yahoo callback route, and its state check"
```

---

### Task 3: The Lambda, and the secret

**Files:**
- Create: `backend/src/yahoo.js`
- Modify: `backend/template.yaml`
- Test: `backend/src/yahoo.test.js`, `backend/src/template.test.js`

**Interfaces:**
- Consumes: `subOf` from `backend/src/lib/owner.js`; the responder helper the other handlers use (read `backend/src/boards.js` for the exact import).
- Produces: `POST /yahoo/leagues`, taking `{ code }` and returning `{ leagues: [...] }`. In this task the fetching is stubbed behind `fetchLeagues(accessToken)`, which Task 6 fills in from real payloads.

**Background the implementer needs.** This is the only place the client secret exists. Read `backend/src/boards.js` for the handler shape (responder, method check, `subOf`, CORS) and mirror it.

The token exchange is standard OAuth2 and its shape is safe to rely on; Yahoo's *fantasy* endpoints are the unverified part, which is why they are not in this task.

`template.yaml` needs two new parameters mirroring the Google pair exactly — `YahooClientId` plain, `YahooClientSecret` with `NoEcho: true` and a description saying what `NoEcho` does and does not protect.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/yahoo.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");

function event(body, sub = "user-1") {
  return {
    requestContext: { http: { method: "POST" }, authorizer: { jwt: { claims: { sub } } } },
    body: JSON.stringify(body),
  };
}

test("a request without a code is refused", async () => {
  const { handler } = require("./yahoo");
  const res = await handler(event({}));
  assert.strictEqual(res.statusCode, 400);
});

test("a signed-out request is refused", async () => {
  const { handler } = require("./yahoo");
  const res = await handler({ requestContext: { http: { method: "POST" } }, body: "{}" });
  assert.strictEqual(res.statusCode, 401);
});

// The secret is the one thing that must never travel.
test("no response body ever carries the secret or the token", async () => {
  process.env.YAHOO_CLIENT_ID = "id";
  process.env.YAHOO_CLIENT_SECRET = "SUPER-SECRET";
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ access_token: "TOKEN-123" }) });
  try {
    const { handler } = require("./yahoo");
    const res = await handler(event({ code: "abc" }));
    assert.ok(!JSON.stringify(res).includes("SUPER-SECRET"), "the secret must not appear");
    assert.ok(!JSON.stringify(res).includes("TOKEN-123"), "the access token must not appear");
  } finally {
    global.fetch = realFetch;
  }
});

test("a rejected code exchange says the sign-in could not be confirmed", async () => {
  process.env.YAHOO_CLIENT_ID = "id";
  process.env.YAHOO_CLIENT_SECRET = "s";
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, text: async () => "invalid_grant" });
  try {
    const { handler } = require("./yahoo");
    const res = await handler(event({ code: "expired" }));
    assert.strictEqual(res.statusCode, 502);
    assert.match(JSON.parse(res.body).message, /could not confirm/i);
  } finally {
    global.fetch = realFetch;
  }
});
```

Add to `backend/src/template.test.js`, matching the style of its neighbours:

```js
test("the Yahoo client secret is NoEcho", () => {
  assert.strictEqual(template.Parameters.YahooClientSecret.NoEcho, true);
});

test("POST /yahoo/leagues requires a signed-in user", () => {
  const ev = template.Resources.YahooFunction.Properties.Events;
  const route = Object.values(ev).find((e) => e.Properties.Path === "/yahoo/leagues");
  assert.strictEqual(route.Properties.Auth.Authorizer, "CognitoAuth");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd backend/src && npm test`
Expected: FAIL — no `./yahoo` module, no `YahooFunction` resource.

- [ ] **Step 3: Implement**

Create `backend/src/yahoo.js`:

```js
// Trades a Yahoo authorisation code for the person's leagues.
//
// The only place the Yahoo client secret exists, and the only place a Yahoo
// access token exists. The token lives inside one invocation: it is never
// returned, never logged, and never written anywhere. That is the whole
// bargain this feature was designed around -- nothing about a Yahoo account
// is kept.

const { subOf } = require("./lib/owner");
const { responder } = require("./lib/http");  // responder(event) -> json(status, body)

const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const FETCH_TIMEOUT_MS = 10_000;

async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: process.env.YAHOO_CLIENT_ID,
    client_secret: process.env.YAHOO_CLIENT_SECRET,
  });

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!r.ok) {
    // Deliberately does not include Yahoo's body: it can echo the code back,
    // and a failed exchange is not the place to widen what we log.
    throw new Error(`exchange rejected: ${r.status}`);
  }
  const j = await r.json();
  if (!j.access_token) throw new Error("exchange returned no token");
  return j.access_token;
}

// Filled in by Task 6, from payloads captured against the real API. Kept
// separate so this handler's shape can be proven before Yahoo's is known.
async function fetchLeagues() {
  return [];
}

exports.handler = async (event) => {
  const json = responder(event);
  if (event.requestContext?.http?.method === "OPTIONS") return json(200, {});

  const sub = subOf(event);
  if (!sub) return json(401, { message: "Sign in first" });

  let code;
  try {
    ({ code } = JSON.parse(event.body || "{}"));
  } catch {
    return json(400, { message: "That request was not readable" });
  }
  if (!code) return json(400, { message: "No Yahoo authorisation code" });

  try {
    const token = await exchangeCode(code, process.env.YAHOO_REDIRECT_URI);
    return json(200, { leagues: await fetchLeagues(token) });
  } catch (e) {
    console.error("Yahoo import failed:", e.message);
    return json(502, { message: "Yahoo could not confirm that sign-in. It may have expired -- please try again." });
  }
};
```

In `backend/template.yaml`, add beside the Google parameters:

```yaml
  YahooClientId:
    Type: String
    Description: Yahoo OAuth client id. Not secret.
  YahooClientSecret:
    Type: String
    NoEcho: true
    Description: >
      Yahoo OAuth client secret. NoEcho keeps it out of console output and
      stack events -- it does NOT keep it out of samconfig.toml, which this
      repo tracks in git. Pass it explicitly at deploy, never with --guided.
```

And the function, mirroring `BoardsFunction`:

```yaml
  YahooFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: yahoo.handler
      Environment:
        Variables:
          YAHOO_CLIENT_ID: !Ref YahooClientId
          YAHOO_CLIENT_SECRET: !Ref YahooClientSecret
          YAHOO_REDIRECT_URI: "https://d2kf4b52rvabfv.cloudfront.net/yahoo/callback"
          ALLOWED_ORIGIN: "https://d2kf4b52rvabfv.cloudfront.net"
      Events:
        YahooLeagues:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /yahoo/leagues
            Method: POST
            Auth:
              Authorizer: CognitoAuth
```

- [ ] **Step 4: Run the tests**

Run: `cd backend/src && npm test`
Expected: PASS, including every existing test.

- [ ] **Step 5: Commit**

```bash
git add backend/src/yahoo.js backend/src/yahoo.test.js backend/src/template.test.js backend/template.yaml
git commit -m "feat: the Yahoo code exchange, behind our own sign-in"
```

---

### Task 4: The panel on New Draft

**Files:**
- Modify: `frontend/src/pages/NewDraft.jsx`
- Test: `frontend/tests/yahoo.spec.js`

**Interfaces:**
- Consumes: `beginYahooAuth` from `frontend/src/lib/yahoo.js` (Task 1); the `yahooLeagues` router state that `YahooCallback` navigates with (Task 2); the existing `applyLeague`-style handler that fills the form.
- Produces: `data-testid="yahoo-import"` (the button) and `data-testid="yahoo-leagues"` (the list).

**Background the implementer needs.** Read the *Import from Sleeper* panel in this file and mirror it — same shape, same list-of-leagues interaction, so the two read as siblings rather than two different ideas.

**The copy fix.** The Sleeper panel says *"Nothing is stored and no sign-in is needed."* That is true of Sleeper. Once a panel beside it requires signing in, that sentence reads as a claim about the page. Make it unmistakably about Sleeper. The Yahoo panel states its own bargain: Yahoo requires signing in, and nothing about the Yahoo account is kept.

The client id reaches the browser as a Vite env var (`import.meta.env.VITE_YAHOO_CLIENT_ID`); it is not secret. If it is absent, the panel explains the build is not configured for Yahoo rather than rendering a button that cannot work — the landing page has the same rule for Cognito, and the reasoning is in that code.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/yahoo.spec.js`:

```js
test("the Yahoo panel sends you to Yahoo with a state", async ({ page }) => {
  await signIn(page);
  await page.goto("/draft/new");

  // Catch the navigation rather than following it off-site.
  await page.route("https://api.login.yahoo.com/**", (r) => r.fulfill({ status: 200, body: "stub" }));
  await page.getByTestId("yahoo-import").click();

  await expect(page).toHaveURL(/api\.login\.yahoo\.com\/oauth2\/request_auth/);
  const url = new URL(page.url());
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.searchParams.get("response_type")).toBe("code");
});

test("leagues carried back from the callback are listed and apply to the form", async ({ page }) => {
  await page.route(`${API}/yahoo/leagues`, (r) =>
    r.fulfill({ json: { leagues: [{ leagueName: "Money League", teams: 10, rounds: 16, format: "half-ppr", rosterSlots: ["QB", "RB"], userTeam: 4 }] } })
  );
  await page.addInitScript(([v]) => window.sessionStorage.setItem("yahoo_oauth_state", v), ["s"]);
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=s");

  await expect(page.getByTestId("yahoo-leagues")).toContainText("Money League");
  await page.getByTestId("yahoo-leagues").getByRole("button", { name: /Money League/ }).click();

  // The same form the Sleeper import fills.
  await expect(page.getByLabel(/teams/i)).toHaveValue("10");
  await expect(page.getByLabel(/rounds/i)).toHaveValue("16");
});
```

```js
// An account with no NFL leagues is not an error, and must not read as one.
test("an account with no Yahoo leagues says so plainly", async ({ page }) => {
  await page.route(`${API}/yahoo/leagues`, (r) => r.fulfill({ json: { leagues: [] } }));
  await page.addInitScript(([v]) => window.sessionStorage.setItem("yahoo_oauth_state", v), ["s"]);
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=s");

  await expect(page.getByTestId("yahoo-leagues-empty")).toContainText(/no yahoo nfl leagues/i);
  await expect(page.getByTestId("yahoo-error")).toHaveCount(0);
});
```

(If the form's fields are not reachable by those labels, use whatever the existing Sleeper tests in `frontend/tests/sleeper.spec.js` use to assert the form filled — match that file, do not invent a new approach.)

- [ ] **Step 2: Run and watch it fail**

Run: `cd frontend && npx playwright test tests/yahoo.spec.js --workers=1`
Expected: FAIL — no `yahoo-import` control.

- [ ] **Step 3: Implement**

`applyLeague` currently fetches a Sleeper draft *and* applies the result. Yahoo
configs arrive already built, so split the applying half out and let both use
it — otherwise the two imports drift into filling the form two different ways:

```js
  // Both imports end here. Sleeper builds its config in the browser; Yahoo's
  // arrives already built from the Lambda. What they do with it is identical,
  // and that is worth keeping true in one place.
  const applyConfig = (cfg) => {
    setTeams(cfg.teams);
    setRounds(cfg.rounds);
    setFormat(cfg.format);
    setSlot(cfg.userTeam);
    setRandomSlot(false);
    setRosterSlots(cfg.rosterSlots);
    setImportedFrom(cfg.leagueName);
    setLeagues(null);
  };
```

Then `applyLeague` keeps its fetch and ends with `applyConfig(cfg)`.

Add the imports:

```js
import { useLocation } from "react-router-dom";
import { beginYahooAuth } from "../lib/yahoo";
```

And the state, reading what the callback navigated with:

```js
  const location = useLocation();
  const [yahooLeagues, setYahooLeagues] = useState(location.state?.yahooLeagues ?? null);
  const [yahooErr, setYahooErr] = useState("");
  const yahooClientId = import.meta.env.VITE_YAHOO_CLIENT_ID;
```

Render this panel immediately after the Sleeper one:

```jsx
      <div className="mb-6 max-w-2xl rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-5">
        <div className="text-sm font-semibold text-white">Import from Yahoo</div>
        <p className="mt-1 text-xs text-zinc-400">
          Yahoo needs you to sign in before it will show your leagues. Nothing about
          your Yahoo account is kept — the sign-in is used once and thrown away.
        </p>

        {!yahooClientId ? (
          // Same rule the landing page follows for sign-in: a button that
          // cannot work is worse than an explanation of why it is missing.
          <p className="mt-3 text-xs text-zinc-500">This build is not configured for Yahoo.</p>
        ) : (
          <button
            type="button"
            data-testid="yahoo-import"
            onClick={() => {
              try {
                window.location.assign(
                  beginYahooAuth(yahooClientId, `${window.location.origin}/yahoo/callback`)
                );
              } catch (e) {
                setYahooErr(e.message);
              }
            }}
            className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-600"
          >
            Sign in to Yahoo
          </button>
        )}

        {yahooErr && (
          <div data-testid="yahoo-panel-error" className="mt-3 text-sm text-rose-300">{yahooErr}</div>
        )}

        {yahooLeagues && yahooLeagues.length === 0 && (
          <p data-testid="yahoo-leagues-empty" className="mt-3 text-sm text-zinc-400">
            No Yahoo NFL leagues found for this season.
          </p>
        )}

        {yahooLeagues && yahooLeagues.length > 0 && (
          <ul data-testid="yahoo-leagues" className="mt-3 space-y-1">
            {yahooLeagues.map((cfg) => (
              <li key={cfg.leagueName}>
                <button
                  type="button"
                  onClick={() => { applyConfig(cfg); setYahooLeagues(null); }}
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-left text-sm text-zinc-200 hover:border-cyan-300/60"
                >
                  {cfg.leagueName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
```

**The copy fix.** In the Sleeper panel, change *"Nothing is stored and no sign-in is needed."* to *"Nothing is stored and no Sleeper sign-in is needed."* — one word, and the sentence stops reading as a claim about the page now that a panel beside it does require signing in.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx playwright test tests/yahoo.spec.js tests/sleeper.spec.js --workers=1`
Expected: PASS — including every existing Sleeper test, which must be untouched by this.

Then `npm run lint` — clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/NewDraft.jsx frontend/tests/yahoo.spec.js
git commit -m "feat: an Import from Yahoo panel beside Sleeper's"
```

---

### Task 5: Capture the real shapes, and extend this plan

**BLOCKED until the Yahoo app exists.** See *Prerequisite* above.

**Files:**
- Create: `backend/src/__fixtures__/yahoo-leagues.json`
- Modify: `docs/superpowers/specs/2026-09-08-yahoo-league-import-design.md`
- Modify: `docs/superpowers/plans/2026-09-08-yahoo-league-import.md` (this file)

**Background the implementer needs.** Everything the spec says about Yahoo's fantasy endpoints is a hypothesis. This task replaces hypotheses with captured facts, and it is the reason the mapper was not written in advance: the multi-source ADP work found that live probes contradicted two assumptions that looked obviously right, and building on those would have cost more than checking did.

- [ ] **Step 1: Complete the flow once, by hand**

With the app registered and deployed through Task 3, sign in at Yahoo and let the callback run. From the Lambda, log **only the response shape** — key names and nesting, never values, never the token.

- [ ] **Step 2: Capture a real leagues payload**

Save the JSON for a real account with at least one NFL league to
`backend/src/__fixtures__/yahoo-leagues.json`. **Before committing it, remove
anything identifying**: team and manager names, email addresses, Yahoo GUIDs.
Field *names* and structure are what the tests need; the values can be
replaced with obvious stand-ins.

- [ ] **Step 3: Correct the spec**

Update the *An honest limitation of this spec* section: replace each expected
endpoint and field with what Yahoo actually returns, and note anything that
differed. Say plainly which assumptions were wrong — the next person needs the
correction more than they need the reassurance.

- [ ] **Step 4: Extend this plan**

Write the remaining tasks from the captured payload:
- the pure mapper `backend/src/lib/yahooConfig.js`, producing exactly
  `{ teams, rounds, format, rosterSlots, userTeam, leagueName }`, unit-tested
  against the fixture;
- wiring it into `fetchLeagues` in `backend/src/yahoo.js`, replacing the stub;
- README, and a screenshot refresh for New Draft.

Two things the Sleeper mapper learned the hard way, which the mapper must
check against real data rather than assume:
- **rounds come from the draft, not the league** — Sleeper's
  `league.settings.draft_rounds` reads 3 for a 16-round draft;
- **scoring must collapse to `standard` / `half-ppr` / `ppr`**, and a Yahoo
  league can be scored in ways none of those describe;
- **which season to ask for.** `NewDraft.jsx` carries `SLEEPER_SEASON = 2026`,
  deliberately not `DRAFT_YEAR`, with a comment saying why: last year's leagues
  are different leagues. Yahoo needs that decision made explicitly rather than
  inherited, and the capture should confirm what Yahoo returns when a season's
  game key is not published yet.

- [ ] **Step 5: Commit**

```bash
git add backend/src/__fixtures__/yahoo-leagues.json docs/superpowers/specs/2026-09-08-yahoo-league-import-design.md docs/superpowers/plans/2026-09-08-yahoo-league-import.md
git commit -m "docs: real Yahoo shapes, and the tasks they make writable"
```

---

## Verification for Tasks 1-4

- [ ] `cd backend/src && npm test` — all pass, including `template.test.js`.
- [ ] `cd frontend && npm run test:unit` — all pass.
- [ ] `cd frontend && npm run lint` — clean.
- [ ] `cd frontend && npx playwright test --workers=1` — the full suite.
- [ ] `git status --short` — clean.

**Note on this machine:** Playwright browser launches and dev-server startup
time out under load. A `browserType.launch: Timeout` or a wave of
`ERR_CONNECTION_REFUSED` is the environment, not the code — re-run a red test
on its own before believing it.

**Deploying Tasks 1-4** touches both halves, and the backend needs the two new
parameters:

```bash
cd backend && sam build && sam deploy --parameter-overrides \
  GoogleClientId=... GoogleClientSecret=$(aws ssm get-parameter --name /perfectpick/google-client-secret --with-decryption --query Parameter.Value --output text) \
  YahooClientId=... YahooClientSecret=$(aws ssm get-parameter --name /perfectpick/yahoo-client-secret --with-decryption --query Parameter.Value --output text)
```

Never `--guided`.
