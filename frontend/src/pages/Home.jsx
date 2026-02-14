import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../lib/api";

function Card({ title, desc }) {
  return (
    <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur">
      <div className="text-sm font-semibold text-white">{title}</div>
      <div className="mt-1 text-sm text-zinc-400">{desc}</div>
    </div>
  );
}

export default function Home() {
  const nav = useNavigate();
  const [teams, setTeams] = useState(12);
  const [rounds, setRounds] = useState(15);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const createDraft = async () => {
    setLoading(true);
    setErr("");
    try {
      const draft = await apiPost("/drafts", { teams, rounds });
      nav(`/draft/${draft.draftId}`);
    } catch (e) {
      setErr(e.message || "Failed to create draft");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-[calc(100vh)] w-full overflow-hidden">
      {/* Background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1000px_500px_at_20%_10%,rgba(34,211,238,0.18),transparent_60%),radial-gradient(900px_500px_at_80%_20%,rgba(59,130,246,0.16),transparent_55%),radial-gradient(700px_500px_at_50%_85%,rgba(168,85,247,0.10),transparent_55%)]" />
        <div className="absolute inset-0 opacity-[0.12] [background-image:linear-gradient(to_right,rgba(255,255,255,0.10)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.10)_1px,transparent_1px)] [background-size:64px_64px]" />
      </div>

      {/* Content */}
      <div className="relative mx-auto max-w-7xl px-6 py-12">
        <div className="grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
          {/* Hero */}
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/60 px-3 py-1 text-xs text-zinc-300 backdrop-blur">
              <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_20px_rgba(34,211,238,0.6)]" />
              PerfectPick • Mock Draft Simulator
            </div>

            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              Draft smarter.
              <span className="block bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent">
                Build the perfect board.
              </span>
            </h1>

            <p className="max-w-2xl text-zinc-300">
              PerfectPick is a modern mock draft simulator with a live Big Board, snake draft engine,
              smart auto-picks, and serverless persistence.
            </p>

            {/* Controls */}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <div className="text-sm text-zinc-300">Teams</div>
                <input
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none ring-0 focus:border-cyan-300/60 focus:shadow-[0_0_0_4px_rgba(34,211,238,0.10)]"
                  type="number"
                  min={2}
                  max={32}
                  value={teams}
                  onChange={(e) => setTeams(Number(e.target.value))}
                />
              </label>

              <label className="space-y-1">
                <div className="text-sm text-zinc-300">Rounds</div>
                <input
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none ring-0 focus:border-sky-300/60 focus:shadow-[0_0_0_4px_rgba(59,130,246,0.10)]"
                  type="number"
                  min={1}
                  max={30}
                  value={rounds}
                  onChange={(e) => setRounds(Number(e.target.value))}
                />
              </label>
            </div>

            {err ? (
              <div className="rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-red-200 text-sm">
                {err}
              </div>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                onClick={createDraft}
                disabled={loading}
                className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-cyan-300 to-sky-300 px-5 py-3 font-semibold text-black shadow-[0_10px_40px_rgba(34,211,238,0.20)] disabled:opacity-50"
              >
                {loading ? "Creating…" : "Start Mock Draft"}
              </button>

              <div className="text-xs text-zinc-400">
                Tip: Once inside the draft, use <span className="text-zinc-200">Auto Pick</span> to simulate quickly.
              </div>
            </div>
          </div>

          {/* Feature cards */}
          <div className="space-y-4">
            <Card
              title="Big Board + Search"
              desc="Filter by position, search names, and draft directly from the board."
            />
            <Card
              title="Snake Draft Engine"
              desc="Round-by-round snake ordering with picks persisted to DynamoDB."
            />
            <Card
              title="Smart Auto Picks"
              desc="Roster-aware auto picks using position needs, rank, and tier weighting."
            />
          </div>
        </div>
      </div>
    </div>
  );
}