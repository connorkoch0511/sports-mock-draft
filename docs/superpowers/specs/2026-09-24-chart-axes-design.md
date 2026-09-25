# Charts that can be read

The two charts in the player drill-down draw marks against an unlabelled
baseline. Nothing on either says what the vertical dimension measures, what its
scale is, or what the horizontal dimension spans. A line climbing gently left
to right is equally consistent with 40% -> 45% and with 5% -> 90%, and the
chart offers no way to tell which.

Reported from a live page: "the charts don't have x and y axis names."

## What is actually there

`WeeklyChart.jsx`, hand-rolled inline SVG, no charting library:

    viewBox        300 x 100
    MARGIN         10 on all four sides
    PLOT           280 x 80
    chart-axis     one horizontal line at the baseline, nothing else

There is one axis element and it carries no text. The 10px margins exist to
keep the outermost marks from clipping, not to hold labels -- there is no
gutter to draw in. That is the whole reason labels are absent rather than
merely small.

## What the axes must say

**The vertical dimension differs per chart, and the units are not guessable.**

    weekly-points-chart   POINTS_FIELD[format]      -> "Points"
    snap-share-chart      snapShare() from gameLog  -> "Snap %"

`snapShare` in `gameLog.js` returns `Math.round((off / team) * 100)` -- 0-100.
There is a second function of the same name in `playerKpis.js` returning
`off / team`, a 0-1 fraction. The charts use the first. Labelling the axis from
the second would put a wrong scale under a right-looking line.

"Points" rather than "PPR points": the bars follow the league's own scoring, and
hard-coding PPR here is a bug this component already fixed once.

**The vertical domain is not always 0-to-max.** Weekly points go negative -- a
lost fumble is -2 -- and the component already floors the domain at
`Math.min(0, ...values)` so a negative week draws downward from the zero line.
Tick values must be generated from the real `minValue`/`maxValue`, never from a
presumed zero. Snap share pins the top at `domainMax = 100`.

**The horizontal dimension is the week number**, not the mark's index. That is
load-bearing: a three-game player's marks sit where those games actually fell,
with the rest of the season empty.

## The two changes

### 1. Room to label (approved: grow the box)

The viewBox grows to **328 x 122**. The plot area stays exactly 280 x 80, so
every existing mark keeps its position and size; the growth is all gutter:

    margins   top 10   right 10   left 38   bottom 32
    plot      280 x 80   (328 - 38 - 10  by  122 - 10 - 32)

    left    +28 over the old 10   y-axis tick values and the axis name
    bottom  +22 over the old 10   week tick values and "Week"

Both dimensions grow, not just the height. A left gutter eats WIDTH, and only
a wider viewBox gives it back -- keeping the box 300 wide would have shrunk the
plot to 262 and moved every mark, which is the thing this option exists to
avoid. (Worked twice wrong before it was worked right: 300x130 yields 262x98
and 328x132 yields 280x90. The arithmetic is above so the next reader does not
have to redo it.)

The charts get taller on the page. Nothing else in the modal moves, and the
alternative -- carving labels out of the current box -- was rejected because it
shrinks the marks ~25% and is worst at 390px, where they are already smallest.

### 2. A minimum span for the x-axis

`xFor` maps week number across `totalWeeks - 1`. Two weeks into a season that
puts week 1 at t=0 and week 2 at t=1: two marks pinned to opposite edges,
which reads as a rendering fault rather than as a two-week sample. This is
what the reported 2026 charts show.

The span floors at **6 weeks**. Early in a season the marks bunch at the left
with the remaining weeks empty ahead of them, which is the true shape. The
floor only ever raises a small span, so `through = 18` -- every existing test
and every completed season -- is untouched.

This preserves the no-interpolation rule exactly: it changes where marks sit,
never whether a mark exists.

## Structure

The geometry is arithmetic and deserves to be testable without a browser. A new
sibling module holds it:

    weeklyChartScale.js       xFor, spanFor (the 6-week floor), yTicks, xTicks
    weeklyChartScale.test.js  node --test, matching gameLog.test.js

`WeeklyChart.jsx` imports and renders. There is no unit test for this component
today -- only e2e -- and the tick maths is exactly the kind of thing that should
fail in milliseconds rather than in Playwright.

## Ticks

    y   3 values: domain min, midpoint, domain max.
        Snap share reads 0 / 50 / 100 from its fixed domain.
        Integers; no decimal noise on a 100px-tall box.

    x   week 1, the last week of the span, and midpoints where the span
        allows -- at most 4 labels, so 390px never collides.

## What must not break

Existing contracts, all currently asserted:

    chart-mark      one per played week, never one per season week
    data-week       real week number; week 3 of the fixture draws nothing
    zero heights    an all-zero player still draws a bar per played week
    chart-axis      toHaveCount(1) -- a live tripwire
    season named    each chart contains its season

`chart-axis` is asserted as exactly one element. The new y-axis therefore gets
its own testid (`chart-axis-y`) rather than reusing that one.

## Accessibility

The `<svg>` already carries `role="img"` and an `aria-label` of the caption.
The tick text is decoration on top of that label, so it is `aria-hidden` --
a screen reader reading "1 5 10 15 Week" between the caption and the data adds
noise, not meaning.

## Verification

    node --test   spanFor floors at 6 and is identity above it;
                  yTicks spans a negative domain; xTicks caps at 4
    Playwright    labels present in both charts; the existing five chart
                  contracts still hold; 390px shows no collision
    screenshot    player.png is captured at 1280x900 on the Summary tab and
                  deliberately frames the charts -- it changes, and is
                  refreshed as part of this work
