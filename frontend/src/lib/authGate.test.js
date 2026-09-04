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
