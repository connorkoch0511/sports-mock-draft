# Drafting Together, Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two or more people draft in the same draft at the same time, correctly: you pick only on your own turn, simultaneous picks cannot silently lose one, everyone sees everyone's picks, and the draft appears in the list for everyone in it.

**Architecture:** Seats already model who may act; this fills the bot seats with real accounts via an invite link, makes every pick-advancing write conditional on the `currentIndex` it read, and derives "which team is mine" per request instead of from the creator's stored `userTeam`. A new members table answers "drafts I am in", which a GSI cannot because `seats` is a list.

**Tech Stack:** Node 22 CommonJS Lambda + DynamoDB + AWS SAM; React 19 + Vite ESM frontend (`node --test` for unit, Playwright for e2e).

## Global Constraints

- **No clock in this phase.** A draft with more than one human seat runs no countdown and no timeout auto-pick. Phase 2 gives the server that authority.
- **The browser auto-picks only for `bot` seats** — never merely because a team is "not mine". With two humans, the old rule makes each browser pick for the other person.
- **Seats are the only thing that grants access.** Membership rows are a list convenience; `GET /drafts/{draftId}` gates on `isSeated`, never on membership.
- **A wrong or missing invite token returns exactly what a non-existent draft returns** — 404, byte for byte. Never 403. Guessing a draft id must learn nothing.
- **Every pick-advancing write is conditional on `currentIndex`.** A lost race is a 409 carrying the current state, never a silent overwrite.
- Picking out of turn is **409**, not 403 — you are in this draft, it simply is not your turn.
- `seats[i].team === i + 1`. Update paths address the **array index**; getting this off by one hands somebody the wrong team silently.
- Backend CommonJS, frontend ESM. Comments explain *why*.

---

## The test helpers that already exist

`backend/src/drafts.test.js` has these; use them rather than inventing new ones:

- `evt(method, path, { draftId, body, claims })` — builds the Lambda event. `claims: { sub: "bob" }` is how a test says who is calling.
- `stubSend(result)` — stubs every DynamoDB call with one result.
- `stubByTable(map)` — stubs per table, for handlers that read two.
- `ownedDraft(ownerId, seatSub)` — a draft item with one human seat.

Where a task below writes `pickAs(draft, "bob", "p1")` or similar, that is
shorthand for: stub the read to return `draft`, then call the handler with
`evt("POST", "/drafts/d1/pick", { draftId: "d1", body: { playerId: "p1" }, claims: { sub: "bob" } })`.
Write the shorthand as a small local helper in that file if it reads better,
built from the four above — do not build a second stubbing mechanism.

`backend/src/me.test.js` has `event(body, claims)` and `getEvent(rawPath, claims)`.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/lib/owner.js` | Gains `seatOf(draft, sub)` and `teamOnClock(draft)` — the two questions every turn decision asks. |
| `backend/src/drafts.js` | Turn check, conditional writes, `yourTeam` on GET, the join route, invite token at creation. |
| `backend/src/lib/advance.js` (new) | The conditional write that moves a draft forward, and the 409 it returns when it loses. One place, because three copies of a concurrency guard drift. |
| `backend/src/lib/members.js` (new) | Writing and reading membership rows, in one place so the dual write is not spread around. |
| `backend/src/me.js` | Lists drafts you are *in*, via members, instead of drafts you own. |
| `backend/template.yaml` | The members table, its policies, and the join route. |
| `frontend/src/pages/Draft.jsx` | `yourTeam`, bot-only auto-pick, no timer when shared, polling. |
| `frontend/src/pages/JoinDraft.jsx` (new) | The `/draft/:draftId/join` route that redeems a token. |
| `frontend/src/pages/Results.jsx`, `MyDrafts.jsx` | Read `yourTeam` where they read `userTeam`. |

---

### Task 1: Two questions every turn decision asks

**Files:**
- Modify: `backend/src/lib/owner.js`
- Test: `backend/src/drafts.test.js` (append — `owner.js` helpers are tested there today)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `seatOf(draft, sub)` → the seat object `{ team, sub, kind }` held by `sub`, or `null`.
  - `teamOnClock(draft)` → the team number whose pick is next (`draft.picks[draft.currentIndex]?.team`), or `null` when the draft is complete or malformed.
  - `humanSeatCount(draft)` → how many seats are `kind: "human"`.

**Background the implementer needs.** `isSeated(draft, sub)` already exists and answers "may this person see this draft at all". These three answer the different question the pick handler needs: *whose* turn is it, and is that this person. Read `owner.js` first — it is small, deliberately the only place access is decided, and its existing comments explain why.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/drafts.test.js`:

```js
const { seatOf, teamOnClock, humanSeatCount } = require("./lib/owner");

const draftWith = (seats, currentIndex = 0, picks = [{ team: 1 }, { team: 2 }]) =>
  ({ seats, currentIndex, picks });

test("seatOf finds the seat a person holds", () => {
  const d = draftWith([
    { team: 1, sub: "alice", kind: "human" },
    { team: 2, sub: null, kind: "bot" },
  ]);
  assert.strictEqual(seatOf(d, "alice").team, 1);
  assert.strictEqual(seatOf(d, "bob"), null);
});

// A bot seat has sub null, and a signed-out caller has no sub. Neither may
// match the other, or a signed-out request would hold every bot seat.
test("a null sub matches no seat, including bot seats", () => {
  const d = draftWith([{ team: 1, sub: null, kind: "bot" }]);
  assert.strictEqual(seatOf(d, null), null);
  assert.strictEqual(seatOf(d, undefined), null);
  assert.strictEqual(seatOf(d, ""), null);
});

test("teamOnClock reads the pick the draft is on", () => {
  assert.strictEqual(teamOnClock(draftWith([], 0)), 1);
  assert.strictEqual(teamOnClock(draftWith([], 1)), 2);
});

test("a finished or malformed draft has nobody on the clock", () => {
  assert.strictEqual(teamOnClock(draftWith([], 2)), null);
  assert.strictEqual(teamOnClock({ picks: [], currentIndex: 0 }), null);
  assert.strictEqual(teamOnClock({}), null);
});

test("humanSeatCount counts only human seats", () => {
  assert.strictEqual(humanSeatCount(draftWith([
    { team: 1, sub: "a", kind: "human" },
    { team: 2, sub: "b", kind: "human" },
    { team: 3, sub: null, kind: "bot" },
  ])), 2);
  assert.strictEqual(humanSeatCount({}), 0);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd backend/src && npm test`
Expected: FAIL — `seatOf is not a function`.

- [ ] **Step 3: Implement**

Add to `backend/src/lib/owner.js`, and add all three to its `module.exports`:

```js
/**
 * The seat this person holds, or null.
 *
 * A bot seat carries sub null, and a signed-out caller has no sub, so the
 * empty check comes first: without it a request with no identity would match
 * every bot seat in the draft.
 */
function seatOf(draft, sub) {
  if (typeof sub !== "string" || sub.length === 0) return null;
  const seats = draft?.seats;
  if (!Array.isArray(seats)) return null;
  return seats.find((s) => s && s.sub === sub) || null;
}

// The team whose pick is next. Null once the draft is finished, which is a
// different thing from team 0 and must not be confused with it.
function teamOnClock(draft) {
  const pick = draft?.picks?.[draft?.currentIndex];
  return pick?.team ?? null;
}

function humanSeatCount(draft) {
  const seats = draft?.seats;
  if (!Array.isArray(seats)) return 0;
  return seats.filter((s) => s && s.kind === "human").length;
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `cd backend/src && npm test`
Expected: PASS, including every existing test.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/owner.js backend/src/drafts.test.js
git commit -m "feat: whose turn it is, and which seat is theirs"
```

---

### Task 2: You may only pick on your own turn

**Files:**
- Modify: `backend/src/drafts.js` (the `POST /drafts/{draftId}/pick` handler)
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: `seatOf`, `teamOnClock` (Task 1).
- Produces: `/pick` returns **409 `{ error: "Not your pick" }`** when the caller does not hold the seat on the clock.

**Background the implementer needs.** Today every gated route uses `isSeated`, which asks whether you hold *a* seat. The code carries a comment saying so. With one human it is the same question; with two it lets either person pick on the other's turn. `isSeated` stays for read access — it is the right question there — and the turn check is added on top, in `/pick` only.

409 rather than 403 deliberately: you are in this draft and permitted to act in it, the state simply moved. The frontend's answer to a 409 is to refresh, not to despair.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/drafts.test.js`, following the mocking style the neighbouring draft tests already use:

```js
test("picking out of turn is refused", async () => {
  // Two humans; team 1 is on the clock, and bob holds team 2.
  const draft = {
    draftId: "d1", ownerId: "alice", currentIndex: 0, picked: [], version: 1,
    seats: [
      { team: 1, sub: "alice", kind: "human" },
      { team: 2, sub: "bob", kind: "human" },
    ],
    picks: [{ team: 1 }, { team: 2 }],
  };
  const res = await pickAs(draft, "bob", "p1");
  assert.strictEqual(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /not your pick/i);
});

test("picking on your own turn is allowed", async () => {
  const draft = {
    draftId: "d1", ownerId: "alice", currentIndex: 0, picked: [], version: 1,
    seats: [
      { team: 1, sub: "alice", kind: "human" },
      { team: 2, sub: "bob", kind: "human" },
    ],
    picks: [{ team: 1 }, { team: 2 }],
  };
  const res = await pickAs(draft, "alice", "p1");
  assert.strictEqual(res.statusCode, 200);
});

// Being in the draft is still what decides whether you can SEE it. Only
// picking gained a second question.
test("somebody with no seat still gets 404 rather than 409", async () => {
  const draft = {
    draftId: "d1", ownerId: "alice", currentIndex: 0, picked: [], version: 1,
    seats: [{ team: 1, sub: "alice", kind: "human" }],
    picks: [{ team: 1 }],
  };
  const res = await pickAs(draft, "stranger", "p1");
  assert.strictEqual(res.statusCode, 404);
});
```

`pickAs` is shorthand — see *The test helpers that already exist* above. Build it from `stubByTable` (the pick handler reads both the drafts and players tables) and `evt`.

- [ ] **Step 2: Run and watch them fail**

Run: `cd backend/src && npm test`
Expected: the out-of-turn test FAILS with 200 — today's code allows it.

- [ ] **Step 3: Implement**

In the `/pick` handler, **after** the existing "already picked" and "draft
already completed" checks and before the player-snapshot fetch. Not
immediately after `isSeated`, which is the obvious-looking place and is wrong:
`teamOnClock` returns `null` for a finished draft, no real seat matches
`null`, so every completed draft would answer "Not your pick" instead of
"Draft already completed" — telling somebody it is not their turn when the
draft is simply over, and sending them to look for the wrong thing:

```js
      // isSeated above answers "may you see this draft". This answers "is it
      // your turn", which with one human is the same question and with two is
      // not: without it either person can pick on the other's turn.
      const onClock = teamOnClock(d);
      const mySeat = seatOf(d, sub);
      if (!mySeat || mySeat.team !== onClock) {
        return json(409, { error: "Not your pick" });
      }
```

Note this must come after `const d = res.Item;` is assigned; move that line up if needed.

- [ ] **Step 4: Run the tests**

Run: `cd backend/src && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js
git commit -m "feat: a pick must come from the seat on the clock"
```

---

### Task 3: Two picks at once cannot lose one

**Files:**
- Modify: `backend/src/drafts.js` (the three `UpdateCommand` calls in `/pick`, `/auto-pick`, `/sim-to-end`)
- Test: `backend/src/drafts.test.js`

**Interfaces:**
- Consumes: nothing beyond Task 2.
- Produces: `advanceDraft({ ddb, table, draftId, draft, expectedIndex })` in `backend/src/lib/advance.js` — performs the conditional write, and **throws a `RaceLost` error carrying the current `currentIndex` and `version`** when the condition fails. All three handlers call it; each turns a `RaceLost` into **409 `{ error: "Somebody just picked", currentIndex, version }`**.

**Background the implementer needs — this is the most consequential task in the plan.** Every one of those three writes today does a read, then an unconditional write of `picks`, `picked` and `currentIndex`. The only `ConditionExpression` anywhere in `drafts.js` guards the DELETE. Two people picking in the same moment both read `currentIndex = 5`, both write slot 5, and **one pick disappears with no error at all** — the player was drafted and then was not.

This is unreachable with one browser, which is why it has survived. It is a live race the moment a second person is seated.

The fix is a condition on the value that was read. If it no longer holds, somebody else advanced the draft and this write must not land.

- [ ] **Step 1: Write the failing test**

```js
// The defect this task exists for: two picks from the same currentIndex.
// Today both succeed and one is silently overwritten.
test("a pick that lost the race is refused, not silently dropped", async () => {
  const draft = {
    draftId: "d1", ownerId: "alice", currentIndex: 0, picked: [], version: 1,
    seats: [{ team: 1, sub: "alice", kind: "human" }],
    picks: [{ team: 1 }, { team: 1 }],
  };
  // The second write fails its condition, as DynamoDB would when another
  // request has already moved currentIndex on.
  const res = await pickAsWithConditionFailure(draft, "alice", "p1");
  assert.strictEqual(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.match(body.error, /somebody just picked/i);
  // The client needs to know where the draft actually is now.
  assert.ok(Number.isInteger(body.currentIndex));
});
```

`pickAsWithConditionFailure` stubs the `UpdateCommand` send to reject with an error whose `name` is `"ConditionalCheckFailedException"`, the way the AWS SDK reports it.

- [ ] **Step 2: Run and watch it fail**

Run: `cd backend/src && npm test`
Expected: FAIL — today the rejection escapes as a 500, not a 409.

- [ ] **Step 3: Implement**

Create `backend/src/lib/advance.js` first, so the rule lives in one place:

```js
// Moving a draft forward, safely.
//
// Every pick-advancing write does a read and then a write, and between those
// two somebody else may have picked. The condition here is what stops the
// second write landing on top of the first -- without it the loser's pick is
// silently overwritten and the player who was drafted simply is not, with no
// error anywhere. Written once rather than three times because three copies
// of a concurrency guard drift, and drift here reintroduces exactly the bug
// this exists to prevent.

const { UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

class RaceLost extends Error {
  constructor(currentIndex, version) {
    super("Somebody just picked");
    this.name = "RaceLost";
    this.currentIndex = currentIndex;
    this.version = version;
  }
}

async function advanceDraft({ ddb, table, draftId, draft, expectedIndex }) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { draftId },
        UpdateExpression:
          "SET picks = :p, picked = :k, currentIndex = :i, version = if_not_exists(version, :z) + :one",
        ConditionExpression: "currentIndex = :expected",
        ExpressionAttributeValues: {
          ":p": draft.picks, ":k": draft.picked, ":i": draft.currentIndex,
          ":z": 0, ":one": 1, ":expected": expectedIndex,
        },
      })
    );
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
    // Read back so the caller can tell the browser where the draft actually
    // is, rather than leaving it to guess and poll.
    const now = await ddb.send(new GetCommand({ TableName: table, Key: { draftId } }));
    throw new RaceLost(now.Item?.currentIndex ?? null, now.Item?.version ?? null);
  }
}

module.exports = { advanceDraft, RaceLost };
```

Then in each of the three handlers, capture the index before mutating and call it. In `/pick`:

```js
      // Captured before the mutation below moves it.
      const expectedIndex = d.currentIndex;
```

then replace that handler's whole `await ddb.send(new UpdateCommand({...}))` with:

```js
      try {
        await advanceDraft({ ddb, table: draftsTable, draftId, draft: d, expectedIndex });
      } catch (e) {
        if (e?.name === "RaceLost") {
          return json(409, { error: e.message, currentIndex: e.currentIndex, version: e.version });
        }
        throw e;
      }
```

Do the same in `/auto-pick` and `/sim-to-end`. What each handler computes
before the write stays exactly as it is and differs between them; only the
write itself is shared.

- [ ] **Step 4: Run the tests**

Run: `cd backend/src && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/advance.js backend/src/drafts.js backend/src/drafts.test.js
git commit -m "fix: a pick that lost the race no longer overwrites the winner"
```

---

### Task 4: The invite link, and taking a seat

**Files:**
- Modify: `backend/src/drafts.js` (creation, and a new `POST /drafts/{draftId}/join`)
- Modify: `backend/template.yaml` (the route)
- Test: `backend/src/drafts.test.js`, `backend/src/template.test.js`

**Interfaces:**
- Consumes: `seatOf` (Task 1).
- Produces:
  - Created drafts carry `inviteToken`, a `randomUUID()`.
  - `POST /drafts/{draftId}/join` taking `{ token }` → `200 { ok: true, team }` with the seat taken, `404` for a wrong token, `409` when full.
  - `GET /drafts/{draftId}` returns `inviteToken` to seated callers.

**Background the implementer needs.** Seats are built at creation with the creator in `userTeam` and every other seat a bot. Joining converts the lowest-numbered bot seat to a human seat holding the caller's `sub`.

**The race is the point of this task.** Two people opening the link at the same instant must not both get seat 3. The write is conditional on that seat still being a bot, and a `ConditionalCheckFailedException` means retry with the next bot seat:

```
UpdateExpression:      SET seats[2].#sub = :me, seats[2].kind = :human
ConditionExpression:   seats[2].kind = :bot
```

The `2` is the **array index**, not the team number — `seats[i].team === i + 1`, so team 3 is `seats[2]`. An off-by-one here hands somebody the wrong team, silently.

A wrong token must return exactly what a missing draft returns. `drafts.js` already has `notFound()` for this; use it rather than writing a second 404 shape, and never return 403 — a 403 tells a guesser the draft exists.

- [ ] **Step 1: Write the failing tests**

```js
test("a wrong invite token is indistinguishable from a missing draft", async () => {
  const draft = { draftId: "d1", inviteToken: "real", seats: [{ team: 1, sub: "alice", kind: "human" }] };
  const wrong = await joinAs(draft, "bob", "guessed");
  const missing = await joinAs(null, "bob", "anything");
  assert.strictEqual(wrong.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(wrong.body), JSON.parse(missing.body));
});

test("joining takes the lowest bot seat", async () => {
  const draft = {
    draftId: "d1", inviteToken: "t", currentIndex: 0, picks: [], version: 1,
    seats: [
      { team: 1, sub: "alice", kind: "human" },
      { team: 2, sub: null, kind: "bot" },
      { team: 3, sub: null, kind: "bot" },
    ],
  };
  const res = await joinAs(draft, "bob", "t");
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).team, 2);
});

// Two people opening the link at once must not both get seat 2.
test("losing the seat race costs a retry, not a seat", async () => {
  const draft = {
    draftId: "d1", inviteToken: "t", currentIndex: 0, picks: [], version: 1,
    seats: [
      { team: 1, sub: "alice", kind: "human" },
      { team: 2, sub: null, kind: "bot" },
      { team: 3, sub: null, kind: "bot" },
    ],
  };
  // The first conditional write fails as though somebody just took seat 2.
  const res = await joinAsWithFirstSeatTaken(draft, "bob", "t");
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).team, 3);
});

test("re-opening the link when already seated is harmless", async () => {
  const draft = {
    draftId: "d1", inviteToken: "t", currentIndex: 0, picks: [], version: 1,
    seats: [{ team: 1, sub: "alice", kind: "human" }, { team: 2, sub: "bob", kind: "bot" }],
  };
  draft.seats[1] = { team: 2, sub: "bob", kind: "human" };
  const res = await joinAs(draft, "bob", "t");
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).team, 2);
});

test("a full draft says so", async () => {
  const draft = {
    draftId: "d1", inviteToken: "t", currentIndex: 0, picks: [], version: 1,
    seats: [{ team: 1, sub: "alice", kind: "human" }],
  };
  const res = await joinAs(draft, "bob", "t");
  assert.strictEqual(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /full/i);
});
```

Add to `backend/src/template.test.js`:

```js
test("POST /drafts/{draftId}/join requires a signed-in user", () => {
  const tpl = loadTemplate();
  const ev = tpl.Resources.DraftsFunction.Properties.Events;
  const route = Object.values(ev).find((e) => e.Properties.Path === "/drafts/{draftId}/join");
  assert.strictEqual(route.Properties.Auth.Authorizer, "CognitoAuth");
});
```

Note `template.test.js` already asserts an exact list of mutating routes; add `POST /drafts/{draftId}/join` to it in alphabetical position, or that test will fail.

- [ ] **Step 2: Run and watch them fail**

Run: `cd backend/src && npm test`
Expected: FAIL — no join route.

- [ ] **Step 3: Implement**

At creation, add to the item beside `version: 1`:

```js
        // Whoever holds this can take a seat. Returned only to people already
        // seated, so it travels the way the person sharing it chooses.
        inviteToken: randomUUID(),
```

Add the handler, before the existing `/pick` route:

```js
    // POST /drafts/{draftId}/join
    if (method === "POST" && /\/drafts\/[^/]+\/join$/.test(path)) {
      if (!sub) return needsAuth();
      const { token } = event.body ? JSON.parse(event.body) : {};

      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      // A wrong token and a missing draft answer identically, so guessing an
      // id learns nothing about whether it exists.
      if (!res.Item || !token || res.Item.inviteToken !== token) return notFound();

      const d = res.Item;
      const already = seatOf(d, sub);
      if (already) return json(200, { ok: true, team: already.team });

      for (let i = 0; i < d.seats.length; i++) {
        if (d.seats[i].kind !== "bot") continue;
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: draftsTable,
              Key: { draftId },
              // The index, not the team: seats[i].team === i + 1.
              UpdateExpression: `SET seats[${i}].#sub = :me, seats[${i}].kind = :human, version = version + :one`,
              ConditionExpression: `seats[${i}].kind = :bot`,
              ExpressionAttributeNames: { "#sub": "sub" },
              ExpressionAttributeValues: { ":me": sub, ":human": "human", ":bot": "bot", ":one": 1 },
            })
          );
          return json(200, { ok: true, team: d.seats[i].team });
        } catch (e) {
          // Somebody took this seat between our read and our write. That is
          // the race this condition exists for: try the next one.
          if (e?.name !== "ConditionalCheckFailedException") throw e;
        }
      }

      return json(409, { error: "This draft is full — every seat is taken" });
    }
```

In the `GET /drafts/{draftId}` response, include `inviteToken: d.inviteToken` alongside the rest.

In `template.yaml`, add the route to `DraftsFunction`'s events, mirroring the neighbouring ones:

```yaml
        JoinDraft:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /drafts/{draftId}/join
            Method: POST
            Auth:
              Authorizer: CognitoAuth
```

- [ ] **Step 4: Run the tests**

Run: `cd backend/src && npm test`
Expected: PASS, including `template.test.js`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js backend/src/template.test.js backend/template.yaml
git commit -m "feat: an invite link, and taking a seat without taking somebody else's"
```

---

### Task 5: Drafts you are in

**Files:**
- Create: `backend/src/lib/members.js`
- Modify: `backend/src/drafts.js` (write a row at create and at join), `backend/src/me.js`
- Modify: `backend/template.yaml` (the table and its policies)
- Test: `backend/src/me.test.js`, `backend/src/template.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `addMember(ddb, table, sub, draftId)` — writes one membership row.
  - `listDraftIds(ddb, table, sub)` → `string[]`, paged.
  - `GET /me/drafts` lists drafts you are seated in.

**Background the implementer needs.** `me.js` today queries the `byOwner` GSI: drafts you *created*. Being in someone else's draft has never been possible, so nothing lists it. A GSI cannot index a list and `seats` is a list, so membership needs its own rows — a table keyed `sub` (HASH) and `draftId` (RANGE).

**A membership row is a cache of what `seats` already says.** The seat is the truth: `GET /drafts/{draftId}` gates on `isSeated` and must never gate on membership. So a stale row shows a draft in your list that 404s when opened — visible and harmless — rather than letting somebody read a draft they were never seated in. Write the seat first and the row second, so the failure mode is the harmless one.

`me.js` already pages its query with a `do/while` on `LastEvaluatedKey`, with a comment explaining why; do the same here rather than assuming one page.

- [ ] **Step 1: Write the failing tests**

In `backend/src/me.test.js`:

```js
test("a draft you joined appears in your list", async () => {
  const res = await listDraftsFor("bob", {
    members: [{ sub: "bob", draftId: "d1" }],
    drafts: { d1: { draftId: "d1", ownerId: "alice", createdAt: 1, teams: 12 } },
  });
  assert.deepStrictEqual(JSON.parse(res.body).drafts.map((d) => d.draftId), ["d1"]);
});

test("a draft you were never in does not", async () => {
  const res = await listDraftsFor("bob", {
    members: [],
    drafts: { d1: { draftId: "d1", ownerId: "alice", createdAt: 1 } },
  });
  assert.deepStrictEqual(JSON.parse(res.body).drafts, []);
});

// The seat is the truth; the row is a convenience. A row without a seat is a
// list entry that 404s on open, which is the safe direction for them to
// disagree in.
test("a membership row for a deleted draft is skipped rather than crashing", async () => {
  const res = await listDraftsFor("bob", {
    members: [{ sub: "bob", draftId: "gone" }],
    drafts: {},
  });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body).drafts, []);
});
```

In `backend/src/template.test.js`:

```js
test("the members table is keyed by person and draft", () => {
  const tpl = loadTemplate();
  const keys = tpl.Resources.DraftMembersTable.Properties.KeySchema;
  assert.deepStrictEqual(keys, [
    { AttributeName: "sub", KeyType: "HASH" },
    { AttributeName: "draftId", KeyType: "RANGE" },
  ]);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd backend/src && npm test`
Expected: FAIL — no members table, no membership listing.

- [ ] **Step 3: Implement**

Create `backend/src/lib/members.js`:

```js
// Which drafts a person is in.
//
// seats already says this, but seats is a list and a DynamoDB index cannot be
// built on a list, so membership gets its own rows. They are a convenience for
// listing and nothing more -- reading a draft is gated on the seat, never on a
// row here, so the two disagreeing shows a draft that 404s rather than letting
// somebody in.

const { PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

async function addMember(ddb, TableName, sub, draftId) {
  await ddb.send(new PutCommand({ TableName, Item: { sub, draftId, joinedAt: Date.now() } }));
}

async function listDraftIds(ddb, TableName, sub) {
  const ids = [];
  let ExclusiveStartKey;
  // Paged for the same reason me.js pages its own query: a page is 1MB, and a
  // surprise here silently truncates somebody's list.
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: "#s = :me",
        ExpressionAttributeNames: { "#s": "sub" },
        ExpressionAttributeValues: { ":me": sub },
        ExclusiveStartKey,
      })
    );
    ids.push(...(res.Items || []).map((i) => i.draftId));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return ids;
}

module.exports = { addMember, listDraftIds };
```

In `drafts.js`, after the `PutCommand` that creates a draft, and after a successful join, call `addMember(ddb, process.env.DRAFT_MEMBERS_TABLE, sub, draftId)`. Seat first, row second.

In `me.js`, replace the drafts branch's `queryByOwner(...)` call with:

```js
      const ids = await listDraftIds(ddb, process.env.DRAFT_MEMBERS_TABLE, sub);
      // A membership row can outlive the draft it names -- deleting a draft
      // does not clean them up, and the seat is the truth anyway. Missing ids
      // are skipped rather than rendered as broken rows.
      const items = [];
      for (const group of chunk(ids, 100)) {
        if (group.length === 0) continue;
        const res = await ddb.send(
          new BatchGetCommand({
            RequestItems: { [draftsTable]: { Keys: group.map((draftId) => ({ draftId })) } },
          })
        );
        items.push(...(res.Responses?.[draftsTable] || []));
      }
      const drafts = items.sort(byNewest);
```

`BatchGetCommand` takes at most 100 keys per call, which is why the loop
exists; `chunk` is already exported from `backend/src/sync/normalize.js`, or
write four lines locally rather than importing across that boundary. Add
`BatchGetCommand` to the `@aws-sdk/lib-dynamodb` import at the top of the
file.

In `template.yaml`, add the table beside the others:

```yaml
  DraftMembersTable:
    Type: AWS::DynamoDB::Table
    Properties:
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: sub
          AttributeType: S
        - AttributeName: draftId
          AttributeType: S
      KeySchema:
        - AttributeName: sub
          KeyType: HASH
        - AttributeName: draftId
          KeyType: RANGE
```

Give both functions the env var and the right policy — `DraftsFunction` writes rows, `MeFunction` only reads them:

```yaml
      Environment:
        Variables:
          DRAFT_MEMBERS_TABLE: !Ref DraftMembersTable
      Policies:
        - DynamoDBCrudPolicy:        # DraftsFunction
            TableName: !Ref DraftMembersTable
        - DynamoDBReadPolicy:        # MeFunction
            TableName: !Ref DraftMembersTable
```

Add each to that function's existing `Environment.Variables` and `Policies` lists rather than replacing them.

- [ ] **Step 4: Run the tests**

Run: `cd backend/src && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/members.js backend/src/drafts.js backend/src/me.js backend/src/me.test.js backend/src/template.test.js backend/template.yaml
git commit -m "feat: list the drafts you are in, not just the ones you made"
```

---

### Task 6: Which team is mine

**Files:**
- Modify: `backend/src/drafts.js` (the `GET /drafts/{draftId}` response)
- Modify: `frontend/src/pages/Draft.jsx`, and any other page reading `userTeam`
- Test: `backend/src/drafts.test.js`, `frontend/tests/draft.spec.js`

**Interfaces:**
- Consumes: `seatOf` (Task 1).
- Produces: `GET /drafts/{draftId}` returns `yourTeam` — the caller's own team number, or `null`.

**Background the implementer needs.** `userTeam` on the draft item is the **creator's** team, set at creation. `Draft.jsx` line 39 reads `draft?.userTeam || 1` to decide which team is yours. That is right while the creator is the only human and wrong for every joiner — they would see the creator's roster highlighted as their own and the clock pointing at the wrong seat.

`yourTeam` is derived per request from `seats`. The stored `userTeam` keeps its meaning — who created it and where they sit — and is left alone. Search the frontend for other `userTeam` readers and move them too.

- [ ] **Step 1: Write the failing tests**

Backend:

```js
test("yourTeam is the caller's own seat, not the creator's", async () => {
  const draft = {
    draftId: "d1", ownerId: "alice", userTeam: 1, currentIndex: 0, picks: [], picked: [],
    seats: [
      { team: 1, sub: "alice", kind: "human" },
      { team: 2, sub: "bob", kind: "human" },
    ],
  };
  assert.strictEqual(JSON.parse((await getDraftAs(draft, "alice")).body).yourTeam, 1);
  assert.strictEqual(JSON.parse((await getDraftAs(draft, "bob")).body).yourTeam, 2);
});
```

Frontend, in `frontend/tests/draft.spec.js`, inside its `test.describe`:

```js
  test("a joiner sees their own team as theirs, not the creator's", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    // The creator made it and sits in team 1; we are the person who joined.
    state.userTeam = 1;
    state.yourTeam = 2;
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await expect(page.getByTestId("my-team")).toContainText("2");
  });
```

If the page has no `data-testid="my-team"` on the element naming your team, add one as part of this task.

- [ ] **Step 2: Run and watch them fail**

Run: `cd backend/src && npm test` then `cd frontend && npx playwright test tests/draft.spec.js --workers=1`
Expected: both FAIL — no `yourTeam`.

- [ ] **Step 3: Implement**

In the GET response object:

```js
        // Derived per request. userTeam is the CREATOR's team, which is right
        // for them and wrong for everybody who joined.
        yourTeam: seatOf(d, sub)?.team ?? null,
```

In `Draft.jsx`, line 39:

```js
  const myTeam = draft?.yourTeam ?? draft?.userTeam ?? 1;
```

The fallback keeps a draft created before this shipped working until its next write, and costs one line.

- [ ] **Step 4: Run the tests**

Run both suites again.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/drafts.js backend/src/drafts.test.js frontend/src/pages/Draft.jsx frontend/tests/draft.spec.js
git commit -m "feat: your team is your seat, not the creator's"
```

---

### Task 7: The browser stops playing for everybody else

**Files:**
- Modify: `frontend/src/pages/Draft.jsx`
- Test: `frontend/tests/draft.spec.js`

**Interfaces:**
- Consumes: `yourTeam` and `seats` from `GET /drafts/{draftId}` (Task 6).
- Produces: nothing later tasks rely on.

**Background the implementer needs — this is the correctness fix in the frontend, and the most dangerous thing in the plan if it is got wrong.**

`Draft.jsx` has an effect that auto-picks whenever the team on the clock is **not yours**. That is how bot teams take their turns, and with one human it is exactly right. With two humans your browser would pick for the other person the instant their turn arrived, and theirs would do the same to you.

The rule becomes: **auto-pick only when the seat on the clock is a `bot` seat.**

Separately, and for the same reason, a draft with more than one human seat runs **no countdown and no timeout auto-pick** at all — the clock becomes the server's job in Phase 2, and until then every browser running its own timer would fire auto-picks at the others. A solo draft keeps its timer exactly as it is.

- [ ] **Step 1: Write the failing tests**

```js
  test("the browser never picks for another human", async ({ page }) => {
    let autoPicks = 0;
    const state = makeDraftState({ currentIndex: 0 });
    state.yourTeam = 1;
    state.seats = [
      { team: 1, sub: "me", kind: "human" },
      { team: 2, sub: "them", kind: "human" },
    ];
    // Team 2 -- another human -- is on the clock.
    state.currentIndex = 1;
    mockDraftApis(page, state);
    await page.route("**/drafts/*/auto-pick", (r) => { autoPicks += 1; return r.fulfill({ json: { ok: true } }); });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.waitForTimeout(2000);
    expect(autoPicks).toBe(0);
  });

  test("a bot seat still advances immediately", async ({ page }) => {
    let autoPicks = 0;
    const state = makeDraftState({ currentIndex: 0 });
    state.yourTeam = 1;
    state.seats = [
      { team: 1, sub: "me", kind: "human" },
      { team: 2, sub: null, kind: "bot" },
    ];
    state.currentIndex = 1;
    mockDraftApis(page, state);
    await page.route("**/drafts/*/auto-pick", (r) => { autoPicks += 1; return r.fulfill({ json: { ok: true } }); });

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect.poll(() => autoPicks).toBeGreaterThan(0);
  });

  test("a shared draft shows no countdown", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    state.yourTeam = 1;
    state.seats = [
      { team: 1, sub: "me", kind: "human" },
      { team: 2, sub: "them", kind: "human" },
    ];
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("clock")).toHaveCount(0);
  });
```

If the countdown element has no `data-testid="clock"`, add one.

- [ ] **Step 2: Run and watch them fail**

Run: `cd frontend && npx playwright test tests/draft.spec.js --workers=1`
Expected: the first test FAILS — today's rule is "not mine", so it picks for the other human.

- [ ] **Step 3: Implement**

Derive both facts near `myTeam`:

```js
  const seats = draft?.seats ?? [];
  const humans = seats.filter((s) => s?.kind === "human").length;
  // More than one person in here means the browser is no longer the authority
  // on time. Phase 2 moves the clock to the server; until then a shared draft
  // simply has no clock, because several browsers each running their own
  // would fire auto-picks at one another.
  const shared = humans > 1;
  // "Not my team" is not the same question as "is a bot", and in a shared
  // draft the difference is somebody else's pick being taken from them.
  const onClockIsBot = seats.find((s) => s?.team === draft?.currentTeam)?.kind === "bot";
```

Change the bot-advance effect's condition from `if (!isMyTurn)` to `if (onClockIsBot)`, and add `if (shared) return;` to the countdown effect and to the timeout auto-pick effect. Hide the countdown element when `shared`.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx playwright test tests/draft.spec.js --workers=1` and `npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Draft.jsx frontend/tests/draft.spec.js
git commit -m "fix: only a bot's turn is the browser's to take"
```

---

### Task 8: Joining, seeing each other, and what Sim to End means now

**Files:**
- Create: `frontend/src/pages/JoinDraft.jsx`
- Modify: `frontend/src/App.jsx`, `frontend/src/pages/Draft.jsx`, `backend/src/drafts.js`
- Test: `frontend/tests/draft.spec.js`, `backend/src/drafts.test.js`
- Regenerate: `screenshots/draft.png`

**Interfaces:**
- Consumes: `POST /drafts/{draftId}/join` (Task 4), `inviteToken` on GET (Task 4), `seats` (Task 7).
- Produces: nothing later tasks rely on.

**Background the implementer needs.** Three things finish the phase.

**The join route.** `/draft/:draftId/join?t=<token>` posts the token to the join endpoint and then sends the person to the draft. It needs `RequireAuth`, so an unsigned visitor signs in first and arrives back here. `frontend/src/pages/AuthCallback.jsx` is the pattern for a route that does work and redirects, including its comment on why a failure must be visible.

**Polling.** The draft page polls `GET /drafts/{draftId}` every 3 seconds while the draft is open and incomplete, so everyone sees everyone's picks. The response carries `version`, which increments on every write, so re-render only when it changes. Stop polling when the draft is complete, and when `document.visibilityState` is `hidden`, so a forgotten tab is not a permanent load.

**Sim to End.** Simulating the rest of a draft other people are sitting in takes their picks from them. The server refuses it with 409 when the draft holds more than one human seat, and the button does not render. A solo draft is unchanged.

- [ ] **Step 1: Write the failing tests**

Backend:

```js
test("sim to end is refused once somebody else is in the draft", async () => {
  const draft = {
    draftId: "d1", ownerId: "alice", currentIndex: 0, picked: [], picks: [{ team: 1 }],
    seats: [
      { team: 1, sub: "alice", kind: "human" },
      { team: 2, sub: "bob", kind: "human" },
    ],
  };
  const res = await simToEndAs(draft, "alice");
  assert.strictEqual(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /on your own/i);
});
```

Frontend:

```js
  test("opening an invite link seats you and opens the draft", async ({ page }) => {
    let joinedWith = null;
    await page.route("**/drafts/*/join", (r) => {
      joinedWith = r.request().postDataJSON().token;
      return r.fulfill({ json: { ok: true, team: 2 } });
    });
    const state = makeDraftState({ currentIndex: 0 });
    state.yourTeam = 2;
    mockDraftApis(page, state);

    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}/join?t=abc123`);

    await expect(page).toHaveURL(new RegExp(`/draft/${DRAFT_ID}$`));
    expect(joinedWith).toBe("abc123");
  });

  test("a picked player appears without touching anything", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    state.yourTeam = 1;
    state.version = 1;
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    // Somebody else picks: the next poll should bring it in.
    const moved = { ...state, version: 2, currentIndex: 1 };
    await page.route(`**/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: moved }));

    await expect.poll(async () => (await page.getByTestId("current-pick").textContent()) || "",
      { timeout: 10000 }).toContain("2");
  });
```

Use whatever test id the page already carries for the pick counter; add `data-testid="current-pick"` if there is none.

- [ ] **Step 2: Run and watch them fail**

Run both suites.
Expected: FAIL — no join route, no polling, sim-to-end returns 200.

- [ ] **Step 3: Implement**

Create `frontend/src/pages/JoinDraft.jsx`:

```jsx
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiPost } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * Redeems an invite link, then opens the draft.
 *
 * Modelled on AuthCallback: a failure here must be visible, because a blank
 * screen after clicking a friend's link is indistinguishable from the app
 * being broken.
 */
export default function JoinDraft() {
  const nav = useNavigate();
  const { draftId } = useParams();
  const [params] = useSearchParams();
  const [err, setErr] = useState("");
  usePageTitle("Joining a draft");

  // Once per visit. StrictMode double-invokes effects in development, and
  // posting the token twice would ask for a second seat.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    apiPost(`/drafts/${draftId}/join`, { token: params.get("t") })
      .then(() => nav(`/draft/${draftId}`, { replace: true }))
      .catch((e) => setErr(e.message || "That invite link did not work"));
  }, [draftId, params, nav]);

  if (err) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div data-testid="join-error" className="rounded-2xl border border-rose-800/40 bg-rose-950/20 px-4 py-3 text-sm text-rose-200">
          {err}
        </div>
      </div>
    );
  }
  return <div className="mx-auto max-w-2xl p-6 text-sm text-zinc-400">Taking your seat…</div>;
}
```

Register in `App.jsx` beside the other draft routes:

```jsx
              <Route path="/draft/:draftId/join" element={<RequireAuth><JoinDraft /></RequireAuth>} />
```

Add polling to `Draft.jsx`, beside the other effects:

```js
  // Everyone in the draft is looking at the same row, and only the person who
  // picked knows it changed. Three seconds is a judgement: fast enough that a
  // pick feels immediate to everybody else, slow enough that twelve people is
  // twenty requests a minute each rather than hundreds.
  useEffect(() => {
    if (!draftId || completed) return undefined;

    const id = setInterval(() => {
      // A tab nobody is looking at does not need to keep asking. Without this
      // a forgotten tab polls until the browser is closed.
      if (document.visibilityState === "hidden") return;
      refresh();
    }, 3000);

    return () => clearInterval(id);
  }, [draftId, completed, refresh]);
```

Use whatever the page already calls to re-fetch the draft in place of
`refresh()` — read the file and reuse it rather than adding a second fetch
path. `version` on the response increments on every write, so re-render only
when it differs from the version already held.

Add a copy-the-link control visible to anyone seated:

```jsx
        <button
          type="button"
          data-testid="copy-invite"
          onClick={() =>
            navigator.clipboard.writeText(
              `${window.location.origin}/draft/${draftId}/join?t=${draft.inviteToken}`
            )
          }
          className="rounded-2xl border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
        >
          Copy invite link
        </button>
```

In `drafts.js`, at the top of the `/sim-to-end` handler after the seat check:

```js
      // Simulating the rest of a draft other people are sitting in takes
      // their picks away from them.
      if (humanSeatCount(d) > 1) {
        return json(409, { error: "Sim to End is for drafts you are in on your own" });
      }
```

Hide the Sim to End button when `seats` holds more than one human.

- [ ] **Step 4: Run everything**

Run: `cd backend/src && npm test`, then `cd frontend && npx playwright test --workers=1` and `npm run lint`.
Expected: all pass, clean.

- [ ] **Step 5: Refresh the screenshot and commit**

The draft page changed, and this repo shows screenshots in the README, so regenerate and commit `screenshots/draft.png` along with the code.

```bash
git add backend/src/drafts.js backend/src/drafts.test.js frontend/src/pages/JoinDraft.jsx frontend/src/App.jsx frontend/src/pages/Draft.jsx frontend/tests/draft.spec.js screenshots/draft.png
git commit -m "feat: join by link, watch each other draft, and no simulating a shared draft"
```

---

## Final Verification

- [ ] `cd backend/src && npm test` — all pass, including `template.test.js`.
- [ ] `cd frontend && npm run test:unit` — all pass.
- [ ] `cd frontend && npm run lint` — clean.
- [ ] `cd frontend && npx playwright test --workers=1` — the full suite.
- [ ] `git status --short` — clean.

**On this machine:** Playwright browser launches and dev-server startup time out under load. A `browserType.launch: Timeout` or a wave of `ERR_CONNECTION_REFUSED` is the environment, not the code — re-run a red test on its own before believing it.

**Deploying** touches both halves, and the backend gains a table: `cd backend && sam build && sam deploy --parameter-overrides ...` with the Google and Yahoo parameter pairs as the README documents, then `cd frontend && npm run deploy`. Never `--guided`.
