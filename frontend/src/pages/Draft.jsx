import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";

function Pill({ children }) {
  return <span className="rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1 text-xs text-zinc-200">{children}</span>;
}

export default function Draft() {
  const { draftId } = useParams();
  const [draft, setDraft] = useState(null);
  const [players, setPlayers] = useState([]);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setErr("");
    try {
      const [d, p] = await Promise.all([apiGet(`/drafts/${draftId}`), apiGet(`/players`)]);
      setDraft(d);
      setPlayers(p.players || []);
    } catch (e) {
      setErr(e.message || "Failed to load");
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return players
      .filter((p) => !draft?.picked?.includes(p.id))
      .filter((p) => (pos ? p.position === pos : true))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true))
      .slice(0, 200);
  }, [players, draft, query, pos]);

  const currentPickLabel = draft
    ? `R${draft.currentRound} P${draft.currentPick} • Team ${draft.currentTeam}`
    : "";

  const makePick = async (playerId) => {
    setBusy(true);
    setErr("");
    try {
      await apiPost(`/drafts/${draftId}/pick`, { playerId });
      await load();
    } catch (e) {
      setErr(e.message || "Pick failed");
    } finally {
      setBusy(false);
    }
  };

  const autoPick = async () => {
    setBusy(true);
    setErr("");
    try {
      await apiPost(`/drafts/${draftId}/auto-pick`, {});
      await load();
    } catch (e) {
      setErr(e.message || "Auto-pick failed");
    } finally {
      setBusy(false);
    }
  };

  if (err) return <div className="p-6 text-red-200">{err}</div>;
  if (!draft) return <div className="p-6 text-zinc-300">Loading…</div>;

  return (
    <div className="mx-auto max-w-7xl p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Link to="/" className="text-zinc-300 hover:text-white">← Home</Link>
        <div className="flex flex-wrap gap-2 items-center justify-end">
          <button
            onClick={autoPick}
            disabled={busy || draft.completed}
            className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
          >
            Auto Pick
          </button>
          <Pill>Draft: {draftId}</Pill>
          <Pill>{currentPickLabel}</Pill>
          <Pill>{draft.teams} teams • {draft.rounds} rounds</Pill>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
        {/* Big Board */}
        <div className="rounded-3xl border border-zinc-900 bg-zinc-950 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Big Board</h2>
            <div className="text-xs text-zinc-400">Click a player to draft</div>
          </div>

          <div className="flex gap-2">
            <input
              className="w-full rounded-xl border border-zinc-800 bg-black px-3 py-2 text-sm text-zinc-200"
              placeholder="Search player…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="rounded-xl border border-zinc-800 bg-black px-3 py-2 text-sm text-zinc-200"
              value={pos}
              onChange={(e) => setPos(e.target.value)}
            >
              <option value="">All</option>
              <option value="QB">QB</option>
              <option value="RB">RB</option>
              <option value="WR">WR</option>
              <option value="TE">TE</option>
            </select>
          </div>

          <div className="max-h-[70vh] overflow-auto space-y-2 pr-1">
            {filtered.map((p) => (
              <button
                key={p.id}
                disabled={busy}
                onClick={() => makePick(p.id)}
                className="w-full text-left rounded-2xl border border-zinc-900 bg-black p-3 hover:border-zinc-700 disabled:opacity-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{p.rank}. {p.name}</div>
                  <div className="text-xs text-zinc-400">ADP {p.adp}</div>
                </div>
                <div className="mt-1 flex gap-2 text-xs text-zinc-300">
                  <Pill>{p.position}</Pill>
                  <Pill>{p.team}</Pill>
                  <Pill>Tier {p.tier}</Pill>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Draft Board */}
        <div className="rounded-3xl border border-zinc-900 bg-zinc-950 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Draft Board</h2>
            <div className="text-xs text-zinc-400">Snake draft • saved in DynamoDB</div>
          </div>

          <div className="overflow-auto rounded-2xl border border-zinc-900">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="bg-black">
                <tr className="text-left">
                  <th className="p-3 text-zinc-400">Pick</th>
                  <th className="p-3 text-zinc-400">Team</th>
                  <th className="p-3 text-zinc-400">Player</th>
                </tr>
              </thead>
              <tbody>
                {draft.picks.map((pk) => (
                  <tr key={pk.overall} className="border-t border-zinc-900">
                    <td className="p-3">#{pk.overall}</td>
                    <td className="p-3">Team {pk.team}</td>
                    <td className="p-3">
                      {pk.player ? (
                        <span className="text-zinc-200">{pk.player.name} <span className="text-zinc-500">({pk.player.position})</span></span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {draft.completed ? (
            <div className="rounded-2xl border border-emerald-900/50 bg-emerald-950/30 p-4 text-emerald-200 text-sm">
              Draft complete ✅
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}