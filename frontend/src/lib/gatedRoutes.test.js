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
