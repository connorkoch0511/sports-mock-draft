import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { picksForSlot, largestGap } from "../lib/snake";

// Home carried this as state with a setter that was never called. It is a
// constant here rather than dead state; the request body is unchanged.
const DRAFT_YEAR = 2025;

export default function NewDraft() {
  const nav = useNavigate();
  const [teams, setTeams] = useState(12);
  const [rounds, setRounds] = useState(15);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [format, setFormat] = useState("standard");
  const [slot, setSlot] = useState(1);
  const [randomSlot, setRandomSlot] = useState(false);

  usePageTitle("New Draft");

  const safeSlot = Math.min(Math.max(1, slot), teams);
  const schedule = useMemo(
    () => picksForSlot(safeSlot, teams, rounds),
    [safeSlot, teams, rounds]
  );

  const createDraft = async () => {
    setLoading(true);
    setErr("");
    try {
      const userTeam = randomSlot
        ? Math.floor(Math.random() * teams) + 1
        : safeSlot;
      const draft = await apiPost("/drafts", {
        teams, rounds, sport: "nfl", format, year: DRAFT_YEAR, userTeam,
      });
      nav(`/draft/${draft.draftId}`);
    } catch (e) {
      setErr(e.message || "Failed to create draft");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">New mock draft</h1>
        <p className="text-sm text-zinc-400">
          Set your league up, pick your slot, and draft.
        </p>
      </div>

      <div className="max-w-2xl space-y-6">
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

          <label className="space-y-1 sm:col-span-2">
            <div className="flex items-center justify-between text-sm text-zinc-300">
              <span>Your draft slot</span>
              <button
                type="button"
                onClick={() => setRandomSlot((v) => !v)}
                data-testid="random-slot"
                className={`rounded-full border px-3 py-0.5 text-xs ${
                  randomSlot
                    ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-200"
                    : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
                }`}
              >
                Random
              </button>
            </div>
            <select
              data-testid="slot-select"
              disabled={randomSlot}
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none focus:border-cyan-300/60 disabled:opacity-40"
              value={safeSlot}
              onChange={(e) => setSlot(Number(e.target.value))}
            >
              {Array.from({ length: teams }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>Slot {n} of {teams}</option>
              ))}
            </select>
            {!randomSlot && (
              <div data-testid="pick-schedule" className="text-xs text-zinc-500">
                Your picks: {schedule.slice(0, 8).join(", ")}
                {schedule.length > 8 ? ", …" : ""}
                {schedule.length > 1 && ` · ${largestGap(schedule)}-pick longest wait`}
              </div>
            )}
          </label>
        </div>

        <label className="space-y-1 block">
          <div className="text-sm text-zinc-300">ADP Format</div>
          <select
            className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="standard">Standard</option>
            <option value="half-ppr">Half PPR</option>
            <option value="ppr">PPR</option>
          </select>
        </label>

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
    </div>
  );
}
