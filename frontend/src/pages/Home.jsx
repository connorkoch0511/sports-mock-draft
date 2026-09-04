import { useAuth } from "../lib/authContext.js";
import Landing from "./Landing.jsx";
import Dashboard from "./Dashboard.jsx";

/**
 * One route, two pages: the pitch for a visitor, your work once you are in.
 * An unconfigured build has no session to read, so it gets the landing page.
 */
export default function Home() {
  const { configured, signedIn } = useAuth();
  return configured && signedIn ? <Dashboard /> : <Landing />;
}
