# Plan: the focus trap both dialogs promise

Spec: `docs/superpowers/specs/2026-09-18-dialog-focus-trap-design.md`
Branch: `fix/sheet-focus-trap`

One new hook, two components that consume it, four new tests in two existing
specs. No backend, no routes, no screenshots — the change is invisible to a
mouse and only a keyboard can see it.

**Every new test must be seen to fail before its fix exists, and fail for the
predicted reason.** On the previous branch four tests were green while the page
was wrong, and one of them was written specifically to catch a defect I had
already photographed. A green-on-first-run test here is treated as broken.

---

## Task 1 — the failing tests, all four, before any hook

Two in `draftphone.spec.js` (sheet, phone viewport) and two in
`drilldown.spec.js` (modal, desktop viewport), because that is where each
dialog's existing tests already live and each file has the setup.

**Assert containment after every press, not a press count.** A test that says
"three presses stays inside" passes against a trap that leaks on the fourth.
Each test presses more times than the dialog has focusable elements — 10 is
comfortably more for both — and requires `document.activeElement` to be inside
the overlay after *each* one.

    forward:  press Tab 10 times, focus inside the overlay every time
    backward: press Shift+Tab 10 times, same

**Predicted reds**, from the measurements in the spec:

    sheet  forward  -> escapes on press 3, into the Big Board search input
    sheet  backward -> escapes on press 1, onto close-controls then the strip
    modal  forward  -> escapes on press 3, to <body> then the site nav
    modal  backward -> escapes on press 1, onto the panels' scroll containers

Anything else — a test erroring, a dialog not open, focus starting outside —
means the test is measuring the wrong thing and gets fixed before the hook is
written.

**Pause the draft first in every one of these.** The countdown re-renders the
page every second, and a ten-press walk would churn underneath it. Both
existing specs already do this.

---

## Task 2 — the hook

`frontend/src/lib/useFocusTrap.js`, taking a ref to the **overlay** element
(not the dialog — see the spec: the sheet's backdrop button is a sibling of the
dialog, the modal's dialog is nested inside its backdrop, and passing the
outermost element makes one hook serve both).

    useFocusTrap(overlayRef, active)

On a `keydown` where `e.key === "Tab"`:

1. Collect focusable descendants of the overlay **at that moment** — the set is
   dynamic: five conditionally-rendered controls in the sheet, and the modal's
   season selector renders only when `seasons.length > 0`.
2. If the set is empty, do nothing.
3. `Shift+Tab` on the first element → `preventDefault`, focus the last.
   `Tab` on the last → `preventDefault`, focus the first.
4. Every other press: do nothing at all, and let the browser move focus.

**Between presses the hook must do nothing.** No effect that re-asserts focus,
no interval, no focusin listener that pulls focus back. `draftphone.spec.js:422`
focuses `seat-board` and requires it still focused 1600ms later; the sheet
re-renders every second. An effect-based trap breaks that test, and the test is
right.

The focusable selector: `a[href]`, `button`, `input`, `select`, `textarea`,
`[tabindex]` — excluding `:disabled` and `[tabindex="-1"]`, then filtered to
those actually rendered (an `offsetParent` or client-rect check), since the
sheet's controls are gated on draft state and a hidden control must not be a
wrap target.

**Then wire it into both components**, passing the overlay ref and `open` /
always-true respectively (the modal only mounts when open).

---

## Task 3 — verify, including what must not move

1. All four new tests green.
2. **The three existing focus tests still green, untouched:**
   `draftphone.spec.js:402` (sheet takes focus, Escape closes),
   `draftphone.spec.js:422` (focus stays put for 1600ms),
   `drilldown.spec.js:115` (Escape closes, focus returns to the row).
   If the trap breaks any of them, the trap is wrong.
3. Full `draftphone.spec.js` and `drilldown.spec.js`.
4. **Mutation checks, separately, because the two ends are separate bugs:**
   - Delete the forward wrap → the two forward tests go red, the two backward
     tests stay green.
   - Delete the backward wrap → the two backward tests go red, forward green.
   If deleting one turns all four red, the tests are not measuring the ends
   independently and they get rewritten.
5. **Render it and drive a keyboard by hand** at 390x844 and 1280x720 — the
   measurements that opened this work came from a browser, and the numbers in
   the spec were wrong twice when I inferred them from source.

---

## Task 4 — full gates

    cd frontend && npm run lint
    cd frontend && npm run test:unit
    cd frontend && caffeinate -i npx playwright test
    cd backend/src && npm test

Check the Playwright total against `npx playwright test --list`: baseline 359
plus the four added here = 363. A run reporting fewer, or taking far longer than
~10 minutes, spanned a sleep and is lying.

---

## Out of scope

The tab bar's `role="tablist"` question and the panels' focusable scroll
containers. Both are on the accepted list; neither is a lie the markup tells.
