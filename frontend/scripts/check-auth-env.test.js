import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseEnvFile,
  loadProductionEnv,
  missingAuthVars,
  REQUIRED_VARS,
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
