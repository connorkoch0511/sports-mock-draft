const KEY = "perfectpick.myDrafts";

// Matches boardRegistry's cap. Fifty entries is far more history than a
// local-only list needs, and it bounds the stored size.
const MAX_ENTRIES = 50;

export function listDrafts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY));
    if (!Array.isArray(parsed)) return [];
    // localStorage is user-writable and shared across every tab on the
    // origin, so a corrupt element (null, a string, an object missing an
    // id) is reachable without any bug in this app. Drop those silently
    // rather than let them reach rendering code, same as an empty list
    // beats an exception above.
    return parsed.filter((d) => d && typeof d === "object" && typeof d.id === "string");
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
  // Not passed by useRememberDraft.js -- only NewDraft.jsx knows a draft is
  // new, at the moment it holds the POST /drafts response. When omitted
  // (the common case: the draft page's load effect re-remembering an
  // already-known draft), the existing entry's `owned` is carried forward
  // below rather than defaulting to false, which would erase ownership the
  // instant the draft page's own effect fires after creation.
  owned,
}) {
  try {
    const existing = listDrafts().find((d) => d.id === id);
    const drafts = listDrafts().filter((d) => d.id !== id);
    const resolvedOwned = owned !== undefined ? Boolean(owned) : Boolean(existing?.owned);
    drafts.unshift({
      id,
      teams,
      rounds,
      format,
      userTeam,
      boardId,
      completed,
      owned: resolvedOwned,
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
