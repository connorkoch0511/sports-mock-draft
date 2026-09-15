import { useSyncExternalStore } from "react";

// Tailwind's xl breakpoint, as a query rather than a class, because the phone
// chrome must not merely be HIDDEN at desktop -- it must not be in the DOM. A
// display:none element still matches Playwright locators, so a strip that
// repeats the header's text ("✅ Completed", the countdown) turns every
// unscoped getByText in the existing suite into a strict-mode violation. CSS
// cannot express "do not exist", so this is the one piece of the phone layout
// that is decided in JS rather than by a max-xl: variant.
//
// xl, not lg: the tabbed layout covers everything below 1280 now. Three
// columns at 1024 gave the Big Board a 277px track and a THIRTY-SIX pixel
// search box -- narrower than two characters -- while the Draft Board's table
// sat 52% behind a horizontal scroll. Tabbed, that same panel measures 936px
// there. This is still two bands, not three: the boundary moved, none was
// added.
//
// Expressed in rem, matching Tailwind 4's own --breakpoint-xl: 80rem. A px
// query drifts from the classes the moment a user changes their browser's
// default font size: at Chrome's "Large" (20px) setting `xl` becomes 1600px
// while a 1280px hook still flips at 1280 -- and every width between renders
// with no header (max-xl:hidden still matching), no strip, no tab bar and one
// unreachable panel. Same unit, no drift, by construction.
const QUERY = "(width < 80rem)";

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
