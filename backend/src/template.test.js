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
