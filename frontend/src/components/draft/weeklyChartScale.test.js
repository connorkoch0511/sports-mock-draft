import test from "node:test";
import assert from "node:assert";
import { GEOM, spanFor, xFor, yTicks, xTicks } from "./weeklyChartScale.js";

// The plot area is the whole promise of the taller box: marks must keep the
// exact position and size they had at viewBox 300x100. Both dimensions grew,
// because a left gutter eats WIDTH and only a wider viewBox gives it back.
test("the gutters grow, the plot area does not", () => {
  assert.equal(GEOM.PLOT_WIDTH, 280);
  assert.equal(GEOM.PLOT_HEIGHT, 80);
  assert.equal(GEOM.WIDTH - GEOM.MARGIN.left - GEOM.MARGIN.right, 280);
  assert.equal(GEOM.HEIGHT - GEOM.MARGIN.top - GEOM.MARGIN.bottom, 80);
});

// yFor(v) = BASELINE - ((v - min) / span) * PLOT_HEIGHT. If either of these
// two moved, every mark would move vertically -- which is exactly what
// "the plot area is unchanged" promises will not happen.
test("the baseline and plot height are unchanged, so no mark moves vertically", () => {
  assert.equal(GEOM.BASELINE, 90);
  assert.equal(GEOM.PLOT_HEIGHT, 80);
});

// Two weeks into a season, week 1 at t=0 and week 2 at t=1 put two marks on
// opposite edges, which reads as a broken render rather than a small sample.
test("a short season is floored to six weeks", () => {
  assert.equal(spanFor(2), 6);
  assert.equal(spanFor(1), 6);
  assert.equal(spanFor(6), 6);
});

// The floor only ever raises. A completed season must be untouched, which is
// what keeps every existing chart test and every finished year bit-for-bit.
test("a full season is left exactly alone", () => {
  assert.equal(spanFor(18), 18);
  assert.equal(spanFor(17), 17);
});

test("week 1 sits at the left edge of the plot, not at the viewBox edge", () => {
  assert.equal(xFor(1, 18), GEOM.MARGIN.left);
});

test("the last week of the span sits at the right edge of the plot", () => {
  assert.equal(xFor(18, 18), GEOM.MARGIN.left + GEOM.PLOT_WIDTH);
});

// The point of the floor: two played weeks bunch at the left with the rest of
// the season visibly empty ahead of them.
test("two played weeks bunch at the left instead of spanning the box", () => {
  const x2 = xFor(2, 2);
  assert.ok(
    x2 < GEOM.MARGIN.left + GEOM.PLOT_WIDTH / 2,
    `week 2 of 2 should sit in the left half, got ${x2}`
  );
});

// Weekly points go negative -- a lost fumble is -2 -- so the domain is not
// 0-to-max and the ticks must say so rather than assuming a zero floor.
test("a negative domain is labelled from its real floor", () => {
  const ticks = yTicks(-4, 20);
  assert.equal(ticks[0], -4);
  assert.equal(ticks[ticks.length - 1], 20);
  assert.equal(ticks.length, 3);
});

test("snap share reads 0 / 50 / 100 from its fixed domain", () => {
  assert.deepStrictEqual(yTicks(0, 100), [0, 50, 100]);
});

test("tick values are integers -- no decimal noise on an 80px box", () => {
  for (const t of yTicks(0, 25)) assert.equal(Number.isInteger(t), true);
});

// At 390px wide the chart is ~340px. More than four x labels collide.
test("at most four week labels, always including the first and last", () => {
  for (const weeks of [6, 9, 14, 18]) {
    const ticks = xTicks(weeks);
    assert.ok(ticks.length <= 4, `${weeks} weeks produced ${ticks.length} labels`);
    assert.equal(ticks[0], 1);
    assert.equal(ticks[ticks.length - 1], spanFor(weeks));
  }
});
