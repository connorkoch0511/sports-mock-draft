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

function Row({ row }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.playerId });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="board-row"
      data-player-id={row.playerId}
      className={`flex items-center gap-3 rounded-2xl border border-zinc-800/70 bg-zinc-950/60 px-3 py-2 ${
        isDragging ? "opacity-60 ring-1 ring-cyan-300/40" : ""
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${row.name}`}
        className="cursor-grab px-1 text-zinc-600 hover:text-zinc-300 active:cursor-grabbing"
      >
        ⠿
      </button>
      <span className="w-8 text-right text-sm tabular-nums text-zinc-500">{row.myRank}</span>
      <span className="flex-1 truncate text-sm text-zinc-100">
        {row.name}
        {row.isNew && (
          <span className="ml-2 rounded-full bg-cyan-300/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-cyan-300">
            New
          </span>
        )}
      </span>
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
  const [rows, setRows] = useState([]);
  const [version, setVersion] = useState(null);
  const [status, setStatus] = useState("loading");
  const [err, setErr] = useState("");
  const saveTimer = useRef(null);

  usePageTitle(board ? board.name : "Board");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const load = useCallback(async () => {
    try {
      const data = await apiGet(`/boards/${boardId}`);
      setBoard(data);
      setRows(data.rows);
      setVersion(data.version);
      setStatus("idle");
      setErr("");
    } catch (e) {
      setErr(e.message || "Failed to load board");
      setStatus("error");
    }
  }, [boardId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const save = useCallback(async (nextRows, expectedVersion) => {
    setStatus("saving");
    try {
      const res = await apiPut(`/boards/${boardId}`, {
        order: nextRows.map((r) => r.playerId),
        version: expectedVersion,
      });
      setVersion(res.version);
      setStatus("saved");
    } catch (e) {
      if (String(e.message).includes("changed since")) {
        setErr("This board changed elsewhere. Reloading.");
        await load();
      } else {
        setErr(e.message || "Save failed");
        setStatus("error");
      }
    }
  }, [boardId, load]);

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
    saveTimer.current = setTimeout(() => save(moved, version), 800);
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
          <h1 className="text-2xl font-semibold tracking-tight">{board.name}</h1>
          <p className="text-sm text-zinc-400">
            {board.format.toUpperCase()} · {board.season} · {rows.length} players
          </p>
        </div>
        <span data-testid="save-status" className="text-xs text-zinc-400">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : status === "dirty" ? "Unsaved" : ""}
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
            {rows.map((row) => <Row key={row.playerId} row={row} />)}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}
