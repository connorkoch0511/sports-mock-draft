import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseEnvFile,
  loadProductionEnv,
  missingAuthVars,
  vapidWarning,
  REQUIRED_VARS,
  VAPID_PLACEHOLDER,
} from "./check-auth-env.js";

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "check-auth-env-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseEnvFile reads KEY=VALUE pairs, skipping blanks and comments", () => {
  withTempDir((dir) => {
    const file = path.join(dir, ".env.production");
    writeFileSync(
      file,
      [
        "# a comment",
        "",
        "VITE_API_BASE_URL=https://example.com",
        'VITE_COGNITO_CLIENT_ID="quoted-value"',
        "VITE_COGNITO_AUTHORITY='single-quoted'",
      ].join("\n")
    );

    assert.deepStrictEqual(parseEnvFile(file), {
      VITE_API_BASE_URL: "https://example.com",
      VITE_COGNITO_CLIENT_ID: "quoted-value",
      VITE_COGNITO_AUTHORITY: "single-quoted",
    });
  });
});

test("parseEnvFile returns an empty object for a file that does not exist", () => {
  withTempDir((dir) => {
    assert.deepStrictEqual(parseEnvFile(path.join(dir, "nope.env")), {});
  });
});

test("loadProductionEnv lets .env.production.local override .env.production", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, ".env.production"),
      "VITE_API_BASE_URL=https://prod.example.com\nVITE_COGNITO_CLIENT_ID=base-client\n"
    );
    writeFileSync(
      path.join(dir, ".env.production.local"),
      "VITE_COGNITO_CLIENT_ID=local-client\n"
    );

    assert.deepStrictEqual(loadProductionEnv(dir), {
      VITE_API_BASE_URL: "https://prod.example.com",
      VITE_COGNITO_CLIENT_ID: "local-client",
    });
  });
});

test("missingAuthVars reports both variables when neither is set", () => {
  assert.deepStrictEqual(missingAuthVars({}), REQUIRED_VARS);
});

test("missingAuthVars reports nothing when both are set and non-empty", () => {
  assert.deepStrictEqual(
    missingAuthVars({
      VITE_COGNITO_AUTHORITY: "https://cognito-idp.us-east-1.amazonaws.com/pool",
      VITE_COGNITO_CLIENT_ID: "abc123",
    }),
    []
  );
});

test("missingAuthVars treats a blank or whitespace-only value as missing", () => {
  assert.deepStrictEqual(
    missingAuthVars({ VITE_COGNITO_AUTHORITY: "   ", VITE_COGNITO_CLIENT_ID: "abc" }),
    ["VITE_COGNITO_AUTHORITY"]
  );
});

test("vapidWarning flags a missing VITE_VAPID_PUBLIC_KEY, without listing it as a required var", () => {
  assert.match(vapidWarning({}), /not set/);
  // Missing VAPID never joins REQUIRED_VARS -- it is a warning precisely
  // because, unlike Cognito, its absence does not brick the app.
  assert.deepStrictEqual(missingAuthVars({}), REQUIRED_VARS);
});

test("vapidWarning flags the committed placeholder specifically", () => {
  assert.match(
    vapidWarning({ VITE_VAPID_PUBLIC_KEY: VAPID_PLACEHOLDER }),
    /placeholder/
  );
});

test("vapidWarning is quiet once a real-looking key is set", () => {
  assert.strictEqual(
    vapidWarning({ VITE_VAPID_PUBLIC_KEY: "BEFjTTw8ptWBm3M3JCdpKrKIc0jDOG0ByKph4cqR86FjyqYLLq7Znva1a6wQVu0BPiw0cwXGN1Ih3UnDFoZv88o" }),
    null
  );
});

test("this repo's real .env.production, as committed, carries a real VAPID public key", () => {
  // This replaces the tripwire that used to assert the opposite. That test
  // existed to fire the moment somebody filled in the real key, as a
  // deploy-time reminder -- and it did exactly that, which is why this now
  // reads the other way round.
  //
  // It pins the property worth keeping: a VAPID public key is an
  // uncompressed P-256 point, so it decodes to 65 bytes beginning 0x04. A
  // truncated paste, a placeholder, or the private half committed here by
  // mistake all fail this -- and none of them would fail at deploy time,
  // because a wrong key is not a deploy error. It just means every
  // subscription is signed against a key the push service rejects and
  // nothing is ever delivered.
  const repoFrontendDir = path.resolve(import.meta.dirname, "..");
  const env = loadProductionEnv(repoFrontendDir);

  assert.strictEqual(vapidWarning(env), null, "the committed key must not warn");

  const key = env.VITE_VAPID_PUBLIC_KEY;
  const bytes = Buffer.from(key.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.strictEqual(bytes.length, 65, `expected 65 bytes, got ${bytes.length}`);
  assert.strictEqual(bytes[0], 4, "must be an uncompressed EC point (0x04)");
});

test("this repo's real .env.production, as committed, passes the check", () => {
  // The inverse of what this test asserted when it was written, and the
  // update its own comment asked for: back then the tracked .env.production
  // carried only VITE_API_BASE_URL, which was the bug. The pool details were
  // committed once the stack existed, and they are public identifiers -- the
  // app client is created with GenerateSecret: false -- so belonging in git
  // is the point, not an accident.
  //
  // Now it guards the other direction: removing either variable breaks every
  // mutation on the deployed site, and this fails before the deploy does.
  const repoFrontendDir = path.resolve(import.meta.dirname, "..");
  const env = loadProductionEnv(repoFrontendDir);
  assert.deepStrictEqual(missingAuthVars(env), []);
});
