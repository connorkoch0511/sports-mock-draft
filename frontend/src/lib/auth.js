import { UserManager, WebStorageStateStore } from "oidc-client-ts";

/**
 * Sign-in, built on Cognito's hosted pages and Google.
 *
 * PKCE, the state parameter, the code exchange and silent renewal all come
 * from oidc-client-ts rather than from code here. Those are the parts of an
 * OAuth flow that are easy to get subtly wrong and impossible to notice when
 * you have, which is the same reason the API verifies tokens with API
 * Gateway's native authorizer instead of by hand.
 */
// `import.meta.env` exists under Vite and nowhere else. Reading through a
// fallback keeps this module importable by the unit tests, which run in plain
// Node -- otherwise the pure helpers below could not be tested at all.
const env = (typeof import.meta !== "undefined" && import.meta.env) || {};

const authority = env.VITE_COGNITO_AUTHORITY;
const clientId = env.VITE_COGNITO_CLIENT_ID;

/**
 * Auth is optional configuration, not a requirement to run the app.
 *
 * A build without the Cognito variables is a perfectly good build: the app
 * works signed out, the nav shows nothing, and no request carries a token.
 * Throwing here would make a missing variable break every page rather than
 * hide one button.
 */
export const isAuthConfigured = Boolean(authority && clientId);

let manager = null;

export function getUserManager() {
  if (!isAuthConfigured) return null;
  if (manager) return manager;

  manager = new UserManager({
    authority,
    client_id: clientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: window.location.origin,
    response_type: "code",
    scope: "openid email profile",
    // Survives a reload: without a persistent store, refreshing the page
    // signs you out, which reads as the session randomly dropping.
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    automaticSilentRenew: true,
  });
  return manager;
}

/**
 * A user is only usable if they exist and their token has not expired.
 *
 * oidc-client-ts keeps an expired user in storage until renewal replaces it,
 * so `user != null` is not the same question as "signed in". Treating the two
 * as one sends expired tokens on every request and gets 401s that look like a
 * server fault.
 */
export function isActive(user) {
  return Boolean(user && !user.expired);
}

export function idTokenOf(user) {
  return isActive(user) ? user.id_token ?? null : null;
}

/** The label shown in the nav: email if we have it, else a stable fallback. */
export function displayNameOf(user) {
  if (!isActive(user)) return null;
  const p = user.profile || {};
  return p.email || p.name || p["cognito:username"] || "Signed in";
}
