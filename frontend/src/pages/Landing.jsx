import { useAuth } from "../lib/authContext.js";
import { usePageTitle } from "../lib/usePageTitle";

function Step({ n, title, children }) {
  return (
    <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-6">
      <div className="font-mono text-xs text-cyan-300">{n}</div>
      <div className="mt-2 text-sm font-semibold text-white">{title}</div>
      <p className="mt-1 text-sm text-zinc-400">{children}</p>
    </div>
  );
}

export default function Landing() {
  const { signIn, configured } = useAuth();
  usePageTitle("PerfectPick");

  return (
    <div className="relative min-h-full w-full overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1000px_500px_at_20%_10%,rgba(34,211,238,0.18),transparent_60%),radial-gradient(900px_500px_at_80%_20%,rgba(59,130,246,0.16),transparent_55%)]" />
        <div className="absolute inset-0 opacity-[0.12] [background-image:linear-gradient(to_right,rgba(255,255,255,0.10)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.10)_1px,transparent_1px)] [background-size:64px_64px]" />
      </div>

      <div className="relative mx-auto max-w-5xl px-6 py-20">
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
          Draft off your board,
          <span className="block bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent">
            not theirs.
          </span>
        </h1>

        <p className="mt-6 max-w-xl text-lg text-zinc-300">
          Rank the players your way, then run your league's draft against your
          own board — with the reasons for every pick shown, not hidden.
        </p>

        {configured && (
          <button
            type="button"
            onClick={signIn}
            data-testid="landing-signin"
            className="mt-8 inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-cyan-300 to-sky-300 px-6 py-3 font-semibold text-black shadow-[0_10px_40px_rgba(34,211,238,0.20)]"
          >
            Sign in with Google
          </button>
        )}

        <div className="mt-16 grid gap-4 sm:grid-cols-3">
          <Step n="01" title="Build your board">
            Drag players into the order you actually believe in. Your board is
            yours, on every device you sign in from.
          </Step>
          <Step n="02" title="Draft off it">
            Import your Sleeper league or set it up by hand, then draft from
            your real pick slot against roster-aware auto-picks.
          </Step>
          <Step n="03" title="See where you disagree">
            Every recommendation shows its reasons — the open roster slot, last
            season's finish, the reach against ADP.
          </Step>
        </div>
      </div>
    </div>
  );
}
