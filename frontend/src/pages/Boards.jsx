import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost, apiDelete } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { listBoards, rememberBoard, forgetBoard } from "../lib/boardRegistry";

const BOARD_SEASON = 2026;

export default function Boards() {
  const nav = useNavigate();
  const [boards, setBoards] = useState(() => listBoards());
  const [format, setFormat] = useState("ppr");
  const [err, setErr] = useState("");

  usePageTitle("Boards");

  const createBoard = async () => {
    setErr("");
    try {
      const name = `My ${format.toUpperCase()} Board`;
      const { boardId } = await apiPost("/boards", {
        name,
        format,
        season: BOARD_SEASON,
      });
      rememberBoard({ id: boardId, name, format });
      setBoards(listBoards());
      nav(`/board/${boardId}`);
    } catch (e) {
      setErr(e.message || "Failed to create board");
    }
  };

  const deleteBoard = async (id) => {
    setErr("");
    try {
      // DELETE /boards/:id is idempotent (a DynamoDB DeleteCommand that
      // succeeds even if the item is already gone), so a resolved call
      // always means it's safe to forget locally. Only drop it from the
      // registry once the server confirms the delete — on failure, keep
      // it listed so the user can retry instead of losing their way back
      // to a board that still exists.
      await apiDelete(`/boards/${id}`);
      forgetBoard(id);
      setBoards(listBoards());
    } catch (e) {
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
            onClick={createBoard}
            data-testid="create-board"
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-600"
          >
            + New board
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-200">
          {err}
        </div>
      )}

      {boards.length === 0 ? (
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
                onClick={() => deleteBoard(b.id)}
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
