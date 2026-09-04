import { useAuth } from "../lib/authContext.js";
import { gateState } from "../lib/gatedRoutes.js";
import Landing from "./Landing.jsx";
import Dashboard from "./Dashboard.jsx";

/**
 * One route, two pages: the pitch for a visitor, your work once you are in.
 * An unconfigured build has no session to read, so it gets the landing page.
 *
 * The loading branch is not politeness, it is the difference between a
 * returning user seeing their drafts and seeing a sales pitch for the app
 * they already use. AuthProvider resolves the stored session asynchronously,
 * so without it every visit paints Landing first and then flips -- which
 * reads as having been logged out, on the one page most likely to be a
 * bookmark. RequireAuth has a wait state for the same reason.
 */
export default function Home() {
  const { configured, signedIn, loading } = useAuth();

  // Asked through gateState rather than re-derived, so this page and
  // RequireAuth cannot drift apart on what "still deciding" means. That
  // helper is the unit-tested one.
  if (gateState({ configured, signedIn, loading }) === "wait") {
    return <div data-testid="home-wait" className="p-8 text-sm text-zinc-500">Loading…</div>;
  }
  return configured && signedIn ? <Dashboard /> : <Landing />;
}
