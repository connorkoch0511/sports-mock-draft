#!/usr/bin/env node
// Fails a deploy loudly when the Cognito variables are missing, instead of
// letting `npm run deploy` ship a build with no way to sign in.
//
// The backend now requires a signed-in caller for every mutation and fails
// closed (401/404) without one. The frontend used to fail open: no Sign in
// button, no token attached, and every create/pick/save/delete call to the
// API just 401s with no visible cause. This script is the frontend's half
// of "fail closed" -- it runs before the build even starts, so a clean
// checkout without the two Cognito variables never reaches S3.
//
// Deliberately dependency-free: this only needs to run in exactly one
// place (the start of `npm run deploy`), so pulling in dotenv for a format
// this simple would be a dependency to buy nothing.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REQUIRED_VARS = ["VITE_COGNITO_AUTHORITY", "VITE_COGNITO_CLIENT_ID"];

// A minimal KEY=VALUE reader, not a full .env parser: no quoting, no
// escapes, no multiline values, no export prefix. That is everything this
// repo's .env files use, and matching Vite's own (equally minimal) handling
// of these two variables is the point -- not building a general parser.
export function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of matching quotes, same as Vite/dotenv.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Merge `.env.production` and `.env.production.local` the way Vite does:
 * the `.local` file — never committed, per-machine — wins on conflicts.
 */
export function loadProductionEnv(dir) {
  const base = parseEnvFile(path.join(dir, ".env.production"));
  const local = parseEnvFile(path.join(dir, ".env.production.local"));
  return { ...base, ...local };
}

/** Which of REQUIRED_VARS are absent or blank in `env`. */
export function missingAuthVars(env) {
  return REQUIRED_VARS.filter((name) => !env[name] || !env[name].trim());
}

function main() {
  const frontendDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
  const env = loadProductionEnv(frontendDir);
  const missing = missingAuthVars(env);

  if (missing.length > 0) {
    console.error(
      [
        "",
        "Deploy blocked: missing Cognito configuration.",
        "",
        `  ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set in` +
          " frontend/.env.production (or .env.production.local).",
        "",
        "Without them, the build has no way to sign in, and every create, pick," +
          " save, and delete call now requires a signed-in caller -- the app",
        "would ship bricked for every mutation with no visible cause.",
        "",
        "See the README's \"Sign-in setup\" section for how to obtain and set" +
          " these two variables.",
        "",
      ].join("\n")
    );
    process.exit(1);
  }
}

// Only run as a CLI check, not on import -- the pure functions above are
// imported directly by this script's own tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
