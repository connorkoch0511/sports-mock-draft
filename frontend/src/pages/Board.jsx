import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { apiGet, apiPut } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { PlayerModal } from "../components/draft/PlayerModal";

const POS_COLORS = {
  QB: "text-rose-300", RB: "text-emerald-300", WR: "text-cyan-300",
  TE: "text-amber-300", K: "text-zinc-400", DEF: "text-violet-300",
};

function DeltaBadge({ delta }) {
  if (delta === null || delta === 0) {
    return <span className="text-xs text-zinc-600">—</span>;
  }
  const up = delta > 0;
  return (
    <span className={`text-xs tabular-nums ${up ? "text-emerald-400" : "text-rose-400"}`}>
      {up ? "+" : ""}{delta} {up ? "↑" : "↓"}
    </span>
  );
}

function Row({ row, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.playerId });

  return (
    <li
      ref={setNodeRef}
      // Pointer listeners on the row, so the whole thing reorders -- rank,
      // position, team, delta, the grip, the empty space between them. The
      // grip alone used to be the only draggable target, and it is a dim
      // six-dot glyph that is easy to miss entirely.
      //
      // The player's name is the deliberate exception: it stops propagation,
      // so it stays a plain click target and opening a player never competes
      // with a drag beginning on the same pixel. `attributes` stay on the
      // grip, so keyboard reordering is untouched.
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="board-row"
      data-player-id={row.playerId}
      className={`flex cursor-grab items-center gap-3 rounded-2xl border border-zinc-800/70 bg-zinc-950/60 px-3 py-2 active:cursor-grabbing ${
        isDragging ? "opacity-60 ring-1 ring-cyan-300/40" : ""
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${row.name}`}
        title="Drag anywhere on the row to reorder"
        className="cursor-grab px-1 text-zinc-500 hover:text-zinc-200 active:cursor-grabbing"
      >
        ⠿
      </button>
      <span className="w-8 text-right text-sm tabular-nums text-zinc-500">{row.myRank}</span>
      {/*
        The name opens the player; the ⠿ grip beside it still reorders. They
        are separate controls, so there is no click-versus-drag ambiguity to
        tune and no clash with the keyboard sensor, which owns Space on the
        grip.
      */}
      <button
        type="button"
        data-testid="open-player"
        onClick={() => onOpen(row)}
        // The one part of the row that is NOT a drag handle. Everything else
        // reorders; the name stays a plain click target, so opening a player
        // never has to compete with a drag that started on the same pixel.
        onPointerDown={(e) => e.stopPropagation()}
        title={`${row.name} — stats and trends`}
        className="flex-1 cursor-pointer truncate text-left text-sm text-zinc-100 hover:text-cyan-200"
      >
        {row.name}
        {row.isNew && (
          <span className="ml-2 rounded-full bg-cyan-300/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-cyan-300">
            New
          </span>
        )}
      </button>
      <span className={`w-10 text-xs ${POS_COLORS[row.position] || "text-zinc-400"}`}>
        {row.position}
      </span>
      <span className="w-10 text-xs text-zinc-500">{row.team}</span>
      <span className="w-16 text-right"><DeltaBadge delta={row.delta} /></span>
    </li>
  );
}

export default function Board() {
  const { boardId } = useParams();
  const [board, setBoard] = useState(null);
  // The title field's own value, so typing does not fight the loaded board.
  const [nameDraft, setNameDraft] = useState("");
  const [rows, setRows] = useState([]);
  const [openRow, setOpenRow] = useState(null);
  const [status, setStatus] = useState("loading");
  const [err, setErr] = useState("");
  const saveTimer = useRef(null);
  // Always holds the most recently known board version (set on load and on
  // every successful save). Reading this instead of a state value captured
  // at drag time avoids submitting a stale version from a debounce closure.
  const versionRef = useRef(null);
  // Chains scheduled saves so a new save always waits for any in-flight
  // save to finish, instead of racing it with an out-of-date version.
  const saveChainRef = useRef(Promise.resolve());


  usePageTitle(board ? board.name : "Board");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // `preserveErr` lets a caller (the 409 conflict handler in `save`) reload
  // fresh board data without wiping a message it just set. The normal load
  // path (initial mount, plain refresh) still clears stale errors as before.
  const load = useCallback(async ({ preserveErr = false } = {}) => {
    try {
      const data = await apiGet(`/boards/${boardId}`);
      setBoard(data);
      setNameDraft(data.name);
      setRows(data.rows);
      versionRef.current = data.version;
      setStatus("idle");
      if (!preserveErr) setErr("");
    } catch (e) {
      setErr(e.message || "Failed to load board");
      setStatus("error");
    }
  }, [boardId]);

  // A false positive. `load` awaits apiGet before it touches state, so every
  // setState inside it runs in a later microtask, never synchronously in this
  // effect body -- the rule cannot see through the await. Fetching on mount is
  // what effects are for; there is nothing here to restructure.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  // Known limitation, accepted as-is: navigating away inside the 800ms
  // debounce window discards the last pending reorder. A reliable async
  // flush from this cleanup isn't worth the complexity for this feature.
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // One writer for both fields. A rename and a reorder hit the same
  // version-checked PUT, so they share the conflict, 401 and 404 handling
  // rather than growing a second copy that drifts from this one.
  const put = useCallback(async (payload) => {
    setStatus("saving");
    try {
      const res = await apiPut(`/boards/${boardId}`, {
        ...payload,
        version: versionRef.current,
      });
      versionRef.current = res.version;
      setStatus("saved");
      // A successful save retires any message left over from a previous
      // failure or conflict (e.g. the "changed elsewhere" notice) — without
      // this, a stale banner from an earlier 409 would sit on screen
      // indefinitely, contradicting the "Saved" status right next to it.
      setErr("");
    } catch (e) {
      if (e.status === 409) {
        setErr("This board changed elsewhere. We've refreshed your view with the latest version.");
        await load({ preserveErr: true });
      } else if (e.status === 401) {
        setErr("Sign in to make changes");
        setStatus("error");
      } else if (e.status === 404) {
        setErr("This board isn't yours to edit");
        setStatus("error");
      } else {
        setErr(e.message || "Save failed");
        setStatus("error");
      }
    }
  }, [boardId, load]);

  const save = useCallback((nextRows) => put({ order: nextRows.map((r) => r.playerId) }), [put]);

  // Queued behind any in-flight reorder for the same reason reorders queue
  // behind each other: both bump the version, and racing them is a 409 the
  // user did nothing to deserve.
  const rename = useCallback(
    (nextName) => {
      const trimmed = nextName.trim();
      if (!trimmed || trimmed === board?.name) return;
      setBoard((b) => (b ? { ...b, name: trimmed } : b));
      saveChainRef.current = saveChainRef.current.then(() => put({ name: trimmed }));
    },
    [put, board?.name]
  );

  function onDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = rows.findIndex((r) => r.playerId === active.id);
    const to = rows.findIndex((r) => r.playerId === over.id);
    if (from < 0 || to < 0) return;

    const moved = arrayMove(rows, from, to).map((r, i) => ({
      ...r,
      myRank: i + 1,
      delta: r.consensusRank === null ? null : r.consensusRank - (i + 1),
    }));

    setRows(moved);
    setStatus("dirty");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      // Chain onto any save already in flight so saves never race each
      // other; each save reads the latest versionRef when it actually runs.
      saveChainRef.current = saveChainRef.current.then(() => save(moved));
    }, 800);
  }

  if (status === "loading") {
    return <div className="py-12 text-center text-zinc-400">Loading board…</div>;
  }
  if (!board) {
    return <div className="py-12 text-center text-rose-300" data-testid="board-error">{err}</div>;
  }

  return (
    <div className="py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          {/*
            The title is the control. A separate "rename" button for a single
            text field is a click and a mode for something you can just type
            into, and the field carries its own label for anyone not seeing
            the heading styling.
          */}
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => rename(nameDraft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setNameDraft(board.name);
            }}
            maxLength={80}
            aria-label="Board name"
            data-testid="board-title"
            className="w-full max-w-md rounded-lg border border-transparent bg-transparent text-2xl font-semibold tracking-tight text-white hover:border-zinc-800 focus:border-zinc-600 focus:outline-none"
          />
          <p className="text-sm text-zinc-400">
            {board.format.toUpperCase()} · {board.season} · {rows.length} players
          </p>
        </div>
        <span data-testid="save-status" className="text-xs text-zinc-400">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : status === "dirty" ? "Unsaved" : status === "error" ? "Save failed" : ""}
        </span>
      </div>

      {(board.changelog.added > 0 || board.changelog.removed > 0) && (
        <div data-testid="changelog" className="mb-4 rounded-2xl border border-cyan-300/20 bg-cyan-300/5 px-4 py-2 text-sm text-cyan-200">
          {board.changelog.added} added, {board.changelog.removed} removed since you last opened this board.
        </div>
      )}

      {err && <div className="mb-4 text-sm text-rose-300">{err}</div>}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={rows.map((r) => r.playerId)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1">
            {rows.map((row) => (
              <Row key={row.playerId} row={row} onOpen={setOpenRow} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {openRow ? (
        <PlayerModal
          key={openRow.playerId}
          player={{
            id: openRow.playerId,
            name: openRow.name,
            position: openRow.position,
            team: openRow.team,
          }}
          format={board?.format || "standard"}
          onClose={() => setOpenRow(null)}
        />
      ) : null}
    </div>
  );
}
