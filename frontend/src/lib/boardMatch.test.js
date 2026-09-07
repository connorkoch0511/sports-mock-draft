import test from "node:test";
import assert from "node:assert";
import { normaliseName, matchPlayers } from "./boardMatch.js";

const POOL = [
  { playerId: "4034", name: "Christian McCaffrey" },
  { playerId: "6794", name: "Justin Jefferson" },
  { playerId: "6786", name: "Ja'Marr Chase" },
  { playerId: "7001", name: "Michael Pittman Jr." },
];

test("case, punctuation and spacing fold away", () => {
  assert.strictEqual(normaliseName("Ja'Marr Chase"), normaliseName("JaMarr  chase"));
  assert.strictEqual(normaliseName("Ja'marr Chase"), normaliseName("Ja'Marr Chase"));
});

test("generational suffixes fold away", () => {
  assert.strictEqual(normaliseName("Michael Pittman Jr."), normaliseName("Michael Pittman"));
  assert.strictEqual(normaliseName("Robert Griffin III"), normaliseName("Robert Griffin"));
});

// The suffix strip must not eat a real name that happens to end in those
// letters -- a surname like Ivy, or a player actually called Sr.
test("a name ending in suffix-like letters is not truncated", () => {
  assert.strictEqual(normaliseName("Bryce Ivy"), "bryce ivy");
});

test("accents fold to their base letters", () => {
  assert.strictEqual(normaliseName("Ronald Peña"), normaliseName("Ronald Pena"));
});

test("an exact id match wins, and is the common case", () => {
  const r = matchPlayers([{ playerId: "4034", name: "anything at all" }], POOL);
  assert.deepStrictEqual(r.order, ["4034"]);
  assert.deepStrictEqual(r.notFound, []);
});

test("an unknown id falls back to the name", () => {
  const r = matchPlayers([{ playerId: "no-such-id", name: "Justin Jefferson" }], POOL);
  assert.deepStrictEqual(r.order, ["6794"]);
});

test("a name-only row matches", () => {
  const r = matchPlayers([{ playerId: null, name: "ja'marr chase" }], POOL);
  assert.deepStrictEqual(r.order, ["6786"]);
});

test("file order is preserved", () => {
  const r = matchPlayers(
    [{ playerId: "6794", name: "" }, { playerId: "4034", name: "" }],
    POOL
  );
  assert.deepStrictEqual(r.order, ["6794", "4034"]);
});

test("somebody who is not in the pool is reported by name", () => {
  const r = matchPlayers([{ playerId: null, name: "Rob Gronkowski" }], POOL);
  assert.deepStrictEqual(r.order, []);
  assert.deepStrictEqual(r.notFound, ["Rob Gronkowski"]);
});

// Two NFL players share a name often enough that guessing would eventually be
// wrong, and wrong silently.
test("an ambiguous name is reported, never guessed", () => {
  const pool = [
    { playerId: "1", name: "Michael Thomas" },
    { playerId: "2", name: "Michael Thomas" },
  ];
  const r = matchPlayers([{ playerId: null, name: "Michael Thomas" }], pool);
  assert.deepStrictEqual(r.order, []);
  assert.deepStrictEqual(r.ambiguous, ["Michael Thomas"]);
  // Ambiguous and not-found mean different things to the person reading the
  // report, so an ambiguous name must not also be counted as missing.
  assert.deepStrictEqual(r.notFound, []);
});

test("an id match is not defeated by a shared name", () => {
  const pool = [
    { playerId: "1", name: "Michael Thomas" },
    { playerId: "2", name: "Michael Thomas" },
  ];
  const r = matchPlayers([{ playerId: "2", name: "Michael Thomas" }], pool);
  assert.deepStrictEqual(r.order, ["2"]);
  assert.deepStrictEqual(r.ambiguous, []);
});

// PUT /boards/{id} rejects a duplicate order with a 400, so this is caught
// before the request rather than surfacing as a server error.
test("a repeated player keeps its first position and is reported", () => {
  const r = matchPlayers(
    [
      { playerId: "4034", name: "Christian McCaffrey" },
      { playerId: "6794", name: "Justin Jefferson" },
      { playerId: "4034", name: "Christian McCaffrey" },
    ],
    POOL
  );
  assert.deepStrictEqual(r.order, ["4034", "6794"]);
  assert.deepStrictEqual(r.duplicates, ["Christian McCaffrey"]);
});

// The same player reached two different ways is still the same player.
test("a repeat by name after a match by id is still a duplicate", () => {
  const r = matchPlayers(
    [
      { playerId: "4034", name: "Christian McCaffrey" },
      { playerId: null, name: "christian mccaffrey" },
    ],
    POOL
  );
  assert.deepStrictEqual(r.order, ["4034"]);
  assert.deepStrictEqual(r.duplicates, ["Christian McCaffrey"]);
});

test("an empty file matches nothing and reports nothing", () => {
  assert.deepStrictEqual(matchPlayers([], POOL), {
    order: [], notFound: [], ambiguous: [], duplicates: [],
  });
});

test("a row with neither a usable id nor a known name is reported, not dropped", () => {
  const r = matchPlayers([{ playerId: "ghost", name: "" }], POOL);
  assert.deepStrictEqual(r.order, []);
  assert.deepStrictEqual(r.notFound, ["ghost"]);
});

// The mirror of the ambiguous-name case. Without this, two pool players
// sharing an id resolved to whichever came last in the array -- putting a
// player nobody chose on the board, silently, which is the exact failure this
// module exists to prevent.
test("an id claimed by two pool players is not used to guess", () => {
  const pool = [
    { playerId: "1", name: "Player A" },
    { playerId: "1", name: "Player B" },
  ];
  const r = matchPlayers([{ playerId: "1", name: "" }], pool);
  assert.deepStrictEqual(r.order, []);
  assert.deepStrictEqual(r.notFound, ["1"]);
});

// A poisoned id is falsy, so the row falls through to the name -- and an
// unambiguous name is a better answer than refusing outright.
test("an unambiguous name still resolves a row whose id is ambiguous", () => {
  const pool = [
    { playerId: "1", name: "Player A" },
    { playerId: "1", name: "Player B" },
    { playerId: "2", name: "Player C" },
  ];
  const r = matchPlayers([{ playerId: "1", name: "Player C" }], pool);
  assert.deepStrictEqual(r.order, ["2"]);
  assert.deepStrictEqual(r.ambiguous, []);
});

// Two pool players with no id would both key to the string "undefined",
// letting either stand in for a row that genuinely carried that text.
test("pool players without ids do not collide on a shared key", () => {
  const pool = [
    { playerId: null, name: "Player A" },
    { name: "Player B" },
    { playerId: "7", name: "Player C" },
  ];
  const r = matchPlayers([{ playerId: "undefined", name: "Player B" }], pool);
  assert.deepStrictEqual(r.order, []);
  assert.deepStrictEqual(r.notFound, ["Player B"]);
});
