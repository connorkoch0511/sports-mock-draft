import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";

const PICK_SECONDS = 60;

function Pill({ children }) {
  return (
    <span className="rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1 text-xs text-zinc-200">
      {children}
    </span>
  );
}

export default function Draft() {
  const { draftId } = useParams();
  const [draft, setDraft] = useState(null);
  const [players, setPlayers] = useState([]);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Timer + pause
  const [paused, setPaused] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(PICK_SECONDS);
  const tickRef = useRef(null);

  const load = async () => {
    setErr("");
    try {
      const d = await apiGet(`/drafts/${draftId}`);
      const p = await apiGet(
        `/players?sport=${d.sport || "nfl"}&format=${encodeURIComponent(d.format || "standard")}`
      );
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

  usePageTitle(draft ? `Draft ${draftId}` : "Draft");

  const filtered = useMemo(() => {
    if (!draft) return [];
    const q = query.trim().toLowerCase();
    return players
      .filter((p) => !draft.picked?.includes(p.id))
      .filter((p) => (pos ? p.position === pos : true))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true))
      .slice(0, 200);
  }, [players, draft, query, pos]);

  const playersById = useMemo(() => {
    const m = new Map();
    for (const p of players) m.set(p.id, p);
    return m;
  }, [players]);

  const rosters = useMemo(() => {
    if (!draft) return {};
    const map = {};
    for (let t = 1; t <= (draft.teams || 0); t++) map[t] = [];

    for (const pk of draft.picks || []) {
      if (pk.player) {
        map[pk.team].push({ overall: pk.overall, round: pk.round, player: pk.player });
      }
    }
    return map;
  }, [draft]);

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

  const simToEnd = async () => {
    setBusy(true);
    setErr("");
    try {
      await apiPost(`/drafts/${draftId}/sim-to-end`, {});
      await load();
    } catch (e) {
      setErr(e.message || "Sim failed");
    } finally {
      setBusy(false);
    }
  };

  // ----- Timer + Autopick behavior -----

  // Reset timer on new pick / when it becomes Team 1's turn
  useEffect(() => {
    if (!draft) return;
    if (draft.completed) {
      setSecondsLeft(0);
      return;
    }
    // Only meaningful for Team 1
    if (draft.currentTeam === 1) setSecondsLeft(PICK_SECONDS);
  }, [draft?.draftId, draft?.currentIndex, draft?.currentTeam, draft?.completed]);

  // Autopick for teams 2..N immediately (while not paused)
  useEffect(() => {
    if (!draft) return;
    if (paused) return;
    if (busy) return;
    if (draft.completed) return;

    if (draft.currentTeam !== 1) {
      autoPick();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.currentTeam, draft?.currentIndex, draft?.completed, paused, busy]);

  // Run countdown only when Team 1 is on the clock
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);

    if (!draft) return;
    if (paused) return;
    if (busy) return;
    if (draft.completed) return;
    if (draft.currentTeam !== 1) return;

    tickRef.current = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [draft?.currentTeam, draft?.completed, paused, busy]);

  // If Team 1 runs out of time, autopick for Team 1
  useEffect(() => {
    if (!draft) return;
    if (paused) return;
    if (busy) return;
    if (draft.completed) return;

    if (draft.currentTeam === 1 && secondsLeft === 0) {
      autoPick();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, draft?.currentTeam, draft?.completed, paused, busy]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  if (err) return <div className="p-6 text-red-200">{err}</div>;
  if (!draft) return <div className="p-6 text-zinc-300">Loading…</div>;

  const canManualPick = !paused && !busy && !draft.completed && draft.currentTeam === 1;

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden">
      {/* Background (same feel as Home) */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1000px_500px_at_20%_10%,rgba(34,211,238,0.14),transparent_60%),radial-gradient(900px_500px_at_80%_20%,rgba(59,130,246,0.12),transparent_55%),radial-gradient(700px_500px_at_50%_85%,rgba(168,85,247,0.10),transparent_55%)]" />
        <div className="absolute inset-0 opacity-[0.10] [background-image:linear-gradient(to_right,rgba(255,255,255,0.10)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.10)_1px,transparent_1px)] [background-size:64px_64px]" />
      </div>

      {/* Content */}
      <div className="relative mx-auto max-w-7xl px-6 py-6 min-h-screen flex flex-col gap-4">
        {/* Top bar */}
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <Link to="/" className="text-zinc-300 hover:text-white">
                ← Home
              </Link>

              <div className="hidden sm:flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/60 px-3 py-1 text-xs text-zinc-300">
                <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_20px_rgba(34,211,238,0.5)]" />
                PerfectPick • Live Draft
              </div>
            </div>

            <div className="flex flex-wrap gap-2 items-center justify-start lg:justify-end">
              <button
                onClick={() => setPaused((p) => !p)}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600"
              >
                {paused ? "Resume" : "Pause"}
              </button>

              {draft.currentTeam === 1 && !draft.completed ? (
                <Pill>⏱ {secondsLeft}s</Pill>
              ) : draft.completed ? (
                <Pill>✅ Completed</Pill>
              ) : (
                <Pill>Auto-picking other teams…</Pill>
              )}

              <button
                onClick={autoPick}
                disabled={paused || busy || draft.completed}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
                title="Auto-pick the current team (Team 1 too)"
              >
                Auto Pick
              </button>

              <button
                onClick={simToEnd}
                disabled={paused || busy || draft.completed}
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
              >
                Sim to End
              </button>

              {draft.completed ? (
                <Link
                  to={`/draft/${draftId}/results`}
                  className="rounded-2xl bg-emerald-400 px-4 py-2 text-xs font-semibold text-black hover:bg-emerald-300"
                >
                  View Results →
                </Link>
              ) : null}

              <Pill>Draft: {draftId}</Pill>
              <Pill>{currentPickLabel}</Pill>
              <Pill>
                {draft.teams} teams • {draft.rounds} rounds
              </Pill>
            </div>
          </div>
        </div>

        {/* 3-column app layout */}
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-[420px_minmax(0,1fr)_360px] flex-1 min-h-0 min-w-0">
          {/* Big Board */}
          <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 space-y-3 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] min-h-0 min-w-0 flex flex-col">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Big Board</h2>
              <div className="text-xs text-zinc-400">
                {draft.completed
                  ? "Draft completed"
                  : paused
                  ? "Paused"
                  : draft.currentTeam === 1
                  ? "You are on the clock (Team 1)"
                  : "Auto-picking other teams"}
              </div>
            </div>

            <div className="flex gap-2">
              <input
                className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-cyan-300/60 focus:shadow-[0_0_0_4px_rgba(34,211,238,0.10)]"
                placeholder="Search player…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-sky-300/60 focus:shadow-[0_0_0_4px_rgba(59,130,246,0.10)]"
                value={pos}
                onChange={(e) => setPos(e.target.value)}
              >
                <option value="">All</option>
                <option value="QB">QB</option>
                <option value="RB">RB</option>
                <option value="WR">WR</option>
                <option value="TE">TE</option>
                <option value="K">K</option>
                <option value="DEF">DEF</option>
              </select>
            </div>

            <div className="flex-1 min-h-0 overflow-auto space-y-2 pr-1">
              {filtered.map((p) => (
                <button
                  key={p.id}
                  disabled={!canManualPick}
                  onClick={() => makePick(p.id)}
                  className="w-full text-left rounded-2xl border border-zinc-900 bg-black/60 p-3 hover:border-zinc-700 disabled:opacity-50"
                  title={
                    canManualPick
                      ? "Click to draft for Team 1"
                      : draft.completed
                      ? "Draft completed"
                      : paused
                      ? "Paused"
                      : "You can only draft when Team 1 is on the clock"
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">
                      {p.rank != null ? `${p.rank}. ` : ""}
                      {p.name}
                    </div>
                    <div className="text-xs text-zinc-400">{p.adp != null ? `ADP ${p.adp}` : "ADP —"}</div>
                  </div>
                  <div className="mt-1 flex gap-2 text-xs text-zinc-300 flex-wrap">
                    <Pill>{p.position}</Pill>
                    <Pill>{p.team}</Pill>
                    {p.tier != null ? <Pill>Tier {p.tier}</Pill> : null}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Draft Board */}
          <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] min-h-0 min-w-0 flex flex-col">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Draft Board</h2>
              <div className="text-xs text-zinc-400">Snake draft</div>
            </div>

            {/* Table (horizontal scroll only) */}
            <div className="flex-1 min-h-0 overflow-auto rounded-2xl border border-zinc-900">
              <table className="w-full text-sm min-w-[620px] md:min-w-[760px]">
                <thead className="bg-black/70 sticky top-0 z-10">
                  <tr className="text-left">
                    <th className="px-3 py-2 text-zinc-400 w-20">Pick</th>
                    <th className="px-3 py-2 text-zinc-400 w-28">Team</th>
                    <th className="px-3 py-2 text-zinc-400">Player</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.picks.map((pk, idx) => {
                    const isNow = idx === draft.currentIndex && !draft.completed;
                    const pl = pk.player || (pk.playerId ? playersById.get(pk.playerId) : null);

                    return (
                      <tr
                        key={pk.overall}
                        className={["border-t border-zinc-900", isNow ? "bg-cyan-300/10" : ""].join(" ")}
                      >
                        <td className="px-3 py-2 text-zinc-200 tabular-nums">#{pk.overall}</td>
                        <td className="px-3 py-2 text-zinc-200">T{pk.team}</td>
                        <td className="px-3 py-2 min-w-0">
                          {pl ? (
                            <span className="text-zinc-200 block truncate">
                              {pl.name} <span className="text-zinc-500">({pl.position})</span>
                            </span>
                          ) : isNow ? (
                            <span className="text-cyan-200">On the clock</span>
                          ) : pk.playerId ? (
                            <span className="text-zinc-500">{pk.playerId}</span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Team Rosters (sticky right rail) */}
          <div className="2xl:sticky 2xl:top-6 min-h-0 min-w-0 flex flex-col rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)] lg:col-span-2 2xl:col-span-1">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Team Rosters</h2>
              <div className="text-xs text-zinc-400">Live</div>
            </div>

            <div className="mt-3 flex-1 min-h-0 overflow-auto space-y-3 pr-1">
              {Array.from({ length: draft.teams }, (_, i) => i + 1).map((teamNum) => (
                <div key={teamNum} className="rounded-2xl border border-zinc-900 bg-black/60 p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">Team {teamNum}</div>
                    <div className="text-xs text-zinc-500">{rosters[teamNum]?.length || 0} picks</div>
                  </div>

                  <div className="mt-2 space-y-2">
                    {(rosters[teamNum] || []).length ? (
                      rosters[teamNum].map((r) => (
                        <div key={r.overall} className="text-sm text-zinc-200 flex items-center justify-between">
                          <span className="text-zinc-500">#{r.overall}</span>
                          <span className="mx-2 flex-1 truncate">{r.player.name}</span>
                          <span className="text-zinc-500">{r.player.position}</span>
                        </div>
                      ))
                    ) : (
                      <div className="text-sm text-zinc-600">No picks yet</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}