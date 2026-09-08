import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiPost } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";

/**
 * Redeems an invite link, then opens the draft.
 *
 * Modelled on AuthCallback: a failure here must be visible, because a blank
 * screen after clicking a friend's link is indistinguishable from the app
 * being broken.
 */
export default function JoinDraft() {
  const nav = useNavigate();
  const { draftId } = useParams();
  const [params] = useSearchParams();
  const [err, setErr] = useState("");
  usePageTitle("Joining a draft");

  // Once per visit. StrictMode double-invokes effects in development, and
  // posting the token twice would ask for a second seat.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    apiPost(`/drafts/${draftId}/join`, { token: params.get("t") })
      .then(() => nav(`/draft/${draftId}`, { replace: true }))
      .catch((e) => setErr(e.message || "That invite link did not work"));
  }, [draftId, params, nav]);

  if (err) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div data-testid="join-error" className="rounded-2xl border border-rose-800/40 bg-rose-950/20 px-4 py-3 text-sm text-rose-200">
          {err}
        </div>
      </div>
    );
  }
  return <div className="mx-auto max-w-2xl p-6 text-sm text-zinc-400">Taking your seat…</div>;
}
