import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiPost, apiPut, apiDelete } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { fetchMyBoards } from "../lib/me";
import { parseBoardFile } from "../lib/boardFile";
import { matchPlayers } from "../lib/boardMatch";

const BOARD_SEASON = 2026;

export default function Boards() {
  const nav = useNavigate();
  const [boards, setBoards] = useState(null);
  const [format, setFormat] = useState("ppr");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");


  usePageTitle("Boards");

  // A ref rather than an effect-local flag, because load() is also called
  // after a delete -- a response landing on a page the user has left should be
  // dropped no matter which call started it.
  const alive = useRef(true);
  useEffect(() => {
    // Set on mount as well as cleared on unmount. StrictMode runs effects
    // mount -> cleanup -> remount, so a cleanup-only version latches false on
    // the second pass and every later response is dropped -- the list simply
    // never renders.
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(() => {
    fetchMyBoards()
      .then((bs) => { if (alive.current) setBoards(bs); })
      .catch((e) => { if (alive.current) setErr(e.message || "Could not load your boards"); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const createBoard = async () => {
    setErr("");
    try {
      // Typed name wins; the format-derived one is the fallback, which is what
      // every board was called before you could name one.
      const typed = name.trim();
      const { boardId } = await apiPost("/boards", {
        name: typed || `My ${format.toUpperCase()} Board`,
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

  const fileRef = useRef(null);
  const importingRef = useRef(false);
  const [importing, setImporting] = useState(false);

  const importBoard = async (file) => {
    // A second file chosen before the first finishes would create a second
    // board and race it to the navigation, leaving the loser behind unexplained.
    // A ref rather than the state, because this has to read true from the
    // instant the first call starts, not after the next render.
    if (importingRef.current) return;
    setErr("");
    let parsed;
    try {
      parsed = parseBoardFile(await file.text());
    } catch (e) {
      setErr(e.message);
      return;
    }

    // Every way out of the block below that has not saved an order leaves the
    // board it created sitting in the person's list, so cleanup belongs in one
    // place rather than on whichever branch was noticed first: a failed GET and
    // a failed PUT orphan a board exactly as a zero-match import does.
    // createdId is cleared only once the order is saved and the board is
    // genuinely theirs.
    let createdId = null;
    importingRef.current = true;
    setImporting(true);
    try {
      const { boardId } = await apiPost("/boards", {
        name: `${parsed.meta.name} (imported)`,
        format: parsed.meta.format,
        season: parsed.meta.season,
      });
      createdId = boardId;

      // A new board reconciles to the whole eligible pool, so these rows are
      // the pool -- exactly what the file's names have to be matched against.
      const created = await apiGet(`/boards/${boardId}`);
      const result = matchPlayers(parsed.players, created.rows);

      if (result.order.length === 0) {
        setErr("None of those players are in this season's pool, so there was nothing to import.");
        return;
      }

      await apiPut(`/boards/${boardId}`, { order: result.order, version: created.version });
      createdId = null;
      nav(`/board/${boardId}`, {
        state: { importReport: { matched: result.order.length, total: parsed.players.length, ...result } },
      });
    } catch (e) {
      setErr(e.message || "Could not import that board");
    } finally {
      if (createdId) {
        try {
          await apiDelete(`/boards/${createdId}`);
        } catch {
          // Swallowed on purpose. A cleanup failure is not this person's
          // problem, and reporting it would replace the message that tells
          // them why their import produced nothing.
        }
      }
      importingRef.current = false;
      setImporting(false);
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
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createBoard();
            }}
            maxLength={80}
            data-testid="board-name"
            aria-label="Name for the new board"
            placeholder={`My ${format.toUpperCase()} Board`}
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            data-testid="import-file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared so choosing the same file twice fires onChange twice --
              // otherwise a failed import cannot be retried without picking a
              // different file first.
              e.target.value = "";
              if (file) importBoard(file);
            }}
          />
          <button
            type="button"
            data-testid="import-board"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
          >
            {importing ? "Importing…" : "Import board"}
          </button>
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
