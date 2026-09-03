import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getUserManager } from "../lib/auth";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * Completes the redirect from Cognito and sends the user back where they
 * started.
 *
 * A failure here shows what went wrong. An auth error the user cannot see is
 * one they cannot report and cannot work around, and a blank screen after
 * clicking "Sign in" is indistinguishable from the app being broken.
 */
export default function AuthCallback() {
  const nav = useNavigate();
  const [err, setErr] = useState("");
  usePageTitle("Signing in");

  // Whether auth is configured is fixed at build time, so it is derived here
  // rather than set from an effect -- an effect would render the spinner
  // first and correct it a frame later.
  const manager = getUserManager();
  const problem = manager ? err : "Sign-in is not configured for this build.";

  useEffect(() => {
    if (!manager) return;

    let cancelled = false;
    manager
      .signinCallback()
      .then((u) => {
        if (cancelled) return;
        const back = u?.state?.returnTo;
        // replace: the callback URL carries a one-time code, so leaving it in
        // history means Back lands on a URL that can no longer be redeemed.
        nav(typeof back === "string" && back.startsWith("/") ? back : "/", {
          replace: true,
        });
      })
      .catch((e) => {
        if (!cancelled) setErr(e?.message || "Sign-in failed.");
      });

    return () => {
      cancelled = true;
    };
  }, [nav, manager]);

  if (problem) {
    return (
      <div className="mx-auto max-w-md px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-zinc-100">Sign-in failed</h1>
        <p data-testid="auth-error" className="mt-2 text-sm text-rose-300">
          {problem}
        </p>
        <Link to="/" className="mt-4 inline-block text-sm text-cyan-300 hover:text-cyan-200">
          ← Back to PerfectPick
        </Link>
      </div>
    );
  }

  return (
    <div data-testid="auth-callback" className="px-6 py-12 text-center text-sm text-zinc-400">
      Signing you in…
    </div>
  );
}
