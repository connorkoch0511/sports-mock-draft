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

/** A stream MODIFY record advancing the draft from pick 0 to pick 1. */
function advanceRecord() {
  return {
    Records: [
      {
        eventName: "MODIFY",
        dynamodb: {
          OldImage: marshall({ draftId: "d1", currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS }),
          NewImage: marshall({
            draftId: "d1",
            currentIndex: 1,
            picks: [{ team: 1, playerId: "p1" }, { team: 2 }],
            seats: SEATS,
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
      OldImage: marshall({ draftId: "d2", currentIndex: 0, picks: [{ team: 1 }, { team: 2 }], seats: SEATS }),
      NewImage: marshall({
        draftId: "d2",
        currentIndex: 1,
        picks: [{ team: 1, playerId: "p1" }, { team: 2 }],
        seats: SEATS,
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
