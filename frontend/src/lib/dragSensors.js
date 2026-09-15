import { MouseSensor } from "@dnd-kit/core";

/**
 * MouseSensor arms on every button except right-click, where the
 * PointerSensor it replaces took the primary button and nothing else. Left
 * alone, that means middle-click, back and forward all start a drag on a
 * sortable row -- and wherever a drop writes (a debounced board save, an
 * immediate queue POST), a middle-click plus a few pixels would silently
 * persist a reorder from a gesture that used to do nothing at all. On
 * Windows and Linux, middle-mousedown also opens Chrome's autoscroll, so
 * those few pixels of movement arrive on their own.
 *
 * This restores the old PointerSensor predicate verbatim: `isPrimary` has no
 * meaning on a MouseEvent, so the button test is all of it.
 *
 * Shared rather than copied -- every dnd-kit sensor list in this app
 * (Board.jsx, QueuePanel.jsx) should use this one class, not a second
 * definition of a security-shaped predicate that can drift from the first.
 */
export class PrimaryMouseSensor extends MouseSensor {
  static activators = [
    {
      eventName: "onMouseDown",
      handler: ({ nativeEvent: event }, { onActivation }) => {
        if (event.button !== 0) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
}
