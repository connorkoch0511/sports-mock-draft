# You cannot reorder your big board with a finger

**Status:** approved design, corrected 13 September after the first diagnosis
proved to be a testing artifact. Not yet implemented.
**Scope:** one file, `frontend/src/pages/Board.jsx`. Nothing else imports dnd-kit.

## The bug

On a touchscreen the big board cannot be reordered at all. Scrolling works;
dragging a row does nothing, no matter how deliberately you do it.

Instrumented at 390×844 with touch emulation, dispatching genuine touch events
over CDP. A row receives:

```
pointerdown, touchstart, pointermove, pointermove, touchmove,
pointercancel, touchmove*, touchmove*, touchend*      (* = non-cancelable)
```

The computed `touch-action` on the row is `auto`, so the browser is free to
claim the gesture for scrolling — and it does, firing **`pointercancel`** a
couple of frames in. dnd-kit's `PointerSensor` abandons the drag there. Every
later `touchmove` arrives non-cancelable, because the browser has already
committed to scrolling and nothing can take the gesture back.

Holding still first does not help. There is no native long-press-to-drag, so a
400ms hold followed by a clean vertical move produces the same
`pointercancel`. The sensor never activates, so the board is read-only to a
thumb.

```js
useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
```

A four-pixel threshold is right for a mouse, which scrolls with a wheel and
whose movement is therefore unambiguous. dnd-kit's own guidance is that
`PointerSensor` needs `touch-action: none` on the draggable to work on touch —
but setting that here would forbid scrolling the list entirely, trading a
board you cannot reorder for a board you cannot read.

## How the first diagnosis got this backwards

Worth recording, because the mistake is reusable.

The original probe dispatched synthetic `PointerEvent`s straight at the row
with `element.dispatchEvent(...)`, and saw the board reorder on a swipe. It
was written up as "scrolling silently re-ranks your board and saves it" —
data corruption, and the reason this project was scheduled ahead of the draft
page.

That reorder cannot happen to a real finger. Synthetic pointer events skip the
browser's scroll-versus-drag arbitration entirely, so `pointercancel` never
fires and the drag proceeds — an outcome available only to the test harness.
**The probe measured its own dispatch method, not the application.** The
implementer's first run caught it: the plan predicted the swipe test would
fail, and instead the swipe passed while the long-press failed.

The rule this yields: when a test simulates input, verify that the simulation
produces the same event sequence as the real device before drawing a
conclusion from it. Instrumenting the listeners took one run and would have
caught this before any of it was written down.

## The fix

Unchanged by the correction — it was the right fix for the wrong reason.
Replace the one pointer sensor with two input-specific ones:

```js
useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
```

dnd-kit selects by input type, so **mouse behaviour is unchanged**: the same
four-pixel threshold on the same whole-row target.

`TouchSensor` works at the touch-event level rather than the pointer level,
and that is what beats `pointercancel`. Once its delay elapses it calls
`preventDefault()` on `touchmove`, so the browser never claims the gesture and
never cancels the pointer. Before the delay it prevents nothing, so the
gesture stays the browser's and the list scrolls exactly as it does today.
Verified: after the change the same instrumented gesture runs
`pointerdown … pointermove × 8 … pointerup` with **no `pointercancel`**.

The two constraints divide the gesture:

- A finger that **moves more than 5px before 250ms** never activates the drag.
  The browser scrolls, as it always did.
- A finger that **stays still for 250ms** activates. The row lifts and follows
  the thumb.

That is the reorder idiom iOS and Android already teach, so it needs no
explanation on screen.

## What must not be broken

The whole row is the drag target deliberately. `Board.jsx` says why:

> The grip alone used to be the only draggable target, and it is a dim
> six-dot glyph that is easy to miss entirely.

That was a real fix for mouse users, and a dim six-dot glyph is a *worse*
target for a thumb than for a cursor. So the answer is not grip-only dragging
on touch. The whole row stays draggable on both inputs.

## The sharp edge

The player's name is the one part of the row that is not a drag handle:

```jsx
onPointerDown={(e) => e.stopPropagation()}
```

This works **only because `PointerSensor` listens for `pointerdown`.**
`MouseSensor` listens for `mousedown` and `TouchSensor` for `touchstart`, so
after the swap the guard stops nothing and pressing a player's name would
begin a drag instead of opening them. The guard has to follow the sensors.

`attributes` stay on the grip, so keyboard reordering is untouched.

## Testing

**The desktop regression net.** Five tests in `board.spec.js` pin current
behaviour and must pass unchanged:

- `dragging the row body reorders the board`
- `the name is not a drag handle`
- `dragging by the grip still reorders`
- `clicking the name still opens the player, and reorders nothing`
- `keyboard reorder saves the new order`

They drive drags with `page.mouse.down/move`, which `MouseSensor` consumes.
**If one of them needs editing to pass, stop** — that means mouse behaviour
changed, which this design forbids.

**The bug, written down.** Two tests under `test.use({ hasTouch: true })` at a
phone viewport, driving genuine touch events over CDP — not synthetic pointer
events, which is the mistake that produced the first diagnosis:

- A long-press then drag reorders the row. **This fails today** — it is the
  bug.
- A swipe that starts on a row leaves the order unchanged and scrolls.
  **This passes today** and must keep passing: it is what stops the fix from
  buying touch dragging at the cost of touch scrolling.

Both are needed, and the asymmetry is the point. One proves reordering starts
working; the other proves scrolling did not stop.

## Out of scope

- Any visual change: no grip resizing, no "hold to reorder" hint, no new
  affordance. If the gesture proves undiscoverable in real use, that is a
  separate change with its own evidence.
- `touch-action: none` on rows. It would make `PointerSensor` work on touch
  and make the list unscrollable, which is a worse bug than the one being
  fixed.
- The draft page — 8.2 screens tall on a phone — which is the next project.
- Tuning the delay and tolerance. They are the platform-conventional values.
