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
 * is readable but frozen, and nothing can adopt it any more -- the purge
 * script removes unowned rows before this gate ever ships. Letting a mutation
 * adopt one as a side effect would make the first person to send a pick its
 * owner.
 */
function canMutate(item, sub) {
  if (typeof sub !== "string" || sub.length === 0) return false;
  if (isUnowned(item)) return false;
  return item.ownerId === sub;
}

/**
 * One seat per team: the creator in theirs, a bot in every other.
 *
 * A list rather than a scalar owner because invitations fill empty seats
 * later, and the access check below never has to change to accommodate them.
 */
function buildSeats(teams, userTeam, sub) {
  return Array.from({ length: teams }, (_, i) => {
    const team = i + 1;
    return team === userTeam
      ? { team, sub, kind: "human" }
      : { team, sub: null, kind: "bot" };
  });
}

/**
 * May this person see and act in this draft?
 *
 * The `kind` check is not redundant with the sub comparison, but not for the
 * reason it first appears. A null caller sub is already refused by the guard
 * below, before any seat is examined. What `kind` actually stops is a seat
 * that is NOT human yet carries a populated sub equal to the caller's -- a
 * corrupted row today, and a "pending invitation" seat the moment invitations
 * exist, where the sub is known before the person has accepted. Remove the
 * check and that seat grants access.
 */
function isSeated(draft, sub) {
  if (typeof sub !== "string" || sub.length === 0) return false;
  const seats = draft?.seats;
  if (!Array.isArray(seats)) return false;
  return seats.some((s) => s && s.kind === "human" && s.sub === sub);
}

module.exports = { ANON, subOf, isUnowned, canMutate, buildSeats, isSeated };
