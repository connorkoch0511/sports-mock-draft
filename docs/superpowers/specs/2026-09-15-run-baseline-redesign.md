# A run is a departure from the board, not a fast position

Supersedes the baseline described in
`2026-09-15-positional-run-detection-design.md`. Everything else in that spec —
why this is a scoring factor and not a banner, why your own picks are excluded,
why the sentence must be true of the Draft Board — still holds.

## What was measured, and why the first design is dead

The factor shipped behind a full audit: 2,160 picks in strict-consensus drafts
and 6,480 more where seats reach, against the live pool of 889 players.

With the original constants it fired on **29.4%** of all picks — more than 90%
of every pick in rounds 2 through 4. Tuning `RUN_MIN_COUNT` from 3 to 5 brought
the headline to **12.5%**, inside the target band. The distribution did not
move:

| round | fires |
|---|---|
| 1 | 17.4% |
| 2 | **61.1%** |
| 3 | 41.0% |
| 4 | **68.8%** |
| 5–15 | **0.0%** |

Only RB and WR ever fired. TE and QB never did. Every observed run was 5-of-8
or larger, so the weight was always 3.5 and `RUN_WEIGHT`'s 3 and 4 entries were
unreachable — the factor had no gradient.

The approved spec's worked example was *"Round 2, everyone taking RBs →
silent. Round 9, sudden TE rush → fires."* The measurement is the exact
inverse. Twenty sampled sentences were hand-verified true both before and after
tuning, so this is not a correctness bug. **The model is wrong.**

### The root cause

    expected(p) = startable left at p / all startable left

This compares picks against **what remains**. But picks are driven by **what is
best** — and the top of a fantasy board is heavily RB/WR. In a 12-team league
the startable sets hold roughly 28 RB, 28 WR, 16 TE, 12 QB, 12 K, 12 DEF, so
RB's expected share is about 26%. The first four rounds run 60%+ RB/WR because
that is what the top of the board *is*. Sixty against twenty-six reads as a
departure on nearly every early pick. Later, once the top RBs and WRs are gone,
picks spread across positions, observed falls toward expected, and the factor
goes silent for the rest of the draft.

No threshold fixes this. Every constant is a threshold on a baseline that is
wrong in rounds 1–4, and raising thresholds silences the late rounds first —
the opposite of what is needed. That is what the `RUN_MIN_COUNT` = 5 tuning
did: it fixed the headline number by muting rounds 5–15, not by firing only on
departures.

## The replacement

**Expected becomes the position mix of the best players on the board, as of
when the window's picks were made.**

A run then means *other drafters are departing from the board* — which is the
only version that carries information the user does not already have. If the
eight best available were five running backs and five running backs went, the
board predicted it and there is nothing to report. `scarcityFactor` already
covers pure depletion.

### The board must be reconstructed

The comparison cannot use the *current* top of the board. Those picks already
removed players from it: take five RBs and the remaining top-8 holds fewer RBs,
so expected drops while observed rises, and the factor fires on its own
aftermath. Self-fulfilling, in the wrong direction.

So `detectRuns` rebuilds the board as of the window's start:

    windowStart = index in `made` of the window's earliest pick
    takenSince  = players on picks at or after windowStart, ANY seat
    boardThen   = (available ∪ takenSince) sorted by `compareRank`

    K           = | takenSince |
    expected(p) = | { top K of boardThen with position p } | / K
    observed(p) = | { picks at p in the window } | / | window |

`compareRank` is the comparator `context.js` already uses to order the pool;
it must be the same one, so the baseline sees the board in the order the rest
of the engine does. It sorts unranked players last, which is what makes the
late-round degradation described below gradual rather than abrupt.

`observed` is unchanged from the current implementation: every pick at that
position by **other teams**, over the window, counted without regard to
startability, because it feeds a sentence the user verifies by counting the
Draft Board.

**On the asymmetry in K.** `K` counts players taken by *any* seat, including the
user's own, while `observed` counts only other teams' picks. This is
deliberate: both sides are shares, and the board lost those players regardless
of who took them. It is flagged here because it looks like a bug to a fresh
reader, and a future change that "fixes" it by excluding the user's picks from
`K` would quietly shrink the denominator of the baseline only.

### What this removes

The baseline no longer touches `startable`, so:

- `detectRuns` no longer needs the `startable` argument for its expected rate.
- The `left === 0` skip goes away, and with it the behaviour Task 2's review
  flagged: the run signal vanishing exactly as a position's startable tier
  empties, which is when a user would most expect urgency.

`runFactor` keeps the `startable` gate on the **candidate**. That gate is about
urgency — a run is an argument for taking someone before they are gone, and
that cannot apply to a player nobody would start. It is unaffected by this
change.

## What carries over unchanged

- `runFactor`, its gates, its ordering in `FACTORS`, and the weight lookup.
- The reason text and every argument behind it: numerals, the position code
  with an `s`, and the words "by other teams".
- The engine's invariant: no zero-weight reasons, `score = base + sum(weights)`.
- The mutation discipline from Task 3, including the lesson that a fixture
  blocked on two independent grounds pins neither constant.
- `frontend/scripts/audit-runs.js`, which is the most valuable artifact the
  first attempt produced. It is what found this.

## The prediction that makes this falsifiable

In the audit's **scenario A** every seat autopicks by consensus rank, so the
sequence of picks *is* board order. Under the new baseline observed should
equal expected, and the factor should fire **at or near 0%**.

In **scenario B**, where seats reach within the top 6, those reaches are
departures and should surface as runs.

If scenario A does not collapse to near-zero, the model is wrong and it is
visible in a single run. The first design had no such prediction, which is why
a full audit was required to discover it was inverted. **This prediction is a
required acceptance check, not an observation to make afterwards.**

## The constants are hypotheses again

`RUN_WINDOW`, `RUN_MIN_COUNT`, `RUN_MULTIPLE`, `RUN_WEIGHT` and
`RUN_WEIGHT_MAX_COUNT` all return to unsettled. `RUN_MIN_COUNT` = 5 exists only
to suppress a firing rate the new baseline should not produce, and carrying it
over would hide whether the redesign worked.

Starting points: `RUN_WINDOW` 8, `RUN_MIN_COUNT` 3, `RUN_MULTIPLE` 1.75,
`RUN_WEIGHT` `{3: 1.5, 4: 2.5, 5: 3.5}`, `RUN_WEIGHT_MAX_COUNT` 5 — the
original hypotheses, re-derived by the audit. `RUN_WEIGHT`'s 3 and 4 entries
are expected to come back to life, because smaller genuine departures become
detectable once ordinary early-round behaviour stops registering as one.

## The risk to watch, and how to see it

Of 889 players in the live pool, **118 are ranked**. While ranked players are on
the board, `boardThen`'s top K is meaningful. Once they are exhausted it is
sorting an unranked tail, and the baseline degrades — in precisely the late
rounds where the spec wants a TE rush to fire.

The audit must therefore report, per round, both the firing rate **and** how
many ranked players remain. The degradation has to be visible in the numbers
rather than inferred, and if late rounds still cannot fire, that is a finding
to report rather than a constant to tune.

## Acceptance

1. Scenario A fires at or near 0%.
2. Scenario B fires, and its firing rate is not concentrated in rounds 1–4 the
   way the old model's was.
3. Sampled sentences are hand-verified true, re-derived from raw pick rows.
4. The audit reports ranked-players-remaining by round.
5. `RUN_WEIGHT`'s 3 and 4 entries are reachable, or the audit explains why not.

## Out of scope

- **Deriving our own ADP from draft history.** Considered and rejected for now:
  eleven of twelve seats are bots calling `pickBestForTeam` with
  `consensusRank`, so aggregating our drafts re-derives the ranking we fed in,
  and `perfectpick-drafts` holds two drafts. The public feeds (FFC, ESPN,
  Yahoo) already *are* aggregated draft history, from thousands of real drafts.
  Worth revisiting once real humans draft in real leagues, where our own picks
  would carry a league's own tendencies that a national average cannot.
- **Blending the three ADP sources into the baseline.** Consensus rank alone
  first; a blend is only worth building if the audit shows the single-source
  baseline failing.
- **No banner, indicator, or always-on surface.** Unchanged from the original
  spec.
