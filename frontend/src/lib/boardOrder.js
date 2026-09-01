/**
 * Reorder the player pool by a user's saved board.
 *
 * Every player gets one ordinal: board players use the rank the user gave
 * them, and everyone else uses their consensus rank in the draft's format.
 * Unranked players have no position to claim, so they sort last. Board
 * players carry `myRank` and `delta` for display; nobody else does.
 *
 * The pool and the board can disagree about who is ranked at all. A board
 * covers every player ranked in ITS format, which is not the same set as the
 * draft's format -- measured against production, standard ranks 223 players
 * and PPR ranks 272, with standard a strict subset. Appending the off-board
 * group wholesale, as this used to, therefore buried players who belong near
 * the top: a standard board driving a PPR draft pushed 49 of them below its
 * 223 rows, 22 of those inside the top 223. The same happens in miniature to
 * anyone the nightly sync ranks after a board was built.
 *
 * Ties go to the board player: it is the user's explicit ranking.
 *
 * Returns the pool untouched when there are no rows, which is the fallback
 * path for a board that was deleted or failed to load.
 */
export function orderByBoard(players, boardRows) {
  if (!Array.isArray(boardRows) || boardRows.length === 0) return players;

  const byId = new Map(boardRows.map((r) => [String(r.playerId), r]));

  const decorated = players.map((p, index) => {
    const row = byId.get(String(p.id));
    if (row) {
      return {
        player: { ...p, myRank: row.myRank, delta: row.delta },
        rank: row.myRank,
        fromBoard: 1,
        index,
      };
    }
    return { player: p, rank: p.rank ?? null, fromBoard: 0, index };
  });

  decorated.sort((a, b) => {
    // Unranked sorts last. Comparing them numerically would be NaN, so the
    // null cases are settled before any subtraction happens.
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
