/**
 * Who is asking, and may they change this?
 *
 * Both questions live here so that "owned by somebody else" cannot mean one
 * thing in drafts.js and another in boards.js. The token itself is verified by
 * API Gateway's Cognito authorizer before the Lambda runs; by the time these
 * claims exist they have already been checked, so this module only reads them.
 */

// boards.js wrote this literal as ownerId on every board created before
// accounts existed. It means "nobody", and treating it as a real owner would
// make every one of those boards permanently unclaimable.
const ANON = "anon";

/** The caller's Cognito subject, or null when the route is unauthenticated. */
function subOf(event) {
  const sub = event?.requestContext?.authorizer?.jwt?.claims?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}

function isUnowned(item) {
  const owner = item?.ownerId;
  return !owner || owner === ANON;
}

/**
 * Deliberately not "the owner OR anybody if it is unowned": an unowned draft
 * is readable but frozen, and the way to thaw it is POST /me/claim, which is
 * a conditional write. Letting a mutation adopt it as a side effect would make
 * the first person to send a pick its owner.
 */
function canMutate(item, sub) {
  if (typeof sub !== "string" || sub.length === 0) return false;
  if (isUnowned(item)) return false;
  return item.ownerId === sub;
}

module.exports = { ANON, subOf, isUnowned, canMutate };
