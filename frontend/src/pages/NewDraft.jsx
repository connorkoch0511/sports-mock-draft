import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";
import { picksForSlot, largestGap } from "../lib/snake";
import { listBoards } from "../lib/boardRegistry";
import {
  fetchUser,
  fetchLeagues,
  fetchLeagueDraft,
  toDraftConfig,
} from "../lib/sleeper";

// Home carried this as state with a setter that was never called. It is a
// constant here rather than dead state; the request body is unchanged.
const DRAFT_YEAR = 2025;

// The Sleeper season to look leagues up in. This is deliberately NOT DRAFT_YEAR.
// DRAFT_YEAR is 2025 and is stored as metadata on the draft record; the ADP data
// the sync job loads is 2026 (ADP_YEAR in template.yaml). A user's 2025 and 2026
// Sleeper leagues are different leagues, so looking up 2025 would show last
// season's leagues while drafting them against this season's rankings.
const SLEEPER_SEASON = 2026;

export default function NewDraft() {
  const nav = useNavigate();
  const [teams, setTeams] = useState(12);
  const [rounds, setRounds] = useState(15);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [format, setFormat] = useState("standard");
  const [slot, setSlot] = useState(1);
  const [randomSlot, setRandomSlot] = useState(false);
  const [rosterSlots, setRosterSlots] = useState(null);
  const [boardId, setBoardId] = useState("");
  const [myBoards] = useState(() => listBoards());
  const [username, setUsername] = useState("");
  const [leagues, setLeagues] = useState(null);
  const [sleeperErr, setSleeperErr] = useState("");
  const [finding, setFinding] = useState(false);
  const [importedFrom, setImportedFrom] = useState("");

  usePageTitle("New Draft");

  const safeSlot = Math.min(Math.max(1, slot), teams);
  const schedule = useMemo(
    () => picksForSlot(safeSlot, teams, rounds),
    [safeSlot, teams, rounds]
  );

  const selectedBoard = myBoards.find((b) => b.id === boardId) || null;
  const boardFormatMismatch =
    selectedBoard && selectedBoard.format && selectedBoard.format !== format;

  const createDraft = async () => {
    setLoading(true);
    setErr("");
    try {
      const userTeam = randomSlot
        ? Math.floor(Math.random() * teams) + 1
        : safeSlot;
      const draft = await apiPost("/drafts", {
        teams,
        rounds,
        sport: "nfl",
        format,
        year: DRAFT_YEAR,
        userTeam,
        ...(rosterSlots?.length ? { rosterSlots } : {}),
        ...(boardId ? { boardId } : {}),
      });
      nav(`/draft/${draft.draftId}`);
    } catch (e) {
      setErr(e.message || "Failed to create draft");
    } finally {
      setLoading(false);
    }
  };

  const findLeagues = async () => {
    setFinding(true);
    setSleeperErr("");
    setLeagues(null);
    try {
      const user = await fetchUser(username);
      const found = await fetchLeagues(user.user_id, SLEEPER_SEASON);
      if (found.length === 0) {
        setSleeperErr(`No ${SLEEPER_SEASON} leagues found for "${username}"`);
      }
      setLeagues(found.map((l) => ({ ...l, __userId: user.user_id })));
    } catch (e) {
      setSleeperErr(e.message || "Could not reach Sleeper");
    } finally {
      setFinding(false);
    }
  };

  const applyLeague = async (league) => {
    setSleeperErr("");
    try {
      const draft = await fetchLeagueDraft(league.league_id);
      const cfg = toDraftConfig(league, draft, league.__userId);
      setTeams(cfg.teams);
      setRounds(cfg.rounds);
      setFormat(cfg.format);
      setSlot(cfg.userTeam);
      setRandomSlot(false);
      setRosterSlots(cfg.rosterSlots);
      setImportedFrom(cfg.leagueName);
      setLeagues(null);
    } catch (e) {
      setSleeperErr(e.message || "Could not load that league's draft");
    }
  };

  return (
    <div className="py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">New mock draft</h1>
        <p className="text-sm text-zinc-400">
          Set your league up, pick your slot, and draft.
        </p>
      </div>

      <div className="mb-6 max-w-2xl rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-5">
        <div className="text-sm font-semibold text-white">Import from Sleeper</div>
        <p className="mt-1 text-xs text-zinc-400">
          Enter a Sleeper username to pull a league's teams, rounds, scoring, roster
          slots, and your draft slot. Nothing is stored and no sign-in is needed.
        </p>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            data-testid="sleeper-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") findLeagues(); }}
            placeholder="Sleeper username"
            className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-300/60"
          />
          <button
            type="button"
            onClick={findLeagues}
            disabled={finding}
            data-testid="sleeper-find"
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-600 disabled:opacity-50"
          >
            {finding ? "Finding…" : "Find my leagues"}
          </button>
        </div>

        {sleeperErr && (
          <div data-testid="sleeper-error" className="mt-3 text-sm text-rose-300">
            {sleeperErr}
          </div>
        )}

        {leagues && leagues.length > 0 && (
          <ul data-testid="sleeper-leagues" className="mt-3 space-y-1">
            {leagues.map((l) => (
              <li key={l.league_id}>
                <button
                  type="button"
                  onClick={() => applyLeague(l)}
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-left text-sm text-zinc-200 hover:border-cyan-300/60"
                >
                  {l.name}
                  <span className="ml-2 text-xs text-zinc-500">
                    {l.total_rosters} teams
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {rosterSlots && (
          <div data-testid="roster-summary" className="mt-4 space-y-2">
            <div className="text-xs text-zinc-400">
              Roster imported from {importedFrom} — {rosterSlots.length} roster slots
            </div>
            <div className="flex flex-wrap gap-1">
              {rosterSlots.map((s, i) => (
                <span
                  key={`${s}-${i}`}
                  className={`rounded-full border px-2 py-0.5 text-[10px] ${
                    s === "BN"
                      ? "border-zinc-800 text-zinc-500"
                      : "border-cyan-300/40 text-cyan-200"
                  }`}
                >
                  {s}
                </span>
              ))}
            </div>
            {rosterSlots.length !== rounds && (
              <div data-testid="roster-rounds-note" className="text-xs text-zinc-500">
                This draft is {rounds} rounds, and the roster holds {rosterSlots.length} slots.
                {rounds < rosterSlots.length
                  ? " Both are expected — a rookie or partial draft fills only part of a roster."
                  : " Both are expected — Sleeper's roster slots don't always include every taxi or IR spot, so a draft can run more rounds than the roster shows."}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="max-w-2xl space-y-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <div className="text-sm text-zinc-300">Teams</div>
            <input
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none ring-0 focus:border-cyan-300/60 focus:shadow-[0_0_0_4px_rgba(34,211,238,0.10)]"
              type="number"
              min={2}
              max={32}
              value={teams}
              onChange={(e) => setTeams(Number(e.target.value))}
            />
          </label>

          <label className="space-y-1">
            <div className="text-sm text-zinc-300">Rounds</div>
            <input
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none ring-0 focus:border-sky-300/60 focus:shadow-[0_0_0_4px_rgba(59,130,246,0.10)]"
              type="number"
              min={1}
              max={40}
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
            />
          </label>

          <label className="space-y-1 sm:col-span-2">
            <div className="flex items-center justify-between text-sm text-zinc-300">
              <span>Your draft slot</span>
              <button
                type="button"
                onClick={() => setRandomSlot((v) => !v)}
                data-testid="random-slot"
                className={`rounded-full border px-3 py-0.5 text-xs ${
                  randomSlot
                    ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-200"
                    : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
                }`}
              >
                Random
              </button>
            </div>
            <select
              data-testid="slot-select"
              disabled={randomSlot}
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none focus:border-cyan-300/60 disabled:opacity-40"
              value={safeSlot}
              onChange={(e) => setSlot(Number(e.target.value))}
            >
              {Array.from({ length: teams }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>Slot {n} of {teams}</option>
              ))}
            </select>
            {!randomSlot && (
              <div data-testid="pick-schedule" className="text-xs text-zinc-500">
                Your picks: {schedule.slice(0, 8).join(", ")}
                {schedule.length > 8 ? ", …" : ""}
                {schedule.length > 1 && ` · ${largestGap(schedule)}-pick longest wait`}
              </div>
            )}
          </label>
        </div>

        <label className="space-y-1 block">
          <div className="text-sm text-zinc-300">ADP Format</div>
          <select
            className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="standard">Standard</option>
            <option value="half-ppr">Half PPR</option>
            <option value="ppr">PPR</option>
          </select>
        </label>

        {myBoards.length > 0 && (
          <label className="space-y-1 block">
            <div className="text-sm text-zinc-300">Use my board</div>
            <select
              data-testid="board-select"
              value={boardId}
              onChange={(e) => setBoardId(e.target.value)}
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-zinc-100 outline-none focus:border-cyan-300/60"
            >
              <option value="">Consensus ADP (no board)</option>
              {myBoards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.format ? ` · ${b.format.toUpperCase()}` : ""}
                </option>
              ))}
            </select>
            {boardFormatMismatch && (
              <div data-testid="board-format-note" className="text-xs text-amber-300/90">
                This board was built for {selectedBoard.format.toUpperCase()}. Its ranks
                still apply, but they were not made for {format.toUpperCase()} scoring.
              </div>
            )}
          </label>
        )}

        {err ? (
          <div className="rounded-2xl border border-red-900/60 bg-red-950/40 p-4 text-red-200 text-sm">
            {err}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            onClick={createDraft}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-cyan-300 to-sky-300 px-5 py-3 font-semibold text-black shadow-[0_10px_40px_rgba(34,211,238,0.20)] disabled:opacity-50"
          >
            {loading ? "Creating…" : "Start Mock Draft"}
          </button>

          <div className="text-xs text-zinc-400">
            Tip: Once inside the draft, use <span className="text-zinc-200">Auto Pick</span> to simulate quickly.
          </div>
        </div>
      </div>
    </div>
  );
}
