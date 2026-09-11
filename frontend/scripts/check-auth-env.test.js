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

test("this repo's real .env.production, as committed, still carries the VAPID placeholder", () => {
  // A live tripwire, not just a unit test of the pure function: this fails
  // the moment someone fills in the real key without also updating this
  // test, which is exactly the deploy-time reminder this placeholder exists
  // to give in the first place.
  const repoFrontendDir = path.resolve(import.meta.dirname, "..");
  const env = loadProductionEnv(repoFrontendDir);
  assert.match(vapidWarning(env) || "", /placeholder/);
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
