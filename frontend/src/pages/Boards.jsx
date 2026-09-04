import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost, apiDelete } from "../lib/api";
import { useAuth } from "../lib/authContext.js";
import { mustSignIn } from "../lib/authGate.js";
import { usePageTitle } from "../lib/usePageTitle";
import { fetchMyBoards } from "../lib/me";

const BOARD_SEASON = 2026;

export default function Boards() {
  const nav = useNavigate();
  const [boards, setBoards] = useState(null);
  const [format, setFormat] = useState("ppr");
  const [err, setErr] = useState("");

  const { configured, signedIn, signIn } = useAuth();
  const needsSignIn = mustSignIn({ configured, signedIn });

  usePageTitle("Boards");

  const load = useCallback(() => {
    fetchMyBoards()
      .then(setBoards)
      .catch((e) => setErr(e.message || "Could not load your boards"));
  }, []);

  useEffect(() => { load(); }, [load]);

  const createBoard = async () => {
    setErr("");
    try {
      const name = `My ${format.toUpperCase()} Board`;
      const { boardId } = await apiPost("/boards", {
        name,
        format,
        season: BOARD_SEASON,
      });
      // No local list to update -- navigating away leaves the page anyway,
      // and the server already has it.
      nav(`/board/${boardId}`);
    } catch (e) {
      setErr(e.message || "Failed to create board");
    }
  };

  const deleteBoard = async (b) => {
    // A board is hand-ranked work with no undo, and it sits one nav item away
    // from My drafts, which already confirms. Same destructive action, same
    // gate, same copy shape.
    if (
      !window.confirm(
        `Delete the board "${b.name}"? This cannot be undone, and your rankings will be lost.`
      )
    ) {
      return;
    }
    setErr("");
    try {
      // Server first, then reload: on failure the row stays listed so the
      // user can retry rather than losing their way back to a board that
      // still exists.
      //
      // DELETE /boards/:id used to be idempotent — a DynamoDB DeleteCommand
      // that succeeded even when the item was already gone. It is now a
      // conditional delete on ownerId, so "already gone" and "not yours"
      // both answer 404, which the catch below treats as stale rather than
      // something to retry -- either way, re-reading the server is correct.
      await apiDelete(`/boards/${b.id}`);
      load();
    } catch (e) {
      if (e.status === 404) { load(); return; }
      setErr(e.message || "Failed to delete board");
    }
  };

  return (
    <div className="py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My boards</h1>
          <p className="text-sm text-zinc-400">
            Rank players your way, then draft off your own board.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            data-testid="board-format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-cyan-300/60"
          >
            <option value="standard">Standard</option>
            <option value="half-ppr">Half PPR</option>
            <option value="ppr">PPR</option>
          </select>
          <button
            type="button"
            onClick={needsSignIn ? signIn : createBoard}
            data-testid="create-board"
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-600"
          >
            {needsSignIn ? "Sign in to create" : "+ New board"}
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-200">
          {err}
        </div>
      )}

      {boards === null ? (
        // Not shown once an error lands -- the banner above already explains
        // why there is nothing, so "Loading…" underneath it would be a lie.
        !err && <div className="text-sm text-zinc-500">Loading…</div>
      ) : boards.length === 0 ? (
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-8 text-center text-sm text-zinc-500">
          No boards yet. Create one to rank players your way.
        </div>
      ) : (
        <ul className="space-y-1" data-testid="board-list">
          {boards.map((b) => (
            <li key={b.id} className="flex items-center gap-2">
              <button
                onClick={() => nav(`/board/${b.id}`)}
                className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-left text-sm text-zinc-200 hover:border-zinc-600"
              >
                {b.name}
              </button>
              <button
                onClick={() => deleteBoard(b)}
                aria-label={`Delete ${b.name}`}
                className="rounded-2xl border border-zinc-800 px-3 py-3 text-xs text-zinc-500 hover:border-rose-900/60 hover:text-rose-300"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
