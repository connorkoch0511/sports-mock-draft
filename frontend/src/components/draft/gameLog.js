/**
 * Which columns a game log shows, by position.
 *
 * A quarterback's log and a receiver's log have almost nothing in common, and
 * a union of both columns would be mostly blank for everyone. Sleeper picks
 * per position and so do we.
 */
const PASSING = [
  { key: "pass_att", label: "ATT" },
  { key: "pass_yd", label: "YDS" },
  { key: "pass_td", label: "TD" },
  { key: "pass_int", label: "INT" },
];

const RUSHING = [
  { key: "rush_att", label: "CAR" },
  { key: "rush_yd", label: "YDS" },
  { key: "rush_td", label: "TD" },
];

const RECEIVING = [
  { key: "rec_tgt", label: "TGT" },
  { key: "rec", label: "REC" },
  { key: "rec_yd", label: "YDS" },
  { key: "rec_td", label: "TD" },
];

export function columnsFor(position) {
  switch (position) {
    case "QB":
      return [...PASSING, ...RUSHING];
    case "RB":
      return [...RUSHING, ...RECEIVING];
    case "WR":
    case "TE":
      return [...RECEIVING, ...RUSHING];
    default:
      // K and DEF have no rushing or receiving line worth a column. They still
      // get points and snaps, which the table adds either side of this.
      return [];
  }
}

/**
 * A stat as the row should read it.
 *
 * The row exists only for a week the player was active, so a field Sleeper did
 * not send means he recorded none of it -- that is a real zero, not unknown.
 * The "did not play" case never reaches here: those weeks are absent from the
 * log entirely and the table renders them as gaps.
 */
export function statValue(row, key) {
  const v = row?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Share of the team's offensive snaps, or null when either half is missing.
 *
 * Returning null rather than 0 matters: "played no snaps" and "we do not know
 * how many snaps" look identical as a zero, and only one of them is a fact.
 */
export function snapShare(row) {
  const off = row?.off_snp;
  const team = row?.tm_off_snp;
  if (typeof off !== "number" || typeof team !== "number" || team <= 0) return null;
  return Math.round((off / team) * 100);
}

/**
 * Every week of the season in order, with the weeks he missed marked.
 *
 * The gaps are the point: a log that silently skips from week 3 to week 11
 * hides an eight-week injury, which is exactly what somebody drafting him
 * needs to see.
 */
export function withByeGaps(gameLog, weeks) {
  const byWeek = new Map();
  for (const row of gameLog || []) byWeek.set(row.wk, row);

  const out = [];
  for (let wk = 1; wk <= weeks; wk++) {
    const row = byWeek.get(wk);
    out.push(row ? { wk, played: true, row } : { wk, played: false, row: null });
  }
  return out;
}
