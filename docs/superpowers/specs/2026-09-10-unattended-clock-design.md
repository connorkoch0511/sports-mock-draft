# Drafting Together, Phase 3: The Unattended Clock

**Status:** approved design, not yet implemented
**Depends on:** Phase 2 (`docs/superpowers/specs/2026-09-09-shared-clock-design.md`), merged and deployed at `8620c19`

## Problem

Phase 2 gave every draft a deadline the server owns and enforces. It did not
give the server a reason to look at that deadline on its own. `POST /expire`
is called by browsers: the page waits until its countdown reaches zero and
asks the server to check its own clock.

So the clock is only true while somebody is watching. Close every tab on a
draft and its deadline passes with nothing to notice. The next person to open
the page gets one auto-pick, correctly, but hours or days late — and in a
draft with other people in it, everyone waits on whichever browser happens to
be open.

Phase 2 anticipated this and shaped `/expire` for a scheduler rather than for
the browser that happens to call it: the endpoint takes no argument about
time, consults only the server's clock, and is safe to call when nothing is
due. What is missing is the caller.

## Decisions

Carried in from the Phase 2 spec:

- The deadline is data, never a running timer, and it is written inside the
  same conditional write that moves `currentIndex`.
- A board that fails to load falls back to consensus rankings; it must never
  fail a pick or stall the clock.
- `/auto-pick` never consults the deadline. `/expire` only ever consults the
  deadline.

Made in this brainstorm:

1. **Every draft, solo included.** The scheduler does not care how many human
   seats a draft has. A deadline is a deadline. The consequence is accepted
   deliberately: a solo mock draft left open and walked away from will finish
   itself, and the person comes back to a completed draft whose later picks
   they did not make.
2. **The scheduler drains; the browser does not.** This is a deliberate
   divergence from Phase 2's rule that one expired deadline produces exactly
   one auto-pick. That rule stays exactly as it is for `POST /expire`, where a
   catch-up burst would fire on a draft somebody is actively watching. The
   scheduler instead keeps picking for a draft until its deadline is in the
   future or the draft is complete, because the drafts it finds are by
   definition ones nobody is watching, and the alternative is a zombie draft
   that needs one scheduler run per remaining pick.

   **Catch-up consumes the missed time.** A drained pick advances the deadline
   from the draft's *previous* deadline, not from wall-clock now: a draft
   forty minutes overdue burns forty one-minute slots and the loop terminates
   naturally when the deadline reaches the present. This is not a refinement,
   it is what makes the drain a drain. `advanceDraft` writes `now + 60s`, so a
   loop that re-read the draft and continued "while the deadline is in the
   past" would find a deadline it had just placed in the *future* and exit
   after exactly one pick — the zombie draft this decision exists to prevent,
   with the loop written and green. `advanceDraft` therefore takes an optional
   deadline base. Absent — every browser path, `/pick`, `/auto-pick`,
   `/expire` and sim-to-end — behaviour is exactly what it was: a full minute
   from now. Only the scheduler passes one.
3. **Found by a sparse index, not a scan.** A draft is in the index only while
   its clock should be running.
4. **The scheduler runs in-process, not over HTTP.** It calls the same pick
   rule the route calls, rather than making a signed request to its own API.
5. **A window, not a rate.** Every minute from 08:00 to 02:00
   `America/Los_Angeles`, rather than around the clock.

## Data model

One new global secondary index on `perfectpick-drafts`:

```
byClock    HASH: clockRunning (S)    RANGE: pickDeadline (N)    Projection: KEYS_ONLY
```

`clockRunning` is the constant string `"1"`. It is present on a draft item
only while that draft's clock should actually be running, which makes the
index sparse: a finished or paused draft carries no such attribute and so has
no entry at all. One `Query` per run — `clockRunning = "1" AND pickDeadline <
now` — returns exactly the drafts that are due. No scan, no filter, no reads
of drafts that are not due.

The attribute is maintained at four sites, and **every one of them is a write
that already happens**. No new write is introduced by ordinary drafting:

| Site | Effect on `clockRunning` |
| --- | --- |
| Draft creation (`POST /drafts`) | set, beside the initial `pickDeadline` |
| `advanceDraft` | set in the same conditional write as the new deadline — or **removed** when that write completes the draft |
| `POST /pause` (pausing) | removed |
| `POST /pause` (resuming) | set, in the same write that shifts the deadline forward |

Riding along inside the existing conditional write is the point, not an
optimisation. It is the same property the clock itself relies on: because the
index entry moves atomically with `currentIndex` and `pickDeadline`, the
scheduler can never see an index entry that disagrees with the draft it names.
A separate update would leave a window in which the index claims a draft is
due when it is not, and the scheduler would pick for a turn that has already
been taken.

### The one write that is not free: the scheduler's self-heal

Riding along is enough to keep the index *correct*, and not enough to keep it
*drainable*. The query is ascending on `pickDeadline` with a limit, so a draft
that is in the index but can never advance is returned **first, on every run,
forever**. Twenty-five of those and the clock silently stops for everybody
else: the whole run is spent re-reading drafts it cannot move.

So the scheduler self-heals. When a drain makes zero picks for a *structural*
reason, it conditionally removes `clockRunning` so the draft leaves the index:

| Reason | Condition on the removal |
| --- | --- |
| completed | `currentIndex >= size(picks)` |
| paused | `attribute_exists(pausedAt)` |

Conditional, because between the read that said "completed" and this write the
draft may have changed, and un-indexing a draft whose clock should be running
is the exact bug the index exists to prevent. A condition failure means the
draft moved on: it is counted and left indexed.

Nothing transient is evicted. A lost race and a deadline that is simply still
in the future are the system working, and the draft must stay indexed. Neither
is an exhausted player pool: that is recoverable, and evicting would mean the
draft is never enforced again once the pool is fixed, so it is counted and
logged distinctly instead.

This is the one place `clockRunning` is written outside a write that was
already happening. It is a correctness mechanism rather than maintenance —
without it a handful of stuck rows disable the feature for every draft in the
table — and it is carved out explicitly in the plan's Global Constraints.

### Pausing and the index

`advanceDraft`'s condition guards `currentIndex`, and pausing does not move
`currentIndex`. A pick that raced a pause therefore succeeded, and because the
same write sets `clockRunning`, it put the paused draft straight back into the
index `/pause` had just removed it from — manufacturing exactly the stuck rows
above. The condition is therefore `currentIndex = :expected AND
attribute_not_exists(pausedAt)`: picking while paused is a clean failure on
every path, told apart from a lost race by the re-read that already happens,
and answered with a 409 that says the draft is paused rather than that
somebody just picked.

`KEYS_ONLY` is deliberate, and follows the reasoning already written on the
`byOwner` index: the projection excludes `picks`, which is the whole draft
board. The scheduler needs the full item to make a pick, so it loads each
draft by id — but only for the drafts that are actually due, rather than
projecting a board's worth of data into an index that is read every minute.

### A note on the partition key

A constant partition key is a known DynamoDB hot-partition anti-pattern. At
this application's volume it is irrelevant, and building for it now would be
speculative. The escape hatch, if write volume ever justifies it, is to make
the value a shard number (`"0".."N"`) and have the scheduler query N shards;
the attribute name does not change. Do not build that now.

## Reusing the pick rule

`autoPickAndAdvance` today lives in `drafts.js`, is not exported, and takes a
`json` responder — it returns an HTTP response. The scheduler is a second
consumer that has no HTTP response to return, and that is what makes the
current shape wrong.

Move it to `backend/src/lib/autoPick.js`, returning a plain result rather than
a response. The two existing routes wrap that result in `json()` exactly as
they do now, so their behaviour is unchanged. One implementation of "who gets
picked and how the draft advances", with three callers.

This is a refactor in service of the feature, not a cleanup pass. Nothing else
in `drafts.js` moves.

## The scheduler

A new `ClockFunction`, handler `backend/src/clock.js`, following the
`SyncPlayersFunction` precedent rather than adding a schedule event to
`DraftsFunction` — which would then have to distinguish an EventBridge event
from an API Gateway one on every single request.

```yaml
Timeout: 60
MemorySize: 512
Events:
  Tick:
    Type: ScheduleV2
    Properties:
      ScheduleExpression: cron(* 8-23,0-1 * * ? *)
      ScheduleExpressionTimezone: America/Los_Angeles
```

`ScheduleV2` (EventBridge Scheduler), not the `Schedule` the nightly sync
uses: only Scheduler accepts a timezone, and a UTC rule would drift by an hour
twice a year. Every minute of 08:00–01:59 Pacific.

The window is an accepted assumption about when people draft. A draft
abandoned at 02:05 Pacific sits untouched until 08:00, and an East Coast
drafter starting at 09:00 local is outside the window entirely — both only
matter for a draft with no browser open, since a watching browser still calls
`/expire` on time.

Each run:

1. `Query` `byClock` for due drafts, `Limit` 25.
2. For each draft id: load the item, then drain it — auto-pick, and keep
   going while the new deadline is still in the past and the draft is
   unfinished.
3. Stop starting new drafts once the wall-clock budget is spent (~50s of the
   60s timeout). Anything not reached is still in the index and is picked up
   by the next run a minute later.

Two budgets — the query limit and the wall clock — are what stop a run
running away. Neither needs to be exact, because nothing is lost by deferring
a draft to the next tick.

## Races and overlap

No new concurrency machinery. If a human picks while the scheduler is working
on the same draft, `advanceDraft`'s `ConditionExpression` fails for whichever
write lands second and raises `RaceLost`. The scheduler treats that as "a
person got there first", skips that draft, and continues — it is the system
working, not an error.

The same property makes overlapping runs safe, so a run that outlives its
minute needs no lock: the second run's writes simply lose where they collide.

## Failure handling and observability

Failure is scoped to one draft. Each draft is processed inside its own
try/catch, logged with its id, and the loop continues; one bad draft must not
cost the other twenty-four their tick.

- `RaceLost` — expected, skip, not logged as an error.
- A board that will not load — already falls back to consensus rank upstream,
  so it cannot stall a pick.
- Anything else — logged with the draft id, draft left alone, retried next run.

**Accepted:** a draft that throws on every run will be retried every minute
for as long as the window is open, and will spam the log. A failure counter
would stop that, but it is state nobody reads, and a draft that fails forever
is a bug to be found in the log rather than suppressed by one.

One structured log line per run: `due`, `advanced`, `picks`, and then every
non-pick outcome counted separately rather than folded into one `skipped` —
`raced`, `ineligible`, `evicted`, `emptyPool`, `failed`, `deferred`. The split
is what lets the line answer the question that actually matters at 3am: is a
draft poisoned, or is the clock simply finding nothing to do? `raced` and
`ineligible` are the system working; a `failed` or `emptyPool` that repeats
tick after tick is not.

Picks made before a drain throws are still counted in the run total. A run
that made four picks and then died must not report zero.

## Migration

Every draft currently in the table was written before `clockRunning` existed,
so a sparse index leaves all of them invisible to the scheduler — permanently.
The feature would look like it worked while doing nothing for a single
existing draft.

`backend/src/scripts/backfillClockRunning.js`, following the shape of
`purge-unowned.js`: dry run by default, printing what it would write;
`--confirm` to write. It sets `clockRunning` on every draft that is unfinished
and not paused, and skips the rest.

Deploy order, once:

1. `sam deploy` — creates the GSI. Adding a GSI to a live table is an
   asynchronous update that can take several minutes; the table stays fully
   available throughout, and the scheduler finds nothing to do until the
   backfill in step 3 has run. Every tick during those minutes queries an
   index that is still `CREATING` and fails, which is why the schedule sets
   `RetryPolicy: MaximumRetryAttempts: 0`: Scheduler's default of 185 attempts
   over 24 hours would turn a few expected failures into a retry storm on top
   of a per-minute schedule, and a retry buys nothing when the next tick is a
   minute away.
2. `node scripts/backfillClockRunning.js` — read the counts.
3. `node scripts/backfillClockRunning.js --confirm`.

No frontend change. The page already calls `/expire` and already renders the
server's deadline; the scheduler is invisible to it.

## Testing

- **The extraction is behaviour-preserving.** The existing `/expire` and
  `/auto-pick` route tests must pass **unchanged**, and the backend test count
  must not drop. A test that needed editing to accommodate the move is a
  signal the move changed behaviour.
- **The run loop**, against a mocked `ddb` — and specifically against the
  **real** `autoPickAndAdvance` and `advanceDraft`, with the fake storing what
  an `UpdateCommand` writes and enforcing its `ConditionExpression`. A test
  that mocks the pick rule cannot see what deadline the pick actually wrote,
  which is the one value the drain loop reads: it will report a drained draft
  while the real code makes one pick and exits. A long-overdue draft is
  drained; the deadlines written walk forward one slot at a time from the old
  one; a `RaceLost` on one draft does not stop the others; a draft that throws
  does not abort the run, and the picks it made are still counted; the
  wall-clock budget stops new drafts being started and stops a drain
  mid-draft; a draft that completes during a drain has `clockRunning` removed;
  a completed or paused draft that is still indexed is evicted, and an
  exhausted pool, a lost race and a future deadline are not; the Query itself
  is asserted, operator and `Limit` included.
- **The template**, in `template.test.js`, which this repo already uses for
  exactly this class of bug — things that fail silently in production while
  every unit test passes:
  - the `byClock` index exists, with those keys and `KEYS_ONLY`;
  - `ClockFunction` has a `ScheduleV2` event **carrying its timezone**. A
    missing `ScheduleExpressionTimezone` looks fine for months and then fires
    an hour off;
  - `ClockFunction` has read access to boards and players and write access to
    drafts.
- **Mutation-test every guard**, per the house rule: delete the wall-clock
  guard, the `RaceLost` catch, and the `clockRunning` removal on completion.
  Each must turn its covering test **red**, then be restored. Record the
  evidence in the task report.

## Out of scope

- Any notification that your turn has arrived. Still unbuilt, still the
  largest of the three items Phase 2 deferred.
- Per-seat clock lengths or a commissioner-configurable pick duration.
- Sharding the index partition key.
- Any change to how `POST /expire` behaves for browsers.
