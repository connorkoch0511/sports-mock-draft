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

  // This whole effect must run at most once per visit, not merely its first
  // line. StrictMode double-invokes effects in development, and two separate
  // things here are single-use: takeStoredState() removes what it reads, so a
  // second read would refuse a valid callback; and a Yahoo authorisation code
  // can be redeemed exactly once, so a second exchange fails and surfaces an
  // error on top of an import that already succeeded. Guarding only the read
  // fixed the first and left the second, which is worse -- it is invisible
  // until someone tests against real Yahoo, and this project's own Playwright
  // suite runs against the dev server, so it exercises the doubled path on
  // every run without asserting anything about it.
  const ranRef = useRef(false);

  useEffect(() => {
    // Runs at most once per visit, and deliberately has NO cleanup that
    // cancels the work it started.
    //
    // Two things here are single-use. takeStoredState() removes what it
    // reads, so a second read refuses a valid callback. And a Yahoo
    // authorisation code can be redeemed exactly once, so a second exchange
    // fails and shows an error on top of an import that already succeeded.
    //
    // The obvious shape -- a ref guard plus an `alive` flag cleared on
    // cleanup -- is worse than either problem, and was tried: StrictMode runs
    // the effect, tears it down, and runs it again, so the first pass starts
    // the work, its own cleanup cancels it, and the second pass returns early
    // on the ref. Nothing happens at all. Letting the started work finish is
    // right here: the only state it sets afterwards is an error message, and
    // setting that on a component StrictMode is pretending to unmount is
    // harmless.
    if (ranRef.current) return;
    ranRef.current = true;

    const expected = takeStoredState();
    const code = params.get("code");
    const returned = params.get("state");

    if (params.get("error")) {
      // Declining is a choice, not a failure. Straight back, nothing said.
      nav("/draft/new", { replace: true });
      return;
    }

    if (!code || !returned || !expected || returned !== expected) {
      // Compared before the code is sent anywhere: a crafted callback must
      // not reach our API at all, or it could import an attacker's leagues
      // into this person's session.
      //
      // Deferred a tick for react-hooks/set-state-in-effect, which objects to
      // a synchronous setState cascading a render inside the same commit.
      Promise.resolve().then(() =>
        setErr("That Yahoo sign-in could not be verified. Please try again.")
      );
      return;
    }

    apiPost("/yahoo/leagues", { code })
      .then((data) =>
        nav("/draft/new", { replace: true, state: { yahooLeagues: data.leagues || [] } })
      )
      .catch((e) => setErr(e.message || "Could not reach Yahoo just now"));
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
