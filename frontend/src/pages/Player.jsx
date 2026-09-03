import { Link, useParams, useSearchParams } from "react-router-dom";
import { PlayerDetail } from "../components/draft/PlayerDetail";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * One player, at a URL you can send someone.
 *
 * The same PlayerDetail the draft dialog renders, in a page shell instead of a
 * dialog. No advice here: the engine's reasons are about a decision at a
 * particular pick in a particular draft, and this page has neither, so showing
 * them would be attaching a recommendation to a question nobody asked.
 */
export default function Player() {
  const { playerId } = useParams();
  const [params] = useSearchParams();
  const format = (params.get("format") || "standard").toLowerCase();

  usePageTitle("Player");

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <Link
        to="/"
        className="mb-4 inline-block text-xs text-zinc-400 hover:text-zinc-200"
      >
        ← PerfectPick
      </Link>

      <div
        data-testid="player-page"
        className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-5"
      >
        <PlayerDetail
          // The row's copy is not available here -- the page may be opened
          // cold from a link -- so the id is all we start with and everything
          // else arrives with the fetch.
          player={{ id: playerId }}
          format={format}
          headingId="player-page-name"
        />
      </div>
    </div>
  );
}
