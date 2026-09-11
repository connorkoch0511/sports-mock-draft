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

// Display fallback only, same value and reasoning as drafts.js's PICK_SECONDS
// and advance.js's own copy: a draft written before pickSeconds existed still
// needs a number to derive a TTL and a your-turn threshold from.
const PICK_SECONDS = 60;

// web-push's own default TTL is four weeks -- fine for a service that might
// legitimately queue an update for a week-offline phone, wrong for "your
// turn in a fantasy draft". A notification more than one more pick stale
// past the deadline is noise, not news, so the TTL tracks the draft's own
// pace: never less than a minute (a fast draft's queue must not evaporate
// before the push service can even attempt delivery), never more than an
// hour (nobody needs to hear about a slow draft's turn a day late either).
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;

// A drafter with the tab open and a 30-second clock would otherwise get a
// silent push every single pick -- exhausting the browser's silent-push
// budget, after which the browser starts showing its own generic "site
// updated in background" notification instead of anything this app sends.
// Below this, your-turn pushes are skipped; picked-for-you pushes (the one
// case where staying quiet actually costs the person their pick) still go
// out at every speed.
const YOUR_TURN_MIN_PICK_SECONDS = 300;

// web-push forwards this straight to the underlying https.request. With no
// timeout at all, an endpoint that accepts a connection and never answers
// wedges this invocation -- sends are sequential -- until the Lambda's own
// 30-second timeout, and MaximumRetryAttempts: 0 then discards the whole
// batch, including every other draft's notifications riding along in it.
const SEND_TIMEOUT_MS = 5000;

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function ttlFor(pickSeconds) {
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, pickSeconds));
}

async function handler(event) {
  const out = { records: 0, sent: 0, expired: 0, failed: 0 };

  // One invocation can carry a whole drain batch for the same person (a
  // multi-pick advance, several drafts' records back to back) -- without
  // this, every one of those notes re-queries the same person's
  // subscriptions. Scoped to the invocation, not module-level: a Lambda's
  // subscriptions can change between invocations and this must not serve
  // stale rows across them.
  const subsCache = new Map();
  async function subscriptionsFor(sub) {
    if (subsCache.has(sub)) return subsCache.get(sub);
    const res = await ddb.send(
      new QueryCommand({
        TableName: subsTable,
        KeyConditionExpression: "#s = :s",
        ExpressionAttributeNames: { "#s": "sub" },
        ExpressionAttributeValues: { ":s": sub },
      })
    );
    const items = res.Items || [];
    subsCache.set(sub, items);
    return items;
  }

  for (const rec of event?.Records || []) {
    out.records += 1;
    if (rec.eventName !== "MODIFY") continue;

    let notes;
    let pickSeconds;
    try {
      const before = rec.dynamodb?.OldImage ? unmarshall(rec.dynamodb.OldImage) : null;
      const after = rec.dynamodb?.NewImage ? unmarshall(rec.dynamodb.NewImage) : null;
      notes = decideNotifications(before, after);
      pickSeconds = after?.pickSeconds ?? PICK_SECONDS;
    } catch (e) {
      // A malformed record must not abort the batch either. decideNotifications
      // is defensively written and real records are well-formed, but the
      // invariant is "nothing throws" -- true by construction, not by luck.
      out.failed += 1;
      console.error(`record decode/decision failed:`, e?.message || e);
      continue;
    }

    // A pause must not even look up subscriptions -- most records reaching
    // this stream are not a turn changing hands.
    if (notes.length === 0) continue;

    const ttl = ttlFor(pickSeconds);

    for (const note of notes) {
      // Delivery policy, not decision-making -- decideNotifications stays a
      // pure "who does this concern" answer. picked-for-you always sends:
      // that is the one notification whose whole point is telling you about
      // a turn you already missed.
      if (note.kind === "your-turn" && pickSeconds < YOUR_TURN_MIN_PICK_SECONDS) continue;

      let subs;
      try {
        subs = await subscriptionsFor(note.sub);
      } catch (e) {
        // A transient DynamoDB error here (throttling, a permissions blip)
        // must not abort the whole invocation -- that would lose notifications
        // for every remaining note and record in the batch.
        out.failed += 1;
        console.error(`subscription lookup failed for draft ${note.draftId}, sub ${note.sub}:`, e?.message || e);
        continue;
      }

      for (const row of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            JSON.stringify({ title: note.title, body: note.body, draftId: note.draftId }),
            { TTL: ttl, timeout: SEND_TIMEOUT_MS }
          );
          out.sent += 1;
        } catch (e) {
          // 404 and 410 are how a push service says the subscription is gone.
          // Deleting it is required: otherwise the row is retried forever.
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            try {
              await ddb.send(
                new DeleteCommand({ TableName: subsTable, Key: { sub: row.sub, endpoint: row.endpoint } })
              );
              out.expired += 1;
            } catch (delErr) {
              // An exception raised while handling an exception would defeat
              // the very guard it lives inside: it must not escape either.
              out.failed += 1;
              console.error(
                `failed to delete expired subscription for sub ${row.sub}, endpoint ${row.endpoint}:`,
                delErr?.message || delErr
              );
            }
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
