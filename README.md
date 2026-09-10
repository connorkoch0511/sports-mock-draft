# PerfectPick — Fantasy Football Mock Draft Simulator

PerfectPick is built around the board, not the draft. Rank players your way,
then run your league's mock draft off your own board instead of the
consensus one — with the reasoning behind every recommended pick shown, not
hidden. Sign in, and your boards and drafts follow you to any device.

---

## Screenshots

### Home
![Home](screenshots/home.png)

The landing page a signed-out visitor sees: the pitch is the board, not the
draft engine underneath it.

### New Draft
![New Draft](screenshots/newdraft.png)

### Live Draft Board
![Draft](screenshots/draft.png)

### Player drill-down

Click any player — on the draft board or in a big board — for their season
line, a week-by-week game log, and the reasons the engine ranks them where it
does. Weeks they missed show as gaps rather than rows of zeroes, and a rookie's
empty log says so rather than claiming he sat out.

The same detail lives at `/player/:id`, so a player can be linked to directly.
That page carries no draft advice: the engine's reasons are about a decision at
a particular pick, and a standalone page has no pick to advise on.

![Player drill-down](screenshots/player.png)

### Draft Results
![Results](screenshots/results.png)

### Draft Analysis
![Analysis](screenshots/analysis.png)

### My Drafts
![My Drafts](screenshots/drafts.png)

### My Boards
![Boards](screenshots/boards.png)

### Board Editor
![Board](screenshots/board.png)

---

## Features

- **Sign-in Required** — Google sign-in via Cognito; drafts and boards are private to the people in them, not to anyone who merely has the link
- **Draft With Friends** — Share an invite link and whoever opens it takes an open seat in your draft, so everyone sees every pick as it happens. The clock isn't shared yet, so only whoever's turn it actually is sees a countdown
- **Custom Big Boards** — Rank players your way, save the board, and draft off it instead of the consensus order
- **Every source's ADP** — See our ADP, ESPN's and Yahoo's side by side while you rank and while you draft, so a player one service likes a round earlier than another is obvious. Our rank stays the default order; sort by any source when you want to
- **Share a Big Board** — Download a board as CSV or JSON and hand it to a friend, who imports it as their own copy to edit. Files carry player names as well as ids, so they are readable on their own and survive a player id changing between seasons; anyone missing from the new season's pool is reported by name rather than dropped in silence
- **Snake Draft Engine** — Round-by-round snake ordering with full persistence to DynamoDB
- **Big Board + Search** — Filter by position, search by name, and paginate through the full player pool
- **Smart Auto Picks** — Roster-aware auto picks weighted by ADP rank, position needs, and tier
- **60-Second Clock** — Countdown timer for Team 1; auto-picks on timeout
- **Sim to End** — Instantly simulate all remaining picks to complete a draft
- **Pause / Resume** — Freeze the draft clock at any time
- **Export** — Download your completed draft as CSV or JSON
- **ADP Formats** — Standard, Half PPR, and PPR scoring supported

---

## Tech Stack

### Frontend
| Tool | Version |
|------|---------|
| React | 19 |
| Vite | 7 |
| React Router | 7 |
| Tailwind CSS | 4 |

### Backend
| Service | Purpose |
|---------|---------|
| AWS Lambda (Node.js 20) | API handler functions |
| AWS DynamoDB | Draft and player persistence |
| AWS API Gateway (HTTP API) | REST API routing |
| AWS CloudFront | Static frontend hosting |
| AWS SAM | Infrastructure as code |

---

## Architecture

```
Browser (React + Vite)
    │
    │  HTTPS
    ▼
CloudFront (CDN)
    │
    ├─── Static assets (S3)
    │
    └─── API calls
          │
          ▼
    API Gateway (HTTP)
          │
          ├── GET  /players              → PlayersFunction
          ├── POST /drafts               → DraftsFunction
          ├── GET  /drafts/:id           → DraftsFunction
          ├── POST /drafts/:id/pick      → DraftsFunction
          ├── POST /drafts/:id/auto-pick → DraftsFunction
          └── POST /drafts/:id/sim-to-end→ DraftsFunction
                    │
                    ▼
              DynamoDB
              ├── perfectpick-drafts
              └── perfectpick-players
```

Player ADP data is synced nightly via a scheduled `SyncPlayersFunction` Lambda.

---

## Getting Started

### Prerequisites
- Node.js 20+
- AWS CLI configured with appropriate permissions
- AWS SAM CLI (for backend)

### Frontend

```bash
cd frontend
npm install

# Create a local env file pointing at your deployed API
echo "VITE_API_BASE_URL=https://your-api-gateway-url" > .env.local

npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Backend

`GoogleClientId`, `GoogleClientSecret`, `YahooClientId` and
`YahooClientSecret` have no default, so the deploy fails without them.
Complete the [Sign-in setup](#sign-in-setup-one-time-manual) section below
first if you haven't already; it walks through getting the Google pair.

```bash
cd backend
sam build
sam deploy --parameter-overrides \
  GoogleClientId=YOUR_CLIENT_ID \
  GoogleClientSecret=$(aws ssm get-parameter \
    --name /perfectpick/google-client-secret --with-decryption \
    --query Parameter.Value --output text) \
  YahooClientId=YOUR_YAHOO_CLIENT_ID \
  YahooClientSecret=$(aws ssm get-parameter \
    --name /perfectpick/yahoo-client-secret --with-decryption \
    --query Parameter.Value --output text)
```

**Not `sam deploy --guided`.** It offers to save your answers to
`backend/samconfig.toml`, which this repo tracks in git, and it writes
parameter values there in plaintext — `NoEcho` keeps the secret out of console
output and stack events, not out of that file. One prompt answered on autopilot
is all it takes to commit the secret. Pass the parameters explicitly instead,
the same way every deploy does.

The deploy outputs the `ApiBaseUrl` — use that as `VITE_API_BASE_URL`.

---

## Testing

Tests use [Playwright](https://playwright.dev) with fully mocked API routes — no live backend required.

```bash
cd frontend
npm test              # run all tests headlessly
npm run test:headed   # run with a visible browser
npm run test:ui       # open the Playwright interactive UI
```

Three suites run against this project:

| Suite | Command | What it covers |
|-------|---------|----------------|
| Backend unit | `cd backend/src && npm test` | Handlers, response shaping, gzip negotiation, DynamoDB pagination, roster and snake logic |
| Frontend unit | `cd frontend && npm run test:unit` | Pure modules — board ordering, draft analysis, the local registries, Sleeper mapping |
| End-to-end | `cd frontend && npm test` | Every page, driven through a real browser with the API mocked at the route level |

Screenshots are written to `screenshots/` on each end-to-end run, and the images
above come from that suite. When a change alters what a page looks like, rerun the
suite and commit the updated image so this README keeps matching the app.

---

## Sign-in setup (one-time, manual)

Signing in is **required for everything**, viewing included. `GET
/drafts/{draftId}` answers 401 with no token, and 404 unless the caller holds
a seat in that draft; `GET /boards/{boardId}` answers 404 unless the caller
is the board's owner. A draft or board's ID is not enough on its own —
knowing it only gets you in if you're already one of the people in it.

Because the API's authorizer references the Cognito user pool, the four steps
below are no longer optional — a deploy without `GoogleClientId` and
`GoogleClientSecret` now fails at CloudFormation rather than quietly shipping
an API that accepts anonymous writes.

**1. Create a Google OAuth client**

- Google Cloud Console → APIs & Services → Credentials → *Create credentials* →
  *OAuth client ID* → **Web application**.
- Configure the OAuth consent screen first if prompted (External, app name,
  your email). It can stay in Testing while only you sign in.
- Leave the redirect URI blank for now — the value depends on the Cognito
  domain, which does not exist yet.
- Note the **client ID** and **client secret**.

**2. Deploy with the credentials**

The secret must never enter git. Put it in SSM once:

```bash
aws ssm put-parameter --name /perfectpick/google-client-secret \
  --type SecureString --value 'THE_SECRET'
```

The Yahoo credential works the same way and is required by the same deploy,
whether or not you use the Yahoo import — the template has no default for it:

```bash
aws ssm put-parameter --name /perfectpick/yahoo-client-secret \
  --type SecureString --value 'THE_YAHOO_SECRET'
```

Then deploy, reading it back at deploy time:

```bash
cd backend
sam deploy --parameter-overrides \
  GoogleClientId=YOUR_CLIENT_ID \
  GoogleClientSecret=$(aws ssm get-parameter \
    --name /perfectpick/google-client-secret --with-decryption \
    --query Parameter.Value --output text) \
  YahooClientId=YOUR_YAHOO_CLIENT_ID \
  YahooClientSecret=$(aws ssm get-parameter \
    --name /perfectpick/yahoo-client-secret --with-decryption \
    --query Parameter.Value --output text)
```

**3. Point Google at Cognito**

The deploy prints `AuthDomain`. Back in the Google credential, add this as an
authorized redirect URI:

```
https://<AuthDomain>/oauth2/idpresponse
```

**4. Build the frontend with the pool details**

Add to `frontend/.env.production` (the deploy outputs give both values):

```
VITE_COGNITO_AUTHORITY=https://cognito-idp.us-east-1.amazonaws.com/<UserPoolId>
VITE_COGNITO_CLIENT_ID=<UserPoolClientId>
```

A build without these variables cannot create, edit, or delete anything, and
offers no way to sign in to fix that — every mutating call reaches the API
with no token and comes back 401. `npm run deploy` refuses to run without
both variables set, for exactly this reason.

**What happens to drafts and boards made before accounts existed**

A one-off script (`backend/src/scripts/purge-unowned.js`) deletes every draft
and board with no owner before this read gate ever ships, so there is nothing
left to adopt: every draft and board a signed-in caller can reach was owned
from the moment it was created.

Somebody who was mid-draft and never signed in does not come back to find it
frozen — the purge deletes the row outright, dump file aside, so there is
nothing left to resume. That is the direct cost of requiring an owner from
birth, and it is worth knowing before you run the purge rather than after.

## Deploying

### This release only: the order matters

Drafts and boards became private in this release, and two new routes appeared.
Deploying the halves in the wrong order breaks the live site, so once, in this
order:

```bash
# 1. See what the purge would delete. Read the drafts line: if `rows` and
#    `unowned` differ, stop -- owned rows without seats exist, and they would
#    be unopenable by their own owner. The script names them.
cd backend/src && node scripts/purge-unowned.js

# 2. Delete them. Irreversible. Keep the dump it writes to
#    ~/perfectpick-purge-backups somewhere durable.
node scripts/purge-unowned.js --confirm

# 3. Backend, which adds the two /me routes and one index per table.
cd .. && sam build && sam deploy --parameter-overrides \
  GoogleClientId=YOUR_CLIENT_ID \
  GoogleClientSecret=$(aws ssm get-parameter \
    --name /perfectpick/google-client-secret --with-decryption \
    --query Parameter.Value --output text) \
  YahooClientId=YOUR_YAHOO_CLIENT_ID \
  YahooClientSecret=$(aws ssm get-parameter \
    --name /perfectpick/yahoo-client-secret --with-decryption \
    --query Parameter.Value --output text)

# 4. Frontend, and not before step 3: the new bundle calls /me/drafts and
#    /me/boards on nearly every page, and they do not exist until the backend
#    update completes.
cd ../frontend && npm run deploy
```

Anyone signed in across the deploy keeps a valid token, but may hold the old
bundle until the CloudFront invalidation lands — their draft list will briefly
point at rows the purge removed. A reload fixes it.

### Frontend

```bash
cd frontend
npm run deploy
```

This builds the app, syncs to S3, and invalidates the CloudFront cache.

### Backend

`GoogleClientId`, `GoogleClientSecret`, `YahooClientId` and
`YahooClientSecret` have no default and are not saved in
`backend/samconfig.toml` — a secret can never live in a committed file, so all
four must be passed on every deploy, not just the first. A plain `sam deploy`
fails at CloudFormation for want of them, and it fails *after* the build,
which reads like a broken deploy rather than a missing argument.

**Run the purge first, before this deploy, the first time you ship the read
gate.** `backend/src/scripts/purge-unowned.js` deletes every unowned draft
and board (dry run by default; `--confirm` to actually delete). It has to run
before `sam deploy` puts the Cognito authorizer in front of `GET
/drafts/{draftId}` and `GET /boards/{boardId}` — once that gate is live,
unowned rows are unreachable through the API, and the script's own dump file
is the only way to get them back.

```bash
cd backend/src
node scripts/purge-unowned.js              # dry run — read the counts
node scripts/purge-unowned.js --confirm    # dumps to disk, then deletes

cd ..
sam build
sam deploy --parameter-overrides \
  GoogleClientId=YOUR_CLIENT_ID \
  GoogleClientSecret=$(aws ssm get-parameter \
    --name /perfectpick/google-client-secret --with-decryption \
    --query Parameter.Value --output text) \
  YahooClientId=YOUR_YAHOO_CLIENT_ID \
  YahooClientSecret=$(aws ssm get-parameter \
    --name /perfectpick/yahoo-client-secret --with-decryption \
    --query Parameter.Value --output text)
```

### The scheduled clock

Every draft has a server-owned deadline. A browser calling `POST
/drafts/{id}/expire` asks the server to enforce it; `ClockFunction`
(`backend/src/clock.js`) asks the same question on a timer, so a draft with no
tab open still moves. It runs every minute from 08:00 to 01:59 Pacific, finds
due drafts through the sparse `byClock` index, and drains each one — picking
repeatedly, each pick consuming one expired minute, until the deadline catches
up with the present.

**Deploying it the first time needs the backfill.** Every draft written before
this feature has no `clockRunning` attribute, and the index is sparse, so the
scheduler would never see any of them — while looking, from every log and
every test, as though it worked. Once, after the deploy that creates the
index:

```bash
# Wait for the index. Every tick fails while it says CREATING.
aws dynamodb describe-table --table-name perfectpick-drafts --region us-east-1 \
  --query "Table.GlobalSecondaryIndexes[?IndexName=='byClock'].IndexStatus" --output text

cd backend/src
node scripts/backfillClockRunning.js            # dry run — read the counts
node scripts/backfillClockRunning.js --confirm  # writes clockRunning
```

The dry run's `to write` should be roughly the number of unfinished drafts. It
also names, in full and uncapped, any draft that qualifies for the clock but
has no usable `pickDeadline`: `byClock` is a composite index and DynamoDB will
not project an item missing either key, so those drafts need a real deadline
before they can ever be indexed. That list is a to-do list, which is why it is
not truncated the way the other id listings are.

**Reading its log.** No function in `template.yaml` sets `FunctionName`, so
CloudFormation generates one — `/aws/lambda/sports-mock-draft-ClockFunction`
does not resolve. Ask the stack:

```bash
CLOCK_FN=$(aws cloudformation describe-stack-resource --stack-name sports-mock-draft \
  --region us-east-1 --logical-resource-id ClockFunction \
  --query StackResourceDetail.PhysicalResourceId --output text)
aws logs tail "/aws/lambda/$CLOCK_FN" --since 15m --region us-east-1 --format short | grep "clock run"
```

One line per run: `due`, `advanced`, `picks`, then every non-pick outcome
counted separately — `raced`, `ineligible`, `evicted`, `emptyPool`, `failed`,
`deferred`. `raced` and `ineligible` are the system working. A `failed` or
`emptyPool` that repeats tick after tick is a poisoned draft worth finding.
`deferred` is the work-left-over number: it covers a draft this run never
reached at all *and* one whose drain ran out of time budget partway through,
however many picks that drain already made — either way it is still waiting
for the next tick, and a `deferred` that keeps climbing means runs are
truncating, not just idling.

**The kill switch.** The clock writes to live drafts on a timer, so know how
to stop it before you need to:

```bash
# The `[0]` picks the first match: with more than one schedule containing
# "Clock", plain `--output text` would return their names tab-separated and
# break the --name argument below, so verify CLOCK_SCHED by hand if you have
# more than one candidate.
CLOCK_SCHED=$(aws scheduler list-schedules --region us-east-1 \
  --query "Schedules[?contains(Name,'Clock')].Name | [0]" --output text)

# UpdateSchedule is a full replacement, not a patch: `--state DISABLED` alone
# is rejected for want of --schedule-expression, --flexible-time-window and
# --target, so read the current definition and hand it back unchanged.
CUR=$(aws scheduler get-schedule --name "$CLOCK_SCHED" --region us-east-1)
aws scheduler update-schedule --region us-east-1 --name "$CLOCK_SCHED" --state DISABLED \
  --schedule-expression "$(jq -r .ScheduleExpression <<<"$CUR")" \
  --schedule-expression-timezone "$(jq -r .ScheduleExpressionTimezone <<<"$CUR")" \
  --flexible-time-window "$(jq -c .FlexibleTimeWindow <<<"$CUR")" \
  --target "$(jq -c .Target <<<"$CUR")"
```

`--state ENABLED` the same way turns it back on, and the next `sam deploy`
restores whatever the template says — this is an incident switch, not a
configuration change. To stop it *this second* without a schedule definition:

```bash
CLOCK_FN=$(aws cloudformation describe-stack-resource --stack-name sports-mock-draft \
  --region us-east-1 --logical-resource-id ClockFunction \
  --query StackResourceDetail.PhysicalResourceId --output text)
aws lambda put-function-concurrency --region us-east-1 \
  --function-name "$CLOCK_FN" --reserved-concurrent-executions 0
# undo: aws lambda delete-function-concurrency --function-name "$CLOCK_FN" --region us-east-1
```

Either way, deadlines stay exactly where they are and browsers calling
`/expire` keep enforcing the clock on their own.

---

## Project Structure

```
sports-mock-draft/
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Home.jsx             # Chooses: Landing signed out, Dashboard signed in
│   │   │   ├── Landing.jsx          # The signed-out front door
│   │   │   ├── Dashboard.jsx        # Your drafts and boards, from your account
│   │   │   ├── NewDraft.jsx         # Draft setup (manual + Sleeper import)
│   │   │   ├── Draft.jsx            # Live draft board
│   │   │   ├── Results.jsx          # Post-draft results and analysis
│   │   │   ├── Boards.jsx           # Your boards
│   │   │   ├── Board.jsx            # Single board editor (drag to reorder)
│   │   │   ├── MyDrafts.jsx         # Your drafts
│   │   │   ├── Player.jsx           # Player drill-down; the one public app page
│   │   │   └── AuthCallback.jsx     # Completes the Google redirect
│   │   ├── components/
│   │   │   ├── NavBar.jsx
│   │   │   ├── RequireAuth.jsx      # Gates a route, prompting in place
│   │   │   └── draft/               # Draft board panels, player modal
│   │   └── lib/
│   │       ├── api.js               # Fetch wrapper; attaches the id token
│   │       ├── auth.js              # oidc-client-ts setup, session helpers
│   │       ├── AuthProvider.jsx     # Publishes user, signedIn, sub, loading
│   │       ├── authContext.js       # The context and its hook, kept apart
│   │       ├── authGate.js          # mustSignIn: one rule, one place
│   │       ├── gatedRoutes.js       # gateState: allow / wait / prompt
│   │       ├── idToken.js           # Token holder, so api.js needs no React
│   │       ├── me.js                # GET /me/drafts, GET /me/boards
│   │       ├── sleeper.js           # Sleeper API client + mapping
│   │       ├── snake.js             # Snake draft order helpers
│   │       ├── boardOrder.js        # Board ordering helpers
│   │       ├── draftAnalysis.js     # Post-draft grading
│   │       ├── pickAdvice.js        # Pick-time advice engine
│   │       └── usePageTitle.js      # Per-page document titles
│   ├── scripts/
│   │   └── check-auth-env.js        # Refuses a deploy with no Cognito config
│   ├── tests/                       # Playwright end-to-end specs
│   └── playwright.config.js
├── backend/
│   ├── src/
│   │   ├── drafts.js          # Draft CRUD + snake engine + auto-pick logic
│   │   ├── boards.js          # Board CRUD
│   │   ├── players.js         # Player query handler
│   │   ├── me.js              # Your drafts and boards, by owner
│   │   ├── syncPlayers.js     # Nightly ADP, stats and game-log sync
│   │   ├── clock.js           # Scheduled: enforces deadlines with no browser open
│   │   ├── template.test.js   # Asserts every mutating route carries the authorizer
│   │   ├── lib/
│   │   │   ├── owner.js       # Who owns this, and who may act in it
│   │   │   ├── http.js        # Responses, CORS, gzip
│   │   │   ├── roster.js      # Roster slot logic
│   │   │   ├── advance.js     # The one conditional write that moves a draft
│   │   │   ├── autoPick.js    # Who gets picked, shared by the routes and the clock
│   │   │   └── reconcile.js   # Board-vs-pool reconciliation
│   │   └── scripts/
│   │       ├── purge-unowned.js        # One-off: delete rows nobody owns, dump first
│   │       └── backfillClockRunning.js # One-off: put existing drafts in the clock index
│   └── template.yaml          # SAM infrastructure definition
└── screenshots/               # Auto-generated by the test suite
```
