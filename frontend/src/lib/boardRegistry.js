const KEY = "perfectpick.myBoards";

export function listBoards() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rememberBoard({ id, name, format }) {
  try {
    const boards = listBoards().filter((b) => b.id !== id);
    boards.unshift({ id, name, format, updatedAt: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(boards.slice(0, 50)));
  } catch {
    // Storage unavailable (private mode, quota). The board still exists
    // server-side and remains reachable by link.
  }
}

export function forgetBoard(id) {
  try {
    localStorage.setItem(KEY, JSON.stringify(listBoards().filter((b) => b.id !== id)));
  } catch {
    // See rememberBoard.
  }
}
