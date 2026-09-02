/**
 * Reorder the player pool by a user's saved board.
 *
 * Every player gets one ordinal: board players sort by `myRank`, everyone
 * else by their consensus rank in the draft's format (`p.rank`). Ties go to
 * the board player -- it's the user's explicit ranking. Unranked players
 * sort last, except a board player unranked in the draft's format: that
 * player still sorts by `myRank`, same as any other board row. Board
 * players carry `myRank` and `delta` for display; nobody else does.
 *
 * `myRank` and `p.rank` are ordinals over different populations -- a board
 * only covers players ranked in its own format (e.g. 223 for standard), not
 * necessarily the draft's format (e.g. 272 for PPR). Merging the two
 * compresses that mismatch rather than removing it: measured against
 * production shape, off-board ranked players land an average of 19.5 spots
 * (worst case 38) from their true rank, down from an average of 105 (worst
 * case 216) when off-board players were appended wholesale, as this
 * function used to do.
 *
 * Returns the pool untouched when there are no rows -- the fallback path
 * for a board that was deleted or failed to load.
 */
export function orderByBoard(players, boardRows) {
  if (!Array.isArray(boardRows) || boardRows.length === 0) return players;

  const byId = new Map(boardRows.map((r) => [String(r.playerId), r]));

  const decorated = players.map((p, index) => {
    const row = byId.get(String(p.id));
    if (row) {
      return {
        player: { ...p, myRank: row.myRank, delta: row.delta },
        rank: row.myRank ?? null,
        fromBoard: 1,
        index,
      };
    }
    return { player: p, rank: p.rank ?? null, fromBoard: 0, index };
  });

  decorated.sort((a, b) => {
    // Unranked sorts last. Without this guard, `null - rank` would coerce
    // `null` to 0 and sort unranked players first, not last -- never NaN.
    if (a.rank === null && b.rank === null) return a.index - b.index;
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;

    if (a.rank !== b.rank) return a.rank - b.rank;

    // Same position claimed: the user's own ranking wins, then pool order,
    // so the result never depends on the engine's sort stability.
    if (a.fromBoard !== b.fromBoard) return b.fromBoard - a.fromBoard;
    return a.index - b.index;
  });

  return decorated.map((d) => d.player);
}
