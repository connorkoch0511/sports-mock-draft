// Trades a Yahoo authorisation code for the person's leagues.
//
// The only place the Yahoo client secret exists, and the only place a Yahoo
// access token exists. The token lives inside one invocation: it is never
// returned, never logged, and never written anywhere. That is the whole
// bargain this feature was designed around -- nothing about a Yahoo account
// is kept.

const { subOf } = require("./lib/owner");
const { responder } = require("./lib/http");  // responder(event) -> json(status, body)

const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const FETCH_TIMEOUT_MS = 10_000;

async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: process.env.YAHOO_CLIENT_ID,
    client_secret: process.env.YAHOO_CLIENT_SECRET,
  });

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!r.ok) {
    // Deliberately does not include Yahoo's body: it can echo the code back,
    // and a failed exchange is not the place to widen what we log.
    throw new Error(`exchange rejected: ${r.status}`);
  }
  const j = await r.json();
  if (!j.access_token) throw new Error("exchange returned no token");
  return j.access_token;
}

// Filled in by Task 6, from payloads captured against the real API. Kept
// separate so this handler's shape can be proven before Yahoo's is known.
async function fetchLeagues() {
  return [];
}

exports.handler = async (event) => {
  const json = responder(event);
  if (event.requestContext?.http?.method === "OPTIONS") return json(200, {});

  const sub = subOf(event);
  if (!sub) return json(401, { message: "Sign in first" });

  let code;
  try {
    ({ code } = JSON.parse(event.body || "{}"));
  } catch {
    return json(400, { message: "That request was not readable" });
  }
  if (!code) return json(400, { message: "No Yahoo authorisation code" });

  try {
    const token = await exchangeCode(code, process.env.YAHOO_REDIRECT_URI);
    return json(200, { leagues: await fetchLeagues(token) });
  } catch (e) {
    console.error("Yahoo import failed:", e.message);
    return json(502, { message: "Yahoo could not confirm that sign-in. It may have expired -- please try again." });
  }
};
