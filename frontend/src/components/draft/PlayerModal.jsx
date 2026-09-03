import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { PlayerDetail } from "./PlayerDetail";

/**
 * The drill-down as a dialog, opened from a Big Board row or a board row.
 *
 * Only the shell lives here — focus, Escape, the backdrop and the portal. The
 * content is PlayerDetail, shared with the /player/:id page so the two cannot
 * drift into showing different things about the same player.
 *
 * It reads; it never drafts. The only control that drafts anybody is the
 * row's own Draft button.
 */
export function PlayerModal({
  player,
  format,
  reasons,
  startingPoint,
  onBoard,
  playersWereEvaluated,
  onClose,
}) {
  const closeRef = useRef(null);

  // Focus moves into the dialog on open and back to whatever opened it on
  // close. Without the restore, closing drops focus to the top of the page and
  // a keyboard user loses their place in a 25-row list.
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Rendered through a portal to <body>, NOT in place.
  //
  // Both callers sit inside a panel carrying `backdrop-blur`, and a
  // backdrop-filter ancestor becomes the containing block for its fixed
  // descendants. Rendered in place, this "full-screen" overlay measured
  // 418x518 at (57,177) inside the Big Board column instead of covering the
  // 1280x720 viewport -- a dialog trapped in the left third of the page.
  return createPortal(
    <div
      data-testid="player-modal-backdrop"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-testid="player-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="player-modal-name"
        className="my-8 w-full max-w-2xl rounded-3xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
      >
        <PlayerDetail
          player={player}
          format={format}
          reasons={reasons}
          startingPoint={startingPoint}
          onBoard={onBoard}
          playersWereEvaluated={playersWereEvaluated}
          headingId="player-modal-name"
          trailing={
            <button
              ref={closeRef}
              type="button"
              data-testid="player-modal-close"
              aria-label="Close"
              onClick={onClose}
              className="rounded-full border border-zinc-800 px-3 py-1 text-sm text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
            >
              ✕
            </button>
          }
        />
      </div>
    </div>,
    document.body
  );
}
