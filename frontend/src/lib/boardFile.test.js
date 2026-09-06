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

// The two cases the brief's tests missed, both of which the next task's parser
// would have had to work around.
test("a row missing position or team keeps the key, as null", () => {
  const rows = [{ playerId: "1", name: "Nameless Team Guy" }];
  const player = JSON.parse(boardToJson(BOARD, rows)).players[0];
  assert.ok("position" in player, "position key was dropped entirely");
  assert.ok("team" in player, "team key was dropped entirely");
  assert.strictEqual(player.position, null);
});

test("a missing field is an empty CSV column, not a missing one", () => {
  const rows = [{ playerId: "1", name: "Nameless Team Guy" }];
  const line = boardToCsv(BOARD, rows).trim().split("\n")[2];
  assert.strictEqual(line, "1,Nameless Team Guy,,,1");
});

test("a newline in the board name cannot split the comment line", () => {
  const board = { name: "Line one\nLine two", format: "ppr", season: 2026 };
  const lines = boardToCsv(board, ROWS).split("\n");
  assert.strictEqual(lines[0], "# PerfectPick board · Line one Line two · ppr · 2026");
  // The header must still be line 1, or every row index below shifts.
  assert.strictEqual(lines[1], "rank,player,position,team,playerId");
});

import { parseBoardFile } from "./boardFile.js";

test("a round trip preserves the order exactly", () => {
  const { meta, players } = parseBoardFile(boardToCsv(BOARD, ROWS));
  assert.strictEqual(meta.name, "Sleepers and busts");
  assert.strictEqual(meta.format, "ppr");
  assert.strictEqual(meta.season, 2026);
  assert.deepStrictEqual(players.map((p) => p.playerId), ["4034", "6794"]);
});

test("a json round trip preserves the order exactly", () => {
  const { meta, players } = parseBoardFile(boardToJson(BOARD, ROWS));
  assert.strictEqual(meta.name, "Sleepers and busts");
  assert.deepStrictEqual(players.map((p) => p.name), [
    "Christian McCaffrey",
    "Justin Jefferson",
  ]);
});

// The format is sniffed, so a file renamed .txt still works.
test("json is recognised by its content, not its extension", () => {
  const { players } = parseBoardFile('  \n {"perfectpickBoard":1,"players":[{"name":"A","playerId":"1"}]}');
  assert.strictEqual(players.length, 1);
});

test("a quoted field containing a comma survives the round trip", () => {
  const rows = [{ playerId: "1", name: "Smith, Steve Sr.", position: "WR", team: "BAL" }];
  const { players } = parseBoardFile(boardToCsv(BOARD, rows));
  assert.strictEqual(players[0].name, "Smith, Steve Sr.");
});

test("a doubled quote unescapes to one", () => {
  const rows = [{ playerId: "1", name: 'Dale "Ace" Jones', position: "WR", team: "BAL" }];
  const { players } = parseBoardFile(boardToCsv(BOARD, rows));
  assert.strictEqual(players[0].name, 'Dale "Ace" Jones');
});

// Hand-edited files are an intended input, so these are not exotic.
test("CRLF line endings parse", () => {
  const text = "rank,player,playerId\r\n1,Christian McCaffrey,4034\r\n";
  assert.strictEqual(parseBoardFile(text).players[0].name, "Christian McCaffrey");
});

test("columns in a different order still parse, by header name", () => {
  const text = "playerId,player\n4034,Christian McCaffrey\n";
  const { players } = parseBoardFile(text);
  assert.deepStrictEqual(players[0], { playerId: "4034", name: "Christian McCaffrey" });
});

test("an extra column is ignored rather than fatal", () => {
  const text = "rank,player,playerId,notes\n1,Christian McCaffrey,4034,my guy\n";
  assert.strictEqual(parseBoardFile(text).players[0].playerId, "4034");
});

test("a file of names only parses, with no ids", () => {
  const text = "player\nChristian McCaffrey\nJustin Jefferson\n";
  const { players } = parseBoardFile(text);
  assert.deepStrictEqual(players, [
    { playerId: null, name: "Christian McCaffrey" },
    { playerId: null, name: "Justin Jefferson" },
  ]);
});

test("a file with no metadata takes the app's defaults, not a guess", () => {
  const { meta } = parseBoardFile("player\nChristian McCaffrey\n");
  assert.deepStrictEqual(meta, { name: "Imported board", format: "ppr", season: 2026 });
});

test("blank lines and trailing newlines are skipped", () => {
  const text = "rank,player,playerId\n\n1,Christian McCaffrey,4034\n\n\n";
  assert.strictEqual(parseBoardFile(text).players.length, 1);
});

test("a row with neither a name nor an id is skipped, not imported blank", () => {
  const text = "rank,player,playerId\n1,,\n2,Justin Jefferson,6794\n";
  const { players } = parseBoardFile(text);
  assert.deepStrictEqual(players.map((p) => p.name), ["Justin Jefferson"]);
});

test("unparseable json says so", () => {
  assert.throws(() => parseBoardFile("{ not json"), /could not be read/i);
});

test("a json file that is not a board says so", () => {
  assert.throws(() => parseBoardFile('{"hello":"world"}'), /not a PerfectPick board/i);
});

test("a future format version is refused rather than half-read", () => {
  assert.throws(
    () => parseBoardFile('{"perfectpickBoard":99,"players":[]}'),
    /newer version/i
  );
});

test("a CSV with no recognisable columns says so", () => {
  assert.throws(() => parseBoardFile("alpha,beta\n1,2\n"), /no player column/i);
});

test("a file with no usable rows says so", () => {
  assert.throws(() => parseBoardFile("rank,player,playerId\n"), /no players/i);
});

test("an empty file says so", () => {
  assert.throws(() => parseBoardFile("   "), /empty/i);
});

// The case the reviewer found by probing rather than reading: the writer
// quotes a field containing a newline, and the reader used to split on
// newlines first -- tearing the field in half, dropping its id, and
// corrupting the row after it. Silently, as wrong data.
test("a quoted field containing a newline round-trips intact", () => {
  const rows = [
    { playerId: "1", name: "Line one\nLine two", position: "WR", team: "BAL" },
    { playerId: "2", name: "Justin Jefferson", position: "WR", team: "MIN" },
  ];
  const { players } = parseBoardFile(boardToCsv(BOARD, rows));
  assert.strictEqual(players.length, 2, "the following row was swallowed");
  assert.strictEqual(players[0].name, "Line one\nLine two");
  assert.strictEqual(players[0].playerId, "1", "the id of the split row was lost");
  assert.strictEqual(players[1].name, "Justin Jefferson");
});

test("a board name containing the metadata separator survives", () => {
  const board = { name: "Sleepers · Busts", format: "ppr", season: 2026 };
  const { meta } = parseBoardFile(boardToCsv(board, ROWS));
  assert.strictEqual(meta.name, "Sleepers · Busts");
  assert.strictEqual(meta.format, "ppr");
  assert.strictEqual(meta.season, 2026);
});

test("a board name containing a comma survives, unquoted though it is", () => {
  const board = { name: "Sleepers, busts, dart throws", format: "ppr", season: 2026 };
  const { meta, players } = parseBoardFile(boardToCsv(board, ROWS));
  assert.strictEqual(meta.name, "Sleepers, busts, dart throws");
  assert.strictEqual(players.length, 2);
});

test("a header with odd casing and padding still matches", () => {
  const { players } = parseBoardFile('Rank, Player , PlayerID \n1,Christian McCaffrey,4034\n');
  assert.deepStrictEqual(players[0], { playerId: "4034", name: "Christian McCaffrey" });
});
