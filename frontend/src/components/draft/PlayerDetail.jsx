import { useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { ReasonList, SCORED_NOTHING, NOT_EVALUATED, ADVICE_BASIS } from "./ReasonList";
import { columnsFor, statValue, statOrNull, snapShare, withByeGaps, gapLabel } from "./gameLog";
import { computeKpis } from "./playerKpis";
import { StartingPoint } from "./StartingPoint";
import { WeeklyChart } from "./WeeklyChart";
import { POINTS_FIELD } from "./playerKpis";

const SEASON_WEEKS = 18;

// Summary carries everything the drill-down used to show before the log:
// the KPI row, the draft numbers, the advice card, and (Task 5) its charts.
// Game Log carries only the table and the season selector -- the one piece
// of the page that legitimately grows past a single screen.
const TABS = [
  { id: "summary", label: "Summary", testid: "tab-summary" },
  { id: "gamelog", label: "Game Log", testid: "tab-gamelog" },
];

function Stat({ label, value, testId }) {
  return (
    <div data-testid={testId} className="rounded-xl border border-zinc-900 bg-black/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-sm text-zinc-200 tabular-nums">{value}</div>
    </div>
  );
}

/**
 * Everything known about one player, with no shell around it.
 *
 * Shared by the dialog opened from a draft or a board and by the standalone
 * /player/:id page, so the two can never drift into showing different things
 * about the same player. `trailing` is whatever the shell wants in the top
 * right -- a close button in the dialog, nothing on the page.
 *
 * `player` is the caller's copy, rendered immediately so the panel opens with
 * a name in it. The fetch then fills in the game log, which the pool endpoint
 * deliberately does not carry.
 */
export function PlayerDetail({
  player,
  format,
  reasons,
  startingPoint,
  onBoard,
  playersWereEvaluated,
  headingId = "player-detail-name",
  trailing = null,
}) {
  const [detail, setDetail] = useState(null);
  const [failed, setFailed] = useState(false);
  const [activeTab, setActiveTab] = useState("summary");
  // A viewer's own pick, once made. Stays `null` until then so `defaultSeason`
  // (derived below, fresh every render) keeps winning instead of being
  // clobbered by a stale initial value computed before the fetch resolved.
  const [seasonOverride, setSeasonOverride] = useState(null);

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
  const cols = columnsFor(p.position);
  const kpis = computeKpis(detail, format);

  // An em dash is a claim -- "we know, and there is none" -- and before the
  // fetch lands we do not know. `computeKpis` cannot tell the two apart: it is
  // handed `detail` and returns null both for "not fetched" and "fetched, no
  // stats", which is right for a pure function and wrong for a row of numbers
  // somebody is reading. So the distinction is drawn here, from the same
  // condition the game log's own "Loading…" already uses below.
  //
  // This is the rule gameLog.js states twice for itself -- statOrNull exists
  // because a zero is a mark claiming he scored nothing, and snapShare returns
  // null because "played no snaps" and "we do not know" are different facts.
  // The KPI row sits one layer above those and now honours it too.
  const loading = !detail && !failed;
  // Not an em dash, and not a spinner: three spinners in adjacent boxes are
  // noise for a fetch this short, and both they and a wider glyph would move
  // the row's geometry while it settles.
  const NOT_YET = "·";
  const kpi = (value) => (loading ? NOT_YET : value);

  // Every season this player has a log for, newest first.
  const seasons = Object.keys(detail?.gameLogs ?? {}).sort((a, b) => b - a);
  // The current calendar season, deliberately -- it is what Yahoo and
  // Sleeper do, and it was chosen knowing that during draft season it opens
  // on a nearly empty year. The fallback is not a second guess at the rule:
  // a season with no games at all is not a useful default, and the selector
  // still offers it.
  const current = String(new Date().getFullYear());
  const defaultSeason = seasons.includes(current) ? current : seasons[0];
  // A user's own pick overrides the default. It lives in state rather than
  // being reset here so that switching to Summary and back to Game Log
  // keeps whatever year they had open. Task 5's charts, added to Summary,
  // read this same `season`.
  const season = seasonOverride ?? defaultSeason;

  const log = detail?.gameLogs?.[season] || [];
  // Only as far as the season actually got. Rendering all 18 weeks mid-season
  // would label unplayed weeks "did not play", which accuses the player of
  // missing games nobody has played. Falls back to the full season for a log
  // synced before this was recorded.
  const through = detail?.gameLogThrough?.[season] ?? SEASON_WEEKS;
  const weeks = withByeGaps(log, through);
  const playedWeeks = log.length;

  // Rendered through a portal to <body>, NOT in place.
  //
  // Both callers sit inside a panel carrying `backdrop-blur`, and a
  // backdrop-filter ancestor becomes the containing block for its fixed
  // descendants. Rendered in place, this "full-screen" overlay measured
  // 418x518 at (57,177) inside the Big Board column instead of covering the
  // 1280x720 viewport -- a dialog trapped in the left third of the page.
  return (
    <>
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 id={headingId} className="text-xl font-semibold text-zinc-100">
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
      {trailing}
    </div>

    {/*
      Two destinations, not two actions -- Summary is what a visitor sees
      first, and Game Log is where the one section that can genuinely run
      long lives. Modeled on TabBar's grid-of-buttons pattern rather than a
      role="tab"/role="tablist" pair, to match how the rest of the app marks
      the active one (aria-current, not aria-selected).
    */}
    {/*
      Above the tabs, not inside Summary: this is the glanceable answer and it
      stays true whichever tab you are reading. Yahoo and Sleeper both pin
      their equivalent row above their tab bars for the same reason -- you
      should not have to leave the game log to remember what he averages.

      Production, not draft position. ADP, rank and tier are right for a
      first-rounder and an em dash for most of the pool; what a player
      actually did is a fact for everyone with a game log, including a
      fourth-string tight end who never scores.
    */}
    {/*
      The season these three describe. They come from `stats`, whose year the
      coverage rule picks and flips mid-autumn -- which is the very "you
      cannot tell which year you are reading" problem this redesign set out to
      fix, and it would have been reintroduced one row higher.
    */}
    {p.statsSeason ? (
      <div data-testid="kpi-season" className="mt-3 text-[11px] text-zinc-500">
        Season totals — {p.statsSeason}
      </div>
    ) : null}
    <div data-testid="player-kpis" className="mt-1 grid grid-cols-3 gap-2">
      <Stat
        label="FPTS/GAME"
        testId="kpi-fpts"
        value={kpi(kpis.fptsPerGame != null ? kpis.fptsPerGame.toFixed(1) : "—")}
      />
      <Stat label="POS RANK" testId="kpi-posrank" value={kpi(kpis.posRank ?? "—")} />
      <Stat
        label="SNAP SHARE"
        testId="kpi-snapshare"
        value={kpi(kpis.snapShare != null ? `${Math.round(kpis.snapShare * 100)}%` : "—")}
      />
    </div>

    <div
      data-testid="player-tabs"
      aria-label="Player detail views"
      className="mt-4 grid grid-cols-2 gap-1 rounded-2xl border border-zinc-900 bg-black/40 p-1"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          data-testid={t.testid}
          aria-current={activeTab === t.id ? "page" : undefined}
          onClick={() => setActiveTab(t.id)}
          className={`rounded-xl px-2 py-1.5 text-xs font-medium transition-colors ${
            activeTab === t.id
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>

    {activeTab === "summary" ? (
      <>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <Stat label="ADP" value={p.adp ?? "—"} />
          <Stat label="Rank" value={p.rank ?? "—"} />
          <Stat label="Tier" value={p.tier ?? "—"} />
        </div>

        {reasons !== undefined ? (
          <div className="mt-4 rounded-2xl border border-cyan-900/50 bg-cyan-950/20 px-3 py-2 space-y-2">
            <div className="text-xs font-medium text-cyan-100">Why {p.name} is here</div>
            <StartingPoint startingPoint={startingPoint} onBoard={onBoard} />
            <ReasonList
              reasons={reasons}
              emptyText={playersWereEvaluated ? SCORED_NOTHING : NOT_EVALUATED}
            />
            <p className="text-[11px] leading-snug text-zinc-500">{ADVICE_BASIS}</p>
          </div>
        ) : null}

        {/*
          Two charts, neither of which predicts anything -- see WeeklyChart's
          own comment. `log` (this season's played weeks only) feeds both, so
          a week with no row here draws no mark on either chart; a bye or an
          injury is blank space, not a zero. `through` gives both charts the
          season's real length so a three-game rookie's marks sit bunched at
          the start of the axis instead of stretched across weeks that have
          not happened.
        */}
        {playedWeeks > 0 ? (
          <div className="mt-4 space-y-3">
            <div className="rounded-2xl border border-zinc-900 bg-black/40 px-3 py-2">
              <WeeklyChart
                testId="weekly-points-chart"
                label={`Weekly points — ${season}`}
                kind="bars"
                rows={log}
                weeks={through}
                // The league's own scoring, matching the KPI row above. The
                // bars were hard-coded to PPR, so a standard league read
                // "FPTS/GAME 9.0" above weeks averaging 15 -- two scoring
                // systems, unlabelled, an inch apart.
                valueOf={(row) => statOrNull(row, POINTS_FIELD[format] ?? "pts_ppr")}
              />
            </div>
            <div className="rounded-2xl border border-zinc-900 bg-black/40 px-3 py-2">
              <WeeklyChart
                testId="snap-share-chart"
                label={`Snap share — ${season}`}
                kind="line"
                rows={log}
                weeks={through}
                valueOf={snapShare}
                // 0-100, fixed: auto-scaling drew a 16% ceiling and a 96%
                // ceiling as the same line at the top of the box.
                domainMax={100}
              />
            </div>
          </div>
        ) : null}
      </>
    ) : (
      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-200">Game Log</h3>
            {seasons.length > 0 ? (
              <select
                data-testid="season-select"
                aria-label="Season"
                value={season}
                onChange={(e) => setSeasonOverride(e.target.value)}
                className="rounded-lg border border-zinc-800 bg-black/40 px-1.5 py-0.5 text-[11px] text-zinc-300"
              >
                {seasons.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            ) : null}
          </div>
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
            {/*
              A rookie and a veteran who missed the year both have an empty
              log, and they are not the same fact. "Did not play" of a rookie
              claims he was available and sat.
            */}
            {p.yearsExp === 0
              ? "No game log — a rookie with no NFL season yet."
              : "No game log — he did not play a game this season."}
          </p>
        ) : (
          // Never abridged: every week from 1 through `through` renders, gaps
          // included -- collapsing them into a "show more" would hide exactly
          // the multi-week absence a drafter most needs to see.
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
                {weeks.map(({ wk, played, row }, i) => {
                  if (!played) {
                    return (
                      <tr key={wk} data-testid="game-log-gap" data-week={wk} className="border-t border-zinc-900 text-zinc-700">
                        <td className="px-2 py-1.5 tabular-nums">{gapLabel(weeks[i])}</td>
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
    )}
    </>
  );
}
