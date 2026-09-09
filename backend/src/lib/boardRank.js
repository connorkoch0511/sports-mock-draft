/**
 * A big board, expressed as the one thing the drafting code needs from it:
 * a function from player to rank, lower being better.
 *
 * Kept apart from drafts.js because it knows nothing about drafts, picks or
 * seats -- it turns a stored `order` array into a comparison, and that is all.
 */

const { GetCommand } = require("@aws-sdk/lib-dynamodb");

// Sorts behind every ranked player while staying a finite number. Infinity
// would poison pickBestForTeam's `100000 - rank` arithmetic into NaN, and
// NaN compares false against everything -- the loop would pick nobody.
const UNRANKED = 100000;

function consensusRank(p) {
  return p?.rank != null ? Number(p.rank) : UNRANKED;
}

/**
 * Position in the array is the rank. Anyone absent from it sorts behind
 * everyone present, ordered among themselves by consensus.
 *
 * That fallback is load-bearing, not padding: boards.js reconciles newly
 * added players in at read time, so a stored order written in July does not
 * list a player added in August. Without the fallback he would score as
 * unranked rather than as "good, just not on your list".
 */
function rankFromOrder(order) {
  const list = Array.isArray(order) ? order : [];
  const index = new Map();
  list.forEach((id, i) => {
    const key = String(id);
    // First occurrence wins: a duplicated id is a board that lists someone
    // twice, and the higher slot is the one its owner meant.
    if (!index.has(key)) index.set(key, i);
  });

  return (p) => {
    const hit = index.get(String(p?.id));
    return hit !== undefined ? hit : list.length + consensusRank(p);
  };
}

/**
 * Boards are keyed by boardId alone, so this reads a seat-holder's board
 * without needing to be that person.
 *
 * Returns null -- meaning "use consensus" -- for a board that is missing or
 * unreadable. Deleting a board mid-draft must never be able to stall the
 * clock, so a failure here degrades rather than throwing.
 */
async function loadBoardRank({ ddb, boardsTable, boardId }) {
  if (!boardId || !boardsTable) return null;
  try {
    const res = await ddb.send(new GetCommand({ TableName: boardsTable, Key: { boardId } }));
    if (!res.Item) return null;
    return rankFromOrder(res.Item.order);
  } catch (e) {
    console.error("board unreadable, falling back to consensus:", e.message);
    return null;
  }
}

module.exports = { UNRANKED, consensusRank, rankFromOrder, loadBoardRank };
