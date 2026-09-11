# Telling somebody it is their turn

**Status:** approved design, not yet implemented
**Depends on:** the shared clock, the unattended clock, and per-draft pick lengths — all merged and deployed.

## Problem

Nothing tells a drafter their turn has arrived. The page polls every three
seconds, so a browser sitting open does find out — but only while somebody is
looking at it. Close the tab and the draft is silent until you next think to
check, which in a draft with a long pick length could be a day.

This is the last of the three items the shared clock deferred, and the only
one that needed a decision before it needed code: there was no delivery
channel in this stack at all.

## Decisions

1. **Web push, not email.** Push costs nothing to send — the browser vendors'
   own services carry it — needs no AWS prerequisite, and arrives in seconds
   rather than minutes. It also stores **no email address**, which suits an
   app that already declines to keep a Yahoo credential or a Sleeper login.
   The cost is accepted: a service worker, a permission prompt people can
   decline, subscriptions that expire, and iOS delivering only when the site
   has been added to the home screen.
2. **Two events.** "You are on the clock", and "we picked X for you". The
   second is what stops a long draft going quietly wrong — you learn you
   missed a turn without opening the page.
3. **Every draft, regardless of pick length.** Not restricted to slow drafts.
4. **Silent when the app is focused.** The service worker checks for a
   focused window on this origin and shows nothing if it finds one. This is
   what makes decision 3 safe: in a thirty-second solo draft every pick is
   your turn, and without this the feature would notify you every thirty
   seconds while you sat watching it. A notification is only ever useful when
   you are *not* looking, so that is the only time it appears.
5. **The sender is decoupled from the pick path.** A DynamoDB stream on the
   drafts table feeds a notifier Lambda.

### Why the stream, and not the obvious alternatives

Sending inline after `advanceDraft` succeeds would be simpler to follow, but
it puts an HTTPS call to a third-party push endpoint inside the request that
makes a pick. Every pick would then wait on it, and a slow or failing push
service would become a slow or failing pick. Fire-and-forget does not rescue
it: Lambda freezes once a response is returned, so an un-awaited send may
never happen at all.

That conditional write is the single most safety-critical path in this
application — it is what stops two people overwriting each other's picks —
and nothing should be added to it that does not have to be there.

Letting the existing scheduled clock send them was the other option. It
already runs every minute, but it only looks at *overdue* drafts, so it would
have to invent state tracking whose turn had begun and whether they had been
told, and it would be up to a minute late.

The stream costs a new moving part and gains two things: zero latency added
to picking, and the before-and-after images that make "was this pick
automatic?" answerable.

## Data model

**A new table, `perfectpick-push-subs`:**

```
PK: sub        (Cognito subject — the person)
SK: endpoint   (the push service URL — one row per browser)
    p256dh, auth   (the subscription's keys)
    createdAt
```

One person may hold several rows: a laptop and a phone are separate
subscriptions. A row is deleted when a push service answers `404` or `410`,
which is how it reports that a subscription has expired — that cleanup is
required, not optional, or the table fills with dead endpoints that are
retried forever.

**One addition to the pick record.** The notifier must distinguish "your turn
began" from "we picked for you", and inferring it from the images is
guesswork. The auto-pick path marks what it writes:

```js
d.picks[d.currentIndex].auto = true;
```

Set only by `lib/autoPick.js`. A manual pick leaves it absent.

**A stream on the drafts table**, `NEW_AND_OLD_IMAGES`. Nothing else reads
it today.

## The notifier

A new `NotifierFunction`, triggered by the stream, handling `MODIFY` records:

1. Compare `OldImage.currentIndex` with `NewImage.currentIndex`. If it did not
   increase, ignore the record — pauses, board changes and seat-board writes
   all land here too.
2. The pick that was just completed is `NewImage.picks[oldIndex]`. If it
   carries `auto: true`, notify the seat that held **that** pick: "we picked
   X for you".
3. The seat now on the clock is `NewImage.picks[newIndex].team`. If that seat
   is human, notify its `sub`: "you are on the clock".
4. A completed draft (`newIndex >= picks.length`) has nobody on the clock —
   send only the auto-pick notice, if any.

**Idempotency.** DynamoDB streams guarantee at-least-once delivery, so a
record may arrive twice and produce a duplicate notification. That is
accepted rather than solved: the cost is one repeated banner, and the state
needed to deduplicate would be more dangerous than the duplicate.

**Failure is per-subscription.** One dead endpoint must not stop the others
being notified, and no push failure may ever fail the stream record in a way
that makes DynamoDB retry the batch — a retried batch would re-notify
everybody in it.

## Keys and configuration

A VAPID keypair identifies this application to the push services. The private
key goes in SSM beside the Google and Yahoo secrets and is read at deploy
time; the public key is not secret and is shipped to the browser as
`VITE_VAPID_PUBLIC_KEY`.

Consistent with the existing rule: a build with no public key configured
shows no notification control at all, rather than one that cannot work.

## Frontend

**A service worker**, `frontend/public/sw.js`, so it is served from the root
and gets root scope. It does two things: show a notification, and on click
focus or open the draft it names. Before showing, it calls
`clients.matchAll({ type: "window" })` and returns without showing if any
client on this origin is focused — decision 4.

**Asking permission, late and once.** Never on load. On a draft page, a
control offers to turn notifications on; clicking it requests permission and,
on grant, subscribes and POSTs the subscription. The three states are shown
honestly — off, on, and blocked-by-the-browser, the last of which is not
re-prompted because the browser will not ask again.

**Two routes** to carry subscriptions: one to store, one to remove.

## Testing

- The notifier's decision logic is a pure function of the two images, and is
  tested as one: no advance, an advance to a human seat, an advance to a bot
  seat, a completed draft, a pick marked `auto`, a pick not marked `auto`.
- An expired endpoint (`410`) deletes exactly that row and leaves the
  person's other subscriptions alone.
- One failing subscription does not prevent the others being sent, and does
  not fail the record.
- The service worker's focus check: with a focused client, nothing is shown.
- `template.test.js` gains assertions for the stream (`NEW_AND_OLD_IMAGES`),
  the notifier's event source, and its access to the subscriptions table —
  all three fail silently in production while every unit test passes.
- Mutation-test the `currentIndex` comparison and the focus check.

## Out of scope

- Email, and any second channel. The notifier has one sender.
- Per-person preferences beyond the browser's own permission: no quiet hours,
  no per-draft mute, no digest.
- Notifying anything other than the two events in decision 2.
- iOS behaviour beyond what the platform gives for an installed web app.
