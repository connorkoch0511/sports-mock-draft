import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiPost } from "../lib/api";
import { takeStoredState } from "../lib/yahoo";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * Completes the return from Yahoo.
 *
 * Modelled on AuthCallback: a failure here must be visible, because a blank
 * screen after signing in is indistinguishable from the app being broken.
 */
export default function YahooCallback() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [err, setErr] = useState("");
  usePageTitle("Importing from Yahoo");

  // takeStoredState() removes what it reads, so it must run at most once per
  // visit to this route. StrictMode double-invokes effects in development;
  // without this ref the first invocation would consume the real state and
  // the second (the one that survives) would see it already gone, refusing
  // a perfectly valid callback.
  const expectedRef = useRef(undefined);

  useEffect(() => {
    let alive = true;
    if (expectedRef.current === undefined) {
      expectedRef.current = takeStoredState();
    }
    const expected = expectedRef.current;
    const code = params.get("code");
    const returned = params.get("state");

    // Branches (not early returns) so the cleanup below always gets
    // registered -- an early return here would skip it, leaving `alive`
    // stuck true if the deferred setError below fires after unmount.
    if (params.get("error")) {
      // Declining is a choice, not a failure. Straight back, nothing said.
      nav("/draft/new", { replace: true });
    } else if (!code || !returned || !expected || returned !== expected) {
      // Compared before the code is sent anywhere: a crafted callback must
      // not reach our API at all, or it could import an attacker's leagues
      // into this person's session.
      //
      // setErr is deferred a tick (react-hooks/set-state-in-effect):
      // calling it synchronously in the effect body forces a cascading
      // render in the same commit, which the API-failure branch below never
      // triggers because it is already inside a .then/.catch.
      Promise.resolve().then(() => {
        if (alive) setErr("That Yahoo sign-in could not be verified. Please try again.");
      });
    } else {
      apiPost("/yahoo/leagues", { code })
        .then((data) => {
          if (!alive) return;
          nav("/draft/new", { replace: true, state: { yahooLeagues: data.leagues || [] } });
        })
        .catch((e) => {
          if (alive) setErr(e.message || "Could not reach Yahoo just now");
        });
    }

    return () => { alive = false; };
  }, [params, nav]);

  if (err) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div data-testid="yahoo-error" className="rounded-2xl border border-rose-800/40 bg-rose-950/20 px-4 py-3 text-sm text-rose-200">
          {err}
        </div>
      </div>
    );
  }

  return <div className="mx-auto max-w-2xl p-6 text-sm text-zinc-400">Importing your Yahoo leagues…</div>;
}
