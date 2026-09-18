import { useEffect } from "react";

/**
 * Keep Tab inside an overlay while it is open.
 *
 * `aria-modal="true"` is a promise that the rest of the page is inert, and
 * both dialogs in this app declared it while containing nothing. Measured with
 * real key presses before this existed:
 *
 *   control sheet  forward  escapes at press 3 -> the Big Board's search box,
 *                           its filter selects, then open-player and queue-add
 *                  backward escapes at press 2 -> open-controls, the strip,
 *                           the nav, <body>
 *   player modal   forward  escapes at press 3 -> <body>, the site nav
 *                  backward escapes at press 1 -> scroll-rosters,
 *                           scroll-draft-board, then queue-add / open-player
 *
 * The leaks are actionable, not merely disorienting: a keyboard user tabbing
 * out of either dialog can draft or queue a player through a backdrop they
 * cannot see past.
 *
 * TAKES THE OVERLAY, NOT THE DIALOG. The sheet's backdrop close button is a
 * SIBLING of its `role="dialog"` element, so trapping the dialog would make
 * that button unreachable by keyboard while a mouse can still click it. The
 * modal's dialog is NESTED INSIDE its backdrop, so there the two coincide.
 * Passing each component's outermost overlay element lets one hook serve both.
 *
 * DOES NOTHING BETWEEN KEY PRESSES, and that is load-bearing rather than
 * minimal. `draftphone.spec.js` pins that focus placed on the sheet's board
 * select is still there 1600ms later, and the sheet re-renders every second
 * from the countdown clock. An effect that re-asserted focus -- or a focusin
 * listener that pulled it back -- would break that test, and the test is
 * right: it exists because the sheet once stole focus back every second and
 * made its own headline control impossible to use.
 */

// `[tabindex]` catches the scroll containers Chromium makes focusable, and the
// panel itself (tabIndex={-1}); the negative ones are filtered out below so
// they never become a wrap target, while still being focusable programmatically.
const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]",
].join(",");

function focusableWithin(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("tabindex") === "-1") return false;
    // Rendered, not merely present. The sheet's five controls are each gated on
    // draft state, so a hidden one must never become the element Tab wraps to.
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });
}

export function useFocusTrap(overlayRef, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const overlay = overlayRef.current;
    if (!overlay) return undefined;

    const onKeyDown = (e) => {
      if (e.key !== "Tab") return;

      // Computed at press time, never captured on mount: the focusable set is
      // dynamic. Five conditionally-rendered controls in the sheet, and the
      // modal's season selector renders only when the player has more than one
      // season of game log.
      const items = focusableWithin(overlay);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const on = document.activeElement;

      // Both ends. Wrapping only the last element is the naive version and
      // would have left the backward leak -- the direction that fails after a
      // single press -- exactly as it was.
      if (e.shiftKey && (on === first || !overlay.contains(on))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (on === last || !overlay.contains(on))) {
        e.preventDefault();
        first.focus();
      }
      // Every other press falls through untouched: the browser moves focus
      // between the overlay's own controls, which is what it is for.
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [overlayRef, active]);
}
