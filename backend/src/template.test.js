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
  // Without this, the two "no route escapes the authorizer" assertions below
  // pass vacuously whenever extraction returns nothing -- a renamed Resources
  // key, a restructured template, a parse that degrades a block to a scalar.
  // An empty result means the test lost sight of the routes, which is exactly
  // when it must fail rather than go green.
  assert.ok(
    rows.length >= 12,
    `expected at least 12 HttpApi routes, extracted ${rows.length}`
  );
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
    "POST /drafts/{draftId}/expire",
    "POST /drafts/{draftId}/join",
    "POST /drafts/{draftId}/pause",
    "POST /drafts/{draftId}/pick",
    "POST /drafts/{draftId}/seat-board",
    "POST /drafts/{draftId}/sim-to-end",
    "POST /yahoo/leagues",
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

test("the Yahoo client secret is NoEcho", () => {
  const tpl = loadTemplate();
  assert.strictEqual(tpl.Parameters.YahooClientSecret.NoEcho, true);
});

test("POST /yahoo/leagues requires a signed-in user", () => {
  const tpl = loadTemplate();
  const ev = tpl.Resources.YahooFunction.Properties.Events;
  const route = Object.values(ev).find((e) => e.Properties.Path === "/yahoo/leagues");
  assert.strictEqual(route.Properties.Auth.Authorizer, "CognitoAuth");
});

test("POST /drafts/{draftId}/join requires a signed-in user", () => {
  const tpl = loadTemplate();
  const ev = tpl.Resources.DraftsFunction.Properties.Events;
  const route = Object.values(ev).find((e) => e.Properties.Path === "/drafts/{draftId}/join");
  assert.strictEqual(route.Properties.Auth.Authorizer, "CognitoAuth");
});

test("the members table is keyed by person and draft", () => {
  const tpl = loadTemplate();
  const keys = tpl.Resources.DraftMembersTable.Properties.KeySchema;
  assert.deepStrictEqual(keys, [
    { AttributeName: "sub", KeyType: "HASH" },
    { AttributeName: "draftId", KeyType: "RANGE" },
  ]);
});

// The fetch abort inside the handler must fire before the platform kills the
// invocation, or the friendly timeout message can never be sent.
test("the Yahoo function outlives its own fetch timeout", () => {
  const tpl = loadTemplate();
  const fnTimeout = tpl.Resources.YahooFunction.Properties.Timeout;
  const globalTimeout = tpl.Globals.Function.Timeout;
  assert.ok(fnTimeout > globalTimeout, "it must override the global, not inherit it");
  // 8s per fetch, and Task 6 adds a second sequential call after the exchange.
  assert.ok(fnTimeout >= 20, `expected room for two 8s fetches, got ${fnTimeout}`);
});

test("the drafts table has a sparse clock index", () => {
  const tpl = loadTemplate();
  const t = tpl.Resources.DraftsTable.Properties;
  const gsi = (t.GlobalSecondaryIndexes || []).find((g) => g.IndexName === "byClock");
  assert.ok(gsi, "byClock index is missing");
  assert.deepEqual(
    gsi.KeySchema.map((k) => [k.AttributeName, k.KeyType]),
    [["clockRunning", "HASH"], ["pickDeadline", "RANGE"]]
  );
  assert.equal(gsi.Projection.ProjectionType, "KEYS_ONLY");
  // A key attribute with no definition is a deploy-time failure, not a
  // runtime one, so it never shows up in any other test.
  const defs = Object.fromEntries(t.AttributeDefinitions.map((a) => [a.AttributeName, a.AttributeType]));
  assert.equal(defs.clockRunning, "S");
  assert.equal(defs.pickDeadline, "N");
});

test("the clock runs on a schedule, in a real timezone", () => {
  const tpl = loadTemplate();
  const fn = tpl.Resources.ClockFunction;
  assert.ok(fn, "ClockFunction is missing");
  assert.equal(fn.Properties.Handler, "clock.handler");

  const events = Object.values(fn.Properties.Events || {});
  const sched = events.find((e) => e.Type === "ScheduleV2");
  // Type Schedule (EventBridge rules) cannot express a timezone, so a UTC
  // rule would drift by an hour twice a year. ScheduleV2 is not a style
  // preference here.
  assert.ok(sched, "the clock needs a ScheduleV2 event, not Schedule");
  assert.equal(sched.Properties.ScheduleExpression, "cron(* 8-23,0-1 * * ? *)");
  assert.equal(sched.Properties.ScheduleExpressionTimezone, "America/Los_Angeles");
});

test("the clock can read what it needs and write only drafts", () => {
  const tpl = loadTemplate();
  const policies = tpl.Resources.ClockFunction.Properties.Policies || [];
  const named = policies.map((p) => Object.keys(p)[0]);
  assert.ok(named.includes("DynamoDBCrudPolicy"), "needs write access to drafts");
  assert.ok(named.includes("DynamoDBReadPolicy"), "needs read access to players and boards");
  const env = tpl.Resources.ClockFunction.Properties.Environment.Variables;
  for (const k of ["DRAFTS_TABLE", "PLAYERS_TABLE", "BOARDS_TABLE"]) {
    assert.ok(env[k], `${k} is not passed to the clock`);
  }
});

test("a failing tick is not retried 185 times", () => {
  const tpl = loadTemplate();
  const events = Object.values(tpl.Resources.ClockFunction.Properties.Events || {});
  const sched = events.find((e) => e.Type === "ScheduleV2");
  // EventBridge Scheduler defaults to 185 attempts spread over 24 hours. The
  // clock runs every minute and its query is the same one next minute, so a
  // retry can only pile failures on top of a schedule that is already
  // retrying -- and the very first deploy guarantees failures, because the
  // byClock index is CREATING for minutes after the stack updates.
  assert.equal(sched.Properties.RetryPolicy?.MaximumRetryAttempts, 0);
});
