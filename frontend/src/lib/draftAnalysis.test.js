import test from "node:test";
import assert from "node:assert";
import { analyzeDraft } from "./draftAnalysis.js";

function player(id, { adp = null, tier = null, position = "RB", rank = null } = {}) {
  return { id, name: `Player ${id}`, position, team: "SF", rank, adp, tier };
}

function pick(overall, team, p) {
  return { overall, round: 1, team, playerId: p ? p.id : null, player: p };
}

function draftWith(picks, extra = {}) {
  return {
    draftId: "d1",
    teams: 2,
    rounds: 2,
    userTeam: 1,
    rosterSlots: ["RB", "WR"],
    completed: true,
    picks,
    ...extra,
  };
}

test("a player taken earlier than his ADP is a reach, scoring negative", () => {
  const d = draftWith([pick(1, 1, player("a", { adp: 5.5 }))]);
  const out = analyzeDraft(d);
  assert.strictEqual(out.you.valueCaptured, -4.5);
});

test("a player who falls past his ADP is value, scoring positive", () => {
  const d = draftWith([pick(20, 1, player("a", { adp: 5.5 }))]);
  const out = analyzeDraft(d);
  assert.strictEqual(out.you.valueCaptured, 14.5);
});

test("value is summed across a team's scoreable picks", () => {
  const d = draftWith([
    pick(1, 1, player("a", { adp: 5.5 })),   // -4.5
    pick(20, 1, player("b", { adp: 5.5 })),  // +14.5
  ]);
  assert.strictEqual(analyzeDraft(d).you.valueCaptured, 10);
});

test("a pick whose player has no ADP is excluded, not scored as zero", () => {
  const d = draftWith([
    pick(1, 1, player("a", { adp: 5.5 })),
    pick(2, 1, player("b", { adp: null })),
  ]);
  const out = analyzeDraft(d);

  assert.strictEqual(out.you.valueCaptured, -4.5, "the ADP-less pick must not contribute");
  assert.strictEqual(out.scoreable.without, 1);
  assert.strictEqual(out.scoreable.with, 1);
});

test("a draft where no pick has an ADP yields zero value and does not throw", () => {
  const d = draftWith([pick(1, 1, player("a")), pick(2, 1, player("b"))]);
  const out = analyzeDraft(d);

  assert.strictEqual(out.you.valueCaptured, 0);
  assert.strictEqual(out.scoreable.with, 0);
  assert.strictEqual(out.scoreable.without, 2);
});

test("teams rank by value, best first, and you get your own rank", () => {
  const d = draftWith([
    pick(1, 1, player("a", { adp: 5.5 })),    // team 1: -4.5
    pick(58, 2, player("b", { adp: 30 })),    // team 2: +28
  ]);
  const out = analyzeDraft(d);

  assert.deepStrictEqual(out.teams.map((t) => t.team), [2, 1]);
  assert.strictEqual(out.you.rank, 2);
  assert.strictEqual(out.teams.length, 2, "every team appears, even with no picks");
});

test("a tie in value ranks by team number, deterministically", () => {
  const d = draftWith([
    pick(10, 1, player("a", { adp: 5 })),   // +5
    pick(10, 2, player("b", { adp: 5 })),   // +5
  ]);
  assert.deepStrictEqual(analyzeDraft(d).teams.map((t) => t.team), [1, 2]);
});

test("best pick and biggest reach are named", () => {
  const d = draftWith([
    pick(1, 1, player("reacher", { adp: 5.5 })),  // -4.5
    pick(20, 1, player("steal", { adp: 5.5 })),   // +14.5
  ]);
  const out = analyzeDraft(d);

  assert.strictEqual(out.you.bestPick.player.id, "steal");
  assert.strictEqual(out.you.bestPick.delta, 14.5);
  assert.strictEqual(out.you.biggestReach.player.id, "reacher");
  assert.strictEqual(out.you.biggestReach.delta, -4.5);
});

test("best pick and biggest reach are null when nothing is scoreable", () => {
  const out = analyzeDraft(draftWith([pick(1, 1, player("a"))]));
  assert.strictEqual(out.you.bestPick, null);
  assert.strictEqual(out.you.biggestReach, null);
});

test("roster shape reports a slot never drafted as unfilled", () => {
  const d = draftWith([pick(1, 1, player("a", { position: "RB" }))]);
  const out = analyzeDraft(d);

  assert.deepStrictEqual(out.you.rosterShape.filled, ["RB"]);
  assert.deepStrictEqual(out.you.rosterShape.unfilled, ["WR"]);
});

test("roster shape reports a position drafted beyond its slot count as extra", () => {
  const d = draftWith([
    pick(1, 1, player("a", { position: "RB" })),
    pick(2, 1, player("b", { position: "RB" })),
  ]);
  const out = analyzeDraft(d);

  assert.deepStrictEqual(out.you.rosterShape.extra, [{ position: "RB", count: 1 }]);
});

test("roster shape reads the draft's own rosterSlots, not a default roster", () => {
  // Three QB slots is not any default. If the code hardcodes a roster this fails.
  const d = draftWith([pick(1, 1, player("a", { position: "QB" }))], {
    rosterSlots: ["QB", "QB", "QB"],
  });
  const out = analyzeDraft(d);

  assert.deepStrictEqual(out.you.rosterShape.unfilled, ["QB", "QB"]);
  assert.deepStrictEqual(out.you.rosterShape.extra, []);
});

test("tier counts tally by tier and ignore players without one", () => {
  const d = draftWith([
    pick(1, 1, player("a", { tier: 1 })),
    pick(2, 1, player("b", { tier: 1 })),
    pick(3, 1, player("c", { tier: 3 })),
    pick(4, 1, player("d", { tier: null })),
  ]);
  assert.deepStrictEqual(analyzeDraft(d).you.tierCounts, { 1: 2, 3: 1 });
});

test("the longest wait spans a team's biggest gap and lists who went during it", () => {
  const d = draftWith([
    pick(1, 1, player("mine-1")),
    pick(2, 2, player("theirs-a")),
    pick(3, 2, player("theirs-b")),
    pick(4, 1, player("mine-2")),
  ]);
  const out = analyzeDraft(d);

  assert.strictEqual(out.you.longestWait.from, 1);
  assert.strictEqual(out.you.longestWait.to, 4);
  assert.strictEqual(out.you.longestWait.span, 3);
  assert.deepStrictEqual(
    out.you.longestWait.playersGone.map((p) => p.id),
    ["theirs-a", "theirs-b"]
  );
});

test("a single pick has no wait", () => {
  const out = analyzeDraft(draftWith([pick(1, 1, player("a"))]));
  assert.strictEqual(out.you.longestWait, null);
});

test("a draft with no completed picks returns zeroes rather than throwing", () => {
  const out = analyzeDraft(draftWith([pick(1, 1, null), pick(2, 2, null)]));

  assert.strictEqual(out.you.valueCaptured, 0);
  assert.strictEqual(out.you.bestPick, null);
  assert.strictEqual(out.you.longestWait, null);
  assert.strictEqual(out.scoreable.with, 0);
});

test("an in-progress draft analyzes only the picks made so far", () => {
  const d = draftWith(
    [pick(1, 1, player("a", { adp: 5.5 })), pick(2, 2, null), pick(3, 1, null)],
    { completed: false }
  );
  const out = analyzeDraft(d);

  assert.strictEqual(out.you.valueCaptured, -4.5);
  assert.strictEqual(out.scoreable.with, 1);
});

test("a null or malformed draft returns an empty result rather than throwing", () => {
  for (const bad of [null, undefined, {}, { picks: null }]) {
    const out = analyzeDraft(bad);
    assert.strictEqual(out.you.valueCaptured, 0);
    assert.deepStrictEqual(out.teams, []);
  }
});
