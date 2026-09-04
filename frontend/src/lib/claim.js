/**
 * Which of this browser's ids are worth offering to POST /me/claim.
 *
 * Only ids the local registries recorded as *created here* are ever sent --
 * never every id this browser has seen. Sending the latter would be asking to
 * own drafts somebody shared with you, and while the server's conditional
 * write would refuse, asking at all is the wrong shape.
 */

// Matches MAX_IDS in backend/src/me.js and the registries' own cap.
const MAX_IDS = 50;

function ids(list, predicate) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (e) =>
        e && typeof e === "object" && typeof e.id === "string" && e.id.length > 0
    )
    .filter(predicate)
    .map((e) => e.id)
    .slice(0, MAX_IDS);
}

export function claimableIds({ drafts, boards } = {}) {
  return {
    draftIds: ids(drafts, (d) => Boolean(d.owned)),
    // Every remembered board was created by this browser: rememberBoard is
    // called from exactly one place, immediately after POST /boards.
    boardIds: ids(boards, () => true),
  };
}

export function claimKey(sub) {
  return `perfectpick.claimed.${sub}`;
}

export function hasClaimed(sub) {
  try {
    return localStorage.getItem(claimKey(sub)) !== null;
  } catch {
    // Storage unavailable. Claiming again is harmless -- the server's write is
    // conditional and idempotent in effect -- so fail towards trying.
    return false;
  }
}

export function markClaimed(sub) {
  try {
    localStorage.setItem(claimKey(sub), String(Date.now()));
  } catch {
    // See hasClaimed.
  }
}
