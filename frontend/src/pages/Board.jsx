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
import { useAuth } from "../lib/authContext.js";
import { mustSignIn } from "../lib/authGate.js";
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

function Row({ row, onOpen, canDrag }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.playerId, disabled: !canDrag });

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
        disabled={!canDrag}
        aria-label={`Reorder ${row.name}`}
        title={canDrag ? undefined : "Sign in to reorder this board"}
        className="cursor-grab px-1 text-zinc-600 hover:text-zinc-300 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-zinc-600"
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
        title={`${row.name} — stats and trends`}
        className="flex-1 truncate text-left text-sm text-zinc-100 hover:text-cyan-200"
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

  const { configured, signedIn, signIn } = useAuth();
  const needsSignIn = mustSignIn({ configured, signedIn });

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

  const save = useCallback(async (nextRows) => {
    setStatus("saving");
    try {
      const res = await apiPut(`/boards/${boardId}`, {
        order: nextRows.map((r) => r.playerId),
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

  function onDragEnd(event) {
    // Defense in depth: `disabled` on useSortable already keeps a drag from
    // starting when signed out, but a stale drag already in flight when
    // sign-in state flips mid-drag should not reach the API either.
    if (needsSignIn) return;

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
          <h1 className="text-2xl font-semibold tracking-tight">{board.name}</h1>
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

      {needsSignIn && (
        <div
          data-testid="signin-required"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cyan-800/40 bg-cyan-950/20 px-4 py-3 text-sm text-cyan-200"
        >
          <span>Sign in to reorder this board. Reordering is disabled until you do.</span>
          <button
            type="button"
            onClick={signIn}
            data-testid="signin-required-button"
            className="rounded-2xl border border-cyan-800/60 bg-cyan-950/40 px-3 py-1.5 text-xs text-cyan-200 hover:border-cyan-600"
          >
            Sign in
          </button>
        </div>
      )}

      {err && <div className="mb-4 text-sm text-rose-300">{err}</div>}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={rows.map((r) => r.playerId)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1">
            {rows.map((row) => (
              <Row key={row.playerId} row={row} onOpen={setOpenRow} canDrag={!needsSignIn} />
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
