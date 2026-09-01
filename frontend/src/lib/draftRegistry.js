const KEY = "perfectpick.myDrafts";

// Matches boardRegistry's cap. Fifty entries is far more history than a
// local-only list needs, and it bounds the stored size.
const MAX_ENTRIES = 50;

export function listDrafts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rememberDraft({
  id,
  teams,
  rounds,
  format,
  userTeam,
  boardId = null,
  completed = false,
}) {
  try {
    const drafts = listDrafts().filter((d) => d.id !== id);
    drafts.unshift({
      id,
      teams,
      rounds,
      format,
      userTeam,
      boardId,
      completed,
      updatedAt: Date.now(),
    });
    localStorage.setItem(KEY, JSON.stringify(drafts.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage unavailable (private mode, quota). The draft still exists
    // server-side and remains reachable by link.
  }
}

export function forgetDraft(id) {
  try {
    localStorage.setItem(KEY, JSON.stringify(listDrafts().filter((d) => d.id !== id)));
  } catch {
    // See rememberDraft.
  }
}
