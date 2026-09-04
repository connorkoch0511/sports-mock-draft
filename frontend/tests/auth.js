export const AUTHORITY =
  "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test";
export const CLIENT_ID = "test-client-id";
export const ID_TOKEN = "test-id-token";

/**
 * Sign in without Cognito.
 *
 * oidc-client-ts reads its session from this one localStorage key, so writing
 * it before the app boots is a complete sign-in as far as the app is
 * concerned. `expires_at` is far in the future because an expired user is
 * treated as signed out.
 */
// The default address is shown in the nav of every screenshot taken while
// signed in, and those ship in the README -- so it reads as an illustration
// rather than as leftover test scaffolding. example.com is reserved for
// exactly this (RFC 2606).
export async function signIn(page, { sub = "user-me", email = "you@example.com" } = {}) {
  const key = `oidc.user:${AUTHORITY}:${CLIENT_ID}`;
  const value = JSON.stringify({
    id_token: ID_TOKEN,
    access_token: "test-access-token",
    token_type: "Bearer",
    scope: "openid email profile",
    profile: { sub, email },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  await page.addInitScript(
    ([k, v]) => window.localStorage.setItem(k, v),
    [key, value]
  );

  // Signing in triggers a claim of whatever this browser made. Every spec that
  // signs in would otherwise see an unmocked request to a dead API base.
  await page.route("**/me/claim", (route) =>
    route.fulfill({
      json: { claimed: { drafts: [], boards: [] }, skipped: { drafts: [], boards: [] } },
    })
  );
}
