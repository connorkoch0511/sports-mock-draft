# Yahoo league import — design

**Status:** approved 8 September 2026. Implementation not started.

## Goal

Set up a mock draft from a real Yahoo league the way you already can from a
Sleeper one: teams, rounds, scoring, roster slots and your own draft slot,
without retyping any of it.

## What makes this different from Sleeper

Sleeper's read API needs no authentication and allows browser calls outright,
so `frontend/src/lib/sleeper.js` talks to it directly — no backend, no
credential, nothing stored. Yahoo requires OAuth. That single fact drives every
decision below.

**Nothing about a person's Yahoo account is stored. Ever.** Decided by Connor,
8 September 2026, over the two alternatives (a stored refresh token for
permanent connection, or a token held in the browser for the session). The
consequence is deliberate and load-bearing: because the access token is
discarded at the end of one request, everything the New Draft form needs must
be fetched inside that one request. Fetching league names now and each league's
settings later would need the token a second time, and there will not be one.

Importing again next month means signing in to Yahoo again. That is the price,
and it was chosen with the alternatives in front of us.

## Not in this project

- **ESPN.** Separate, later, and gated on a decision that has not been made:
  ESPN publishes no league API, and the usual route is undocumented endpoints
  driven by `SWID`/`espn_s2` cookies, which breaks whenever ESPN changes
  something and sits awkwardly against their terms. Yahoo first, deliberately,
  because Yahoo's API is real and documented.
- **Rosters, keepers, or a finished draft's results.** This imports league
  *settings* only, exactly as the Sleeper import does.
- **Any change to the Sleeper import**, beyond the copy fix noted below.

## Prerequisite, and only Connor can do it

A Yahoo developer app must exist before any of this runs:

1. Register an app at Yahoo's developer site with **Fantasy Sports read**
   permission.
2. Set its redirect URI to `https://d2kf4b52rvabfv.cloudfront.net/yahoo/callback`.
3. Put the client secret in SSM, mirroring the Google one:
   ```
   aws ssm put-parameter --name /perfectpick/yahoo-client-secret \
     --type SecureString --value 'THE_SECRET'
   ```
4. Deploy passes it the same way `GoogleClientSecret` is passed — a `NoEcho`
   template parameter read from SSM at deploy time, never committed.

**The client secret must never enter git.** `backend/samconfig.toml` is tracked
in this repo, and `sam deploy --guided` offers to write parameter values into
it in plaintext; `NoEcho` protects console output and stack events, not that
file. Pass parameters explicitly, exactly as the README already documents for
Google.

## An honest limitation of this spec

Every Yahoo endpoint, field name and response shape below is **unverified**.
Yahoo's league endpoints require credentials, so unlike the multi-source ADP
work — where both providers' public feeds were probed live before a line was
written, and two of the resulting design decisions came directly from what the
probes returned — nothing here could be checked first.

So the implementation's **first task is to verify the shapes against the real
API** and correct this document before building on it. Treat every endpoint
below as a starting hypothesis, not a fact. Where reality differs, reality
wins.

Expected, to be confirmed:

- Authorise: `https://api.login.yahoo.com/oauth2/request_auth` with
  `client_id`, `redirect_uri`, `response_type=code`, `state`.
- Exchange: `POST https://api.login.yahoo.com/oauth2/get_token` with
  `grant_type=authorization_code`, `code`, `redirect_uri`, and the client
  credentials.
- Leagues: the fantasy API's `users;use_login=1` collection, filtered to the
  NFL game, with league settings requested as a sub-resource so one call
  returns everything rather than one call per league.

The public Yahoo endpoint already used for ADP (`pub-api-ro.fantasysports…`)
is a different, unauthenticated service. It is not involved here.

## Architecture

```
New Draft page                Yahoo                 our API (Lambda)
     |                          |                          |
  [Import from Yahoo] --------->|                          |
     |                    sign in, approve                 |
     |<--- /yahoo/callback?code=…&state=… ---              |
     |                                                     |
     |------ POST /yahoo/leagues { code, state } --------->|
     |                                          exchange code for token
     |                                          fetch leagues + settings
     |                                          map onto draft configs
     |<---------------- [ { leagueName, teams, … } ] ------|
     |                                          token discarded
  pick a league -> the existing form fills in
```

The access token exists only inside one Lambda invocation. It is never
returned to the browser, never logged, and never written to any table.

### Components

| Piece | Responsibility |
|---|---|
| `frontend/src/lib/yahoo.js` (new) | Build the authorise URL, generate and check `state`, exchange the code through our API. No secret, no Yahoo API calls. |
| `frontend/src/pages/YahooCallback.jsx` (new) | The `/yahoo/callback` route. Reads `code` and `state`, hands them to the API, sends the person back to New Draft with the leagues. |
| `frontend/src/pages/NewDraft.jsx` | An *Import from Yahoo* panel beside the Sleeper one, reusing the same league-picker shape. |
| `backend/src/yahoo.js` (new) | `POST /yahoo/leagues`. The only place the client secret exists. Exchanges the code, fetches, maps, returns. |
| `backend/src/lib/yahooConfig.js` (new) | Pure: a Yahoo league and its draft onto the same shape `toDraftConfig` produces. Unit-tested against captured payloads. |

### The route

`POST /yahoo/leagues`, behind the existing `CognitoAuth` authorizer like every
other mutating route. You must be signed in to PerfectPick to use it — the
Yahoo sign-in is a second, separate thing, and neither substitutes for the
other.

## `state` is a real CSRF guard, not decoration

Generate a random value, keep it in `sessionStorage`, send it to Yahoo, and
**refuse the callback if what comes back does not match**. Without that check
an attacker can hand someone a crafted callback URL and have their own Yahoo
account imported into that person's session. The check belongs on the frontend,
before the code is ever sent to our API, and the value is cleared once used so
a callback cannot be replayed.

## Mapping onto the existing shape

`toDraftConfig(league, draft, userId)` in `frontend/src/lib/sleeper.js` already
defines the target: `{ teams, rounds, format, rosterSlots, userTeam,
leagueName }`. `yahooConfig.js` produces the same shape from Yahoo's data, so
the New Draft form does not learn a second vocabulary.

Two traps the Sleeper version already documents, which Yahoo will have its own
versions of and which the verification task must check:

- **Rounds come from the draft, not the league.** Sleeper's
  `league.settings.draft_rounds` reads 3 for a 16-round draft. Whatever Yahoo's
  equivalent is, confirm it against a real league rather than trusting its name.
- **Scoring collapses to the three formats our ADP data carries** — `standard`,
  `half-ppr`, `ppr`. Yahoo leagues can score in ways none of those describe;
  the mapping must pick the nearest and must not pretend otherwise.

## Errors, and what each says

Each failure names what went wrong, in terms of what the person did:

| What happened | What they see |
|---|---|
| They declined at Yahoo | The panel, unchanged, with no error — declining is not a failure |
| `state` does not match | That sign-in could not be verified, please try again |
| Code exchange rejected | Yahoo would not confirm that sign-in, which usually means it expired — try again |
| No NFL leagues on the account | No Yahoo NFL leagues found for this season |
| Yahoo unreachable or 5xx | Could not reach Yahoo just now |

A failure leaves the New Draft form exactly as it was. Nothing is half-applied.

## Copy that has to change

The Sleeper panel currently reads *"Nothing is stored and no sign-in is
needed."* That is true of Sleeper and will read as a claim about the whole page
once a panel beside it requires signing in. It must clearly belong to Sleeper.

The Yahoo panel states its own bargain plainly: signing in to Yahoo is
required, and nothing about the Yahoo account is kept.

## Testing

- `yahooConfig.js` is pure and unit-tested against **captured real payloads**,
  not hand-written shapes — the same rule the ADP adapters follow, and the one
  that caught a test which could not fail there.
- The `state` mismatch path has its own test. A CSRF guard nobody has watched
  reject anything is not yet a guard.
- End-to-end with Yahoo's endpoints mocked: the happy path, a declined
  sign-in, a mismatched `state`, an account with no leagues, and a Yahoo 500.
- A test that the client secret never appears in any response body.

## Risks

- **Nothing here is verified.** The largest risk on this project, addressed by
  making verification the first task rather than an assumption.
- **Yahoo's JSON is awkward** — the ADP work already met its irregular nesting
  (numeric string keys, arrays of mixed objects) and flattens defensively
  rather than indexing fixed paths. The same approach applies, and
  `backend/src/sync/adpYahoo.js` is the working precedent to copy.
- **A second sign-in is a real cost to the person**, accepted deliberately in
  exchange for storing nothing.
- **Yahoo could change or withdraw the API.** If it does, this feature stops
  and the Sleeper import is unaffected.
