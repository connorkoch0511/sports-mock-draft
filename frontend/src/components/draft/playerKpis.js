// The drill-down used to lead with ADP, rank and tier -- three draft-position
// numbers, all of them an em dash for most of the pool. These are what a
// fourth-string tight end actually has: what he scored, where that ranked,
// and how often he was on the field.

const POINTS_FIELD = {
  ppr: "pts_ppr",
  half: "pts_half_ppr",
  standard: "pts_std",
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function computeKpis(detail, format) {
  const s = detail?.stats;
  const gp = num(s?.gp);

  const points = num(s?.[POINTS_FIELD[format] ?? POINTS_FIELD.standard]);
  const fptsPerGame = gp && gp > 0 && points !== null ? points / gp : null;

  // PPR only: the feed publishes no equivalent for the other formats, and a
  // PPR rank shown under "standard" would be a lie with a number attached.
  const posRank = format === "ppr" ? num(s?.pos_rank_ppr) : null;

  const off = num(s?.off_snp);
  const team = num(s?.tm_off_snp);
  const snapShare = off !== null && team !== null && team > 0 ? off / team : null;

  return { fptsPerGame, posRank, snapShare };
}
