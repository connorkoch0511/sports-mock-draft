import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../lib/api";

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
    <div className="mx-auto max-w-3xl p-6 space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold">Mist Mock Draft</h1>
        <p className="text-zinc-400">
          PFF-style mock draft simulator: big board, draft board, and saved sessions (AWS serverless).
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <div className="text-sm text-zinc-300">Teams</div>
          <input
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-2 text-zinc-200"
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
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-2 text-zinc-200"
            type="number"
            min={1}
            max={30}
            value={rounds}
            onChange={(e) => setRounds(Number(e.target.value))}
          />
        </label>
      </div>

      {err ? <div className="rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-red-200 text-sm">{err}</div> : null}

      <button
        onClick={createDraft}
        disabled={loading}
        className="rounded-xl bg-white px-4 py-2 font-medium text-black disabled:opacity-50"
      >
        {loading ? "Creating…" : "Start Mock Draft"}
      </button>

      <div className="text-xs text-zinc-500">
        Next: add sport selector + import ADP later (we’ll start with a built-in demo player list).
      </div>
    </div>
  );
}