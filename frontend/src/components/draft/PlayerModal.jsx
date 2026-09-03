import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiGet } from "../../lib/api";
import { ReasonList, SCORED_NOTHING, NOT_EVALUATED, ADVICE_BASIS } from "./ReasonList";
import { columnsFor, statValue, snapShare, withByeGaps } from "./gameLog";

const SEASON_WEEKS = 18;

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-zinc-900 bg-black/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-sm text-zinc-200 tabular-nums">{value}</div>
    </div>
  );
}

/**
 * Everything known about one player.
 *
 * Opened from a Big Board row or a board row. It reads; it never drafts —
 * the only control that drafts anybody is the row's own Draft button.
 *
 * `player` is the row's copy, shown immediately so the dialog opens with a
 * name in it rather than a spinner. The fetch then fills in the game log,
 * which the pool endpoint deliberately does not carry.
 */
export function PlayerModal({ player, format, reasons, playersWereEvaluated, onClose }) {
  const [detail, setDetail] = useState(null);
  const [failed, setFailed] = useState(false);
  const dialogRef = useRef(null);
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

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const d = await apiGet(
          `/players/${encodeURIComponent(player.id)}?format=${encodeURIComponent(format)}`
        );
        if (!cancelled) setDetail(d.player || null);
      } catch {
        // The row already carries name, position, team, ADP and rank, so a
        // failed fetch costs the game log and nothing else. Saying so beats an
        // empty table that looks like a player who never played.
        if (!cancelled) setFailed(true);
      }
    })();

    return () => { cancelled = true; };
  }, [player.id, format]);

  const p = detail || player;
  const log = detail?.gameLog || [];
  const cols = columnsFor(p.position);
  // Only as far as the season actually got. Rendering all 18 weeks mid-season
  // would label unplayed weeks "did not play", which accuses the player of
  // missing games nobody has played. Falls back to the full season for a log
  // synced before this was recorded.
  const through = detail?.gameLogThrough ?? SEASON_WEEKS;
  const weeks = withByeGaps(log, through);
  const playedWeeks = log.length;

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
        ref={dialogRef}
        data-testid="player-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="player-modal-name"
        className="my-8 w-full max-w-2xl rounded-3xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="player-modal-name" className="text-xl font-semibold text-zinc-100">
              {p.name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              <span>{p.position} · {p.team}</span>
              {p.injuryStatus ? (
                <span
                  data-testid="player-modal-injury"
                  className="rounded-full border border-rose-900/60 bg-rose-950/40 px-2 py-0.5 text-rose-300"
                >
                  {p.injuryStatus}{p.injuryBodyPart ? ` · ${p.injuryBodyPart}` : ""}
                </span>
              ) : null}
              {p.depthChartOrder != null ? (
                <span className="rounded-full border border-zinc-800 px-2 py-0.5">
                  Depth {p.depthChartOrder}
                </span>
              ) : null}
            </div>
          </div>
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
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <Stat label="ADP" value={p.adp ?? "—"} />
          <Stat label="Rank" value={p.rank ?? "—"} />
          <Stat label="Tier" value={p.tier ?? "—"} />
        </div>

        {reasons !== undefined ? (
          <div className="mt-4 rounded-2xl border border-cyan-900/50 bg-cyan-950/20 px-3 py-2 space-y-2">
            <div className="text-xs font-medium text-cyan-100">Why {p.name} is here</div>
            <ReasonList
              reasons={reasons}
              emptyText={playersWereEvaluated ? SCORED_NOTHING : NOT_EVALUATED}
            />
            <p className="text-[11px] leading-snug text-zinc-500">{ADVICE_BASIS}</p>
          </div>
        ) : null}

        <div className="mt-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-zinc-200">
              Game log{detail?.gameLogSeason ? ` · ${detail.gameLogSeason}` : ""}
            </h3>
            {playedWeeks > 0 ? (
              <span className="text-[11px] text-zinc-500">{playedWeeks} games</span>
            ) : null}
          </div>

          {!detail && !failed ? (
            <p data-testid="player-modal-loading" className="mt-2 text-xs text-zinc-500">
              Loading…
            </p>
          ) : failed ? (
            <p data-testid="player-modal-log-error" className="mt-2 text-xs text-amber-300">
              The game log could not be loaded.
            </p>
          ) : playedWeeks === 0 ? (
            <p data-testid="player-modal-no-log" className="mt-2 text-xs text-zinc-500">
              No game log for this player — he has not played a game this season.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto rounded-2xl border border-zinc-900">
              <table data-testid="player-modal-log" className="w-full text-xs">
                <thead className="bg-black/70">
                  <tr className="text-left">
                    <th className="px-2 py-1.5 text-zinc-400">WK</th>
                    {cols.map((c) => (
                      <th key={c.key} className="px-2 py-1.5 text-right text-zinc-400">{c.label}</th>
                    ))}
                    <th className="px-2 py-1.5 text-right text-zinc-400">SNP</th>
                    <th className="px-2 py-1.5 text-right text-zinc-400">PTS</th>
                  </tr>
                </thead>
                <tbody>
                  {weeks.map(({ wk, played, row }) => {
                    if (!played) {
                      return (
                        <tr key={wk} data-testid="game-log-gap" data-week={wk} className="border-t border-zinc-900 text-zinc-700">
                          <td className="px-2 py-1.5 tabular-nums">{wk}</td>
                          <td className="px-2 py-1.5 text-zinc-600" colSpan={cols.length + 2}>
                            did not play
                          </td>
                        </tr>
                      );
                    }
                    const share = snapShare(row);
                    return (
                      <tr key={wk} data-testid="game-log-week" data-week={wk} className="border-t border-zinc-900">
                        <td className="px-2 py-1.5 text-zinc-300 tabular-nums">{wk}</td>
                        {cols.map((c) => (
                          <td key={c.key} className="px-2 py-1.5 text-right text-zinc-300 tabular-nums">
                            {statValue(row, c.key)}
                          </td>
                        ))}
                        <td className="px-2 py-1.5 text-right text-zinc-400 tabular-nums">
                          {share == null ? "—" : `${share}%`}
                        </td>
                        <td className="px-2 py-1.5 text-right text-zinc-100 tabular-nums">
                          {statValue(row, "pts_ppr").toFixed(1)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
