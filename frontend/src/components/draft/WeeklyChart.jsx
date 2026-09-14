// Hand-rolled inline SVG. The app has no charting library and these two
// charts do not need one -- a bar per week and a point per week, nothing a
// library buys anything for.
//
// The rule these obey is stricter than it looks: a mark on a chart reads as
// more authoritative than a sentence, so a chart is the easiest place in this
// app to accidentally claim something projected. `rows` must already be
// filtered to weeks that happened (PlayerDetail passes the season's game log,
// which only ever contains played weeks); a week with no row here gets no
// mark, not a zero, and `valueOf` returning null|undefined for a row it CAN
// read (an unknown snap share, say) drops that one mark the same way -- never
// a fabricated zero standing in for "we don't know".

const WIDTH = 300;
const HEIGHT = 100;
const MARGIN = { top: 10, right: 10, bottom: 10, left: 10 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const BASELINE = HEIGHT - MARGIN.bottom;

// Position along the x-axis follows the real week number, not the mark's
// index in the array. A three-game player in an 18-week season should show
// three marks bunched wherever they actually fell, with the rest of the
// season sitting empty -- not three marks stretched evenly across the full
// width, which would erase the very gaps this component exists to preserve.
function xFor(wk, totalWeeks) {
  const span = Math.max(totalWeeks - 1, 1);
  const t = totalWeeks > 1 ? (wk - 1) / span : 0.5;
  return MARGIN.left + t * PLOT_WIDTH;
}

/**
 * `rows`: the season's played weeks (already gap-free -- one entry per week
 *   that has a row, in whatever order the caller has them; each row needs a
 *   numeric `wk`).
 * `valueOf(row)`: reads the value to plot from a row. Returning anything
 *   other than a finite number (null, undefined, NaN) drops that week's mark
 *   entirely rather than drawing it at zero.
 * `kind`: "bars" for weekly points (boom-versus-bust), "line" for snap share
 *   (a usage trend, drawn only between weeks that are actually consecutive).
 * `weeks`: how many weeks the season has run, so a mark's x position reflects
 *   when it happened.
 * `label`: short caption, expected to name the season.
 * `testId`: data-testid on the chart's own container.
 */
export function WeeklyChart({ rows, valueOf, kind, weeks = 18, label, testId, domainMax }) {
  const points = (rows || [])
    .map((row) => ({ wk: row.wk, value: valueOf(row) }))
    .filter((p) => typeof p.value === "number" && Number.isFinite(p.value));

  // `domainMax` fixes the top of the scale for a bounded measure. Snap share
  // is a percentage: auto-scaling it to each player's own peak drew a 16%
  // ceiling and a 96% ceiling as the identical line touching the top of the
  // box, so a fourth-stringer and a bell-cow looked the same. Points have no
  // natural ceiling and keep auto-scaling.
  const values = points.map((p) => p.value);
  const maxValue = domainMax ?? Math.max(1, ...values);
  // Weekly points go negative -- a lost fumble is -2 -- and a bar computed as
  // max(baseline - y, 0) rendered nothing at all for those weeks, which reads
  // as "did not play". The floor is the data's own minimum so a negative week
  // is drawn, downward, from the zero line.
  const minValue = Math.min(0, ...values);
  const span = maxValue - minValue || 1;
  const yFor = (value) => BASELINE - ((value - minValue) / span) * PLOT_HEIGHT;
  const zeroY = yFor(0);

  const color = kind === "bars" ? "#22d3ee" : "#a78bfa";
  const barWidth = 6;

  // A player who appeared fifteen times and scored nothing draws fifteen bars
  // of zero height -- which is mathematically right and reads as an empty box,
  // indistinguishable from having no data at all. Those are different claims,
  // and this is the app that spent a day making a panel say LESS rather than
  // conflate them. So say it in words. The marks are still rendered beneath,
  // because the count of them is the season he actually played.
  const allZero = points.length > 0 && points.every((pt) => pt.value === 0);
  // Rows exist but none of them carries this measure -- snap counts are not
  // recorded for every player. An axis with no marks and no words is the same
  // empty box the all-zero note exists to prevent, for the opposite reason.
  const noneRecorded = points.length === 0 && (rows || []).length > 0;

  return (
    <div data-testid={testId} className="relative">
      {label ? <div className="mb-1 text-[11px] text-zinc-500">{label}</div> : null}
      {/*
        preserveAspectRatio scales the fixed 300x100 drawing down to whatever
        width the modal gives it -- as narrow as ~340px at 390px wide -- with
        no horizontal overflow, and the viewBox's own margins leave room for
        the outermost marks instead of clipping a bar sitting at week 1 or 18.
      */}
      {(allZero || noneRecorded) && (
        <div
          data-testid="chart-all-zero"
          className="pointer-events-none absolute inset-x-0 bottom-0 top-5 flex items-center justify-center text-xs text-zinc-500"
        >
          {noneRecorded
            ? `${kind === "bars" ? "Points" : "Snap counts"} not recorded`
            : `No ${kind === "bars" ? "points" : "snaps"} in ${points.length} games`}
        </div>
      )}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        role="img"
        aria-label={label}
      >
        {/*
          Drawn unconditionally, including for an all-zero player: the axis
          is what tells the difference between "he played and scored
          nothing" (a zero-height bar sitting ON an axis) and "he did not
          play" (no bar, no data point -- see the gap handling above).
        */}
        <line
          data-testid="chart-axis"
          x1={MARGIN.left}
          y1={BASELINE}
          x2={WIDTH - MARGIN.right}
          y2={BASELINE}
          stroke="#3f3f46"
          strokeWidth="1"
          fill="none"
        />

        {kind === "bars" ? (
          points.map((p) => {
            const x = xFor(p.wk, weeks) - barWidth / 2;
            const v = yFor(p.value);
            // From the zero line, up or down, so a negative week is visible
            // as a negative week rather than as nothing.
            const y = Math.min(v, zeroY);
            const height = Math.abs(v - zeroY);
            return (
              <rect
                key={p.wk}
                data-testid="chart-mark"
                data-week={p.wk}
                x={x}
                y={y}
                width={barWidth}
                height={height}
                fill={color}
              />
            );
          })
        ) : (
          <>
            {/*
              A segment is drawn only between weeks that are literally back
              to back. Two played weeks either side of a bye are NOT
              connected -- a straight line between them would draw a value
              for the missed week that never existed, which is exactly the
              interpolation this component must never do.
            */}
            {points.slice(1).map((p, i) => {
              const prev = points[i];
              if (p.wk !== prev.wk + 1) return null;
              return (
                <line
                  key={`seg-${p.wk}`}
                  x1={xFor(prev.wk, weeks)}
                  y1={yFor(prev.value)}
                  x2={xFor(p.wk, weeks)}
                  y2={yFor(p.value)}
                  stroke={color}
                  strokeWidth="1.5"
                  fill="none"
                />
              );
            })}
            {points.map((p) => (
              <circle
                key={p.wk}
                data-testid="chart-mark"
                data-week={p.wk}
                cx={xFor(p.wk, weeks)}
                cy={yFor(p.value)}
                r="2.5"
                fill={color}
              />
            ))}
          </>
        )}
      </svg>
    </div>
  );
}
