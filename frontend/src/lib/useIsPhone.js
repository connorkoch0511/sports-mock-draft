import { useSyncExternalStore } from "react";

// Tailwind's lg breakpoint, as a query rather than a class, because the phone
// chrome must not merely be HIDDEN at desktop -- it must not be in the DOM. A
// display:none element still matches Playwright locators, so a strip that
// repeats the header's text ("✅ Completed", the countdown) turns every
// unscoped getByText in the existing suite into a strict-mode violation. CSS
// cannot express "do not exist", so this is the one piece of the phone layout
// that is decided in JS rather than by a max-lg: variant.
// Expressed in rem, matching Tailwind 4's own --breakpoint-lg: 64rem. A px
// query drifts from the classes the moment a user changes their browser's
// default font size: at Chrome's "Large" (20px) setting `lg` becomes 1280px
// while a 1024px hook still flips at 1024 -- and every width between renders
// with no header (max-lg:hidden still matching), no strip, no tab bar and one
// unreachable panel. Same unit, no drift, by construction.
const QUERY = "(width < 64rem)";

const mql = () => window.matchMedia(QUERY);

function subscribe(callback) {
  const m = mql();
  m.addEventListener("change", callback);
  return () => m.removeEventListener("change", callback);
}

export function useIsPhone() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
