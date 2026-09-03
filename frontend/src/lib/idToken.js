/**
 * The current id token, in one plain module.
 *
 * Deliberately not part of AuthContext: `api.js` makes requests from ordinary
 * functions with no React around them, and importing a component module there
 * would drag the whole provider into the request path. AuthContext publishes
 * into here; api.js reads from here; neither imports the other.
 */
let currentIdToken = null;

export function setCurrentIdToken(token) {
  currentIdToken = token ?? null;
}

/** The token to attach, or null when signed out or auth is unconfigured. */
export function getCurrentIdToken() {
  return currentIdToken;
}
