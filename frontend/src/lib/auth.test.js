import test from "node:test";
import assert from "node:assert";
import { isActive, idTokenOf, displayNameOf } from "./auth.js";

const user = (over = {}) => ({ expired: false, id_token: "tok", profile: {}, ...over });

// oidc-client-ts keeps an expired user in storage until renewal replaces it,
// so "a user exists" and "signed in" are different questions. Conflating them
// sends dead tokens on every request.
test("an expired user is not active", () => {
  assert.strictEqual(isActive(user()), true);
  assert.strictEqual(isActive(user({ expired: true })), false);
  assert.strictEqual(isActive(null), false);
  assert.strictEqual(isActive(undefined), false);
});

test("no token comes from an expired or absent user", () => {
  assert.strictEqual(idTokenOf(user()), "tok");
  assert.strictEqual(idTokenOf(user({ expired: true })), null);
  assert.strictEqual(idTokenOf(null), null);
});

test("a user with no id_token yields null, not undefined", () => {
  assert.strictEqual(idTokenOf(user({ id_token: undefined })), null);
});

test("the display name prefers email and never shows nothing", () => {
  assert.strictEqual(displayNameOf(user({ profile: { email: "a@b.com" } })), "a@b.com");
  assert.strictEqual(displayNameOf(user({ profile: { name: "Connor" } })), "Connor");
  assert.strictEqual(
    displayNameOf(user({ profile: { "cognito:username": "google_123" } })),
    "google_123"
  );
  assert.strictEqual(displayNameOf(user({ profile: {} })), "Signed in");
  assert.strictEqual(displayNameOf(null), null);
});
