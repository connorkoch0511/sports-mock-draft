import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePageTitle } from "../lib/usePageTitle";
import { fetchMyDrafts, fetchMyBoards } from "../lib/me";
import { apiDelete } from "../lib/api";

const FORMAT_LABEL = {
  standard: "Standard",
  "half-ppr": "Half PPR",
  ppr: "PPR",
};

function describe(d) {
  // Format+teams alone collides constantly -- 12-team PPR is the default,
  // so two unrelated drafts both read "PPR, 12 teams". Rounds and pick
  // narrow it further, and the relative time makes even two drafts with
  // identical settings distinguishable, since they were not created at
  // the exact same millisecond. This string backs both the aria-label and
  // the delete confirmation, so it is the only thing standing between a
  // careful user and deleting the wrong one.
  return `${FORMAT_LABEL[d.format] || d.format}, ${d.teams} teams, ${d.rounds} rounds, pick ${d.userTeam}, created ${relativeTime(d.createdAt)}`;
}

function relativeTime(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function MyDrafts() {
  const [drafts, setDrafts] = useState(null);
  const [boards, setBoards] = useState([]);
  const [err, setErr] = useState("");

  usePageTitle("My Drafts");

  // Two independent requests, not Promise.all -- boards are only used to
  // resolve a name onto a draft row, so a failed boards fetch should not
  // block the drafts list (or, worse, leave drafts stuck at null forever
  // while an error banner is shown for something the boards fetch caused).
  const load = useCallback(() => {
    fetchMyDrafts()
      .then(setDrafts)
      .catch((e) => setErr(e.message || "Could not load your drafts"));
    fetchMyBoards()
      .then(setBoards)
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  // Server first, then local: on failure the row stays listed so the user can
  // retry rather than losing their way back to a draft that still exists.
  //
  // DELETE is no longer idempotent: it is a conditional delete on ownerId, so
  // "already gone" and "not yours" both answer 404. The catch re-reads from
  // the server rather than trusting a local list -- there is no local list
  // anymore for that row to be a dead entry in.
  const remove = async (d) => {
    if (!window.confirm(`Delete this ${describe(d)} draft? This cannot be undone, and anyone you shared it with will lose access.`)) {
      return;
    }
    setErr("");
    try {
      await apiDelete(`/drafts/${d.id}`);
      load();
    } catch (e) {
      if (e.status === 404) { load(); return; }
      setErr(e.message || "Failed to delete draft");
    }
  };

  return (
    <div className="py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">My drafts</h1>
        <p className="text-sm text-zinc-400">
          Drafts you have started or opened on this device.
        </p>
      </div>

      {err && (
        <div data-testid="my-drafts-error" className="mb-4 rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-200">
          {err}
        </div>
      )}

      {drafts === null ? (
        // Not shown once an error lands -- the banner above already explains
        // why there is nothing, so "Loading…" underneath it would be a lie.
        !err && <div className="text-sm text-zinc-500">Loading…</div>
      ) : drafts.length === 0 ? (
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-8 text-center text-sm text-zinc-500">
          No drafts yet. Start one and it will show up here.
        </div>
      ) : (
        <ul className="space-y-1" data-testid="my-drafts-list">
          {drafts.map((d) => {
            // The board name isn't on the draft row, so a board that is not
            // (or no longer) yours resolves to a generic label rather than a
            // stale name or a raw id.
            const boardName = d.boardId
              ? boards.find((b) => b.id === d.boardId)?.name || "a custom board"
              : null;

            return (
              <li key={d.id} className="flex items-center gap-2" data-testid="draft-row">
                <Link
                  to={d.completed ? `/draft/${d.id}/results` : `/draft/${d.id}`}
                  className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-left text-sm text-zinc-200 hover:border-zinc-600"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {FORMAT_LABEL[d.format] || d.format} · {d.teams} teams · {d.rounds} rounds
                    </span>
                    <span
                      className={
                        d.completed
                          ? "rounded-full border border-emerald-900/60 px-2 py-0.5 text-xs text-emerald-300"
                          : "rounded-full border border-cyan-900/60 px-2 py-0.5 text-xs text-cyan-300"
                      }
                    >
                      {d.completed ? "Completed" : "In progress"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    Pick {d.userTeam}
                    {boardName ? ` · off ${boardName}` : ""} · {relativeTime(d.createdAt)}
                  </div>
                </Link>
                {d.completed && (
                  <Link
                    to={`/draft/${d.id}/results?view=analysis`}
                    data-testid="analysis-link"
                    aria-label={`Analysis of ${describe(d)} draft`}
                    className="rounded-2xl border border-zinc-800 px-3 py-3 text-xs text-zinc-400 hover:border-cyan-300/40 hover:text-cyan-200"
                  >
                    Analysis
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => remove(d)}
                  data-testid="delete-draft"
                  aria-label={`Delete ${describe(d)} draft`}
                  title="Deletes the draft for everyone. Anyone you shared it with will lose access."
                  className="rounded-2xl border border-zinc-800 px-3 py-3 text-xs text-zinc-500 hover:border-rose-900/60 hover:text-rose-300"
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
