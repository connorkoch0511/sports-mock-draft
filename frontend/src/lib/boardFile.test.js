import test from "node:test";
import assert from "node:assert";
import { boardToCsv, boardToJson, boardFilename } from "./boardFile.js";

const BOARD = { name: "Sleepers and busts", format: "ppr", season: 2026 };
const ROWS = [
  { playerId: "4034", name: "Christian McCaffrey", position: "RB", team: "SF" },
  { playerId: "6794", name: "Justin Jefferson", position: "WR", team: "MIN" },
];

test("csv carries the board's identity in a comment line", () => {
  const first = boardToCsv(BOARD, ROWS).split("\n")[0];
  assert.strictEqual(first, "# PerfectPick board · Sleepers and busts · ppr · 2026");
});

test("csv has a header row and one row per player, in order", () => {
  const lines = boardToCsv(BOARD, ROWS).trim().split("\n");
  assert.strictEqual(lines[1], "rank,player,position,team,playerId");
  assert.strictEqual(lines[2], "1,Christian McCaffrey,RB,SF,4034");
  assert.strictEqual(lines[3], "2,Justin Jefferson,WR,MIN,6794");
});

// Names carry apostrophes and periods routinely and commas occasionally.
// Splitting on commas without quoting is the classic way this breaks.
test("a field containing a comma is quoted", () => {
  const rows = [{ playerId: "1", name: "Smith, Steve Sr.", position: "WR", team: "BAL" }];
  const line = boardToCsv(BOARD, rows).trim().split("\n")[2];
  assert.strictEqual(line, '1,"Smith, Steve Sr.",WR,BAL,1');
});

test("a field containing a quote has it doubled, per RFC 4180", () => {
  const rows = [{ playerId: "1", name: 'Dale "Ace" Jones', position: "WR", team: "BAL" }];
  const line = boardToCsv(BOARD, rows).trim().split("\n")[2];
  assert.strictEqual(line, '1,"Dale ""Ace"" Jones",WR,BAL,1');
});

test("a board name containing a comma does not break the comment line", () => {
  const board = { name: "Sleepers, busts, and dart throws", format: "ppr", season: 2026 };
  const lines = boardToCsv(board, ROWS).split("\n");
  assert.ok(lines[0].startsWith("# PerfectPick board · Sleepers, busts, and dart throws · "));
  assert.strictEqual(lines[1], "rank,player,position,team,playerId");
});

test("json carries a format version and the board's identity", () => {
  const parsed = JSON.parse(boardToJson(BOARD, ROWS));
  assert.strictEqual(parsed.perfectpickBoard, 1);
  assert.strictEqual(parsed.name, "Sleepers and busts");
  assert.strictEqual(parsed.format, "ppr");
  assert.strictEqual(parsed.season, 2026);
});

test("json players carry rank, id and the readable fields", () => {
  const parsed = JSON.parse(boardToJson(BOARD, ROWS));
  assert.deepStrictEqual(parsed.players[0], {
    rank: 1,
    playerId: "4034",
    name: "Christian McCaffrey",
    position: "RB",
    team: "SF",
  });
  assert.strictEqual(parsed.players[1].rank, 2);
});

test("the filename is the board name, made safe for a filesystem", () => {
  assert.strictEqual(boardFilename(BOARD, "csv"), "sleepers-and-busts.csv");
  assert.strictEqual(
    boardFilename({ name: "My PPR Board!! (2026)" }, "json"),
    "my-ppr-board-2026.json"
  );
});

test("a board named only in punctuation still gets a filename", () => {
  assert.strictEqual(boardFilename({ name: "!!!" }, "csv"), "board.csv");
});
