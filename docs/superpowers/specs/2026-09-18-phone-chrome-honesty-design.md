# The phone chrome, at the reader's font

Two items, one root cause: **sizes that were chosen at one font and do not hold
at another.** The touch targets were the item on the status page's accepted
list. Measuring them turned up a worse defect that was on no list at all, and
the two share a fix.

Measured on a real render at 390x844, at three root font sizes.

## What the measurement says

At the default 16px root, against the 44px guideline the sheet's own rows were
built to hit:

    strip-status   114x 20   under by 24   <- the tap target back to the board
    ... button      38x 34   under by 10
    Pause           60x 34   under by 10
    tab buttons     78x 36   under by  8
    STRIP container 334x 52
    TAB BAR         334x 46

**The accepted-list entry understated this too.** It records Pause and `⋯` at
"around 32px" and the tab buttons at "around 36px", and never mentions
`strip-status` at all — which is the *worst* of them at 20px, and the control
the README advertises as "the shortest way back to the board".

**There is no slack to grow into.** The scroller measures `scrollHeight 776 ===
clientHeight 776`, and the document does not scroll. Adding 10px to the strip
and 8px to the tab bar takes 18px straight out of the panel.

**But the containers are already bigger than their controls** — the strip
spends 16px of `py-2` around 34px buttons inside a 52px box, and the tab bar
10px around 36px buttons. The height is there; it is spent on padding rather
than on anything a thumb can hit.

## The deficit exists only at the default font

    root  strip-status   ... button   tab buttons   strip height
    16px      20px          34px          36px          52px
    20px      50px          42px          45px          72px
    24px     150px          50px          54px         176px

Everything here already scales — the labels and padding are in `rem`-based
utilities. At a 20px root every control except `⋯` already passes.

**So the fix cannot be a fixed pixel height.** A hard-coded 44px would be
correct at one root and wrong at every other, which is precisely the drift that
clipped the queue strip's chips (a `max-h-[132px]` cap around contents in
`rem`) and that put the phone breakpoint in pixels against a `rem` class
system. `min-h-11` resolves to `2.75rem`: 44px at 16, 55px at 20, 66px at 24.

## The defect that was on no list

**At a 24px root the strip is 176px tall — a fifth of the screen — and its
status label is 46px wide and 150px tall.** `⏱ 60s · your pick` has broken onto
three lines with the `·` stranded alone on the middle one, and the panel
beneath it is visibly mangled: the search box collapses to an empty blob and
the scoring select overflows the panel's right edge. The page begins scrolling
from a 20px root.

`statusLabel` is a single composed string, and the strip is a
`flex items-center gap-2` row in which `Team N`, Pause and `⋯` all hold their
width while the label has no shrink discipline. The label is therefore the only
thing that can give, so it gives completely.

**Neither existing strip test can see this.** One asserts `strip-status`
*contains* "your pick"; the other asserts a Pause button is *visible*. Both are
true of a 176px strip with its clock in ribbons.

## The fix

**The label never breaks mid-phrase.** `whitespace-nowrap` on `strip-status`.
It is the one thing the strip exists to show under a running clock, and the
rule is the one the advice card already settled: the line that says what
matters survives the squeeze, and everything else is elaboration.

**`Team N` is what gives way.** It is the only element in the strip already
duplicated immediately below it — the Big Board panel header reads "You are on
the clock (Team 1)" in the same viewport — so hiding it when space is tight
costs nothing and keeps the strip one short row. Clock, Pause and `⋯` stay.

**The targets grow into the padding, not into the page.** `min-h-11` on
`strip-status`, Pause, `⋯` and the four tab buttons, with the containers'
vertical padding reduced to absorb it. The strip holds 18px of unused padding
and the tab bar 10px, against a 10px and 8px deficit. **Whether this nets to
zero is a measurement, not an assumption** — it is re-measured after, and if
the chrome grows at all the number is recorded rather than waved past.

## Decisions

**Scaling units, not pixels.** See above. This is the third time this codebase
has faced the px-vs-rem question and the first two both shipped bugs.

**Hide `Team N` rather than wrapping the row.** Wrapping keeps every element but
roughly doubles the strip's height exactly when space is tightest, on a page
with 0px of slack. Truncating the label was rejected outright: it makes the
clock the thing that gets cut.

**`min-h`, not `h`.** A minimum lets a control grow with its own content; a
fixed height is another number that is right at one font size.

## Testing

**At three roots, with 16px as the control.** The queue strip's test is the
model: it stays green at 16 against the old cap and turns red at 20 and 24,
which is what proves it measures the font rather than the layout. Here the
polarity is reversed — the target deficit is *at* 16 — so the suite needs both:
targets asserted at every root, and the strip's height and label integrity
asserted at 20 and 24.

**The strip's label must be one line.** Assert `strip-status` renders at a
single line's height at a 24px root — red today at 150px. "Contains the text"
is what the existing tests do and it cannot fail here.

**The strip must stay proportionate.** Assert its height against the viewport
at a 24px root — red today at 176px of 844.

**Mutation checks.** Remove `whitespace-nowrap` and the single-line test must go
red. Remove `min-h-11` and the target test must go red at the 16px root.
Neither is believed until it has been seen to fail.

**Verify the utility actually emits.** `min-h-11` is absent from today's built
CSS because nothing uses it. After the change, grep the built CSS for the
emitted rule — this repo has shipped a height cap whose utility never compiled,
and the class name looking right in the JSX is not evidence.

**Render it.** Every number above came from a browser, and the 24px breakage is
invisible in the diff, in the tests, and in the class names.

## Out of scope

The control sheet's missing focus trap — the other half of the "phone chrome
honesty" pair — is **not** in this change. It is a behavioural fix with a
dynamic focusable set (five conditionally-rendered controls, none of them
present on a finished draft) and it deserves its own spec rather than riding
along with a sizing change. It stays on the accepted list until then.
