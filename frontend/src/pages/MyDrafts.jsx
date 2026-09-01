import { useState } from "react";
import { Link } from "react-router-dom";
import { usePageTitle } from "../lib/usePageTitle";
import { listDrafts, forgetDraft } from "../lib/draftRegistry";
import { listBoards } from "../lib/boardRegistry";

const FORMAT_LABEL = {
  standard: "Standard",
  "half-ppr": "Half PPR",
  ppr: "PPR",
};

function relativeTime(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function MyDrafts() {
  const [drafts, setDrafts] = useState(() => listDrafts());
  const boards = listBoards();

  usePageTitle("My Drafts");

  const forget = (id) => {
    forgetDraft(id);
    setDrafts(listDrafts());
  };

  return (
    <div className="py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">My drafts</h1>
        <p className="text-sm text-zinc-400">
          Drafts you have started or opened on this device.
        </p>
      </div>

      {drafts.length === 0 ? (
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-8 text-center text-sm text-zinc-500">
          No drafts yet. Start one and it will show up here.
        </div>
      ) : (
        <ul className="space-y-1" data-testid="my-drafts-list">
          {drafts.map((d) => {
            // The registry stores boardId; names live in the board registry,
            // so a board that is not yours resolves to a generic label rather
            // than a stale name or a raw id.
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
                    {boardName ? ` · off ${boardName}` : ""} · {relativeTime(d.updatedAt)}
                  </div>
                </Link>
                <button
                  type="button"
                  onClick={() => forget(d.id)}
                  data-testid="forget-draft"
                  aria-label={`Forget draft ${d.id}`}
                  title="Removes it from this list only. The draft still exists and its link still works."
                  className="rounded-2xl border border-zinc-800 px-3 py-3 text-xs text-zinc-500 hover:border-rose-900/60 hover:text-rose-300"
                >
                  Forget
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
