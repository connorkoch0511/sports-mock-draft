# A header that stops offering what it cannot do

**Status:** approved design, not yet implemented
**Depends on:** nothing. Touches only the draft page's header row.

## Problem

The draft page header renders twelve things. On a **completed** draft, five of
them cannot do anything: Pause, the seat-board picker, Auto Pick, Sim to End
and the notify toggle. Two more are meaningless: "Copy invite link" (nobody
joins a finished draft) and "R15 P12 · Team" (there is no current pick).

The result wraps onto two rows and reads as noise. Worse, three of the dead
controls are *greyed but present*, which says "this exists, just not now" — a
promise that is true mid-draft and false forever once the last pick is in.

Independently, the "Draft: 5d0fa0eb-d06d-4cb2-b9be-70af31026abd" pill spends
thirty-six characters — most of a row — on an identifier nobody reads. The
same value is in the address bar, and sharing is already covered by "Copy
invite link".

This is the header that was fixed once for wrapping onto a third line
(`b31dbed`) and has since gained a board picker and a notify toggle. It is
running out of room, and the cheapest space is the space spent on things that
do nothing.

## Decisions

1. **Disabled where the state is temporary; absent where it is terminal.**
   This is the whole idea. A control greyed out because the draft is paused,
   or because it is not your turn, will become available again — greying it
   is honest. A control greyed out because the draft is *over* will never
   come back, and greying it wastes a row to say so. Those become absent.
2. **The draft id pill is removed outright**, on every draft, not just
   completed ones. It is in the URL, and "Copy invite link" is the sharing
   path.
3. **No overflow menu, no grouping, no redesign.** Deliberately out of scope:
   this removes what is dead and keeps everything else exactly where it is.

## What the header shows

**A completed draft** keeps four things:

- the status badge, reading "Completed"
- **View Results →**
- "Your Team: N"
- "12 teams · 15 rounds"

and drops: Pause/Resume, the seat-board select, Auto Pick, Sim to End, Copy
invite link, the notify toggle, and the current-pick indicator.

**A live draft** keeps everything it has today, minus the draft id pill. That
is the headroom that stops it wrapping on a narrower window.

## How

The controls already know about this state — `Draft.jsx` holds a `completed`
local, and Auto Pick, Sim to End and Pause each carry
`disabled={... || draft.completed}` today. The change is to render them
conditionally rather than disable them, and to drop `|| draft.completed` from
the `disabled` expressions that remain, since an unrendered control does not
need disabling.

The seven, by the handle a test would use for each:

| Control | Handle |
| --- | --- |
| Pause / Resume | button text `Pause`/`Resume` |
| Auto-pick board | `data-testid="seat-board"` |
| Auto Pick | button text `Auto Pick` |
| Sim to End | button text `Sim to End` |
| Copy invite link | `data-testid="copy-invite"` |
| Notify toggle | `data-testid="notify-toggle"` |
| Current pick | `data-testid="current-pick"` |

Two of these already have a second reason not to render: Sim to End is
hidden when a second human is seated, and the notify toggle when push is
unsupported. Add the completed condition alongside those, do not replace
them.

The status badge is the `✅ Completed` branch of the existing pill ternary
and stays exactly as it is; the other branches of that ternary (Paused, the
countdown, the waiting-on pills) are unreachable on a completed draft
already.

Do not introduce a new state variable or restructure the row. Every control
keeps its `data-testid`, its classes and its position among the others.

## A consequence worth noting

This resolves an item already on the accepted list: *"Pause stays clickable on
a finished draft — clicking it gets the backend's 409 and a generic banner."*
The fix turns out not to be better error handling but not offering the
button. Remove that entry when this ships.

The backend keeps its own guard. `POST /pause` still answers 409 on a
completed draft, and should: the API does not trust the page, and a stale tab
can still send the request.

## Testing

- `frontend/tests/boarddraft.spec.js` holds the header assertions from
  `b31dbed` — the row staying on one line, and the Big Board panel's height.
  Both must still pass.
- New: on a completed draft each of the seven dropped controls is absent —
  `toHaveCount(0)`, not "not visible", since the point is that they are not
  rendered.
- New: on a live draft each of them is still present, so the condition cannot
  be inverted without a test failing.
- The draft id pill is gone from both states.
- Check the existing specs that drive Pause, Auto Pick and Sim to End: any
  that act on a completed fixture will now find no control. If one does, that
  test was asserting the disabled-but-present behaviour this change removes —
  update it deliberately and say so, rather than reaching for the element a
  different way.
- Regenerate `screenshots/draft.png`, and any other screenshot showing this
  header.

## Out of scope

- Grouping rarely-used controls behind an overflow or menu. That is the real
  answer if the row runs out of space again, and it needs its own thought
  about what is primary during a draft.
- Anything outside the header row.
- The backend's own completed-draft guards, which stay exactly as they are.
