import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * A finished draft, shown to someone who may have no account at all.
 *
 * This is the app's only anonymous read. It calls /drafts/:id/shared, which
 * returns five fields and nothing caller-derived -- deliberately NOT
 * /drafts/:id, whose projection carries inviteToken and would let a reader
 * join the draft.
 *
 * Every failure looks the same on purpose: a wrong token, a revoked token and
 * a draft that never existed all arrive here as a 404, because distinguishing
 * them would tell a stranger which draft ids are real.
 */
export default function SharedResults() {
  const { draftId } = useParams();
  const [params] = useSearchParams();
  const token = params.get("t") || "";
  const [draft, setDraft] = useState(null);
  const [missing, setMissing] = useState(false);
  usePageTitle("Draft results");

  useEffect(() => {
    let live = true;
    apiGet(`/drafts/${draftId}/shared?t=${encodeURIComponent(token)}`)
      .then((d) => live && setDraft(d))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [draftId, token]);

  if (missing) {
    return (
      <div data-testid="shared-missing" className="mx-auto max-w-lg p-8 text-center">
        <h1 className="text-xl font-semibold">This link is not available</h1>
        <p className="mt-2 text-sm text-zinc-400">
          It may have been turned off by whoever shared it, or it may never have
          existed.
        </p>
      </div>
    );
  }

  if (!draft) return <div className="p-8 text-sm text-zinc-400">Loading…</div>;

  const made = (draft.picks || []).filter((p) => p.player);

  return (
    <div data-testid="shared-results" className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">Draft results</h1>
      <p className="mt-1 text-sm text-zinc-400">
        {draft.teams} teams · {draft.rounds} rounds · {draft.format}
      </p>
      <ol className="mt-6 space-y-2">
        {made.map((p) => (
          <li
            key={p.overall}
            className="flex items-baseline gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/60 px-3 py-2"
          >
            <span className="w-14 shrink-0 tabular-nums text-xs text-zinc-500">
              {p.round}.{String(p.overall).padStart(2, "0")}
            </span>
            <span className="w-16 shrink-0 text-xs text-zinc-500">Team {p.team}</span>
            <span className="font-medium">{p.player.name}</span>
            <span className="text-xs text-zinc-400">
              {p.player.position}
              {p.player.team ? ` · ${p.player.team}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
