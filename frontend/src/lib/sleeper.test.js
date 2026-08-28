import test from "node:test";
import assert from "node:assert";
import { toDraftConfig } from "./sleeper.js";

// Shapes captured from three real Sleeper leagues. Field names and value types
// are as the API actually returns them; only draft_order contents are synthetic,
// since that maps opaque user ids to slots.
const JOES = {
  name: "Average Joes 26'",
  total_rosters: 12,
  roster_positions: ["QB","RB","RB","WR","WR","WR","TE","FLEX","K","DEF","BN","BN","BN","BN","BN","BN"],
  scoring_settings: { rec: 0.5, pass_td: 4, rec_td: 6 },
  settings: { draft_rounds: 3, type: 0 },
};
const JOES_DRAFT = {
  type: "snake",
  settings: { rounds: 16, teams: 12, pick_timer: 60 },
  draft_order: { "865123803410374656": 7 },
};

const ARCADE = {
  name: "Arcade League",
  total_rosters: 10,
  roster_positions: ["QB","RB","RB","WR","WR","TE","FLEX","FLEX","K","DEF","BN","BN","BN","BN","BN"],
  scoring_settings: { rec: 1.0 },
  settings: { draft_rounds: 3, type: 0 },
};
const ARCADE_DRAFT = { type: "snake", settings: { rounds: 15, teams: 10 }, draft_order: null };

const USER = "865123803410374656";

test("maps a half-PPR league to the half-ppr format", () => {
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, USER).format, "half-ppr");
});

test("maps a full-PPR league to the ppr format", () => {
  assert.strictEqual(toDraftConfig(ARCADE, ARCADE_DRAFT, USER).format, "ppr");
});

test("maps a league with no reception scoring to standard", () => {
  const league = { ...JOES, scoring_settings: { pass_td: 4 } };
  assert.strictEqual(toDraftConfig(league, JOES_DRAFT, USER).format, "standard");
});

test("takes rounds from the draft, never from league.settings.draft_rounds", () => {
  // draft_rounds is 3 here; the real draft is 16 rounds.
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, USER).rounds, 16);
});

test("falls back to roster length when the draft has no round count", () => {
  const draft = { settings: {}, draft_order: null };
  assert.strictEqual(toDraftConfig(JOES, draft, USER).rounds, 16);
});

test("takes teams from total_rosters", () => {
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, USER).teams, 12);
  assert.strictEqual(toDraftConfig(ARCADE, ARCADE_DRAFT, USER).teams, 10);
});

test("carries roster_positions through verbatim", () => {
  const cfg = toDraftConfig(JOES, JOES_DRAFT, USER);
  assert.deepStrictEqual(cfg.rosterSlots, JOES.roster_positions);
  assert.strictEqual(cfg.rosterSlots.filter((s) => s === "BN").length, 6);
  assert.strictEqual(cfg.rosterSlots.filter((s) => s === "FLEX").length, 1);
});

test("reads the user's real draft slot from draft_order", () => {
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, USER).userTeam, 7);
});

test("defaults the slot to 1 when the draft order is not set", () => {
  assert.strictEqual(toDraftConfig(ARCADE, ARCADE_DRAFT, USER).userTeam, 1);
});

test("defaults the slot to 1 when the user is absent from draft_order", () => {
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, "someone-else").userTeam, 1);
});

test("ignores a slot outside the league's team count", () => {
  const draft = { ...JOES_DRAFT, draft_order: { [USER]: 99 } };
  assert.strictEqual(toDraftConfig(JOES, draft, USER).userTeam, 1);
});

test("carries the league name", () => {
  assert.strictEqual(toDraftConfig(JOES, JOES_DRAFT, USER).leagueName, "Average Joes 26'");
});

test("survives a league with no draft at all", () => {
  const cfg = toDraftConfig(JOES, null, USER);
  assert.strictEqual(cfg.rounds, 16);
  assert.strictEqual(cfg.userTeam, 1);
  assert.strictEqual(cfg.teams, 12);
});
