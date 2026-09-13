# Scrolling your big board must not re-rank it

**Status:** approved design, not yet implemented
**Scope:** one file, `frontend/src/pages/Board.jsx`. Nothing else imports dnd-kit.

## The bug

On a touchscreen, swiping to scroll the big board reorders it — and the new
order saves.

Measured on 13 September at 390×844 with touch emulation: a finger swipe
starting on row 3 moved CeeDee Lamb from 3rd to 1st. The drop runs
`setRows(moved)` and a debounced PUT, so the change is not a visual glitch —
it persists to the server. Every attempt to scroll the list silently
re-ranks the board, and the user's own rankings are the one thing in this app
they cannot get back from a feed.

The cause is the sensor:

```js
useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
```

Four pixels of movement starts a drag. On a mouse that is right — four pixels
is a deliberate gesture, and a mouse scrolls with a wheel. On a finger, four
pixels of movement *is* a scroll, and there is no other way to scroll. The
same constraint that makes dragging feel responsive with a mouse makes
scrolling impossible with a thumb.

This is the app's desktop assumption in its sharpest form. The draft page
merely assumes a large screen; this assumes a pointing device that scrolls
by other means.

## What must not be broken

The whole row is the drag target deliberately. `Board.jsx` says why:

> The grip alone used to be the only draggable target, and it is a dim
> six-dot glyph that is easy to miss entirely.

That was a real fix for mouse users, and a dim six-dot glyph is a *worse*
target for a thumb than for a cursor, not better. So the answer is not to
retreat to grip-only dragging on touch. Whatever we do keeps the whole row
draggable on both inputs.

## The fix

Replace the one pointer sensor with two input-specific ones:

```js
useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
```

dnd-kit selects the sensor by input type, so **mouse behaviour is unchanged**:
the same four-pixel threshold on the same whole-row target.

On touch, the two constraints divide the gesture:

- A finger that **moves more than 5px before 250ms** never activates the
  drag. The browser scrolls, as it always did.
- A finger that **stays still for 250ms** activates. The row lifts and
  follows the thumb.

That is the reorder idiom iOS and Android already teach, so the gesture
needs no explanation on screen.

## The sharp edge

The player's name is the one part of the row that is not a drag handle. It
is implemented as:

```jsx
onPointerDown={(e) => e.stopPropagation()}
```

This works **only because `PointerSensor` listens for `pointerdown`.**
`MouseSensor` listens for `mousedown` and `TouchSensor` for `touchstart`, so
after the swap this guard stops nothing: pressing a player's name would begin
a drag instead of opening them.

The guard has to follow the sensors — stopping propagation on `mousedown` and
`touchstart` as well. Two existing tests cover this, so it would be caught,
but it is the reason this change is not a one-line edit.

`attributes` stay on the grip, so keyboard reordering is untouched.

## Testing

**The desktop regression net.** Five tests in `board.spec.js` already pin the
current behaviour and must pass unchanged:

- `dragging the row body reorders the board`
- `the name is not a drag handle`
- `dragging by the grip still reorders`
- `clicking the name still opens the player, and reorders nothing`
- `keyboard reorder saves the new order`

They drive drags with `page.mouse.down/move`, which `MouseSensor` consumes,
so no test edit should be needed. **If one of them needs editing to pass,
stop** — that means mouse behaviour changed, which this design forbids.

**The bug, written down.** Two new tests under `test.use({ hasTouch: true })`
at a phone viewport:

- A swipe that starts on a row leaves the order unchanged. *This fails
  today* — it is the bug, and watching it fail first is what proves it is
  testing the right thing.
- A long-press followed by a drag reorders. Without this, a fix that simply
  disabled touch dragging altogether would pass the first test.

Both are needed: one proves scrolling works, the other proves reordering
still does.

## Out of scope

- Any visual change: no grip resizing, no "hold to reorder" hint, no new
  affordance. If the gesture proves undiscoverable in real use, that is a
  separate change with its own evidence.
- The draft page. It is the larger half of "it assumes a desktop" — 8.2
  screens tall on a phone — and it is the next project, not this one.
- The delay and tolerance values are the platform-conventional ones. Tuning
  them is a follow-up if real use argues for it, not a thing to fiddle with
  now.
