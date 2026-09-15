# A run on a position is an argument for taking one

> **The baseline in this spec was measured and replaced.** See
> `2026-09-15-run-baseline-redesign.md`. Audited against 8,640 simulated picks
> on the live pool, the expected-rate model here fired on 61% of round 2 and 0%
> of rounds 5-15 — the inverse of the worked example below. Everything else in
> this document still holds: why this is a factor and not a banner, why your own
> picks are excluded, and why the sentence must be true of the Draft Board.


The advice engine reasons about scarcity — how many startable players at a
position are expected to survive to your next pick — but it has no notion of
*momentum*. It cannot tell that most of the recent picks were running backs. The
pick history it would read is already sitting in the draft it is handed.

This adds one scoring factor.

## Why this is a factor and not a banner

`pickAdvice.js` states the rule it is built around in its own header:

> THE REASONS ARE THE SCORING FACTORS. There is no separate "explanation" pass:
> a factor either returns a reason carrying the exact weight it contributed, or
> it returns nothing at all.
>
>     score = base + every returned reason's weight

Zero-weight reasons are rejected deliberately — "a reason that did not move the
ranking is decoration, and decoration erodes trust in the reasons that are
real" — and an invariant test enforces it. Factors are handed a **frozen** entry
so they cannot move a score by any other route.

So an informational "RB run" note cannot live inside this engine. It would have
to be a separate module with its own surface, and then the page has two voices:
a banner announcing that running backs are flying off the board, beside an
advice card recommending a wide receiver and never mentioning it. **The page
would be arguing with its own engine.**

A run is real information about what other drafters are doing, and the honest
consequence of real information is that it changes the recommendation. So it
changes the recommendation, and the reason explains why.

The cost is accepted with eyes open: **if a run is on at RB but a WR is still
the right pick, the user is not told about the run.** That is the same contract
every other factor already has — a reason appears when it bears on the answer.

## Decisions

### Your own picks do not count

A run is evidence about what *other* drafters are doing. Your own picks are not
news to you.

Counting them creates a feedback loop with yourself: taking running backs in
back-to-back rounds is normal at a turn, and the engine would then cite your own
two picks as evidence that running backs are flying, and recommend a third. The
window is built from picks at seats other than `mySlot`.

### It fires on departure from the expected rate, not on a flat count

A flat "four of the last six" fires on nearly every pick in rounds 1–3, because
running-back-heavy drafting is simply what early rounds look like. A factor that
fires constantly for a non-signal moves scores for no reason — decoration by
volume rather than by weight, which is the same failure the zero-weight rule
exists to prevent.

So a run fires when a position's observed share of the recent window exceeds the
share you would expect from what is still on the board.

### The firing condition is clever; the sentence is not

The reason text is the plain countable fact:

> Four of the last eight picks by other teams were running backs.

The expectation test never appears in the text. Stating the ratio instead
("running backs are going at twice the expected rate") would be both harder to
check and harder to phrase honestly.

**The sentence must be literally true of the Draft Board.** That constraint
decides two things that would otherwise be free choices:

- It says *"by other teams"* explicitly, because your own picks are excluded
  from the window. Without those three words the count would not match the rows
  a user counts, and a reason a user can disprove by counting is worse than no
  reason.
- The numerator counts **every** pick at that position in the window, not only
  picks of startable players. Counting a subset would make the sentence false
  in exactly the cases a careful user checks it.

This is the one place the design pays for verifiability rather than purity, and
it is worth it: every other factor's text is checkable, and this one has to be
too.

### The expected rate uses startable players — the scarcity lesson

`scarcityFactor` carries this scar in a comment:

> Survivors are counted inside the startable window, never over the whole pool:
> 891 running backs are available and a raw count of them can never be scarce,
> which is exactly why this factor fired zero times on live data.

The lesson applies to the **baseline**, not the count. Asking "what share of the
remaining board is running backs" over the whole pool gives an answer dominated
by 891 undraftable backs, and nothing would ever look like a departure from it.
The expected share is therefore computed over `startable` — the population this
league could actually field — while the observed count stays over real picks, so
the sentence stays checkable.

### It is gated exactly like scarcity

A run is an argument for *urgency* — take one before they are gone. That
argument only applies to a player who might actually be gone. So the factor
reuses scarcity's two gates: the candidate must be startable at his position,
and must sit inside the `gap` window (`entry.index < ctx.gap`). A player nobody
will reach before your next pick gains nothing from a run.

## Where it lives

Three files, all existing, following the established shape.

**`frontend/src/lib/pickAdvice/context.js`** — `buildContext` gains a `runs`
field. It already derives `made` (picks carrying a player, in order), `mySlot`,
`pool` and `startable`; `runs` is computed from those and nothing else.

`runs` is a `Map` from position to `{ count, window }` where `count` is that
position's picks in the window and `window` is how many picks the window
actually contained — which is smaller than `RUN_WINDOW` early in a draft, and is
carried explicitly so the reason text never claims a longer history than exists.
An entry is present **only for positions that cleared the test**. A position
that did not run is absent rather than present-with-a-false-flag, so the factor
cannot accidentally read a non-run as a run.

**`frontend/src/lib/pickAdvice/weights.js`** — the constants:

- `RUN_WINDOW` — how many picks by other teams to look back over. Starting
  value **8**. Six is about half a round in a twelve-team league once your own
  picks are removed, which is too short to see a run develop.
- `RUN_MIN_COUNT` — minimum absolute count, starting value **3**. Without it,
  one of two picks is a 50% share and would read as a run.
- `RUN_MULTIPLE` — how far observed must exceed expected, starting value
  **1.75**.
- `RUN_WEIGHT` — a table keyed on count, in the shape `SCARCITY` already uses.
  Starting values `{ 3: 1.5, 4: 2.5, 5: 3.5 }`, with counts above 5 taking the
  5 value, so the weight is capped by construction.

**`frontend/src/lib/pickAdvice/factors.js`** — `runFactor(entry, ctx)`,
registered in the `FACTORS` array. It returns `null` unless the candidate's
position is present in `ctx.runs` and both scarcity gates pass; otherwise it
returns `{ kind: "run", weight, text }`.

## The expected share

Expected share for a position is that position's remaining startable players
over all remaining startable players:

    expected(p) = |{ e in pool : e.id in startable(p) }|
                  / sum over all q of |{ e in pool : e.id in startable(q) }|

Observed share is `count / window` over every pick in the window. The position
runs when `observed >= expected * RUN_MULTIPLE` and `count >= RUN_MIN_COUNT`.

Using what remains rather than a fixed league-wide prior is deliberate: it means
the factor adapts as the board empties. Late in a draft where only tight ends
are left, tight ends going quickly is not a run.

## Testing

Unit tests alongside the existing ones in `pickAdvice.test.js` and the
`pickAdvice/` tests, covering:

- A genuine run fires and carries the right count in its text.
- A normal early-round RB-heavy sequence does **not** fire, because it does not
  beat the expected rate. This is the test that would have caught a flat
  threshold.
- The user's own picks are excluded — the same sequence fires or not depending
  only on whose seat made the picks.
- The reason's sentence is true of the draft it describes: the count and the
  window in the text match the picks actually made by other teams. This is the
  test that pins verifiability, and it is the one that fails if someone later
  "improves" the numerator to count only startable picks.
- A candidate outside the `gap` window gets no run weight.
- `RUN_MIN_COUNT` is load-bearing: two picks at a position never fire.

The engine's existing invariant test must continue to pass — no zero-weight
reasons, and `score === base + sum(weights)`.

**Each of the four constants is mutation-checked**: changed in turn, and a test
must go red for each. A constant no test pins is a constant that can be edited
to anything.

### Validation against live data is a requirement, not a nicety

`scarcityFactor` shipped and **fired zero times on live data**. `tierCliffFactor`
shipped and was **false in 3 of its 68 reasons**. Both read correctly and passed
their tests.

So before the constants are final, the factor is run against real draft data and
two numbers are recorded: how often it fires, and a hand-check of a sample of
the reasons it produced for whether the claim is true. A factor that fires on
almost every pick is as wrong as one that never fires, and the starting values
above are a hypothesis, not a result.

## Out of scope

- **No banner, indicator, or always-on surface.** Considered and rejected above.
- **No cross-position runs** ("the board is going fast"). Not actionable — it
  does not tell you what to take.
- **No run detection on the phone's own surface.** There is no new surface; the
  advice card already renders on every layout.
- **No persistence.** `runs` is derived per render from the draft, like every
  other part of the context.
