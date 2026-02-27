import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";

export default function Results() {
  const { draftId } = useParams();
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    apiGet(`/drafts/${draftId}`)
      .then(setDraft)
      .catch((e) => setErr(e.message || "Failed to load results"));
  }, [draftId]);

  usePageTitle(draftId ? `Results ${draftId}` : "Results");

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

      {/* Layout */}
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
    </div>
  );
}