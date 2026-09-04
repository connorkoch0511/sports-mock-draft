import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchMyDrafts, fetchMyBoards } from "../lib/me";
import { usePageTitle } from "../lib/usePageTitle";

const FORMAT_LABEL = { standard: "Standard", "half-ppr": "Half PPR", ppr: "PPR" };

export default function Dashboard() {
  const [drafts, setDrafts] = useState(null);
  const [boards, setBoards] = useState(null);
  const [err, setErr] = useState("");
  usePageTitle("Home");

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchMyDrafts(), fetchMyBoards()])
      .then(([d, b]) => {
        if (cancelled) return;
        setDrafts(d);
        setBoards(b);
      })
      .catch((e) => {
        if (!cancelled) setErr(e.message || "Could not load your drafts");
      });
    return () => { cancelled = true; };
  }, []);

  const inProgress = (drafts || []).filter((d) => !d.completed);

  return (
    <div className="py-10">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Your drafts</h1>
        <Link
          to="/draft/new"
          data-testid="dashboard-new-draft"
          className="rounded-2xl bg-gradient-to-r from-cyan-300 to-sky-300 px-4 py-2 font-semibold text-black"
        >
          + New draft
        </Link>
      </div>

      {err && <div data-testid="dashboard-error" className="mb-4 text-sm text-rose-300">{err}</div>}

      {drafts === null && !err ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : inProgress.length === 0 ? (
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-8 text-center text-sm text-zinc-500">
          Nothing in progress. Start a draft and pick up where you leave off.
        </div>
      ) : (
        <ul className="space-y-1" data-testid="dashboard-drafts">
          {inProgress.slice(0, 5).map((d) => (
            <li key={d.id}>
              <Link
                to={`/draft/${d.id}`}
                className="block rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-zinc-200 hover:border-zinc-600"
              >
                {FORMAT_LABEL[d.format] || d.format} · {d.teams} teams · {d.rounds} rounds
                <span className="ml-2 text-xs text-zinc-500">Pick {d.userTeam}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-10 mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Your boards</h2>
        <Link to="/boards" className="text-sm text-cyan-300">All boards</Link>
      </div>

      {boards && boards.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2" data-testid="dashboard-boards">
          {boards.slice(0, 4).map((b) => (
            <li key={b.id}>
              <Link
                to={`/board/${b.id}`}
                className="block rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-sm text-zinc-200 hover:border-zinc-600"
              >
                {b.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-6 text-center text-sm text-zinc-500">
          No boards yet. <Link to="/boards" className="text-cyan-300">Build one</Link> and draft off it.
        </div>
      )}
    </div>
  );
}
