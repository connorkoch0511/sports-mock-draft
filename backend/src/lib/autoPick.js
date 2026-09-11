// backend/src/lib/autoPick.js
//
// Who gets picked when a pick is made for somebody, and how the draft moves
// on. Lives here rather than in drafts.js because it now has three callers:
// POST /auto-pick, POST /expire, and the scheduled clock -- and the last of
// those has no HTTP response to return, which is what made the old shape
// (taking a `json` responder and returning a response) wrong.
const { DEFAULT_ROSTER, parseRosterSlots, rosterNeed, kDefBlocked } = require("./roster");
const { withAdpBySource } = require("./adpBySource");
const { advanceDraft } = require("./advance");
const { consensusRank, loadBoardRank } = require("./boardRank");
const { QueryCommand } = require("@aws-sdk/lib-dynamodb");

const ALLOWED_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

async function loadPlayersForSport({ ddb, table, sport, format }) {
  // A Query page tops out at 1MB; the players table (~3,900 items) is close
  // enough to that ceiling that a single page could silently drop players,
  // so page through ExclusiveStartKey/LastEvaluatedKey until exhausted.
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "#s = :sport",
        ExpressionAttributeNames: { "#s": "sport" },
        ExpressionAttributeValues: { ":sport": sport },
        ExclusiveStartKey,
      })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const players = items
    .filter((p) => p && ALLOWED_POS.has(p.position))
    .map((p) => ({
      id: p.id || p.playerId,
      name: p.name,
      position: p.position,
      team: p.team,
      rank: p.rank?.[format] ?? null,
      adp:  p.adp?.[format] ?? null,
      // Spread as-is: it has no format dimension, because neither ESPN nor
      // Yahoo publishes one. See lib/adpBySource for why absent must stay
      // absent.
      ...withAdpBySource(p.adpBySource),
      tier: p.tier?.[format] ?? null,
    }))
    // IMPORTANT: sort by rank, push nulls to bottom
    .sort((a,b) => (a.rank ?? 999999) - (b.rank ?? 999999));

  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  return { players, byId };
}

function getRosterCounts(draft, teamNum, playerById) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const pk of draft.picks) {
    if (pk.team !== teamNum || !pk.playerId) continue;
    const pl = playerById[pk.playerId];
    if (!pl) continue;
    if (counts[pl.position] !== undefined) counts[pl.position] += 1;
  }
  return counts;
}

function pickBestForTeam(draft, teamNum, players, rankOf = consensusRank) {
  const pickedSet = new Set(draft.picked || []);
  const counts = draft.__counts || { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  const roster = parseRosterSlots(
    draft.rosterSlots?.length ? draft.rosterSlots : DEFAULT_ROSTER
  );
  const picksRemaining = draft.picks.filter(
    (p, i) => i >= draft.currentIndex && p.team === teamNum
  ).length;
  const blockKDef = kDefBlocked(counts, roster, picksRemaining);

  let best = null;
  let bestScore = -Infinity;

  for (const p of players) {
    if (!p?.id) continue;
    if (pickedSet.has(p.id)) continue;

    // Rank dominates (lower rank = better). Which ranking is the caller's
    // choice: consensus by default, the seat's own board when it has one.
    const base = 100000 - rankOf(p);

    // Roster need: starters first, then FLEX, then nothing — bench is
    // best-available. Clamped to 1 so "needed at all" is what scores, not
    // how many slots are missing — otherwise a league needing three WRs
    // outweighs an RB by a fixed 500-point moat that rank can never cross,
    // and every bot takes the same position with its first pick.
    const needs = Math.min(rosterNeed(counts, p.position, roster), 1) * 500;

    // Hold K/DEF until the team is down to its last few picks.
    const kDefPenalty =
      blockKDef && (p.position === "K" || p.position === "DEF") ? -20000 : 0;

    // Small tie-breaker (stable). Scaled well below 1 -- the smallest
    // possible gap between two distinct ranks -- so it only ever settles a
    // genuine tie and can never flip a real ranking decision. A big board's
    // `order` array ranks players by consecutive position (0, 1, 2, ...), so
    // two adjacent players can be as little as 1 rank apart; an unscaled,
    // name-length tiebreak of that same magnitude was overriding exactly
    // those close calls.
    const tiebreak = (p.name || "").length * 0.0001;

    const score = base + needs + kDefPenalty + tiebreak;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return best;
}

/**
 * Which board drives this team's auto-pick: the seat's own, else the draft's,
 * else none (consensus).
 *
 * `undefined` and `null` mean different things here and the distinction is
 * the whole point. An absent boardId is a seat that has never chosen, and
 * inherits. An explicit null is a seat that chose "Consensus rankings" -- a
 * decision, which must NOT then be overridden by the creator's board. `??`
 * cannot tell those apart, so this asks whether the property is present.
 */
function boardIdForTeam(draft, teamNum) {
  const seat = (draft?.seats || []).find((s) => s?.team === teamNum);
  if (seat && Object.prototype.hasOwnProperty.call(seat, "boardId")) return seat.boardId;
  return draft?.boardId ?? null;
}

// Shared by /auto-pick ("draft for me, on purpose") and /expire ("the clock
// ran out"). The two differ only in what they check before calling this --
// authorization in one, the deadline in the other -- and keeping the picking
// itself in one place is what stops those two paths drifting into picking
// differently.
/**
 * @param {{players: object[], byId: object}} [pool] - an already-loaded
 *   player pool. The two HTTP callers make one pick per request and pass
 *   nothing, so the pool is loaded here as it always was. The scheduler's
 *   drain makes many picks for one draft and loads it once, the way
 *   sim-to-end already does -- re-reading and re-sorting ~3,900 rows per
 *   pick is the difference between a drain that fits its budget and one that
 *   does not. The pool is a static list of players; who is still available
 *   is decided by `d.picked`, which is re-read per pick, so reusing it
 *   cannot make a stale pick.
 * @param {number} [deadlineBase] - passed straight through to advanceDraft.
 */
async function autoPickAndAdvance({
  ddb, d, draftId, playersTable, draftsTable, boardsTable, pool, deadlineBase,
}) {
  const sport = (d.sport || "nfl").toLowerCase();
  const format = (d.format || "standard").toLowerCase();
  const { players, byId } =
    pool || (await loadPlayersForSport({ ddb, table: playersTable, sport, format }));

  const teamNum = d.picks[d.currentIndex]?.team;
  d.__counts = getRosterCounts(d, teamNum, byId);

  const rankOf =
    (await loadBoardRank({ ddb, boardsTable, boardId: boardIdForTeam(d, teamNum) })) || consensusRank;

  const best = pickBestForTeam(d, teamNum, players, rankOf);
  if (!best) return { ok: false, code: "empty" };

  d.picks[d.currentIndex].playerId = best.id;
  // Marked, not inferred. The notifier has to tell "your turn began" from
  // "the clock picked for you", and the only honest way to know is for the
  // path that did it to say so.
  d.picks[d.currentIndex].auto = true;
  d.picks[d.currentIndex].player = {
    id: best.id,
    name: best.name,
    position: best.position,
    team: best.team,
    rank: best.rank,
    adp: best.adp,
    ...withAdpBySource(best.adpBySource),
    tier: best.tier,
  };

  // Captured before the mutation below moves it.
  const expectedIndex = d.currentIndex;
  d.picked = [best.id, ...(d.picked || [])];
  d.currentIndex = d.currentIndex + 1;

  try {
    await advanceDraft({ ddb, table: draftsTable, draftId, draft: d, expectedIndex, deadlineBase });
  } catch (e) {
    if (e?.name === "RaceLost") {
      return { ok: false, code: "race", error: e.message, currentIndex: e.currentIndex, version: e.version };
    }
    // Somebody paused between our read and our write. A clean, distinct
    // failure: the caller must say "the draft is paused", not "somebody just
    // picked".
    if (e?.name === "DraftPaused") {
      return { ok: false, code: "paused", error: e.message, currentIndex: e.currentIndex, version: e.version };
    }
    throw e;
  }

  return { ok: true, picked: best };
}

module.exports = {
  loadPlayersForSport,
  getRosterCounts,
  pickBestForTeam,
  boardIdForTeam,
  autoPickAndAdvance,
};
