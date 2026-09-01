import { useEffect } from "react";
import { rememberDraft } from "./draftRegistry";

/**
 * Records a fetched draft in the local registry.
 *
 * Keyed on the draft id and its completed flag, and nothing else: the draft
 * page re-renders on every pick, so keying on the draft object would write to
 * localStorage once per pick during a sim-to-end.
 *
 * Safe to call before the fetch resolves — a null or id-less draft is ignored.
 */
export function useRememberDraft(draft) {
  const id = draft?.draftId;
  const completed = Boolean(draft?.completed);

  useEffect(() => {
    if (!id) return;
    rememberDraft({
      id,
      teams: draft.teams,
      rounds: draft.rounds,
      format: draft.format,
      userTeam: draft.userTeam,
      boardId: draft.boardId ?? null,
      completed,
    });
    // Deliberately keyed on id and completed only — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, completed]);
}
