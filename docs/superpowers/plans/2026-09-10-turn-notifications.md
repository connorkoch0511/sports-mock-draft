# Turn Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell a drafter their turn has arrived, and tell them when the clock picked for them, without putting anything new in the path that makes a pick.

**Architecture:** A DynamoDB stream on the drafts table feeds a notifier Lambda. It compares the before and after images, decides who to tell and what, and sends web push. Subscriptions live in their own table. The service worker stays silent when a window on this origin is already focused, which is what makes notifying on every draft safe.

**Tech Stack:** AWS SAM (Lambda + DynamoDB Streams), Node 24 CommonJS backend tested with `node --test`, React 19 + Vite frontend, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-turn-notifications-design.md`

## Global Constraints

- **Nothing is added to the pick path.** `advanceDraft` and its conditional write are untouched by every task here. If a task seems to need a change there, stop and report.
- **A push failure must never fail a stream record.** DynamoDB retries a failed batch, and a retried batch re-notifies everyone in it. Catch per subscription.
- **An expired subscription is deleted, not retried.** Push services answer `404` or `410`; both mean gone.
- **A build with no `VITE_VAPID_PUBLIC_KEY` shows no notification control at all** — the same rule the landing page follows for sign-in, and the Yahoo panel for its client id.
- **Mutation-test every guard:** delete it, run the covering test, confirm **red**, restore, confirm **green**. Record the evidence.
- Backend CommonJS, frontend ESM. Never run `git stash`.
- Read printed Playwright totals rather than the exit code — this machine has reported a partial count with a zero exit, and a run spanning a laptop sleep will do it again.

## File Structure

- `backend/src/lib/autoPick.js` — *modify.* Mark the pick it writes.
- `backend/src/lib/notifyDecisions.js` — **new.** A pure function: two images in, a list of notifications out. No AWS, no network.
- `backend/src/notifier.js` — **new.** The stream handler: decisions in, web push out, dead subscriptions deleted.
- `backend/src/drafts.js` — *modify.* Two routes to store and remove a subscription.
- `backend/src/package.json` — *modify.* Add `web-push`, this project's first runtime dependency beyond the AWS SDK.
- `backend/template.yaml` — *modify.* A stream on the drafts table, the subscriptions table, `NotifierFunction`, two route events.
- `frontend/public/sw.js` — **new.** Show, focus-check, and click-through.
- `frontend/src/lib/push.js` — **new.** Subscribe, unsubscribe, and read the permission state.
- `frontend/src/pages/Draft.jsx` — *modify.* The control.

---

### Task 1: Mark the picks the clock makes

Everything else needs to tell "your turn began" from "we picked for you", and inferring it from images is guesswork.

**Files:**
- Modify: `backend/src/lib/autoPick.js`
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Produces: a pick written by the auto-pick path carries `auto: true`. A manual pick leaves the field absent.

- [ ] **Step 1: Record the baseline**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Write the pass count into the report.

- [ ] **Step 2: Write the failing tests**

Append to `backend/src/drafts.test.js`, following its existing conventions:

```js
test("a pick the clock makes is marked as automatic", async () => {
  const d = ownedDraft(ME.sub);
  let written = null;
  stubByTable({
    "drafts-test": { Item: d },
    "players-test": { Items: MOCK_POOL },
  });
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.UpdateExpression?.includes("picks = :p")) {
      written = cmd.input.ExpressionAttributeValues[":p"];
    }
    if (cmd?.input?.TableName === "players-test") return { Items: MOCK_POOL };
    return { Item: d };
  });

  await handler(evt("POST", "/drafts/d1/auto-pick", { draftId: "d1", claims: ME }));

  assert.equal(written[0].auto, true);
});

test("a pick a person makes is not marked automatic", async () => {
  const d = ownedDraft(ME.sub);
  let written = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.UpdateExpression?.includes("picks = :p")) {
      written = cmd.input.ExpressionAttributeValues[":p"];
    }
    if (cmd?.input?.TableName === "players-test") return { Items: MOCK_POOL };
    return { Item: d };
  });

  await handler(
    evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: MOCK_POOL[0].id }, claims: ME })
  );

  assert.equal(written[0].auto, undefined);
});
```

`MOCK_POOL` and `stubByTable` are this file's existing helpers — grep for a passing auto-pick test and copy how it seeds the player pool rather than inventing a fixture. If the existing tests use a different name, use theirs.

- [ ] **Step 3: Run them and watch them fail**

Run: `cd backend && node --test src/drafts.test.js 2>&1 | tail -10`
Expected: the first test FAILS (`undefined !== true`); the second PASSES already, pinning behaviour that must not change.

- [ ] **Step 4: Mark it**

In `backend/src/lib/autoPick.js`, beside where the pick is filled in:

```js
  d.picks[d.currentIndex].playerId = best.id;
  // Marked, not inferred. The notifier has to tell "your turn began" from
  // "the clock picked for you", and the only honest way to know is for the
  // path that did it to say so.
  d.picks[d.currentIndex].auto = true;
```

- [ ] **Step 5: Run the suite**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Expected: all pass, count up by two.

- [ ] **Step 6: Commit**

```bash
git add backend/src/lib/autoPick.js backend/src/drafts.test.js
git commit -m "feat: the clock marks the picks it makes"
```

---

### Task 2: Who to tell, and what — as a pure function

The whole decision, with no AWS and no network, so it can be tested exhaustively.

**Files:**
- Create: `backend/src/lib/notifyDecisions.js`
- Test: `backend/src/lib/notifyDecisions.test.js`

**Interfaces:**
- Produces: `decideNotifications(oldImage, newImage) -> Notification[]`, where a `Notification` is
  `{ sub, kind: "your-turn" | "picked-for-you", draftId, title, body }`.
  An empty array means nothing to send.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/lib/notifyDecisions.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { decideNotifications } = require("./notifyDecisions");

function draft({ currentIndex, picks, seats, draftId = "d1" }) {
  return { draftId, currentIndex, picks, seats };
}
const SEATS = [
  { team: 1, kind: "human", sub: "user-a" },
  { team: 2, kind: "human", sub: "user-b" },
  { team: 3, kind: "bot", sub: null },
];

test("nothing is sent when the pick did not move", () => {
  // Pauses, board changes and seat-board writes all land on this stream.
  const d = draft({ currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS });
  assert.deepEqual(decideNotifications(d, { ...d, pausedAt: 123 }), []);
});

test("the seat now on the clock is told it is their turn", () => {
  const before = draft({ currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS });
  const after = draft({ currentIndex: 1, picks: [{ team: 1, playerId: "p1" }, { team: 2 }], seats: SEATS });
  const out = decideNotifications(before, after);
  assert.equal(out.length, 1);
  assert.equal(out[0].sub, "user-b");
  assert.equal(out[0].kind, "your-turn");
});

test("a bot's turn tells nobody", () => {
  const before = draft({ currentIndex: 1, picks: [{ team: 1 }, { team: 2 }, { team: 3 }], seats: SEATS });
  const after = draft({ currentIndex: 2, picks: [{ team: 1 }, { team: 2, playerId: "p2" }, { team: 3 }], seats: SEATS });
  assert.deepEqual(decideNotifications(before, after), []);
});

test("a pick the clock made tells the person it was made for", () => {
  const before = draft({ currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS });
  const after = draft({
    currentIndex: 1,
    picks: [{ team: 1, playerId: "p1", auto: true, player: { name: "Jahmyr Gibbs" } }, { team: 2 }],
    seats: SEATS,
  });
  const out = decideNotifications(before, after);
  const mine = out.find((n) => n.kind === "picked-for-you");
  assert.ok(mine, "the seat that was picked for must be told");
  assert.equal(mine.sub, "user-a");
  assert.match(mine.body, /Gibbs/);
});

test("a pick a person made tells only the next seat", () => {
  const before = draft({ currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS });
  const after = draft({
    currentIndex: 1,
    picks: [{ team: 1, playerId: "p1", player: { name: "Jahmyr Gibbs" } }, { team: 2 }],
    seats: SEATS,
  });
  const kinds = decideNotifications(before, after).map((n) => n.kind);
  assert.deepEqual(kinds, ["your-turn"]);
});

test("a finished draft has nobody on the clock", () => {
  const before = draft({ currentIndex: 1, picks: [{ team: 1 }, { team: 2 }], seats: SEATS });
  const after = draft({
    currentIndex: 2,
    picks: [{ team: 1 }, { team: 2, playerId: "p2", auto: true, player: { name: "Bijan Robinson" } }],
    seats: SEATS,
  });
  const kinds = decideNotifications(before, after).map((n) => n.kind);
  assert.deepEqual(kinds, ["picked-for-you"], "no your-turn past the end of the draft");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/lib/notifyDecisions.test.js 2>&1 | tail -8`
Expected: FAIL — `Cannot find module './notifyDecisions'`.

- [ ] **Step 3: Write the decision**

Create `backend/src/lib/notifyDecisions.js`:

```js
// backend/src/lib/notifyDecisions.js
//
// Who gets told, and what. A pure function of the draft's before and after
// images, so the whole decision is testable without AWS, a network, or a
// push service -- which matters because this is the part that decides
// whether somebody's phone buzzes at midnight.
//
// Every write to a draft lands on the stream that calls this: pauses, board
// changes, seat-board writes, deletes. Only an advancing currentIndex means
// a turn changed hands.

function seatFor(image, team) {
  return (image.seats || []).find((s) => s?.team === team) || null;
}

/**
 * @returns {Array<{sub: string, kind: "your-turn"|"picked-for-you", draftId: string, title: string, body: string}>}
 */
function decideNotifications(oldImage, newImage) {
  if (!oldImage || !newImage) return [];

  const before = oldImage.currentIndex ?? 0;
  const after = newImage.currentIndex ?? 0;
  if (!(after > before)) return [];

  const picks = newImage.picks || [];
  const out = [];

  // The pick that just completed. Told only when the clock made it: a person
  // who picked for themselves does not need telling they did.
  const done = picks[before];
  if (done?.auto) {
    const seat = seatFor(newImage, done.team);
    if (seat?.kind === "human" && seat.sub) {
      out.push({
        sub: seat.sub,
        kind: "picked-for-you",
        draftId: newImage.draftId,
        title: "Your clock ran out",
        body: `We picked ${done.player?.name || "a player"} for you.`,
      });
    }
  }

  // Whoever is now on the clock. A completed draft has nobody.
  const next = picks[after];
  if (next) {
    const seat = seatFor(newImage, next.team);
    if (seat?.kind === "human" && seat.sub) {
      out.push({
        sub: seat.sub,
        kind: "your-turn",
        draftId: newImage.draftId,
        title: "You're on the clock",
        body: "It's your pick.",
      });
    }
  }

  return out;
}

module.exports = { decideNotifications };
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8`
Expected: all pass, count up by six.

- [ ] **Step 5: Mutation-test the advance check**

Replace `if (!(after > before)) return [];` with `if (false) return [];`. "nothing is sent when the pick did not move" must go **red**. Restore, confirm green.

This is the guard that stops a pause notifying everybody in the draft.

- [ ] **Step 6: Commit**

```bash
git add backend/src/lib/notifyDecisions.js backend/src/lib/notifyDecisions.test.js
git commit -m "feat: who to tell when a turn changes hands"
```

---

### Task 3: Storing a subscription

**Files:**
- Modify: `backend/src/drafts.js`, `backend/template.yaml`
- Test: `backend/src/drafts.test.js`, `backend/src/template.test.js`

**Interfaces:**
- Produces: `POST /push/subscribe` stores `{ endpoint, keys: { p256dh, auth } }` for the caller; `DELETE /push/subscribe` removes one by endpoint. Table `perfectpick-push-subs`, PK `sub`, SK `endpoint`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/drafts.test.js`:

```js
test("a subscription is stored against the caller", async () => {
  let put = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.Item?.endpoint) put = cmd.input.Item;
    return {};
  });
  const res = await handler(
    evt("POST", "/push/subscribe", {
      body: { endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } },
      claims: ME,
    })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(put.sub, ME.sub);
  assert.equal(put.endpoint, "https://push.example/abc");
  assert.equal(put.p256dh, "k");
});

test("a subscription without an endpoint is refused", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({}));
  const res = await handler(
    evt("POST", "/push/subscribe", { body: { keys: { p256dh: "k", auth: "a" } }, claims: ME })
  );
  assert.equal(res.statusCode, 400);
});

test("subscribing requires a signed-in caller", async () => {
  const res = await handler(
    evt("POST", "/push/subscribe", { body: { endpoint: "https://push.example/abc" } })
  );
  assert.equal(res.statusCode, 401);
});

test("a subscription can be removed", async () => {
  let deleted = null;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.Key?.endpoint) deleted = cmd.input.Key;
    return {};
  });
  const res = await handler(
    evt("DELETE", "/push/subscribe", { body: { endpoint: "https://push.example/abc" }, claims: ME })
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(deleted, { sub: ME.sub, endpoint: "https://push.example/abc" });
});
```

Append to `backend/src/template.test.js`:

```js
test("the push subscriptions table is keyed by person and endpoint", () => {
  const tpl = loadTemplate();
  const t = tpl.Resources.PushSubsTable.Properties;
  assert.deepEqual(
    t.KeySchema.map((k) => [k.AttributeName, k.KeyType]),
    [["sub", "HASH"], ["endpoint", "RANGE"]]
  );
});

test("both push routes require a signed-in caller", () => {
  const rows = httpRoutes(loadTemplate()).filter((r) => r.path === "/push/subscribe");
  assert.equal(rows.length, 2, "expected POST and DELETE");
  for (const r of rows) assert.equal(r.authorizer, "CognitoAuth", `${r.method} must be authorised`);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && node --test src/drafts.test.js src/template.test.js 2>&1 | tail -10`
Expected: all six FAIL — no routes, no table.

- [ ] **Step 3: Add the routes**

In `backend/src/drafts.js`, beside the other routes:

```js
    // POST /push/subscribe  { endpoint, keys: { p256dh, auth } }
    //
    // One row per browser: a laptop and a phone are different subscriptions
    // for the same person, and both should buzz.
    if (method === "POST" && path === "/push/subscribe") {
      if (!sub) return needsAuth();
      const body = event.body ? JSON.parse(event.body) : {};
      const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
      if (!endpoint) return json(400, { error: "endpoint is required" });
      await ddb.send(
        new PutCommand({
          TableName: pushSubsTable,
          Item: {
            sub,
            endpoint,
            p256dh: body.keys?.p256dh || null,
            auth: body.keys?.auth || null,
            createdAt: Date.now(),
          },
        })
      );
      return json(200, { ok: true });
    }

    // DELETE /push/subscribe  { endpoint }
    if (method === "DELETE" && path === "/push/subscribe") {
      if (!sub) return needsAuth();
      const body = event.body ? JSON.parse(event.body) : {};
      const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
      if (!endpoint) return json(400, { error: "endpoint is required" });
      await ddb.send(new DeleteCommand({ TableName: pushSubsTable, Key: { sub, endpoint } }));
      return json(200, { ok: true });
    }
```

Add `const pushSubsTable = process.env.PUSH_SUBS_TABLE;` beside the other table constants at the top of the file.

- [ ] **Step 4: Add the table and the routes to the template**

In `backend/template.yaml`, beside the other tables:

```yaml
  PushSubsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: perfectpick-push-subs
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: sub
          AttributeType: S
        - AttributeName: endpoint
          AttributeType: S
      KeySchema:
        - AttributeName: sub
          KeyType: HASH
        # One row per browser. A phone and a laptop are separate
        # subscriptions for the same person and both should be kept.
        - AttributeName: endpoint
          KeyType: RANGE
```

Give `DraftsFunction` the env var and the policy, and the two route events:

```yaml
          PUSH_SUBS_TABLE: !Ref PushSubsTable
```
```yaml
        - DynamoDBCrudPolicy:
            TableName: !Ref PushSubsTable
```
```yaml
        PushSubscribe:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /push/subscribe
            Method: POST
            Auth:
              Authorizer: CognitoAuth
        PushUnsubscribe:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /push/subscribe
            Method: DELETE
            Auth:
              Authorizer: CognitoAuth
```

- [ ] **Step 5: Run the tests and validate the template**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8 && sam validate --lint`
Expected: all pass, count up by six; template valid.

- [ ] **Step 6: Mutation-test the auth guard**

Delete `if (!sub) return needsAuth();` from the POST route. "subscribing requires a signed-in caller" must go **red**. Restore, confirm green.

- [ ] **Step 7: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js backend/template.yaml backend/src/template.test.js
git commit -m "feat: store a browser's push subscription"
```

---

### Task 4: The notifier

**Files:**
- Create: `backend/src/notifier.js`, `backend/src/notifier.test.js`
- Modify: `backend/src/package.json`, `backend/template.yaml`, `backend/src/template.test.js`

**Interfaces:**
- Consumes: `decideNotifications` (Task 2), the subscriptions table (Task 3), the `auto` marker (Task 1).
- Produces: `handler(event)` for a DynamoDB stream event. Returns a summary `{ records, sent, expired, failed }` so tests can assert without reading logs.

- [ ] **Step 1: Add the dependency**

Run: `cd backend/src && npm install web-push @aws-sdk/util-dynamodb`

This is the project's first runtime dependency beyond the AWS SDK, and it ships in the Lambda bundle. It is here because web push requires VAPID JWT signing and `aes128gcm` payload encryption, and hand-rolling either is a poor trade against a well-established library.

- [ ] **Step 2: Write the failing tests**

Create `backend/src/notifier.test.js`. Mock `web-push` at the module boundary and the DynamoDB client as the other backend tests do:

```js
const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const webpush = require("web-push");

process.env.PUSH_SUBS_TABLE = "subs-test";
process.env.VAPID_PUBLIC_KEY = "pub";
process.env.VAPID_PRIVATE_KEY = "priv";
process.env.VAPID_SUBJECT = "mailto:test@example.com";

const { handler } = require("./notifier");

test.afterEach(() => mock.restoreAll());

const SEATS = [
  { team: 1, kind: "human", sub: "user-a" },
  { team: 2, kind: "human", sub: "user-b" },
];

/** A stream MODIFY record advancing the draft from pick 0 to pick 1. */
function advanceRecord() {
  return {
    Records: [
      {
        eventName: "MODIFY",
        dynamodb: {
          OldImage: { draftId: "d1", currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS },
          NewImage: {
            draftId: "d1",
            currentIndex: 1,
            picks: [{ team: 1, playerId: "p1" }, { team: 2 }],
            seats: SEATS,
          },
        },
      },
    ],
  };
}

test("the person now on the clock is sent one push per browser", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [
      { sub: "user-b", endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" },
      { sub: "user-b", endpoint: "https://push.example/phone", p256dh: "k", auth: "a" },
    ],
  }));
  const sent = [];
  mock.method(webpush, "sendNotification", async (sub) => {
    sent.push(sub.endpoint);
    return {};
  });

  const out = await handler(advanceRecord());
  assert.equal(out.sent, 2);
  assert.deepEqual(sent.sort(), ["https://push.example/laptop", "https://push.example/phone"]);
});

test("an expired subscription is deleted, not retried", async () => {
  const deleted = [];
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.Key?.endpoint) {
      deleted.push(cmd.input.Key.endpoint);
      return {};
    }
    return { Items: [{ sub: "user-b", endpoint: "https://push.example/gone", p256dh: "k", auth: "a" }] };
  });
  mock.method(webpush, "sendNotification", async () => {
    const e = new Error("gone");
    e.statusCode = 410;
    throw e;
  });

  const out = await handler(advanceRecord());
  assert.equal(out.expired, 1);
  assert.deepEqual(deleted, ["https://push.example/gone"]);
});

test("one failing subscription does not stop the others, and does not fail the record", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [
      { sub: "user-b", endpoint: "https://push.example/bad", p256dh: "k", auth: "a" },
      { sub: "user-b", endpoint: "https://push.example/good", p256dh: "k", auth: "a" },
    ],
  }));
  const sent = [];
  mock.method(webpush, "sendNotification", async (sub) => {
    if (sub.endpoint.endsWith("bad")) throw new Error("push service on fire");
    sent.push(sub.endpoint);
    return {};
  });

  // Must resolve. A throw here fails the batch, and DynamoDB retries a failed
  // batch -- which would notify everyone in it a second time.
  const out = await handler(advanceRecord());
  assert.equal(out.failed, 1);
  assert.deepEqual(sent, ["https://push.example/good"]);
});

test("a record that does not advance the pick sends nothing", async () => {
  let queried = false;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    queried = true;
    return { Items: [] };
  });
  const paused = advanceRecord();
  paused.Records[0].dynamodb.NewImage.currentIndex = 0;
  paused.Records[0].dynamodb.NewImage.pausedAt = 123;

  const out = await handler(paused);
  assert.equal(out.sent, 0);
  assert.equal(queried, false, "a pause must not even look up subscriptions");
});
```

**On the images — this is decided, do not choose differently.** A real stream delivers DynamoDB-typed attribute values (`{ "S": "d1" }`), not plain JSON. The handler unmarshalls at its edge, and the fixtures above must therefore be marshalled so they match what production actually sends. Add to the test file:

```js
const { marshall } = require("@aws-sdk/util-dynamodb");
```

and build the record's images with it, keeping the fixtures readable:

```js
        dynamodb: {
          OldImage: marshall({ draftId: "d1", currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS }),
          NewImage: marshall({
            draftId: "d1",
            currentIndex: 1,
            picks: [{ team: 1, playerId: "p1" }, { team: 2 }],
            seats: SEATS,
          }),
        },
```

A handler tested against a shape the stream never sends is a handler that does not work — this is the single most likely way for this task to pass its tests and fail in production.

- [ ] **Step 3: Run them and watch them fail**

Run: `cd backend && node --test src/notifier.test.js 2>&1 | tail -8`
Expected: FAIL — no such module.

- [ ] **Step 4: Write the notifier**

Create `backend/src/notifier.js`:

```js
// backend/src/notifier.js
//
// The stream's reader. Every write to a draft arrives here -- pauses, board
// changes, seat-board writes, deletes -- and almost all of them are not news.
// lib/notifyDecisions answers "did a turn change hands, and whose", and this
// file does nothing but carry that answer to the browsers that asked for it.
//
// It lives on a stream rather than inside the pick path deliberately: the
// conditional write that moves a draft forward is what stops two people
// overwriting each other, and an HTTPS call to a push service has no business
// inside it.
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const webpush = require("web-push");
const { decideNotifications } = require("./lib/notifyDecisions");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const subsTable = process.env.PUSH_SUBS_TABLE;

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function handler(event) {
  const out = { records: 0, sent: 0, expired: 0, failed: 0 };

  for (const rec of event?.Records || []) {
    out.records += 1;
    if (rec.eventName !== "MODIFY") continue;

    const before = rec.dynamodb?.OldImage ? unmarshall(rec.dynamodb.OldImage) : null;
    const after = rec.dynamodb?.NewImage ? unmarshall(rec.dynamodb.NewImage) : null;

    const notes = decideNotifications(before, after);
    // A pause must not even look up subscriptions -- most records reaching
    // this stream are not a turn changing hands.
    if (notes.length === 0) continue;

    for (const note of notes) {
      const subs = await ddb.send(
        new QueryCommand({
          TableName: subsTable,
          KeyConditionExpression: "#s = :s",
          ExpressionAttributeNames: { "#s": "sub" },
          ExpressionAttributeValues: { ":s": note.sub },
        })
      );

      for (const row of subs.Items || []) {
        try {
          await webpush.sendNotification(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            JSON.stringify({ title: note.title, body: note.body, draftId: note.draftId })
          );
          out.sent += 1;
        } catch (e) {
          // 404 and 410 are how a push service says the subscription is gone.
          // Deleting it is required: otherwise the row is retried forever.
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await ddb.send(
              new DeleteCommand({ TableName: subsTable, Key: { sub: row.sub, endpoint: row.endpoint } })
            );
            out.expired += 1;
          } else {
            // Caught per subscription and never rethrown. A throw here fails
            // the batch, and DynamoDB retries a failed batch -- which would
            // notify everybody in it a second time.
            out.failed += 1;
            console.error(`push failed for ${row.endpoint}:`, e?.message || e);
          }
        }
      }
    }
  }

  console.log(JSON.stringify({ msg: "notifier run", ...out }));
  return out;
}

module.exports = { handler };
```

- [ ] **Step 5: Wire it into the template**

Add the stream to `DraftsTable`:

```yaml
      # Read by NotifierFunction only. Both images, because "was this pick
      # automatic, and whose turn just began" is a question about the change,
      # not about the row.
      StreamSpecification:
        StreamViewType: NEW_AND_OLD_IMAGES
```

Add the function:

```yaml
  NotifierFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: notifier.handler
      Timeout: 30
      MemorySize: 512
      Environment:
        Variables:
          PUSH_SUBS_TABLE: !Ref PushSubsTable
          VAPID_PUBLIC_KEY: !Ref VapidPublicKey
          VAPID_PRIVATE_KEY: !Ref VapidPrivateKey
          VAPID_SUBJECT: !Ref VapidSubject
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref PushSubsTable
      Events:
        DraftChanged:
          Type: DynamoDB
          Properties:
            Stream: !GetAtt DraftsTable.StreamArn
            StartingPosition: LATEST
            BatchSize: 10
            # A failing batch is retried, and a retried batch notifies
            # everybody in it again. The handler is written never to throw;
            # this is the second line of defence.
            MaximumRetryAttempts: 0
```

Add three parameters beside the existing secrets, with `VapidPrivateKey` marked `NoEcho: true`, and pass them at deploy time from SSM exactly as the Google and Yahoo secrets are.

Append to `backend/src/template.test.js`:

```js
test("the drafts table streams both images", () => {
  const t = loadTemplate().Resources.DraftsTable.Properties;
  assert.equal(t.StreamSpecification.StreamViewType, "NEW_AND_OLD_IMAGES");
});

test("the notifier reads the stream and never retries a batch", () => {
  const fn = loadTemplate().Resources.NotifierFunction;
  assert.ok(fn, "NotifierFunction is missing");
  const evt = Object.values(fn.Properties.Events).find((e) => e.Type === "DynamoDB");
  assert.ok(evt, "the notifier needs a DynamoDB stream event");
  // A retried batch re-notifies everyone in it.
  assert.equal(evt.Properties.MaximumRetryAttempts, 0);
});

test("the VAPID private key is NoEcho", () => {
  assert.equal(loadTemplate().Parameters.VapidPrivateKey.NoEcho, true);
});
```

- [ ] **Step 6: Run everything**

Run: `cd backend && node --test 'src/**/*.test.js' 2>&1 | tail -8 && sam validate --lint`
Expected: all pass; template valid.

- [ ] **Step 7: Mutation-test the two guards that matter**

Remove the per-subscription `try`/`catch` so a push failure propagates. "one failing subscription does not stop the others" must go **red**. Restore, confirm green.

Then make the `404`/`410` branch fall through to the generic failure path. "an expired subscription is deleted, not retried" must go **red**. Restore, confirm green.

- [ ] **Step 8: Commit**

```bash
git add backend/src/notifier.js backend/src/notifier.test.js backend/src/package.json backend/src/package-lock.json backend/template.yaml backend/src/template.test.js
git commit -m "feat: send the push when a turn changes hands"
```

---

### Task 5: Asking, subscribing, and staying quiet

**Files:**
- Create: `frontend/public/sw.js`, `frontend/src/lib/push.js`, `frontend/src/lib/push.test.js`
- Modify: `frontend/src/pages/Draft.jsx`
- Test: `frontend/tests/draft.spec.js`

**Interfaces:**
- Consumes: `POST`/`DELETE /push/subscribe` (Task 3).
- Produces: `data-testid="notify-toggle"` on the control.

- [ ] **Step 1: Write the service worker**

Create `frontend/public/sw.js` — in `public/` so it is served from the root and gets root scope:

```js
// The service worker exists for two moments: a push arrives, and somebody
// clicks it.
//
// It stays silent when a window on this origin is already focused. That is
// what makes notifying on every draft safe rather than maddening: in a
// thirty-second solo draft every pick is your turn, and a notification is
// only ever useful when you are NOT looking at the page.
self.addEventListener("push", (event) => {
  const data = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch {
      return {};
    }
  })();

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (clients.some((c) => c.focused)) return;

      await self.registration.showNotification(data.title || "PerfectPick", {
        body: data.body || "",
        tag: data.draftId ? `draft-${data.draftId}` : "perfectpick",
        data,
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const draftId = event.notification.data?.draftId;
  const url = draftId ? `/draft/${draftId}` : "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clients.find((c) => c.url.includes(url));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })()
  );
});
```

- [ ] **Step 2: Write the failing unit tests for the helper**

Create `frontend/src/lib/push.test.js` covering `urlBase64ToUint8Array` (the VAPID key conversion every web-push client needs) and the permission-state reading. Write the tests before the module, run them, and watch them fail.

Keep the network out of it: the subscribe and unsubscribe functions take their dependencies as arguments so they can be driven without a browser.

- [ ] **Step 3: Write `frontend/src/lib/push.js`**

```js
// frontend/src/lib/push.js
import { apiPost, apiDelete } from "./api";

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

/** Whether this browser can do any of this at all. */
export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** "unsupported" | "default" | "granted" | "denied" */
export function pushState() {
  if (!pushSupported() || !VAPID_PUBLIC_KEY) return "unsupported";
  return Notification.permission;
}

/**
 * The VAPID public key travels as base64url, and PushManager wants bytes.
 * Written out rather than pulled in: it is eight lines and the alternative
 * is a dependency in the browser bundle for a string conversion.
 */
export function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function subscribe() {
  if (!pushSupported() || !VAPID_PUBLIC_KEY) return "unsupported";

  const permission = await Notification.requestPermission();
  // Denied is final: the browser will not ask again, so the caller shows the
  // state rather than offering the button once more.
  if (permission !== "granted") return permission;

  const reg = await navigator.serviceWorker.register("/sw.js");
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  const { endpoint, keys } = sub.toJSON();
  await apiPost("/push/subscribe", { endpoint, keys });
  return "granted";
}

export async function unsubscribe() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const { endpoint } = sub.toJSON();
  await sub.unsubscribe();
  await apiDelete("/push/subscribe", { endpoint });
}
```

If `frontend/src/lib/api.js` has no `apiDelete`, add one in the shape of its existing `apiPost` — check before assuming, and say which you found.

- [ ] **Step 4: Add the control to the draft page**

In `Draft.jsx`, beside the other header controls:

```jsx
  const [notifyState, setNotifyState] = useState(() => pushState());

  // ...

  {notifyState !== "unsupported" && (
    <button
      type="button"
      data-testid="notify-toggle"
      disabled={notifyState === "denied"}
      onClick={async () => setNotifyState(await subscribe())}
      className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600 disabled:opacity-50"
    >
      {notifyState === "granted"
        ? "Notifications on"
        : notifyState === "denied"
          ? "Notifications blocked"
          : "Notify me"}
    </button>
  )}
```

`pushState()` returns `"unsupported"` when the build carries no `VITE_VAPID_PUBLIC_KEY`, so the control disappears entirely in such a build — the same rule the landing page follows for sign-in and the Yahoo panel for its client id. `"denied"` is shown and disabled rather than re-prompted, because the browser will not ask again and a button that cannot work is worse than an explanation.

Match the surrounding controls' classes if they differ from the above; the header is dense and this is one more thing in it.

- [ ] **Step 5: Write the Playwright test**

Append to `frontend/tests/draft.spec.js`. Playwright can grant the permission, so the observable behaviour is testable: with notifications granted, clicking the control POSTs a subscription to the API. Assert on the request, not on a browser notification appearing.

Also assert that with no `VITE_VAPID_PUBLIC_KEY` the control is absent — if the dev server always sets it, say so in your report rather than writing a test that cannot fail.

- [ ] **Step 6: Run everything**

Run: `cd frontend && npm run test:unit && npm run lint && npm test 2>&1 | tail -3`
Expected: all green. Check the printed Playwright total against `npx playwright test --list`.

- [ ] **Step 7: Regenerate and look at the screenshot**

Run: `git status --short screenshots/` and open `screenshots/draft.png`. The draft header has wrapped before (`b31dbed`) and this adds a control to it — confirm it has not, and that `boarddraft.spec.js`'s header assertions still pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/public/sw.js frontend/src/lib/push.js frontend/src/lib/push.test.js frontend/src/pages/Draft.jsx frontend/tests/draft.spec.js screenshots/
git commit -m "feat: ask to notify, and stay quiet when you're looking"
```

---

### Task 6: Ship it

**Files:** none.

- [ ] **Step 1: Generate the VAPID keypair**

```bash
cd backend/src && npx web-push generate-vapid-keys
```

Put the private key in SSM beside the other secrets, and keep the public key to hand — it is not secret:

```bash
aws ssm put-parameter --name /perfectpick/vapid-private-key \
  --type SecureString --value 'THE_PRIVATE_KEY' --region us-east-1
```

- [ ] **Step 2: Full verification**

```bash
cd backend && node --test 'src/**/*.test.js' && sam validate --lint
cd ../frontend && npm run test:unit && npm run lint && npm test
```

Read the printed Playwright total and compare it to `npx playwright test --list`. A run much longer than about six minutes has probably spanned a laptop sleep — distrust it and re-run.

- [ ] **Step 3: Deploy the backend**

The stream, the table and the notifier must exist before a browser can subscribe. Deploy with the four existing parameters plus the three VAPID ones, reading the private key from SSM the same way.

- [ ] **Step 4: Deploy the frontend**

Add `VITE_VAPID_PUBLIC_KEY` to `frontend/.env.production` first — without it the control does not render, by design.

```bash
cd frontend && npm run deploy
```

- [ ] **Step 5: Prove it end to end**

Open a draft, turn notifications on, then **switch to another window** — the focus check means a focused tab shows nothing, so testing without switching away proves nothing.

Let a pick expire. A notification should arrive saying the clock picked for you, and another saying you are on the clock. Click one and confirm it focuses the draft.

Then check the tables: `perfectpick-push-subs` holds a row per browser you enabled, and the notifier's log shows `sent` greater than zero.

- [ ] **Step 6: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill.
