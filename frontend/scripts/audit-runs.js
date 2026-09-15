#!/usr/bin/env node
// How often does the positional-run factor actually fire, and is what it says
// true? A measuring instrument, not shipped behaviour -- nothing in the app
// imports this file.
//
// It exists because two factors already shipped past their unit tests and
// were wrong against live data: scarcityFactor fired ZERO times across a
// whole draft (it counted all 891 running backs instead of the ~30 anyone
// would start), and tierCliffFactor was false in 3 of its 68 reasons (it
// compared against the next player instead of scanning the position). Both
// read correctly. Reading correctly is not the test.
//
// So this does three things a unit test cannot:
//   1. It uses the REAL player pool, fetched live. A fixture pool cannot
//      reproduce the shape that killed scarcity -- hundreds of unranked
//      bodies at every position.
//   2. It plays complete drafts and asks for advice at EVERY pick, so the
//      answer is a rate over a draft rather than an assertion about one
//      contrived board.
//   3. It prints the raw last picks beside each sampled sentence, so a human
//      can count them and catch a sentence that is merely plausible. That is
//      the check that would have caught tier-cliff.
//
// Usage:  node scripts/audit-runs.js [--samples=20] [--variants=3] [--reach=6]
//
// --reach controls how far scenario B's seats reach past the top of the
// board (see playDraft()'s `reach` option below); it defaults to 6, matching
// the sensitivity table's baseline row in weights.js. Re-run with --reach=12,
// --reach=20 and --reach=30 to reproduce that table's other rows.

import { adviseOnPick } from "../src/lib/pickAdvice.js";
import {
  RUN_MIN_COUNT,
  RUN_MULTIPLE,
  RUN_WEIGHT,
  RUN_WEIGHT_MAX_COUNT,
  RUN_WINDOW,
} from "../src/lib/pickAdvice/weights.js";

const PLAYERS_URL = "https://6q48e144hf.execute-api.us-east-1.amazonaws.com/players";

const TEAMS = 12;
const ROUNDS = 15;

// The roster the backend gives a draft created without one (see
// backend/src/lib/roster.js), padded with bench to the 15 rounds played.
// It decides who counts as STARTABLE -- the population runFactor's candidate
// gate checks a player against before a run reason can attach to him. It has
// no bearing on detectRuns's expected rate, which compares the window's picks
// against the reconstructed board's own best players and never consults the
// roster at all -- so it is not a detail, just not that one.
const ROSTER_SLOTS = [
  "QB", "RB", "RB", "WR", "WR", "TE", "K", "DEF",
  "BN", "BN", "BN", "BN", "BN", "BN", "BN",
];

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  })
);
const SAMPLE_COUNT = Number(args.get("samples") ?? 20);
const VARIANTS = Number(args.get("variants") ?? 3);
const REACH = Number(args.get("reach") ?? 6);

// ---------------------------------------------------------------- the pool

async function fetchPool() {
  let res;
  try {
    res = await fetch(PLAYERS_URL);
  } catch (err) {
    throw new Error(`could not reach ${PLAYERS_URL}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`${PLAYERS_URL} returned HTTP ${res.status}`);
  const body = await res.json();
  const players = Array.isArray(body) ? body : body?.players;
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error("the players endpoint returned no players");
  }
  // An audit of an empty or truncated pool would report 0% and look exactly
  // like the bug it is looking for, so refuse to run on one.
  const ranked = players.filter((p) => Number.isFinite(p?.rank)).length;
  if (ranked < TEAMS * ROUNDS * 0.5) {
    throw new Error(
      `only ${ranked} of ${players.length} players carry a consensus rank -- ` +
        `too few to draft ${TEAMS * ROUNDS} picks against`
    );
  }
  return { players, ranked };
}

// ------------------------------------------------------------ the simulation

/** Consensus rank ascending, unranked last, ties broken by pool order. */
function byConsensus(a, b) {
  const ar = Number.isFinite(a.player?.rank) ? a.player.rank : Infinity;
  const br = Number.isFinite(b.player?.rank) ? b.player.rank : Infinity;
  return ar - br || a.index - b.index;
}

function emptyPicks() {
  const picks = [];
  let overall = 1;
  for (let round = 1; round <= ROUNDS; round++) {
    const forward = round % 2 === 1;
    for (let i = 0; i < TEAMS; i++) {
      const team = forward ? i + 1 : TEAMS - i;
      picks.push({ overall: overall++, round, team, playerId: null, player: null });
    }
  }
  return picks;
}

// Seeded, so a re-run of the audit measures the same drafts.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One complete draft. Every seat autopicks by consensus rank.
 *
 * `reach` > 0 lets a seat take someone a little below the top of the board,
 * biased hard toward the top. Real drafters reach, and a factor whose firing
 * rate only survives one perfectly obedient pick order has not been measured.
 * The spec scenario runs with reach 0.
 */
function playDraft(players, { reach = 0, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  const board = players
    .map((player, index) => ({ player, index }))
    .sort(byConsensus);
  const picks = emptyPicks();
  for (const slot of picks) {
    const k = reach > 0 ? Math.min(reach, board.length) : 1;
    const at = k > 1 ? Math.floor(rand() ** 3 * k) : 0;
    const [chosen] = board.splice(at, 1);
    slot.playerId = String(chosen.player.id);
    slot.player = chosen.player;
  }
  return picks;
}

// ------------------------------------------------------------- the audit run

/** The picks by teams other than `seat`, most recent last -- what the factor
 *  says its sentence is about. Recomputed here from the raw pick list rather
 *  than read out of the engine, so the printed evidence is independent. */
function otherTeamWindow(made, seat) {
  return made.filter((p) => Number(p.team) !== seat).slice(-RUN_WINDOW);
}

/**
 * How many players carrying a finite consensus rank are still on the board at
 * the START of each round -- sampled once per round, not once per pick.
 *
 * This is not decoration. Only 118 of the live pool's 889 players are ranked,
 * and detectRuns reconstructs the board it compares against by sorting with
 * compareRank, which ties every unranked player. Once fewer ranked players
 * remain than the window's K, the reconstruction cannot be trusted and the
 * factor deliberately stays silent. Printing this column beside the firing
 * rate is what lets a reader tell "silent because nothing departed from the
 * board" apart from "silent because the board has no opinion left".
 */
function rankedRemainingByRound(players, picks) {
  const totalRanked = players.filter((p) => Number.isFinite(p?.rank)).length;
  const byRound = new Map();
  let taken = 0;
  let idx = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    byRound.set(round, totalRanked - taken);
    while (idx < picks.length && picks[idx].round === round) {
      if (Number.isFinite(picks[idx].player?.rank)) taken += 1;
      idx += 1;
    }
  }
  return byRound;
}

function auditDraft(players, picks, label) {
  const results = [];
  const rankedAtRound = rankedRemainingByRound(players, picks);
  for (let seat = 1; seat <= TEAMS; seat++) {
    for (let at = 0; at < picks.length; at++) {
      const made = picks.slice(0, at);
      const draft = {
        teams: TEAMS,
        rounds: ROUNDS,
        userTeam: seat,
        rosterSlots: ROSTER_SLOTS,
        picked: made.map((p) => p.playerId),
        currentIndex: at,
        picks: picks.map((p, i) =>
          i < at
            ? p
            : { overall: p.overall, round: p.round, team: p.team, playerId: null, player: null }
        ),
      };

      const advice = adviseOnPick({ players, draft, myTeam: seat });

      // Every distinct run reason anywhere in the ranking. The factor moves
      // the board for whoever it touches, so "did it fire" is a question
      // about the ranking, not only about the top card.
      const texts = new Map(); // text -> { position, weight }
      for (const row of advice.ranked) {
        for (const reason of row.reasons) {
          if (reason.kind !== "run") continue;
          texts.set(reason.text, { weight: reason.weight, text: reason.text });
        }
      }
      const onRecommendation = (advice.recommendation?.reasons || []).some(
        (r) => r.kind === "run"
      );

      results.push({
        label,
        seat,
        overall: picks[at].overall,
        round: picks[at].round,
        onClock: picks[at].team,
        yourTurn: picks[at].team === seat,
        fired: texts.size > 0,
        reasons: [...texts.values()],
        onRecommendation,
        rankedRemaining: rankedAtRound.get(picks[at].round) ?? null,
        made,
      });
    }
  }
  return results;
}

// --------------------------------------------------------------- the report

function pct(n, of) {
  return of === 0 ? "n/a" : `${((n / of) * 100).toFixed(1)}%`;
}

/** "RB" out of "4 of the last 8 picks by other teams were RBs." */
function positionOf(text) {
  const m = /were (\S+?)s\.$/.exec(text);
  return m ? m[1] : "?";
}

function countsIn(text) {
  const m = /^(\d+) of the last (\d+)/.exec(text);
  return m ? { count: Number(m[1]), window: Number(m[2]) } : { count: null, window: null };
}

function summarise(results, title) {
  const total = results.length;
  const fired = results.filter((r) => r.fired);
  const onRec = results.filter((r) => r.onRecommendation);

  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
  console.log(`picks evaluated                 ${total}`);
  console.log(`produced a run reason           ${fired.length}  (${pct(fired.length, total)})`);
  console.log(`run reason on the RECOMMENDATION ${onRec.length}  (${pct(onRec.length, total)})`);

  const byPosition = new Map();
  const byCount = new Map();
  for (const r of fired) {
    for (const reason of r.reasons) {
      const pos = positionOf(reason.text);
      byPosition.set(pos, (byPosition.get(pos) || 0) + 1);
      const { count } = countsIn(reason.text);
      byCount.set(count, (byCount.get(count) || 0) + 1);
    }
  }
  console.log("\nby position (reasons, not picks -- one pick can carry two)");
  for (const [pos, n] of [...byPosition].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pos.padEnd(4)} ${String(n).padStart(5)}`);
  }

  console.log("\nby run size (how many of the window were that position)");
  for (const [count, n] of [...byCount].sort((a, b) => a[0] - b[0])) {
    const weight = RUN_WEIGHT[Math.min(count, RUN_WEIGHT_MAX_COUNT)] ?? 0;
    console.log(`  ${count} of ${RUN_WINDOW}  ${String(n).padStart(5)}  weight ${weight}`);
  }

  console.log("\nby round  (ranked = players with a consensus rank still on the");
  console.log("           board at the START of the round; the baseline goes");
  console.log("           silent once fewer than K of them remain)");
  const perRound = new Map();
  for (const r of results) {
    const cell = perRound.get(r.round) || { total: 0, fired: 0, ranked: 0, rankedN: 0 };
    cell.total += 1;
    if (r.fired) cell.fired += 1;
    if (Number.isFinite(r.rankedRemaining)) {
      cell.ranked += r.rankedRemaining;
      cell.rankedN += 1;
    }
    perRound.set(r.round, cell);
  }
  console.log(`  ${"rd".padEnd(4)} ${"fired/total".padEnd(12)} ${"rate".padStart(6)}  ${"ranked".padStart(6)}`);
  for (const round of [...perRound.keys()].sort((a, b) => a - b)) {
    const { total: t, fired: f, ranked, rankedN } = perRound.get(round);
    const bar = "#".repeat(Math.round((f / t) * 40));
    const avgRanked = rankedN === 0 ? "n/a" : String(Math.round(ranked / rankedN));
    console.log(
      `  r${String(round).padStart(2)}  ${(String(f).padStart(4) + "/" + String(t).padEnd(4)).padEnd(12)} ` +
        `${pct(f, t).padStart(6)}  ${avgRanked.padStart(6)}  ${bar}`
    );
  }
  return fired;
}

/**
 * The part that matters most: a sentence printed beside the picks it claims
 * to describe, so it can be counted by hand.
 *
 * The RAW last picks are printed with the seat that made each one and the
 * user's own marked, NOT just the filtered window -- if the exclusion of the
 * user's picks were itself broken, printing only the already-filtered window
 * would hide it. Derive the window from the raw rows yourself.
 */
function printSamples(fired, howMany) {
  console.log(`\n\n${howMany} SAMPLED REASONS, WITH THE PICKS THEY CLAIM TO DESCRIBE`);
  console.log("=".repeat(72));
  if (fired.length === 0) {
    console.log("nothing fired; nothing to sample.");
    return;
  }
  const stride = Math.max(1, Math.floor(fired.length / howMany));
  const chosen = [];
  for (let i = 0; i < fired.length && chosen.length < howMany; i += stride) chosen.push(fired[i]);

  chosen.forEach((r, i) => {
    console.log(
      `\n[${i + 1}] ${r.label} | your seat ${r.seat} | overall ${r.overall} (round ${r.round}) | ` +
        `seat ${r.onClock} on the clock${r.yourTurn ? " -- yours" : ""}`
    );
    for (const reason of r.reasons) {
      console.log(`    REASON (+${reason.weight}): "${reason.text}"`);
    }

    // Raw record: the last RUN_WINDOW + 4 picks overall, yours marked.
    const raw = r.made.slice(-(RUN_WINDOW + 4));
    console.log(`    last ${raw.length} picks overall (most recent last):`);
    for (const p of raw) {
      const mine = Number(p.team) === r.seat;
      console.log(
        `      #${String(p.overall).padStart(3)}  seat ${String(p.team).padStart(2)}${mine ? " *YOURS*" : "        "}  ` +
          `${String(p.player.position).padEnd(4)} ${p.player.name}`
      );
    }
    const window = otherTeamWindow(r.made, r.seat);
    console.log(
      `    window (${window.length} picks by other teams): ` +
        window.map((p) => p.player.position).join(" ")
    );
    const tally = new Map();
    for (const p of window) tally.set(p.player.position, (tally.get(p.player.position) || 0) + 1);
    console.log(
      `    tally: ${[...tally].map(([pos, n]) => `${pos}=${n}`).join("  ")}` +
        `  | your own picks excluded from the window: ${r.made.length - r.made.filter((p) => Number(p.team) !== r.seat).length}`
    );
  });
}

// ------------------------------------------------------------------ the main

async function main() {
  console.log("AUDIT: how often does the positional-run factor fire, and is it true?");
  console.log(
    `constants under audit: RUN_WINDOW=${RUN_WINDOW} RUN_MIN_COUNT=${RUN_MIN_COUNT} ` +
      `RUN_MULTIPLE=${RUN_MULTIPLE} RUN_WEIGHT=${JSON.stringify(RUN_WEIGHT)} ` +
      `RUN_WEIGHT_MAX_COUNT=${RUN_WEIGHT_MAX_COUNT}`
  );
  console.log(`scenario B reach: ${REACH} (--reach=${REACH})`);

  const started = Date.now();
  const { players, ranked } = await fetchPool();
  console.log(
    `\npool: ${players.length} players from the live endpoint, ${ranked} of them ranked`
  );
  console.log(`league: ${TEAMS} teams, ${ROUNDS} rounds, roster ${ROSTER_SLOTS.join("/")}`);
  console.log(
    `advice is requested at every one of the ${TEAMS * ROUNDS} picks, once per seat ` +
      `(${TEAMS} vantage points on the same board: the factor excludes YOUR picks, ` +
      `so every seat sees a different window)`
  );

  // Scenario A -- exactly what the plan specifies: every seat takes the best
  // player left by consensus rank. This is the headline number.
  const spec = playDraft(players, { reach: 0 });
  const specResults = auditDraft(players, spec, "consensus");
  const specFired = summarise(specResults, "SCENARIO A -- strict consensus autopick (the spec)");

  // Scenario B -- the same thing with drafters who reach. One perfectly
  // obedient pick order is a single sample of positional flow, and the rate
  // should not depend on it.
  let variantFired = [];
  let variantResults = [];
  for (let v = 0; v < VARIANTS; v++) {
    const picks = playDraft(players, { reach: REACH, seed: 1000 + v });
    variantResults = variantResults.concat(auditDraft(players, picks, `reach-${v + 1}`));
  }
  if (VARIANTS > 0) {
    variantFired = summarise(
      variantResults,
      `SCENARIO B -- ${VARIANTS} drafts where seats reach within the top ${REACH} (robustness)`
    );
  }

  // Sample from the spec scenario; fall back to the reach drafts only if the
  // spec scenario produced nothing to look at.
  printSamples(specFired.length > 0 ? specFired : variantFired, SAMPLE_COUNT);

  console.log(`\n\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(`\nAUDIT FAILED: ${err.message}`);
  console.error("Refusing to report a firing rate against a pool that did not load -- an");
  console.error("audit of nothing reports 0%, which is indistinguishable from the bug.");
  process.exitCode = 1;
});
