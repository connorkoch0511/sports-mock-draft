import {
  DndContext,
  KeyboardSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PrimaryMouseSensor } from "../../lib/dragSensors";
import { useIsPhone } from "../../lib/useIsPhone";

/**
 * One queued player. The whole row is the drag surface, same reasoning as
 * Board.jsx's Row: a lone six-dot grip is an easy target to miss, and this
 * row has no other click target competing for the same pixels the way
 * Board's player name does -- Remove is the one exception, and it opts out
 * of the drag the same way Board's name opts out of it.
 */
function QueueRow({ id, index, player, onRemove, isStrip = false }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="queue-row"
      data-player-id={id}
      // In the strip it is a chip that does not grow: shrink-0 so the row
      // scrolls sideways rather than squeezing four names into nothing, and
      // p-2 because 90px of strip height has no room for p-3 twice over.
      className={`flex cursor-grab items-center justify-between gap-2 rounded-2xl border border-zinc-900 bg-black/60 active:cursor-grabbing ${
        isStrip ? "shrink-0 p-2" : "p-3"
      } ${isDragging ? "opacity-60 ring-1 ring-cyan-300/40" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${player.name}`}
          title="Drag anywhere on the row to reorder"
          className="cursor-grab px-1 text-zinc-500 hover:text-zinc-200 active:cursor-grabbing"
        >
          ⠿
        </button>
        <span className="text-xs text-zinc-500 tabular-nums">{index + 1}</span>
        <div className="min-w-0">
          {/* The queue's own column is the narrowest panel in the layout
              (260px at 3xl) -- a name this column can't fit in full still
              needs to be discoverable on hover, the same reason Board's row
              carries a title. */}
          <div className="truncate font-medium" title={player.name}>
            {player.name}
          </div>
          <div className="text-xs text-zinc-400">
            {player.position} · {player.team}
          </div>
        </div>
      </div>
      <button
        type="button"
        data-testid="queue-remove"
        aria-label={`Remove ${player.name} from your queue`}
        title={`Remove ${player.name} from your queue`}
        onClick={() => onRemove(id)}
        // The sensors listen for mousedown/touchstart, not click, so
        // stopping only the click would still let a drag arm on this same
        // pixel before the click ever fires. Same three-event guard as
        // Board.jsx's name button.
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        // A glyph, not the word: at the 260px the queue column gets, a
        // "Remove" button ate ~75px and truncated three names out of four --
        // "Justin Je...", "CeeDee ...". A queue you cannot read the names in
        // is not doing its job. The full sentence still reaches anyone who
        // needs it, through aria-label and the hover title above.
        className="shrink-0 rounded-full border border-zinc-800 bg-zinc-950/70 px-2 py-1 text-xs leading-none text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * The queue: who you're taking next, in order, drawn from your own seat's
 * private list. Nothing here decides what's IN the queue -- BigBoardPanel's
 * queue-add button does that -- this panel renders it, lets you take
 * somebody back off, and lets you drag it into the order the clock will
 * actually draft from.
 */
export function QueuePanel({ queue, playersById, picked, onRemove, onReorder }) {
  // Filtered on read. A queued player somebody drafted is gone from here the
  // moment the pick lands -- no write, no race, and nothing struck through:
  // an entry you cannot pick is noise in a list whose whole job is what you
  // are going to pick next. Where the run happened is legible on the Draft
  // Board, which exists for that; this list stays nothing but signal.
  const live = queue.filter((id) => !picked.has(id));

  // Mirrors Board.jsx's sensor list exactly -- see dragSensors.js for why
  // PrimaryMouseSensor replaces MouseSensor (a drop here POSTs, so a
  // middle-click reorder would be a real write, not just a stray no-op) and
  // why touch gets a 250ms hold instead of a distance (a finger has no other
  // way to scroll the list, so the same few pixels of movement is how you
  // read it).
  const sensors = useSensors(
    useSensor(PrimaryMouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // A drop reorders the STORED array (the `queue` prop), never the filtered
  // `live` view rendered below -- posting `live` directly would silently
  // drop every already-drafted player's id from storage on the very next
  // drag. Positions of picked ids are left exactly where they were; only the
  // visible ids' slots receive the new order, in the sequence they were
  // dragged into.
  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = live.indexOf(active.id);
    const to = live.indexOf(over.id);
    if (from < 0 || to < 0) return;

    const reorderedLive = arrayMove(live, from, to);
    let cursor = 0;
    const nextStored = queue.map((id) => (picked.has(id) ? id : reorderedLive[cursor++]));
    onReorder(nextStored);
  }

  // Matches the page's own lg boundary: above it this is the strip beneath
  // three columns, below it a tab of its own.
  const isStrip = !useIsPhone();

  return (
    <div
      data-testid="panel-queue"
      // lg:col-span-3 sits HERE and not on the pane wrapper: that wrapper is
      // `lg:contents` above lg, so it has no box for a span to apply to. The
      // cap keeps this a strip -- the row is auto-height, so without it three
      // queued players take 296px and leave the three panels above 208.
      className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] min-h-0 min-w-0 flex flex-col lg:col-span-3 lg:max-h-[132px]"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Queue</h2>
        <div className="text-xs text-zinc-400">{live.length} queued</div>
      </div>

      {/* A strip above lg, a list below it. A bottom strip has 1200px of
          width and 90px of height, so laying the queue out vertically there
          showed one entry of three under a header saying "3 queued". Below lg
          it is a full tab with the opposite budget, and stays a list. */}
      <div
        data-testid="scroll-queue"
        className="mt-3 flex-1 min-h-0 overflow-auto pr-1 space-y-2 lg:space-y-0 lg:flex lg:gap-2 lg:overflow-x-auto lg:overflow-y-hidden"
      >
        {live.length === 0 ? (
          // The point of this panel: an empty queue is a normal, common state
          // (most drafts, most of the time) and a blank box in that state
          // reads as broken rather than "nothing queued yet".
          <p data-testid="queue-empty" className="text-sm text-zinc-500">
            Nothing queued. Add players from the Big Board and the clock will
            draft from this list first if it ever has to pick for you.
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={live} strategy={isStrip ? horizontalListSortingStrategy : verticalListSortingStrategy}>
              {live.map((id, i) => {
                const p = playersById.get(id);
                // The player pool loads separately from the draft itself
                // (Draft.jsx's load()); a queue entry racing ahead of it is
                // not an error, just a row with nothing to render yet.
                if (!p) return null;
                return (
                  <QueueRow
                    key={id}
                    id={id}
                    index={i}
                    player={p}
                    onRemove={onRemove}
                    isStrip={isStrip}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
