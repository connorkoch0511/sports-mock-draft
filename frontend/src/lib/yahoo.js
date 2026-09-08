/**
 * Starting the Yahoo sign-in, and the CSRF guard that makes it safe.
 *
 * No secret lives here and no Yahoo API is called from here. The browser's
 * only jobs are to send the person to Yahoo and to prove, when they come back,
 * that the reply belongs to the request this tab made.
 */

const AUTHORISE = "https://api.login.yahoo.com/oauth2/request_auth";

export const YAHOO_STATE_KEY = "yahoo_oauth_state";

// sessionStorage rather than localStorage: the guard has no business
// outliving the tab that created it. Both throw outright in some privacy
// modes, so every access is wrapped.
function store(value) {
  try {
    sessionStorage.setItem(YAHOO_STATE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function takeStoredState() {
  try {
    const value = sessionStorage.getItem(YAHOO_STATE_KEY);
    // Removed on read, so returning to the callback URL a second time cannot
    // replay it.
    sessionStorage.removeItem(YAHOO_STATE_KEY);
    return value;
  } catch {
    return null;
  }
}

export function beginYahooAuth(clientId, redirectUri) {
  const state = crypto.randomUUID();
  if (!store(state)) {
    // Refusing is the point. Sending someone to Yahoo with a state we cannot
    // check later means the callback has nothing to compare against, which is
    // the same as having no CSRF guard at all.
    throw new Error("Could not start Yahoo sign-in: this browser is blocking session storage.");
  }

  const url = new URL(AUTHORISE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}
