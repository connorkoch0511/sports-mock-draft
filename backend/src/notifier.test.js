const test = require("node:test");
const assert = require("node:assert");
const { mock } = require("node:test");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");
const webpush = require("web-push");

process.env.PUSH_SUBS_TABLE = "subs-test";
// web-push validates the public key's decoded length (65 bytes) the moment
// setVapidDetails runs, which happens at module load -- before any mock in
// this file takes effect. A placeholder like "pub" fails that check and
// crashes the require, so these are a throwaway keypair generated with
// webpush.generateVAPIDKeys(), shaped like the real thing but signing
// nothing that matters.
process.env.VAPID_PUBLIC_KEY = "BEFjTTw8ptWBm3M3JCdpKrKIc0jDOG0ByKph4cqR86FjyqYLLq7Znva1a6wQVu0BPiw0cwXGN1Ih3UnDFoZv88o";
process.env.VAPID_PRIVATE_KEY = "MrRp5j0W9TC95CgAj9Fbk_8KTFlDaGgeTGI_yIrhVRU";
process.env.VAPID_SUBJECT = "mailto:test@example.com";

const { handler } = require("./notifier");

test.afterEach(() => mock.restoreAll());

const SEATS = [
  { team: 1, kind: "human", sub: "user-a" },
  { team: 2, kind: "human", sub: "user-b" },
];

/**
 * A stream MODIFY record advancing the draft from pick 0 to pick 1.
 *
 * pickSeconds defaults to 600 (10 minutes) -- comfortably above the 300s
 * your-turn threshold -- so every test below that is not itself about the
 * threshold or the TTL keeps exercising a your-turn push exactly as before.
 * Tests that care about a specific pace pass their own.
 */
function advanceRecord({ pickSeconds = 600 } = {}) {
  return {
    Records: [
      {
        eventName: "MODIFY",
        dynamodb: {
          OldImage: marshall({
            draftId: "d1",
            currentIndex: 0,
            picks: [{ team: 1 }, { team: 2 }],
            seats: SEATS,
            pickSeconds,
          }),
          NewImage: marshall({
            draftId: "d1",
            currentIndex: 1,
            picks: [{ team: 1, playerId: "p1" }, { team: 2 }],
            seats: SEATS,
            pickSeconds,
          }),
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

test("your-turn is skipped for a draft under the 5-minute threshold", async () => {
  let queried = false;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    queried = true;
    return { Items: [{ sub: "user-b", endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" }] };
  });
  const sent = [];
  mock.method(webpush, "sendNotification", async (sub) => {
    sent.push(sub.endpoint);
    return {};
  });

  const out = await handler(advanceRecord({ pickSeconds: 299 }));
  assert.equal(out.sent, 0);
  assert.equal(sent.length, 0);
  // Skipped before the subscription lookup, not after -- a fast draft
  // must not pay for a query whose result is thrown away.
  assert.equal(queried, false);
});

test("your-turn is sent right at the 5-minute threshold and above", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [{ sub: "user-b", endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" }],
  }));
  const sent = [];
  mock.method(webpush, "sendNotification", async (sub) => {
    sent.push(sub.endpoint);
    return {};
  });

  const out = await handler(advanceRecord({ pickSeconds: 300 }));
  assert.equal(out.sent, 1);
  assert.deepEqual(sent, ["https://push.example/laptop"]);
});

test("picked-for-you is sent even for a draft under the 5-minute threshold", async () => {
  const fastSeats = [
    { team: 1, kind: "human", sub: "user-a" },
    { team: 2, kind: "human", sub: "user-b" },
  ];
  const record = {
    eventName: "MODIFY",
    dynamodb: {
      OldImage: marshall({
        draftId: "d1",
        currentIndex: 0,
        picks: [{ team: 1 }, { team: 2 }],
        seats: fastSeats,
        pickSeconds: 30,
      }),
      NewImage: marshall({
        draftId: "d1",
        currentIndex: 1,
        picks: [{ team: 1, playerId: "p1", auto: true, player: { name: "Auto Pick" } }, { team: 2 }],
        seats: fastSeats,
        pickSeconds: 30,
      }),
    },
  };
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [{ sub: "user-a", endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" }],
  }));
  const sent = [];
  mock.method(webpush, "sendNotification", async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, kind: JSON.parse(payload).title });
    return {};
  });

  // Two notes come out of this record: picked-for-you (user-a, who was
  // auto-picked) and your-turn (user-b, now on the clock) -- the latter
  // skipped by the 30s pace, the former sent regardless.
  const out = await handler({ Records: [record] });
  assert.equal(out.sent, 1);
  assert.deepEqual(sent, [{ endpoint: "https://push.example/laptop", kind: "Your clock ran out" }]);
});

test("a short draft's TTL is clamped to the one-minute floor", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [{ sub: "user-a", endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" }],
  }));
  let options = null;
  mock.method(webpush, "sendNotification", async (_sub, _payload, opts) => {
    options = opts;
    return {};
  });

  const fastSeats = [
    { team: 1, kind: "human", sub: "user-a" },
    { team: 2, kind: "human", sub: "user-b" },
  ];
  const record = {
    eventName: "MODIFY",
    dynamodb: {
      OldImage: marshall({ draftId: "d1", currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: fastSeats, pickSeconds: 15 }),
      NewImage: marshall({
        draftId: "d1",
        currentIndex: 1,
        picks: [{ team: 1, playerId: "p1", auto: true, player: { name: "Auto Pick" } }, { team: 2 }],
        seats: fastSeats,
        pickSeconds: 15,
      }),
    },
  };

  // picked-for-you always sends, even at a 15s pace, so this pins the TTL
  // without the your-turn threshold getting in the way.
  await handler({ Records: [record] });
  assert.equal(options.TTL, 60);
  assert.equal(options.timeout, 5000);
});

test("a slow draft's TTL is clamped to the one-hour ceiling", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [{ sub: "user-b", endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" }],
  }));
  let options = null;
  mock.method(webpush, "sendNotification", async (_sub, _payload, opts) => {
    options = opts;
    return {};
  });

  await handler(advanceRecord({ pickSeconds: 86400 }));
  assert.equal(options.TTL, 3600);
});

test("a draft with no pickSeconds falls back to the 60-second default, floored to a minute TTL", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => ({
    Items: [{ sub: "user-a", endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" }],
  }));
  let options = null;
  mock.method(webpush, "sendNotification", async (_sub, _payload, opts) => {
    options = opts;
    return {};
  });

  const fastSeats = [
    { team: 1, kind: "human", sub: "user-a" },
    { team: 2, kind: "human", sub: "user-b" },
  ];
  const record = {
    eventName: "MODIFY",
    dynamodb: {
      // No pickSeconds at all -- a draft written before the field existed.
      OldImage: marshall({ draftId: "d1", currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: fastSeats }),
      NewImage: marshall({
        draftId: "d1",
        currentIndex: 1,
        picks: [{ team: 1, playerId: "p1", auto: true, player: { name: "Auto Pick" } }, { team: 2 }],
        seats: fastSeats,
      }),
    },
  };

  await handler({ Records: [record] });
  assert.equal(options.TTL, 60);
});

test("subscriptions for the same person are queried once per invocation, not once per note", async () => {
  let queries = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    queries += 1;
    return { Items: [{ sub: "user-b", endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" }] };
  });
  mock.method(webpush, "sendNotification", async () => ({}));

  const batch = advanceRecord();
  // A second draft, same person on the clock in both -- the drain-batch
  // scenario item #11 is about: one person, several notes, one invocation.
  batch.Records.push({
    eventName: "MODIFY",
    dynamodb: {
      OldImage: marshall({ draftId: "d2", currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS, pickSeconds: 600 }),
      NewImage: marshall({
        draftId: "d2",
        currentIndex: 1,
        picks: [{ team: 1, playerId: "p1" }, { team: 2 }],
        seats: SEATS,
        pickSeconds: 600,
      }),
    },
  });

  const out = await handler(batch);
  assert.equal(out.sent, 2);
  assert.equal(queries, 1, "the second record's note for the same sub must be served from cache");
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

test("a failing delete of an expired subscription does not throw, and the run still reports its other work", async () => {
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    if (cmd?.input?.Key?.endpoint) {
      throw new Error("delete rejected: throughput exceeded");
    }
    return {
      Items: [
        { sub: "user-b", endpoint: "https://push.example/gone", p256dh: "k", auth: "a" },
        { sub: "user-b", endpoint: "https://push.example/fine", p256dh: "k", auth: "a" },
      ],
    };
  });
  mock.method(webpush, "sendNotification", async (sub) => {
    if (sub.endpoint.endsWith("gone")) {
      const e = new Error("gone");
      e.statusCode = 410;
      throw e;
    }
    return {};
  });

  // Must resolve even though the DeleteCommand inside the catch block also
  // throws -- an exception raised while handling an exception must not
  // escape the handler either.
  const out = await handler(advanceRecord());
  assert.equal(out.sent, 1);
  assert.equal(out.failed, 1);
});

test("a failing subscription lookup does not throw, and a second record in the same batch is still processed", async () => {
  const secondRecord = {
    eventName: "MODIFY",
    dynamodb: {
      OldImage: marshall({ draftId: "d2", currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS, pickSeconds: 600 }),
      NewImage: marshall({
        draftId: "d2",
        currentIndex: 1,
        picks: [{ team: 1, playerId: "p1" }, { team: 2 }],
        seats: SEATS,
        pickSeconds: 600,
      }),
    },
  };
  const batch = advanceRecord();
  batch.Records.push(secondRecord);

  let call = 0;
  mock.method(DynamoDBDocumentClient.prototype, "send", async (cmd) => {
    call += 1;
    if (call === 1) throw new Error("throttled");
    return { Items: [{ sub: "user-b", endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" }] };
  });
  const sent = [];
  mock.method(webpush, "sendNotification", async (sub) => {
    sent.push(sub.endpoint);
    return {};
  });

  // The QueryCommand for the first record's notification throws. That must
  // not abort the batch: the second record's notification still gets sent.
  const out = await handler(batch);
  assert.equal(out.failed, 1);
  assert.equal(out.sent, 1);
  assert.deepEqual(sent, ["https://push.example/laptop"]);
});

test("a malformed record does not throw", async () => {
  let queried = false;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    queried = true;
    return { Items: [{ sub: "user-b", endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" }] };
  });
  const sent = [];
  mock.method(webpush, "sendNotification", async (sub) => {
    sent.push(sub.endpoint);
    return {};
  });

  const good = advanceRecord().Records[0];
  const malformed = {
    eventName: "MODIFY",
    dynamodb: {
      // Not a real DynamoDB-typed attribute map -- unmarshall must reject it.
      OldImage: { draftId: { S: "d3" }, currentIndex: { BOGUS: "x" } },
      NewImage: { draftId: { S: "d3" }, currentIndex: { BOGUS: "x" } },
    },
  };

  const out = await handler({ Records: [malformed, good] });
  assert.equal(out.failed, 1);
  // The well-formed record right after it in the same batch is unaffected.
  assert.equal(out.sent, 1);
  assert.deepEqual(sent, ["https://push.example/laptop"]);
  assert.equal(queried, true);
});

test("a record that does not advance the pick sends nothing", async () => {
  let queried = false;
  mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    queried = true;
    return { Items: [] };
  });
  const paused = advanceRecord();
  // The image is DynamoDB-typed, so a mutation here must stay typed too --
  // an untyped 0 is not a value unmarshall can interpret.
  paused.Records[0].dynamodb.NewImage.currentIndex = { N: "0" };
  paused.Records[0].dynamodb.NewImage.pausedAt = { N: "123" };

  const out = await handler(paused);
  assert.equal(out.sent, 0);
  assert.equal(queried, false, "a pause must not even look up subscriptions");
});
