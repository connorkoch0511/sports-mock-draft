/** The empty option's value. Distinct from "unset" -- see boardIdFromValue. */
export const CONSENSUS = "";

/**
 * The options for "Auto-pick from".
 *
 * Your own boards, plus consensus, plus -- when the seat currently inherits a
 * board that is not yours -- an entry for that board. A select whose value
 * matches no option renders blank, which here would mean the page showing
 * nothing while the clock quietly drafts from the creator's rankings.
 */
export function boardOptions(myBoards, yourBoardId) {
  const list = Array.isArray(myBoards) ? myBoards : [];
  const opts = [{ value: CONSENSUS, label: "Consensus rankings" }];
  for (const b of list) opts.push({ value: b.id, label: b.name || "Untitled board" });
  if (yourBoardId && !list.some((b) => b.id === yourBoardId)) {
    opts.push({ value: yourBoardId, label: "The draft's board" });
  }
  return opts;
}

/**
 * Null is a decision here, not an absence: it means "I chose consensus", and
 * the server stores it so the seat stops inheriting the draft's board.
 */
export function boardIdFromValue(value) {
  return value === CONSENSUS ? null : value;
}
