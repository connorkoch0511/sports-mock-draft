const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");
const {
  DEFAULT_ROSTER,
  parseRosterSlots,
  rosterNeed,
  kDefBlocked,
} = require("./lib/roster");
const { responder } = require("./lib/http");
const { subOf, ANON, buildSeats, isSeated, seatOf, teamOnClock } = require("./lib/owner");
const { addMember } = require("./lib/members");
const { withAdpBySource } = require("./lib/adpBySource");
const { advanceDraft } = require("./lib/advance");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ALLOWED_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

async function loadPlayersForSport(table, sport, format) {
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

async function getPlayerSnapshot(playersTable, sport, format, playerId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: playersTable,
      Key: { sport, playerId: String(playerId) },
    })
  );

  const p = res.Item;
  if (!p) return null;

  return {
    id: p.id || p.playerId,
    playerId: p.playerId,
    name: p.name,
    position: p.position,
    team: p.team,
    rank: p.rank?.[format] ?? null,
    adp: p.adp?.[format] ?? null,
    // Spread as-is: it has no format dimension, because neither ESPN nor
    // Yahoo publishes one. See lib/adpBySource for why absent must stay
    // absent.
    ...withAdpBySource(p.adpBySource),
    tier: p.tier?.[format] ?? null,
  };
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

function pickBestForTeam(draft, teamNum, players) {
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

    // Rank dominates (lower rank = better)
    const base = p.rank != null ? (100000 - Number(p.rank)) : 0;

    // Roster need: starters first, then FLEX, then nothing — bench is
    // best-available. Clamped to 1 so "needed at all" is what scores, not
    // how many slots are missing — otherwise a league needing three WRs
    // outweighs an RB by a fixed 500-point moat that rank can never cross,
    // and every bot takes the same position with its first pick.
    const needs = Math.min(rosterNeed(counts, p.position, roster), 1) * 500;

    // Hold K/DEF until the team is down to its last few picks.
    const kDefPenalty =
      blockKDef && (p.position === "K" || p.position === "DEF") ? -20000 : 0;

    // Small tie-breaker (stable)
    const tiebreak = (p.name || "").length;

    const score = base + needs + kDefPenalty + tiebreak;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return best;
}

function buildSnakeOrder(teams, rounds) {
  const picks = [];
  let overall = 1;
  for (let r = 1; r <= rounds; r++) {
    const forward = r % 2 === 1;
    const teamOrder = forward
      ? Array.from({ length: teams }, (_, i) => i + 1)
      : Array.from({ length: teams }, (_, i) => teams - i);

    for (const team of teamOrder) {
      picks.push({ overall, round: r, team, playerId: null, player: null });
      overall++;
    }
  }
  return picks;
}

exports.handler = async (event) => {
  const draftsTable = process.env.DRAFTS_TABLE;
  const playersTable = process.env.PLAYERS_TABLE; // ADD this env var in template (see below)

  const method = event.requestContext?.http?.method;
  const path = event.rawPath || event.requestContext?.http?.path || event.path || "";
  const draftId = event.pathParameters?.draftId;

  const json = responder(event);

  if (method === "OPTIONS") {
    return json(200, {});
  }

  // Read once. The authorizer has already verified the token by the time this
  // runs; an absent sub means the route was reached without one, which is a
  // 401 rather than a crash.
  const sub = subOf(event);

  // A resource owned by somebody else answers exactly like one that does not
  // exist. A 403 would confirm the id is real.
  const notFound = () => json(404, { error: "Draft not found" });
  const needsAuth = () => json(401, { error: "Sign in required" });

  try {
    // POST /drafts
    if (method === "POST" && path === "/drafts") {
      if (!sub) return needsAuth();
      const body = event.body ? JSON.parse(event.body) : {};
      const teams = Math.max(2, Math.min(32, Number(body.teams || 12)));
      const rounds = Math.max(1, Math.min(40, Number(body.rounds || 15)));
      const requestedTeam = Number(body.userTeam || 1);
      const userTeam =
        Number.isInteger(requestedTeam) && requestedTeam >= 1 && requestedTeam <= teams
          ? requestedTeam
          : 1;
      const rosterSlots =
        Array.isArray(body.rosterSlots) && body.rosterSlots.length
          ? body.rosterSlots.slice(0, 60).map((s) => String(s).toUpperCase())
          : DEFAULT_ROSTER;
      const rawBoardId = typeof body.boardId === "string" ? body.boardId.trim() : "";
      const boardId = rawBoardId.length > 0 && rawBoardId.length <= 64 ? rawBoardId : null;

      const id = randomUUID();
      const picks = buildSnakeOrder(teams, rounds);

      const sport = String(body.sport || "nfl").toLowerCase();
      const format = String(body.format || "standard").toLowerCase();
      const year = Number(body.year || 2025);

      const item = {
        draftId: id,
        ownerId: sub,
        // Who may act, as distinct from who created it. One human today; a
        // later phase fills the bot seats with invitations.
        seats: buildSeats(teams, userTeam, sub),
        sport,
        format,
        year,
        teams,
        rounds,
        userTeam,
        rosterSlots,
        boardId,
        picks,
        picked: [],
        currentIndex: 0,
        createdAt: Date.now(),
        version: 1,
        // Whoever holds this can take a seat. Returned only to people already
        // seated, so it travels the way the person sharing it chooses.
        inviteToken: randomUUID(),
      };

      await ddb.send(new PutCommand({ TableName: draftsTable, Item: item }));
      // Seat first, row second: if this fails, the failure mode is a missing
      // list entry, not a phantom one.
      await addMember(ddb, process.env.DRAFT_MEMBERS_TABLE, sub, id);

      return json(200, { draftId: id });
    }

    // GET /drafts/{draftId}
    if (method === "GET" && draftId) {
      if (!sub) return needsAuth();
      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      // Not seated is indistinguishable from not there. Reading a draft you
      // were not invited to is exactly what this phase closes.
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;
      const current = d.picks[d.currentIndex] || null;

      return json(200, {
        draftId: d.draftId,
        sport: d.sport || "nfl",
        format: d.format || "standard",
        year: d.year || 2025,
        teams: d.teams,
        rounds: d.rounds,
        userTeam: d.userTeam || 1,
        rosterSlots: d.rosterSlots?.length ? d.rosterSlots : DEFAULT_ROSTER,
        boardId: d.boardId || null,
        inviteToken: d.inviteToken,
        picked: d.picked || [],
        currentIndex: d.currentIndex,
        currentRound: current?.round || d.rounds,
        currentPick: current ? (current.overall % (d.teams || 1)) || d.teams : d.teams,
        currentTeam: current?.team || null,
        completed: d.currentIndex >= d.picks.length,
        picks: (d.picks || []).map((p) => ({
          overall: p.overall,
          round: p.round,
          team: p.team,
          playerId: p.playerId || null,
          player: p.player || null, // already stored
        })),
      });
    }

    // POST /drafts/{draftId}/join
    if (method === "POST" && /\/drafts\/[^/]+\/join$/.test(path)) {
      if (!sub) return needsAuth();
      const { token } = event.body ? JSON.parse(event.body) : {};

      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      // A wrong token and a missing draft answer identically, so guessing an
      // id learns nothing about whether it exists.
      if (!res.Item || !token || res.Item.inviteToken !== token) return notFound();

      const d = res.Item;
      const already = seatOf(d, sub);
      if (already) {
        // Idempotent: this is the self-healing path for a row that never got
        // written (e.g. joined before this table existed). Cheap because a
        // Put here just overwrites the same item with a fresh joinedAt.
        await addMember(ddb, process.env.DRAFT_MEMBERS_TABLE, sub, draftId);
        return json(200, { ok: true, team: already.team });
      }

      const seats = Array.isArray(d.seats) ? d.seats : [];
      for (let i = 0; i < seats.length; i++) {
        if (seats[i]?.kind !== "bot") continue;
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: draftsTable,
              Key: { draftId },
              // The index, not the team: seats[i].team === i + 1.
              UpdateExpression: `SET seats[${i}].#sub = :me, seats[${i}].kind = :human, version = version + :one`,
              ConditionExpression: `seats[${i}].kind = :bot`,
              ExpressionAttributeNames: { "#sub": "sub" },
              ExpressionAttributeValues: { ":me": sub, ":human": "human", ":bot": "bot", ":one": 1 },
            })
          );
          // Seat first, row second: if this fails, the failure mode is a
          // missing list entry, not a phantom one.
          await addMember(ddb, process.env.DRAFT_MEMBERS_TABLE, sub, draftId);
          return json(200, { ok: true, team: seats[i].team });
        } catch (e) {
          if (e?.name !== "ConditionalCheckFailedException") throw e;
          // Somebody took this seat between our read and our write. Before
          // trying the next one, check whether that somebody was US -- a
          // double-clicked link sends two requests that both read the draft
          // before either writes, and blindly advancing would give one person
          // two seats. Re-read rather than trusting the snapshot from the top
          // of this request, which is by now stale by definition.
          const fresh = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
          const mine = seatOf(fresh.Item, sub);
          if (mine) return json(200, { ok: true, team: mine.team });
        }
      }

      return json(409, { error: "This draft is full — every seat is taken" });
    }

    // POST /drafts/{draftId}/pick
    if (method === "POST" && draftId && path.endsWith("/pick")) {
      if (!sub) return needsAuth();
      const body = event.body ? JSON.parse(event.body) : {};
      const playerId = String(body.playerId || "").trim();
      if (!playerId) return json(400, { error: "Missing playerId" });

      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;

      if ((d.picked || []).includes(playerId)) return json(409, { error: "Player already picked" });
      if (d.currentIndex >= d.picks.length) return json(409, { error: "Draft already completed" });

      // isSeated above answers "may you see this draft". This answers "is it
      // your turn", which with one human is the same question and with two is
      // not: without it either person can pick on the other's turn.
      const onClock = teamOnClock(d);
      const mySeat = seatOf(d, sub);
      if (!mySeat || mySeat.team !== onClock) {
        return json(409, { error: "Not your pick" });
      }

      const sport = (d.sport || "nfl").toLowerCase();
      const format = (d.format || "standard").toLowerCase();

      const snap = await getPlayerSnapshot(playersTable, sport, format, playerId);
      if (!snap) return json(400, { error: "Invalid playerId" });

      if (!ALLOWED_POS.has(snap.position)) return json(400, { error: "Snapshot position is not allowed" });

      d.picks[d.currentIndex].playerId = playerId;
      d.picks[d.currentIndex].player = {
        id: snap.id,
        name: snap.name,
        position: snap.position,
        team: snap.team,
        rank: snap.rank,
        adp: snap.adp,
        ...withAdpBySource(snap.adpBySource),
        tier: snap.tier,
      };

      // Captured before the mutation below moves it.
      const expectedIndex = d.currentIndex;

      d.picked = [playerId, ...(d.picked || [])];
      d.currentIndex = d.currentIndex + 1;

      try {
        await advanceDraft({ ddb, table: draftsTable, draftId, draft: d, expectedIndex });
      } catch (e) {
        if (e?.name === "RaceLost") {
          return json(409, { error: e.message, currentIndex: e.currentIndex, version: e.version });
        }
        throw e;
      }

      return json(200, { ok: true });
    }

    // POST /drafts/{draftId}/auto-pick
    if (method === "POST" && draftId && path.endsWith("/auto-pick")) {
      if (!sub) return needsAuth();
      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;
      if (d.currentIndex >= d.picks.length) return json(409, { error: "Draft already completed" });

      const sport = (d.sport || "nfl").toLowerCase();
      const format = (d.format || "standard").toLowerCase();
      const { players, byId } = await loadPlayersForSport(playersTable, sport, format);

      const teamNum = d.picks[d.currentIndex]?.team;
      d.__counts = getRosterCounts(d, teamNum, byId);

      const best = pickBestForTeam(d, teamNum, players);
      if (!best) return json(409, { error: "No players left" });

      d.picks[d.currentIndex].playerId = best.id;
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
        await advanceDraft({ ddb, table: draftsTable, draftId, draft: d, expectedIndex });
      } catch (e) {
        if (e?.name === "RaceLost") {
          return json(409, { error: e.message, currentIndex: e.currentIndex, version: e.version });
        }
        throw e;
      }

      return json(200, { ok: true, picked: best });
    }

    // POST /drafts/{draftId}/sim-to-end
    if (method === "POST" && draftId && path.endsWith("/sim-to-end")) {
      if (!sub) return needsAuth();
      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;
      const sport = (d.sport || "nfl").toLowerCase();
      const format = (d.format || "standard").toLowerCase();
      const { players, byId } = await loadPlayersForSport(playersTable, sport, format);

      // Captured before the loop below moves it. sim-to-end computes many
      // picks in memory but writes once at the end, so the guard is against
      // anything that moved currentIndex since this single read -- not
      // against anything that happens mid-loop, which is all local state.
      const expectedIndex = d.currentIndex;

      while (d.currentIndex < d.picks.length) {
        const teamNum = d.picks[d.currentIndex]?.team;
        d.__counts = getRosterCounts(d, teamNum, byId);

        const best = pickBestForTeam(d, teamNum, players);
        if (!best) break;

        d.picks[d.currentIndex].playerId = best.id;
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
        d.picked = [best.id, ...(d.picked || [])];
        d.currentIndex += 1;
      }

      try {
        await advanceDraft({ ddb, table: draftsTable, draftId, draft: d, expectedIndex });
      } catch (e) {
        if (e?.name === "RaceLost") {
          return json(409, { error: e.message, currentIndex: e.currentIndex, version: e.version });
        }
        throw e;
      }

      return json(200, { ok: true, completed: d.currentIndex >= d.picks.length });
    }

    // DELETE /drafts/{draftId}
    if (method === "DELETE" && draftId) {
      if (!sub) return needsAuth();
      try {
        await ddb.send(
          new DeleteCommand({
            TableName: draftsTable,
            Key: { draftId },
            // One round trip instead of read-then-delete, and no window
            // between the ownership check and the delete.
            //
            // The second clause keeps this condition from drifting away from
            // canMutate, which refuses the legacy "anon" owner for every
            // caller. Without it a caller whose sub were literally "anon"
            // could delete every unclaimed draft. Cognito subs are UUIDs so
            // that cannot happen today -- but the rule is written in two
            // places here, and only one of them is enforced by lib/owner.js.
            ConditionExpression: "ownerId = :me AND ownerId <> :anon",
            ExpressionAttributeValues: { ":me": sub, ":anon": ANON },
          })
        );
        return json(200, { ok: true });
      } catch (e) {
        // Covers all three of: already gone, owned by someone else, never
        // claimed. The client cannot tell them apart, which is the point.
        if (e.name === "ConditionalCheckFailedException") return notFound();
        throw e;
      }
    }

    return json(404, { error: "Not found" });
  } catch (e) {
    return json(500, { error: e.message || "Server error" });
  }
};