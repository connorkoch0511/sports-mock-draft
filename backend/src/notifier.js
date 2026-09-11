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

    let notes;
    try {
      const before = rec.dynamodb?.OldImage ? unmarshall(rec.dynamodb.OldImage) : null;
      const after = rec.dynamodb?.NewImage ? unmarshall(rec.dynamodb.NewImage) : null;
      notes = decideNotifications(before, after);
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

    for (const note of notes) {
      let subs;
      try {
        subs = await ddb.send(
          new QueryCommand({
            TableName: subsTable,
            KeyConditionExpression: "#s = :s",
            ExpressionAttributeNames: { "#s": "sub" },
            ExpressionAttributeValues: { ":s": note.sub },
          })
        );
      } catch (e) {
        // A transient DynamoDB error here (throttling, a permissions blip)
        // must not abort the whole invocation -- that would lose notifications
        // for every remaining note and record in the batch.
        out.failed += 1;
        console.error(`subscription lookup failed for draft ${note.draftId}, sub ${note.sub}:`, e?.message || e);
        continue;
      }

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
