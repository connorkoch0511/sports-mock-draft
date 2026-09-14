// The drill-down used to lead with ADP, rank and tier -- three draft-position
// numbers, all of them an em dash for most of the pool. These are what a
// fourth-string tight end actually has: what he scored, where that ranked,
// and how often he was on the field.

// Keyed on the app's own format vocabulary -- FORMATS in
// backend/src/sync/normalize.js, and the <option value> set in NewDraft. A
// table keyed on "half" matched nothing, so every half-PPR drafter was shown
// STANDARD points under an FPTS/GAME label: a wrong number rather than an
// absent one, which is the worse failure of the two.
export const POINTS_FIELD = {
  ppr: "pts_ppr",
  "half-ppr": "pts_half_ppr",
  standard: "pts_std",
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function computeKpis(detail, format) {
  const s = detail?.stats;
  const gp = num(s?.gp);

  // No silent fallback. An unrecognised format means we do not know which
  // scoring column to divide, and "we do not know" is an em dash -- not
  // another league's points wearing this league's label.
  const field = POINTS_FIELD[format];
  const points = field ? num(s?.[field]) : null;
  const fptsPerGame = gp && gp > 0 && points !== null ? points / gp : null;

  // PPR only: the feed publishes no equivalent for the other formats, and a
  // PPR rank shown under "standard" would be a lie with a number attached.
  const posRank = format === "ppr" ? num(s?.pos_rank_ppr) : null;

  const off = num(s?.off_snp);
  const team = num(s?.tm_off_snp);
  const snapShare = off !== null && team !== null && team > 0 ? off / team : null;

  return { fptsPerGame, posRank, snapShare };
}
