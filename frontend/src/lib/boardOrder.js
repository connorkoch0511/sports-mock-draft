/**
 * Reorder the player pool by a user's saved board.
 *
 * Board players lead, ascending by their own rank, each annotated with
 * `myRank` and `delta` for display. Everyone else follows in the order the
 * players endpoint returned them.
 *
 * A board holds every ranked player for its format (the boards API filters
 * its pool to `rank[format] != null`), so the trailing group is essentially
 * the unranked remainder — there is no interleaving to do.
 *
 * Returns the pool untouched when there are no rows, which is the fallback
 * path for a board that was deleted or failed to load.
 */
export function orderByBoard(players, boardRows) {
  if (!Array.isArray(boardRows) || boardRows.length === 0) return players;

  const byId = new Map(
    boardRows.map((r) => [String(r.playerId), r])
  );

  const onBoard = [];
  const rest = [];

  for (const p of players) {
    const row = byId.get(String(p.id));
    if (row) onBoard.push({ ...p, myRank: row.myRank, delta: row.delta });
    else rest.push(p);
  }

  onBoard.sort((a, b) => a.myRank - b.myRank);

  return [...onBoard, ...rest];
}
