// The chart's arithmetic, kept out of the component so it can be tested
// without a browser. WeeklyChart.jsx renders; everything that can be gotten
// wrong by a number lives here.

// Both dimensions grew when the axes arrived. A left gutter eats WIDTH, so
// keeping the box 300 wide would have shrunk the plot to 262 and moved every
// mark -- the one thing the taller box exists to avoid. Derived from the plot
// outwards rather than written down as a pair of totals, because the totals
// are what got miscalculated twice while this was being designed (300x130
// yields a 262x98 plot; 328x132 yields 280x90).
const MARGIN = { top: 10, right: 10, bottom: 32, left: 38 };
const PLOT_WIDTH = 280;
const PLOT_HEIGHT = 80;

export const GEOM = {
  WIDTH: PLOT_WIDTH + MARGIN.left + MARGIN.right, // 328
  HEIGHT: PLOT_HEIGHT + MARGIN.top + MARGIN.bottom, // 122
  MARGIN,
  PLOT_WIDTH,
  PLOT_HEIGHT,
  // 90, the same value the old 300x100 box had at HEIGHT - MARGIN.bottom.
  // yFor() divides by PLOT_HEIGHT and subtracts from BASELINE, and both are
  // unchanged, so no mark moves vertically.
  BASELINE: MARGIN.top + PLOT_HEIGHT,
};

// The smallest season the x-axis will draw. Two weeks in, the real span put
// week 1 and week 2 on opposite edges of the box: a two-game sample rendered
// as a full-width chart, which reads as a fault rather than as a small
// sample. Floored, those two marks bunch at the left with the rest of the
// season visibly empty ahead of them -- which is the true shape.
//
// It only ever raises, so a completed season, every existing chart test, and
// the 18-week fixture are untouched.
const MIN_SPAN_WEEKS = 6;

export function spanFor(totalWeeks) {
  const n = Number.isFinite(totalWeeks) ? totalWeeks : MIN_SPAN_WEEKS;
  return Math.max(n, MIN_SPAN_WEEKS);
}

// Position follows the real week number, not the mark's index in the array:
// a three-game player's marks sit where those games actually fell, with the
// rest of the season empty. Erasing that was never on the table.
export function xFor(wk, totalWeeks) {
  const weeks = spanFor(totalWeeks);
  const span = Math.max(weeks - 1, 1);
  const t = weeks > 1 ? (wk - 1) / span : 0.5;
  return MARGIN.left + t * PLOT_WIDTH;
}

// Three values: the domain's real floor, its midpoint, its top.
//
// The floor is NOT assumed to be zero. Weekly points go negative -- a lost
// fumble is -2 -- and the component already floors the domain at
// Math.min(0, ...values) so those weeks draw downward from the zero line. A
// tick set that started at 0 would label a scale the marks do not sit on.
//
// Integers, because a decimal on an 80px-tall box is noise.
export function yTicks(minValue, maxValue) {
  const lo = Math.round(minValue);
  const hi = Math.round(maxValue);
  if (lo === hi) return [lo];
  return [lo, Math.round((lo + hi) / 2), hi];
}

// At most four labels: at 390px wide the chart is ~340px and a fifth collides.
// Always the first and last week of the span, with evenly spaced weeks
// between them. De-duplicated, because a short span can round two of the
// interior positions onto the same week.
export function xTicks(totalWeeks) {
  const weeks = spanFor(totalWeeks);
  if (weeks <= 4) return Array.from({ length: weeks }, (_, i) => i + 1);
  const step = (weeks - 1) / 3;
  return [...new Set([1, Math.round(1 + step), Math.round(1 + step * 2), weeks])];
}
