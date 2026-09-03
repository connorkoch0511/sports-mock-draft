// Everything the factors are handed: the pool in board order, who is on the
// clock, what the roster still needs, and what is likely to survive to the
// user's next pick. Built once per advice run.

import { fitRoster } from "../draftAnalysis.js";
import { orderByBoard } from "../boardOrder.js";
import { picksForSlot } from "../snake.js";
import { compareRank, positiveInt } from "./helpers.js";

/**
 * Everything the factors need, computed once. Returns null when there is
 * nothing to advise on: a malformed or completed draft, or an empty pool.
 * None of those are errors the caller should have to catch.
 */
export function buildContext({ players, draft, boardRows, myTeam }) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return null;

  const teams = positiveInt(draft.teams);
  const rounds = positiveInt(draft.rounds);
  if (!teams || !rounds) return null;

  if (draft.picks != null && !Array.isArray(draft.picks)) return null;
  const picks = (Array.isArray(draft.picks) ? draft.picks : []).filter(
    (p) => p && typeof p === "object"
  );
  const made = picks.filter((p) => p.player);

  if (draft.completed === true) return null;
  if (picks.length > 0 && made.length >= picks.length) return null;

  const pool = Array.isArray(players) ? players.filter((p) => p && p.id != null) : [];
  if (pool.length === 0) return null;

  const taken = new Set();
  for (const id of Array.isArray(draft.picked) ? draft.picked : []) taken.add(String(id));
  for (const p of picks) if (p.playerId != null) taken.add(String(p.playerId));

  const available = pool.filter((p) => !taken.has(String(p.id)));
  if (available.length === 0) return null;

  const currentOverall = currentOverallOf(draft, picks, made);

  // The user's slot. Out of range (or absent) costs the reasons that depend
  // on knowing whose roster this is, not the advice itself.
  const requested = Number(myTeam ?? draft.userTeam);
  const mySlot =
    Number.isInteger(requested) && requested >= 1 && requested <= teams ? requested : null;

  const myTurns = mySlot ? picksForSlot(mySlot, teams, rounds) : [];
  const nextOverall = myTurns.find((n) => n > currentOverall) ?? null;
  // No next turn means nothing can run out before it. Scarcity is measured
  // against the user's next pick, never against the end of the draft.
  const gap = nextOverall === null ? 0 : nextOverall - currentOverall;

  // Base order: the board when one is driving the draft, else consensus rank.
  // Sorting by rank first makes the consensus path independent of whatever
  // order the API happened to return.
  const consensus = available
    .map((player, index) => ({ player, index }))
    .sort((a, b) => compareRank(a.player, b.player) || a.index - b.index)
    .map((x) => x.player);
  const hasBoard = Array.isArray(boardRows) && boardRows.length > 0;
  const ordered = hasBoard ? orderByBoard(consensus, boardRows) : consensus;

  // `index === 0 ? 0` keeps the top of the board off negative zero, which
  // survives arithmetic and would surface as "-0" downstream.
  //
  // Frozen: a factor is given the entry, and freezing is what makes "the
  // reasons ARE the scoring factors" a property of the code rather than a
  // convention. `entry.base += 3` inside a factor throws here instead of
  // silently moving the ranking with nothing to show for it.
  const entries = ordered.map((player, index) =>
    Object.freeze({
      player,
      index,
      base: index === 0 ? 0 : -index,
    })
  );

  const rosterSlots = Array.isArray(draft.rosterSlots) ? draft.rosterSlots : [];
  const myMade = mySlot ? made.filter((p) => Number(p.team) === mySlot) : [];

  // Board order per position, which three separate questions are asked of.
  const byPosition = new Map();
  for (const entry of entries) {
    const pos = entry.player.position;
    if (!pos) continue;
    if (!byPosition.has(pos)) byPosition.set(pos, []);
    byPosition.get(pos).push(entry);
  }

  // 1. The next available player at each position, for the tier cliff.
  const nextAtPosition = new Map();
  // 2. Whether a player is genuinely the last at his position in his tier.
  //    Tier is not monotonic with rank in the live payload, so "the next one
  //    is worse" and "he is the last of these" are different claims and only
  //    the second is the one the reason makes.
  const lastInTier = new Set();
  // 3. How many of the players this league could START at the position are
  //    still expected to be on the board at the user's next pick.
  const { windows, startable } = startableAtEachPosition(pool, rosterSlots, teams);
  const survivors = new Map();

  for (const [pos, list] of byPosition) {
    const tiersBelow = new Set();
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (i + 1 < list.length) nextAtPosition.set(entry.index, list[i + 1]);
      const tier = entry.player.tier;
      if (Number.isFinite(tier)) {
        if (!tiersBelow.has(tier)) lastInTier.add(entry.index);
        tiersBelow.add(tier);
      }
    }
    const ids = startable.get(pos);
    survivors.set(
      pos,
      ids ? list.filter((e) => e.index >= gap && ids.has(String(e.player.id))).length : 0
    );
  }

  // How many turns the user has left, this one included. Roster need is
  // pressing relative to this and to nothing else: an open slot with picks to
  // spare is the same kind of non-reason as an open bench spot.
  const turnsLeft = myTurns.filter((n) => n >= currentOverall).length;
  const rosterNow = fitRoster(myMade, rosterSlots);
  const openStarters = rosterNow.unfilled.filter(isStartingSlot).length;

  return {
    pool: entries,
    windows,
    startable,
    lastInTier,
    turnsLeft,
    openStarters,
    currentOverall,
    nextOverall,
    gap,
    mySlot,
    rosterSlots,
    myMade,
    // The shape of the user's roster right now. Each candidate is fitted on
    // top of it with the same fitRoster, so roster need can never drift from
    // how a roster actually fills.
    rosterNow,
    nextAtPosition,
    survivors,
  };
}

/**
 * Who this league could actually START at each position, fixed at the top of
 * the draft by consensus rank -- the only population in which "how many are
 * left?" means anything.
 *
 * The available pool carries 891 running backs and 1,670 receivers, so a raw
 * count of who survives until your next pick is in the hundreds at every
 * position and can never be scarce: the factor fired zero times across a
 * complete 179-pick draft on live data. What a drafter is afraid of is
 * running out of players he would START. Twelve teams starting two running
 * backs and sharing a flex have room for about 28 of them, and the 29th is a
 * bench body whose survival tells you nothing.
 *
 * The set is drawn from the WHOLE pool, drafted players included, so it
 * shrinks as the good ones go instead of quietly refilling from below with
 * whoever is left. That is what makes late-round scarcity real: three
 * startable tight ends left and a long wait until your next pick is a
 * different situation from three hundred tight ends being technically
 * available.
 *
 * The window is `teams x (dedicated slots at the position + its share of the
 * flex slots)`, floored at one starter per team so a league that names no
 * roster at all still has a meaningful window. The flex share is split evenly
 * across the flex-eligible positions in the pool -- which position a given
 * flex ends up holding is exactly the thing nobody knows in advance.
 *
 * Slot classification is asked of fitRoster rather than kept as a second copy
 * of the rules: a slot that will accept a player of no recognisable position
 * is bench capacity, and anything else is a starting slot.
 */
function startableAtEachPosition(pool, rosterSlots, teams) {
  const byPosition = new Map();
  for (const player of pool) {
    const pos = player.position;
    if (!pos) continue;
    if (!byPosition.has(pos)) byPosition.set(pos, []);
    byPosition.get(pos).push(player);
  }

  const everySlot = fitRoster([], rosterSlots).unfilled; // nothing filled: all of them
  const dedicated = new Map();
  let flexSlots = 0;
  for (const label of everySlot) {
    if (label === "FLEX") flexSlots += 1;
    else if (isStartingSlot(label)) dedicated.set(label, (dedicated.get(label) || 0) + 1);
  }

  const flexEligible = [...byPosition.keys()].filter(isFlexEligible);
  const flexShare = flexEligible.length > 0 ? flexSlots / flexEligible.length : 0;

  const windows = new Map();
  const startable = new Map();
  for (const [pos, list] of byPosition) {
    const perTeam = (dedicated.get(pos) || 0) + (isFlexEligible(pos) ? flexShare : 0);
    const size = Math.min(Math.ceil(Math.max(perTeam, 1) * teams), list.length);
    windows.set(pos, size);
    startable.set(
      pos,
      new Set(
        list
          .slice()
          .sort(compareRank)
          .slice(0, size)
          .map((p) => String(p.id))
      )
    );
  }
  return { windows, startable };
}

// A position no real payload uses, for probing what a slot will accept.
const NOT_A_POSITION = "\u0000";
const startingSlotCache = new Map();
const flexEligibleCache = new Map();

/** A bench slot takes anybody, which is why filling one is not a reason. */
function isStartingSlot(label) {
  if (!startingSlotCache.has(label)) {
    const spare = fitRoster([{ player: { position: NOT_A_POSITION } }], [label]);
    startingSlotCache.set(label, spare.unfilled.length > 0);
  }
  return startingSlotCache.get(label);
}

function isFlexEligible(position) {
  if (!flexEligibleCache.has(position)) {
    const fit = fitRoster([{ player: { position } }], ["FLEX"]);
    flexEligibleCache.set(position, fit.unfilled.length === 0);
  }
  return flexEligibleCache.get(position);
}

function currentOverallOf(draft, picks, made) {
  const at = draft.currentIndex;
  if (Number.isInteger(at) && picks[at] && Number.isFinite(picks[at].overall)) {
    return picks[at].overall;
  }
  const pending = picks.find((p) => !p.player);
  if (pending && Number.isFinite(pending.overall)) return pending.overall;
  return made.length + 1;
}

