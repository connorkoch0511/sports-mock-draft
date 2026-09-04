import { useEffect } from "react";
import { useAuth } from "./authContext.js";
import { apiPost } from "./api.js";
import { listDrafts } from "./draftRegistry.js";
import { listBoards } from "./boardRegistry.js";
import { claimableIds, hasClaimed, markClaimed } from "./claim.js";

/**
 * The moment you sign in, the drafts and boards you made before you had an
 * account become yours.
 *
 * Once per account per browser: the marker is only written after the call
 * succeeds, so a failure retries on the next load rather than silently losing
 * the one chance to claim.
 */
export function useClaimOnSignIn() {
  const { signedIn, sub } = useAuth();

  useEffect(() => {
    if (!signedIn || !sub) return;
    if (hasClaimed(sub)) return;

    const { draftIds, boardIds } = claimableIds({
      drafts: listDrafts(),
      boards: listBoards(),
    });
    if (draftIds.length === 0 && boardIds.length === 0) {
      // Nothing to claim is a settled question, not a pending one.
      markClaimed(sub);
      return;
    }

    let cancelled = false;
    apiPost("/me/claim", { draftIds, boardIds })
      .then(() => {
        if (!cancelled) markClaimed(sub);
      })
      .catch(() => {
        // Left unmarked on purpose: the next load tries again. Nothing here is
        // worth interrupting the page for -- an unclaimed draft is still
        // readable, and the user did not ask for this.
      });

    return () => {
      cancelled = true;
    };
  }, [signedIn, sub]);
}
