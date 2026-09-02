import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { useRememberDraft } from "../lib/useRememberDraft";
import { analyzeDraft } from "../lib/draftAnalysis";

export default function Results() {
  const { draftId } = useParams();
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // Anything unrecognised -- including an absent parameter -- is the pick log,
  // so an old link with no ?view keeps behaving exactly as it did.
  const view = searchParams.get("view") === "analysis" ? "analysis" : "picks";

  useEffect(() => {
    apiGet(`/drafts/${draftId}`)
      .then(setDraft)
      .catch((e) => setErr(e.message || "Failed to load results"));
  }, [draftId]);

  usePageTitle(draftId ? `Results ${draftId}` : "Results");
  useRememberDraft(draft);

  if (err) return <div className="p-6 text-red-300">{err}</div>;
  if (!draft) return <div className="p-6 text-zinc-300">Loading results…</div>;

  // Build rosters
  const rosters = {};
  for (let t = 1; t <= draft.teams; t++) rosters[t] = [];
  for (const p of draft.picks) {
    if (p.player && rosters[p.team]) rosters[p.team].push(p);
  }

  const copyLink = async () => {
    try {
        await navigator.clipboard.writeText(window.location.href);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    } catch {
        // fallback
        prompt("Copy this link:", window.location.href);
    }
  };

  function download(filename, text, mime = "text/plain") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function picksToCsv(draft) {
    const rows = [
        ["overall", "round", "team", "playerName", "position", "nflTeam"].join(","),
        ...draft.picks.map((p) => {
        const name = p.player?.name || "";
        const pos = p.player?.position || "";
        const team = p.player?.team || "";
        const safe = (s) => `"${String(s).replace(/"/g, '""')}"`;
        return [p.overall, p.round, p.team, safe(name), safe(pos), safe(team)].join(",");
        }),
    ];
    return rows.join("\n");
  }

  return (
    <div className="py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Draft Results</h1>
          <p className="text-sm text-zinc-400">
            {draft.teams} teams • {draft.rounds} rounds • {draft.format.toUpperCase()}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={copyLink}
              className="rounded-xl border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500"
              >
              {copied ? "Copied ✅" : "Copy Share Link"}
            </button>
            <button
              onClick={() => download(`perfectpick_${draftId}.csv`, picksToCsv(draft), "text/csv")}
              className="rounded-xl border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500"
              >
              Export CSV
              </button>

              <button
              onClick={() => download(`perfectpick_${draftId}.json`, JSON.stringify(draft, null, 2), "application/json")}
              className="rounded-xl border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500"
              >
              Export JSON
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <Link
            to={`/draft/${draftId}`}
            className="rounded-xl border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500"
          >
            Back to Draft
          </Link>
          <Link
            to="/"
            className="rounded-xl border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500"
          >
            New Draft
          </Link>
        </div>
      </div>

      <div className="mb-4 flex gap-2">
        <button
          type="button"
          data-testid="view-tab-picks"
          onClick={() =>
            // Merge rather than replace: setSearchParams({}) would drop any
            // other parameter that happens to be on the URL.
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.delete("view");
              return next;
            })
          }
          className={`rounded-2xl border px-4 py-2 text-sm ${
            view === "picks"
              ? "border-cyan-300/60 bg-cyan-950/30 text-cyan-200"
              : "border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:border-zinc-600"
          }`}
        >
          Pick Log
        </button>
        <button
          type="button"
          data-testid="view-tab-analysis"
          onClick={() =>
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set("view", "analysis");
              return next;
            })
          }
          className={`rounded-2xl border px-4 py-2 text-sm ${
            view === "analysis"
              ? "border-cyan-300/60 bg-cyan-950/30 text-cyan-200"
              : "border-zinc-800 bg-zinc-950/70 text-zinc-400 hover:border-zinc-600"
          }`}
        >
          Analysis
        </button>
      </div>

      {/* Layout */}
      {view === "picks" && (
      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        {/* Pick Log */}
        <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-4">
          <h2 className="mb-3 text-lg font-semibold">Pick Log</h2>
          <div className="overflow-auto rounded-xl border border-zinc-900">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-black/70">
                <tr>
                  <th className="p-3 text-left text-zinc-400">Pick</th>
                  <th className="p-3 text-left text-zinc-400">Team</th>
                  <th className="p-3 text-left text-zinc-400">Player</th>
                </tr>
              </thead>
              <tbody>
                {draft.picks.map((p) => (
                  <tr key={p.overall} className="border-t border-zinc-900">
                    <td className="p-3">#{p.overall}</td>
                    <td className="p-3">Team {p.team}</td>
                    <td className="p-3">
                      {p.player ? (
                        <>
                          {p.player.name}{" "}
                          <span className="text-zinc-500">
                            ({p.player.position})
                          </span>
                        </>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Team Rosters */}
        <div className="space-y-4">
          {Object.entries(rosters).map(([team, picks]) => (
            <div
              key={team}
              className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-4"
            >
              <h3 className="mb-2 font-semibold">Team {team}</h3>
              {picks.length ? (
                <ul className="space-y-2 text-sm">
                  {picks.map((p) => (
                    <li
                      key={p.overall}
                      className="flex items-center justify-between"
                    >
                      <span className="text-zinc-400">#{p.overall}</span>
                      <span className="flex-1 mx-2 truncate">
                        {p.player.name}
                      </span>
                      <span className="text-zinc-500">
                        {p.player.position}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-zinc-500">No picks</div>
              )}
            </div>
          ))}
        </div>
      </div>
      )}

      {view === "analysis" && (() => {
        const a = analyzeDraft(draft);
        const fmt = (n) => (n > 0 ? `+${n}` : `${n}`);

        return (
          <div data-testid="analysis-panel" className="space-y-4">
            <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
              <div className="text-sm text-zinc-400">Team {a.you.team}</div>
              <div className="mt-1 text-3xl font-semibold">
                {fmt(a.you.valueCaptured)}
                <span className="ml-2 text-base font-normal text-zinc-400">
                  value captured
                </span>
              </div>
              <div className="mt-1 text-sm text-zinc-400">
                {a.you.rank} of {a.teams.length} in this draft. Positive means players
                fell to you; negative means you reached.
              </div>
              {a.scoreable.without > 0 && (
                <div data-testid="unscoreable-note" className="mt-2 text-xs text-zinc-500">
                  {a.scoreable.without} of {a.scoreable.with + a.scoreable.without} picks
                  had no ADP to compare against and are excluded.
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {a.you.bestPick && (
                <div data-testid="best-vs-adp" className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
                  <div className="text-sm text-zinc-400">Best vs ADP</div>
                  <div className="mt-1 font-medium">{a.you.bestPick.player.name}</div>
                  <div className="text-xs text-zinc-500">
                    pick {a.you.bestPick.overall} · {fmt(a.you.bestPick.delta)}
                  </div>
                </div>
              )}
              {a.you.biggestReach && (
                <div data-testid="worst-vs-adp" className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
                  <div className="text-sm text-zinc-400">Worst vs ADP</div>
                  <div className="mt-1 font-medium">{a.you.biggestReach.player.name}</div>
                  <div className="text-xs text-zinc-500">
                    pick {a.you.biggestReach.overall} · {fmt(a.you.biggestReach.delta)}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
              <div className="text-sm text-zinc-400">Roster shape</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {a.you.rosterShape.filled.map((s, i) => (
                  <span key={`f${i}`} className="rounded-full border border-cyan-300/40 px-2 py-0.5 text-[10px] text-cyan-200">
                    {s}
                  </span>
                ))}
                {a.you.rosterShape.unfilled.map((s, i) => (
                  <span key={`u${i}`} className="rounded-full border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-600">
                    {s}
                  </span>
                ))}
              </div>
              {a.you.rosterShape.unfilled.length > 0 && (
                <div className="mt-2 text-xs text-zinc-500">
                  Unfilled: {a.you.rosterShape.unfilled.join(", ")}
                </div>
              )}
            </div>

            {a.you.longestWait && (
              <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-5">
                <div className="text-sm text-zinc-400">Your longest wait</div>
                <div className="mt-1 text-sm">
                  {a.you.longestWait.span} picks between {a.you.longestWait.from} and{" "}
                  {a.you.longestWait.to}
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  Gone in that span:{" "}
                  {a.you.longestWait.playersGone.map((p) => p.name).join(", ") || "nobody"}
                </div>
              </div>
            )}

            <div className="text-xs text-zinc-600">
              This grades how the draft went, not how the team will do — the app has no
              projections or bye weeks.
            </div>
          </div>
        );
      })()}
    </div>
  );
}