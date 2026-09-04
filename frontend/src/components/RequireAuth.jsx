import { useAuth } from "../lib/authContext.js";
import { gateState } from "../lib/gatedRoutes.js";

/**
 * Renders the prompt in place rather than redirecting, so the URL survives.
 * signIn already carries a returnTo, so the visitor lands where they meant to.
 */
export default function RequireAuth({ children }) {
  const { configured, signedIn, loading, signIn } = useAuth();
  const state = gateState({ configured, signedIn, loading });

  if (state === "allow") return children;
  if (state === "wait") {
    return <div className="p-8 text-sm text-zinc-500">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-md py-20 text-center" data-testid="auth-gate">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to continue</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Your drafts and boards are tied to your account, so they follow you to
        any device — and nobody else can open them.
      </p>
      <button
        type="button"
        onClick={signIn}
        data-testid="auth-gate-signin"
        className="mt-6 rounded-2xl bg-gradient-to-r from-cyan-300 to-sky-300 px-5 py-3 font-semibold text-black"
      >
        Sign in with Google
      </button>
    </div>
  );
}
