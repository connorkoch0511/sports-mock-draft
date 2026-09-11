const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");
const { DEFAULT_ROSTER } = require("./lib/roster");
const { responder } = require("./lib/http");
const { subOf, ANON, canMutate, buildSeats, isSeated, seatOf, teamOnClock, humanSeatCount } = require("./lib/owner");
const { addMember } = require("./lib/members");
const { withAdpBySource } = require("./lib/adpBySource");
const { advanceDraft, PICK_SECONDS } = require("./lib/advance");
const {
  loadPlayersForSport,
  getRosterCounts,
  pickBestForTeam,
  boardIdForTeam,
  autoPickAndAdvance,
} = require("./lib/autoPick");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ALLOWED_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

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
  const boardsTable = process.env.BOARDS_TABLE;

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

      // A range, not the preset list the UI offers: an imported Sleeper
      // league can carry any timer its commissioner set, and the client is
      // not trusted for either. Absent is not an error -- it means the
      // caller does not care, and 60 is what every draft had before this
      // field existed.
      //
      // The floor is 30, not 15: the draft page polls every 3s and the
      // expire stagger adds up to 2.75s more (see expireDelayMs), so a
      // 15-second slot was mistimed by close to 20% of its own length. 30 is
      // also already the shortest preset the UI offers, so raising the floor
      // to it makes no existing option unreachable. The ceiling is a full
      // day, because Sleeper's own "slow draft" leagues run pick timers of
      // two to twenty-four hours (`pick_timer` 7200-86400) -- all of which
      // the old 3600 ceiling refused, turning an otherwise-normal import into
      // a form nothing could submit.
      let pickSeconds = 60;
      if (body.pickSeconds !== undefined && body.pickSeconds !== null) {
        const n = Number(body.pickSeconds);
        if (!Number.isInteger(n) || n < 30 || n > 86400) {
          return json(400, { error: "pickSeconds must be a whole number of seconds between 30 and 86400" });
        }
        pickSeconds = n;
      }

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
        pickSeconds,
        // Pick 1 is on the clock from the moment the page opens. Every later
        // deadline is written by advanceDraft, inside the conditional write.
        pickDeadline: Date.now() + pickSeconds * 1000,
        // In the clock index from birth: pick 1 is already on the clock.
        clockRunning: "1",
        version: 1,
        // Whoever holds this can take a seat. Returned only to people already
        // seated, so it travels the way the person sharing it chooses.
        inviteToken: randomUUID(),
      };

      await ddb.send(new PutCommand({ TableName: draftsTable, Item: item }));
      // The seat is already committed by this point, and the row is only a
      // convenience for listing. Failing the whole request here would tell
      // somebody their draft was not created when it was -- and a retry would
      // mint a second one, since the id is new each time. Log it and carry on;
      // the list entry can be missing, which is the failure this design
      // deliberately chose to have.
      try {
        await addMember(ddb, process.env.DRAFT_MEMBERS_TABLE, sub, id);
      } catch (e) {
        console.error("membership row not written:", e.message);
      }

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
        // Derived per request. userTeam is the CREATOR's team, which is right
        // for them and wrong for everybody who joined.
        yourTeam: seatOf(d, sub)?.team ?? null,
        // The page only ever reads `team` and `kind` off a seat (to decide
        // who is on the clock and whether the draft is shared) -- never
        // `sub`. Everyone here already passed isSeated above, so handing a
        // teammate's Cognito id to the others isn't a disclosure to a
        // stranger, but there is no reason to ship it when nothing on the
        // client reads it. Least data by default.
        seats: (d.seats || []).map((s) => ({ team: s.team, kind: s.kind })),
        rosterSlots: d.rosterSlots?.length ? d.rosterSlots : DEFAULT_ROSTER,
        boardId: d.boardId || null,
        // The board that would actually drive YOUR auto-pick, already
        // resolved -- the page shows a choice, not a three-state puzzle.
        // Other seats' boards are not exposed, for the same least-data
        // reason their `sub` is not.
        yourBoardId: boardIdForTeam(d, seatOf(d, sub)?.team ?? null),
        inviteToken: d.inviteToken,
        picked: d.picked || [],
        // Bumped on every write. The draft page polls this endpoint so
        // everyone sees everyone's picks, and re-renders only when this
        // number has moved rather than on every poll response.
        version: d.version ?? 1,
        pickDeadline: d.pickDeadline ?? null,
        pickSeconds: d.pickSeconds ?? PICK_SECONDS,
        pausedAt: d.pausedAt ?? null,
        pausedBy: d.pausedBy ?? null,
        // The page corrects for clock skew against this. Without it a laptop
        // running two minutes fast sees every timer already expired and
        // hammers /expire.
        now: Date.now(),
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
        //
        // The seat is already committed by this point (it was committed on a
        // prior request, or this one wouldn't be in the `already` branch),
        // and the row is only a convenience for listing. Failing the whole
        // request here would tell somebody they aren't seated when they are.
        // Log it and carry on; the list entry can be missing, which is the
        // failure this design deliberately chose to have.
        try {
          await addMember(ddb, process.env.DRAFT_MEMBERS_TABLE, sub, draftId);
        } catch (e) {
          console.error("membership row not written:", e.message);
        }
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
          // Seat first, row second: the seat write above already succeeded,
          // and the row is only a convenience for listing. Failing the whole
          // request here would tell somebody they failed to join a draft they
          // just joined. Log it and carry on; the list entry can be missing,
          // which is the failure this design deliberately chose to have.
          try {
            await addMember(ddb, process.env.DRAFT_MEMBERS_TABLE, sub, draftId);
          } catch (e) {
            console.error("membership row not written:", e.message);
          }
          return json(200, { ok: true, team: seats[i].team });
        } catch (e) {
          if (e?.name !== "ConditionalCheckFailedException") throw e;
          // Somebody took this seat between our read and our write. Before
          // trying the next one, check whether that somebody was US -- a
          // double-clicked link sends two requests that both read the draft
          // before either writes, and blindly advancing would give one person
          // two seats. Re-read rather than trusting the snapshot from the top
          // of this request, which is by now stale by definition.
          //
          // ConsistentRead is required here, not optional: this read exists
          // specifically to check the outcome of a write that JUST happened
          // (the sibling request's conditional write, which succeeded where
          // ours failed). DynamoDB's default read is eventually consistent,
          // but a conditional write is always strongly consistent -- so the
          // default read here could still see the pre-write snapshot and
          // conclude we hold no seat, sending this request on to claim a
          // second one. Without this flag that race reopens the exact door
          // the seat-race fix above was written to close.
          const fresh = await ddb.send(
            new GetCommand({ TableName: draftsTable, Key: { draftId }, ConsistentRead: true })
          );
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
        // Two ways advanceDraft's condition can fail, and they must not be
        // reported as each other: RaceLost is "somebody just picked",
        // DraftPaused is "somebody hit pause between your read and your
        // write". Both are a clean 409 carrying their own message.
        if (e?.name === "RaceLost" || e?.name === "DraftPaused") {
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

      // Same position as the turn check in /pick, just above: after the
      // already-completed check, so a finished draft still says it is
      // finished rather than that it is not your turn. Unlike /pick,
      // auto-pick is not ONLY for your own turn -- it is also how a bot
      // seat's pick gets made, by whichever seated human's browser happens
      // to notice the clock has reached it. What it may never be is a way
      // for one human to draft for another: allowed when the seat on the
      // clock is a bot, or when the caller holds that seat. Anyone else,
      // human or not seated at all, gets the same 409 /pick gives.
      const onClock = teamOnClock(d);
      const clockSeat = (d.seats || []).find((s) => s?.team === onClock);
      const mySeat = seatOf(d, sub);
      const clockIsBot = clockSeat?.kind === "bot";
      const iHoldTheClock = !!mySeat && mySeat.team === onClock;
      if (!clockIsBot && !iHoldTheClock) {
        return json(409, { error: "Not your pick" });
      }

      return autoPickResponse(
        json,
        await autoPickAndAdvance({ ddb, d, draftId, playersTable, draftsTable, boardsTable })
      );
    }

    // POST /drafts/{draftId}/expire
    //
    // The clock, enforced. A browser calling this is making a request, not
    // asserting a fact: the deadline is compared against the SERVER's clock,
    // so no browser can shorten anyone's turn by lying about the time.
    //
    // Deliberately takes no argument naming who to pick for, and does not
    // care that a human asked -- an EventBridge schedule calling this on a
    // timer with no browser open is the same call.
    if (method === "POST" && draftId && path.endsWith("/expire")) {
      if (!sub) return needsAuth();
      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;
      // Before the two checks below, for the reason Phase 1 learned the hard
      // way: a guard ordered ahead of the completed check makes a finished
      // draft report the wrong thing about itself.
      if (d.currentIndex >= d.picks.length) return json(409, { error: "Draft already completed" });

      if (d.pausedAt) {
        return json(409, { error: "Draft is paused", currentIndex: d.currentIndex, version: d.version ?? 1 });
      }

      // Strictly greater: a deadline exactly reached has not passed yet.
      if (!(d.pickDeadline != null && Date.now() > d.pickDeadline)) {
        return json(409, {
          error: "Clock has not expired",
          currentIndex: d.currentIndex,
          version: d.version ?? 1,
        });
      }

      // Exactly one pick, no matter how far past the deadline we are. Forty
      // minutes late and forty seconds late do the identical thing: the draft
      // paused because nobody was watching, and nobody was skipped.
      return autoPickResponse(
        json,
        await autoPickAndAdvance({ ddb, d, draftId, playersTable, draftsTable, boardsTable })
      );
    }

    // POST /drafts/{draftId}/pause  { paused: boolean }
    //
    // Any seated human may stop or restart the clock, and the page names who
    // did. Griefable in principle; these are people who were sent an invite
    // link.
    if (method === "POST" && draftId && path.endsWith("/pause")) {
      if (!sub) return needsAuth();
      const body = event.body ? JSON.parse(event.body) : {};
      const wantPaused = body.paused === true;

      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;
      if (d.currentIndex >= d.picks.length) return json(409, { error: "Draft already completed" });

      const now = Date.now();

      // The loser of a pause/resume race lost only because somebody else's
      // write landed first -- the draft is already in a real, definite
      // state, just not the one this request's stale read expected. That is
      // "somebody already paused it" or "somebody already resumed it", never
      // "something is broken", so a re-read (ConsistentRead, for the same
      // reason /join needs it above: this GET exists specifically to observe
      // the write that just beat us) reported as success is the honest
      // answer -- not a 500 with a raw AWS message, and not a 409 either,
      // since the caller's request (stop the clock / restart the clock) has
      // effectively already been satisfied by the winner.
      const reportCurrent = async () => {
        const fresh = await ddb.send(
          new GetCommand({ TableName: draftsTable, Key: { draftId }, ConsistentRead: true })
        );
        const item = fresh.Item || {};
        return json(200, {
          ok: true,
          pausedAt: item.pausedAt ?? null,
          pausedBy: item.pausedBy ?? null,
          pickDeadline: item.pickDeadline ?? null,
        });
      };

      if (wantPaused) {
        // Idempotent: a second pause must not overwrite the first one's
        // timestamp, or the elapsed time it is holding is lost and resume
        // hands back the wrong remainder.
        if (d.pausedAt) {
          return json(200, {
            ok: true,
            pausedAt: d.pausedAt,
            pausedBy: d.pausedBy ?? null,
            pickDeadline: d.pickDeadline ?? null,
          });
        }
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: draftsTable,
              Key: { draftId },
              UpdateExpression:
                "SET pausedAt = :n, pausedBy = :me, version = if_not_exists(version, :z) + :one REMOVE clockRunning",
              ConditionExpression: "attribute_not_exists(pausedAt)",
              ExpressionAttributeValues: { ":n": now, ":me": sub, ":z": 0, ":one": 1 },
            })
          );
        } catch (e) {
          if (e?.name !== "ConditionalCheckFailedException") throw e;
          return await reportCurrent();
        }
        return json(200, { ok: true, pausedAt: now, pausedBy: sub, pickDeadline: d.pickDeadline ?? null });
      }

      if (!d.pausedAt) {
        return json(200, { ok: true, pausedAt: null, pausedBy: null, pickDeadline: d.pickDeadline ?? null });
      }

      // Push the deadline forward by exactly as long as we were stopped, so a
      // pause preserves the REMAINING time rather than granting a fresh
      // minute -- otherwise pausing at four seconds left is a free reset.
      const extended = (d.pickDeadline ?? now) + (now - d.pausedAt);
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: draftsTable,
            Key: { draftId },
            UpdateExpression:
              "SET pickDeadline = :d, clockRunning = :run, version = if_not_exists(version, :z) + :one REMOVE pausedAt, pausedBy",
            ConditionExpression: "pausedAt = :was",
            ExpressionAttributeValues: { ":d": extended, ":run": "1", ":was": d.pausedAt, ":z": 0, ":one": 1 },
          })
        );
      } catch (e) {
        if (e?.name !== "ConditionalCheckFailedException") throw e;
        return await reportCurrent();
      }
      return json(200, { ok: true, pausedAt: null, pausedBy: null, pickDeadline: extended });
    }

    // POST /drafts/{draftId}/seat-board  { boardId: string | null }
    //
    // Which rankings the clock uses when it drafts for you. Lives here rather
    // than on the join screen because joining claims the seat instantly, with
    // no UI -- a chooser in front of that would leave the seat unclaimed while
    // somebody deliberates, which is exactly when a friend clicking the same
    // link takes the last one.
    if (method === "POST" && draftId && path.endsWith("/seat-board")) {
      if (!sub) return needsAuth();
      const body = event.body ? JSON.parse(event.body) : {};
      const raw = typeof body.boardId === "string" ? body.boardId.trim() : "";
      const boardId = raw.length > 0 && raw.length <= 64 ? raw : null;

      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;
      const i = (d.seats || []).findIndex((s) => s?.kind === "human" && s?.sub === sub);
      if (i < 0) return notFound();

      // A seat must not be pointed at rankings its holder does not own --
      // otherwise anyone in the draft could have the clock draft for them out
      // of a board they merely know the id of.
      if (boardId) {
        const b = await ddb.send(new GetCommand({ TableName: boardsTable, Key: { boardId } }));
        if (!b.Item || !canMutate(b.Item, sub)) return json(400, { error: "That board isn't yours" });
      }

      await ddb.send(
        new UpdateCommand({
          TableName: draftsTable,
          Key: { draftId },
          // Always writes the attribute, null included: once touched, this
          // seat's choice is authoritative and stops inheriting the draft's
          // board. See boardIdForTeam.
          UpdateExpression: `SET seats[${i}].boardId = :b, version = if_not_exists(version, :z) + :one`,
          ConditionExpression: `seats[${i}].#sub = :me`,
          ExpressionAttributeNames: { "#sub": "sub" },
          ExpressionAttributeValues: { ":b": boardId, ":me": sub, ":z": 0, ":one": 1 },
        })
      );

      return json(200, { ok: true, boardId });
    }

    // POST /drafts/{draftId}/sim-to-end
    if (method === "POST" && draftId && path.endsWith("/sim-to-end")) {
      if (!sub) return needsAuth();
      const res = await ddb.send(new GetCommand({ TableName: draftsTable, Key: { draftId } }));
      if (!res.Item || !isSeated(res.Item, sub)) return notFound();

      const d = res.Item;

      // Simulating the rest of a draft other people are sitting in takes
      // their picks away from them.
      if (humanSeatCount(d) > 1) {
        return json(409, { error: "Sim to End is for drafts you are in on your own" });
      }

      const sport = (d.sport || "nfl").toLowerCase();
      const format = (d.format || "standard").toLowerCase();
      const { players, byId } = await loadPlayersForSport({ ddb, table: playersTable, sport, format });

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
        // Two ways advanceDraft's condition can fail, and they must not be
        // reported as each other: RaceLost is "somebody just picked",
        // DraftPaused is "somebody hit pause between your read and your
        // write". Both are a clean 409 carrying their own message.
        if (e?.name === "RaceLost" || e?.name === "DraftPaused") {
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

// Exported for tests only -- not part of the HTTP surface.
module.exports.pickBestForTeam = pickBestForTeam;
module.exports.boardIdForTeam = boardIdForTeam;

// The shapes lib/autoPick can return, in the HTTP terms the two routes
// already answer in. Written once so /auto-pick and /expire cannot drift.
// The last line covers both `race` ("Somebody just picked") and `paused`
// ("Draft is paused"): each already carries the message it needs, so the
// only thing that would break by folding them together is the message, and
// that is exactly what is being passed through.
function autoPickResponse(json, r) {
  if (r.ok) return json(200, { ok: true, picked: r.picked });
  if (r.code === "empty") return json(409, { error: "No players left" });
  return json(409, { error: r.error, currentIndex: r.currentIndex, version: r.version });
}