import { useSyncExternalStore } from "react";

// Tailwind's lg breakpoint, as a query rather than a class, because the phone
// chrome must not merely be HIDDEN at desktop -- it must not be in the DOM. A
// display:none element still matches Playwright locators, so a strip that
// repeats the header's text ("✅ Completed", the countdown) turns every
// unscoped getByText in the existing suite into a strict-mode violation. CSS
// cannot express "do not exist", so this is the one piece of the phone layout
// that is decided in JS rather than by a max-lg: variant.
const QUERY = "(max-width: 1023.98px)";

function subscribe(callback) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

export function useIsPhone() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
