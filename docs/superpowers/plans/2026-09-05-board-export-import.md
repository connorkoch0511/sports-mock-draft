# Board Export and Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a big board as CSV or JSON, and import either back as a new
board, so you can hand your rankings to a friend.

**Architecture:** Entirely frontend. Export serialises the `rows` the board page
already holds. Import parses a file into player references, matches them
against the live pool by id then by normalised name, then creates a board with
the existing `POST /boards` and sets its order with the existing
`PUT /boards/{boardId}`. No API, schema or template change.

**Tech Stack:** React + Vite, `node --test` for pure logic, Playwright for the
two end-to-end paths.

## Global Constraints

- **No API, schema or template change.** If one seems necessary, stop and
  report — it means the design is wrong, not that the scope should widen.
- **Import always creates a new board**, never overwrites. The new board is
  named `<file's name> (imported)`.
- **Partial matches import anyway and are reported by name**, not by count:
  "Imported 197 of 200 players. Not found: Le'Veon Bell, Rob Gronkowski."
- **Ambiguous names are never guessed.** A normalised name matching more than
  one pool player is reported as unmatched.
- **Duplicates within a file keep their first occurrence**; later ones are
  reported. `PUT /boards/{boardId}` rejects a duplicate order with 400, so this
  is enforced before the request.
- **Format is sniffed from content, not the extension.** Content whose first
  non-whitespace character is `{` is JSON; anything else is CSV.
- **A file with no metadata still imports**, taking the name `Imported board`
  and the importing app's defaults — format `ppr`, season `2026`.
- **Season and format are informational, never enforced.** A 2025 board imports
  into 2026; departed players fall out through the existing reconcile.
- CSV follows RFC 4180 quoting. Names contain apostrophes and periods routinely
  and commas occasionally, so the writer quotes and the reader unquotes.
- ESM frontend. Comments explain *why*.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/lib/download.js` (new) | Trigger a browser download. Extracted from `Results.jsx`, where it is currently a component-local function, so the board page can use the same one. |
| `frontend/src/lib/boardFile.js` (new) | Turn rows into a CSV or JSON string, and turn a file's text back into `{ meta, players }`. Serialising and parsing one format belong together. |
| `frontend/src/lib/boardMatch.js` (new) | Normalise a player name, and match parsed rows against the live pool. The only module that knows what "the same player" means. |
| `frontend/src/pages/Board.jsx` | Two export buttons. |
| `frontend/src/pages/Boards.jsx` | The import control and the create-then-order flow. |
| `frontend/src/pages/Results.jsx` | Uses the extracted `download`. |

---

### Task 1: Extract the download helper

**Files:**
- Create: `frontend/src/lib/download.js`
- Modify: `frontend/src/pages/Results.jsx:46-54`

**Interfaces:**
- Consumes: nothing.
- Produces: `download(filename: string, text: string, mime?: string) -> void`

`Results.jsx` defines `download` inside the component. The board page needs the
same behaviour, and copying it would be the start of two of them.

- [ ] **Step 1: Create the module**

```js
// frontend/src/lib/download.js
/**
 * Hand the browser a string to save as a file.
 *
 * Lived inside Results.jsx until the board export needed it too. A second
 * copy is how two downloads start behaving differently for no reason.
 */
export function download(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 2: Use it in Results.jsx**

Delete the local `function download(...) { ... }` (lines 46-54) and add the
import beside the other lib imports at the top of the file:

```js
import { download } from "../lib/download";
```

The three call sites (`Copy link`'s neighbours: the CSV and JSON export
buttons) are unchanged — the signature is identical.

- [ ] **Step 3: Verify nothing moved**

Run: `cd frontend && npm run lint`
Expected: clean.

Run: `cd frontend && npx playwright test tests/results.spec.js --reporter=list`
Expected: 10 passed. `results.spec.js` already covers the export buttons, so a
broken extraction fails here.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/download.js frontend/src/pages/Results.jsx
git commit -m "refactor: one download helper, not one per page"
```

---

### Task 2: Serialise a board to CSV and JSON

**Files:**
- Create: `frontend/src/lib/boardFile.js`
- Test: `frontend/src/lib/boardFile.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `boardToCsv(board, rows) -> string`
  - `boardToJson(board, rows) -> string`
  - `boardFilename(board, ext) -> string`

  `board` is `{ name, format, season }`; `rows` is the array the board page
  holds, each `{ playerId, name, position, team }` in display order.

- [ ] **Step 1: Write the failing tests**

```js
// frontend/src/lib/boardFile.test.js
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
```

- [ ] **Step 2: Run to see them fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — cannot find `./boardFile.js`

- [ ] **Step 3: Implement**

```js
// frontend/src/lib/boardFile.js
/**
 * A board on its way out of the app, and on its way back in.
 *
 * The file is meant to be read by a person as well as by this code -- you
 * export a board to give it to somebody. That is why it carries names and not
 * only ids, and why CSV is a first-class format rather than an afterthought.
 */

const CSV_HEADER = "rank,player,position,team,playerId";
const JSON_VERSION = 1;

/** RFC 4180: quote if the field contains a comma, quote, or newline. */
function csvField(value) {
  const s = String(value ?? "");
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function boardToCsv(board, rows) {
  // The comment line is the only place a CSV can carry the board's identity.
  // It is not a CSV field, so a comma in the name is harmless here.
  const lines = [
    `# PerfectPick board · ${board.name} · ${board.format} · ${board.season}`,
    CSV_HEADER,
    ...rows.map((r, i) =>
      [i + 1, csvField(r.name), csvField(r.position), csvField(r.team), csvField(r.playerId)].join(",")
    ),
  ];
  return lines.join("\n") + "\n";
}

export function boardToJson(board, rows) {
  return JSON.stringify(
    {
      perfectpickBoard: JSON_VERSION,
      name: board.name,
      format: board.format,
      season: board.season,
      players: rows.map((r, i) => ({
        rank: i + 1,
        playerId: String(r.playerId),
        name: r.name,
        position: r.position,
        team: r.team,
      })),
    },
    null,
    2
  );
}

export function boardFilename(board, ext) {
  const slug = String(board?.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "board"}.${ext}`;
}
```

- [ ] **Step 4: Run to see them pass**

Run: `cd frontend && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/boardFile.js frontend/src/lib/boardFile.test.js
git commit -m "feat: serialise a board to CSV and JSON"
```

---

### Task 3: Parse a board file back

**Files:**
- Modify: `frontend/src/lib/boardFile.js`
- Test: `frontend/src/lib/boardFile.test.js`

**Interfaces:**
- Consumes: nothing from Task 2's exports.
- Produces: `parseBoardFile(text) -> { meta, players }`, throwing `Error` with a
  human-readable message on anything unusable.
  - `meta` is `{ name: string, format: string, season: number }`
  - `players` is `[{ playerId: string|null, name: string }]` in file order

  Task 4 consumes `players`; Task 6 consumes both.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/boardFile.test.js`:

```js
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
```

- [ ] **Step 2: Run to see them fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — `parseBoardFile` is not exported.

- [ ] **Step 3: Implement**

Append to `frontend/src/lib/boardFile.js`:

```js
const DEFAULT_META = { name: "Imported board", format: "ppr", season: 2026 };

/**
 * One CSV line into fields, honouring RFC 4180 quoting.
 *
 * Written out rather than split(",") because a quoted field may contain a
 * comma, and a quoted field may contain a doubled quote meaning one quote.
 * Both occur in real player names.
 */
function csvLineToFields(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { fields.push(field); field = ""; }
    else field += c;
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

// Header names accepted for each column we care about. A hand-made file is
// likelier to say "name" than "player", and being strict about that would
// reject a file for no reason a user could see.
const NAME_HEADERS = ["player", "name", "playername"];
const ID_HEADERS = ["playerid", "id"];

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");

  let meta = { ...DEFAULT_META };
  const comment = lines.find((l) => l.startsWith("#"));
  if (comment) {
    // "# PerfectPick board · <name> · <format> · <season>"
    const parts = comment.replace(/^#\s*/, "").split(" · ");
    if (parts.length >= 4) {
      meta = {
        name: parts.slice(1, -2).join(" · ") || DEFAULT_META.name,
        format: parts[parts.length - 2] || DEFAULT_META.format,
        season: Number(parts[parts.length - 1]) || DEFAULT_META.season,
      };
    }
  }

  const body = lines.filter((l) => !l.startsWith("#"));
  if (body.length === 0) throw new Error("That file has no players in it.");

  const headers = csvLineToFields(body[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const nameAt = headers.findIndex((h) => NAME_HEADERS.includes(h));
  const idAt = headers.findIndex((h) => ID_HEADERS.includes(h));
  if (nameAt === -1 && idAt === -1) {
    throw new Error("That CSV has no player column. Expected a column named player or playerId.");
  }

  const players = [];
  for (const line of body.slice(1)) {
    const fields = csvLineToFields(line);
    const name = nameAt === -1 ? "" : (fields[nameAt] || "");
    const playerId = idAt === -1 ? null : (fields[idAt] || null);
    // A row naming nobody is a blank line with commas in it.
    if (!name && !playerId) continue;
    players.push({ playerId: playerId ? String(playerId) : null, name });
  }
  if (players.length === 0) throw new Error("That file has no players in it.");
  return { meta, players };
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file could not be read as JSON.");
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.players)) {
    throw new Error("That file is not a PerfectPick board export.");
  }
  if (data.perfectpickBoard != null && data.perfectpickBoard > JSON_VERSION) {
    throw new Error("That board was exported by a newer version of PerfectPick.");
  }

  const players = data.players
    .filter((p) => p && (p.name || p.playerId))
    .map((p) => ({
      playerId: p.playerId != null ? String(p.playerId) : null,
      name: String(p.name ?? ""),
    }));
  if (players.length === 0) throw new Error("That file has no players in it.");

  return {
    meta: {
      name: data.name || DEFAULT_META.name,
      format: data.format || DEFAULT_META.format,
      season: Number(data.season) || DEFAULT_META.season,
    },
    players,
  };
}

/**
 * A file's text into a board, or a thrown Error a person can act on.
 *
 * The format is sniffed from the content rather than the filename, because a
 * file that has been renamed, pasted or re-saved should still import.
 */
export function parseBoardFile(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("That file is empty.");
  return trimmed.startsWith("{") ? parseJson(trimmed) : parseCsv(trimmed);
}
```

- [ ] **Step 4: Run to see them pass**

Run: `cd frontend && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/boardFile.js frontend/src/lib/boardFile.test.js
git commit -m "feat: read a board file back, whichever format it is"
```

---

### Task 4: Match parsed players against the pool

**Files:**
- Create: `frontend/src/lib/boardMatch.js`
- Test: `frontend/src/lib/boardMatch.test.js`

**Interfaces:**
- Consumes: `players` from `parseBoardFile` (Task 3) — `[{ playerId, name }]`.
- Produces:
  - `normaliseName(name) -> string`
  - `matchPlayers(parsed, pool) -> { order: string[], notFound: string[], ambiguous: string[], duplicates: string[] }`

  `pool` is `[{ playerId, name }]`, the rows the board page holds. `order` is
  the matched player ids in file order — exactly what `PUT /boards/{id}` wants.

- [ ] **Step 1: Write the failing tests**

```js
// frontend/src/lib/boardMatch.test.js
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
// letters -- "Sr" as a surname, or a player actually called "Ivy".
test("a name ending in suffix-like letters is not truncated", () => {
  assert.strictEqual(normaliseName("Bryce Ivy"), "bryce ivy");
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
  assert.deepStrictEqual(r.notFound, []);
});

// An exact id still wins over an ambiguous name -- the id is unambiguous.
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

test("an empty file matches nothing and reports nothing", () => {
  assert.deepStrictEqual(matchPlayers([], POOL), {
    order: [], notFound: [], ambiguous: [], duplicates: [],
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd frontend && npm run test:unit`
Expected: FAIL — cannot find `./boardMatch.js`

- [ ] **Step 3: Implement**

```js
// frontend/src/lib/boardMatch.js
/**
 * Deciding whether two references mean the same player.
 *
 * The only module that answers that question, so "the same player" cannot come
 * to mean two things in two places.
 */

// Stripped only as whole trailing words, so a surname that happens to end in
// these letters survives.
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

export function normaliseName(name) {
  const words = String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents, now that NFD split them off
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")       // apostrophes, periods, hyphens
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/**
 * Parsed rows to an order of pool ids, plus everything that did not fit.
 *
 * Id first because it is exact and, both apps drawing on the same player data,
 * it is the usual case. Name second because a hand-made file has no ids and an
 * id can move between seasons.
 */
export function matchPlayers(parsed, pool) {
  const byId = new Map(pool.map((p) => [String(p.playerId), p]));

  const byName = new Map();
  for (const p of pool) {
    const key = normaliseName(p.name);
    if (!key) continue;
    // null marks a key claimed by more than one player: seen once we store the
    // player, seen again we poison it, so a later lookup knows it is ambiguous
    // rather than picking whichever was inserted first.
    byName.set(key, byName.has(key) ? null : p);
  }

  const order = [];
  const taken = new Set();
  const notFound = [];
  const ambiguous = [];
  const duplicates = [];

  for (const row of parsed) {
    let hit = row.playerId ? byId.get(String(row.playerId)) : undefined;

    if (!hit) {
      const key = normaliseName(row.name);
      const named = key ? byName.get(key) : undefined;
      if (named === null) { ambiguous.push(row.name); continue; }
      hit = named;
    }

    if (!hit) { notFound.push(row.name || row.playerId); continue; }

    const id = String(hit.playerId);
    if (taken.has(id)) { duplicates.push(hit.name); continue; }
    taken.add(id);
    order.push(id);
  }

  return { order, notFound, ambiguous, duplicates };
}
```

- [ ] **Step 4: Run to see them pass**

Run: `cd frontend && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/boardMatch.js frontend/src/lib/boardMatch.test.js
git commit -m "feat: match a file's players against the live pool"
```

---

### Task 5: Export buttons on the board page

**Files:**
- Modify: `frontend/src/pages/Board.jsx`
- Test: `frontend/tests/board.spec.js`

**Interfaces:**
- Consumes: `download` (Task 1), `boardToCsv` / `boardToJson` / `boardFilename`
  (Task 2).
- Produces: nothing later tasks use.

- [ ] **Step 1: Add the buttons**

In `frontend/src/pages/Board.jsx`, add the imports beside the existing lib
imports:

```js
import { download } from "../lib/download";
import { boardToCsv, boardToJson, boardFilename } from "../lib/boardFile";
```

The board page header currently holds the title input on the left and the
save-status span on the right. Replace that `<span data-testid="save-status">…`
element with the status and the two buttons together:

```jsx
        <div className="flex items-center gap-2">
          <span data-testid="save-status" className="text-xs text-zinc-400">
            {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : status === "dirty" ? "Unsaved" : status === "error" ? "Save failed" : ""}
          </span>
          {/*
            Exports the order on screen, which is the reconciled one -- what
            you see is what leaves, including any players added since you last
            touched the board.
          */}
          <button
            type="button"
            data-testid="export-csv"
            onClick={() => download(boardFilename(board, "csv"), boardToCsv(board, rows), "text/csv")}
            className="rounded-xl border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
          >
            Export CSV
          </button>
          <button
            type="button"
            data-testid="export-json"
            onClick={() => download(boardFilename(board, "json"), boardToJson(board, rows), "application/json")}
            className="rounded-xl border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600"
          >
            Export JSON
          </button>
        </div>
```

- [ ] **Step 2: Write the end-to-end test**

Add to `frontend/tests/board.spec.js`:

```js
test("exporting CSV downloads the board in the order on screen", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  const [downloaded] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-csv").click(),
  ]);

  const stream = await downloaded.createReadStream();
  const text = await new Promise((resolve, reject) => {
    let out = "";
    stream.on("data", (c) => { out += c; });
    stream.on("end", () => resolve(out));
    stream.on("error", reject);
  });

  const lines = text.trim().split("\n");
  expect(lines[0]).toContain("# PerfectPick board");
  expect(lines[1]).toBe("rank,player,position,team,playerId");
  // The first data row must be the first row on screen.
  const firstOnScreen = await page.getByTestId("board-row").first().getAttribute("data-player-id");
  expect(lines[2]).toContain(firstOnScreen);
});

test("exporting JSON downloads a parseable board", async ({ page }) => {
  await mockBoard(page, makeBoardState());
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);

  const [downloaded] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-json").click(),
  ]);
  expect(downloaded.suggestedFilename()).toMatch(/\.json$/);
});
```

- [ ] **Step 3: Run**

Run: `cd frontend && npx playwright test tests/board.spec.js --reporter=list`
Expected: all pass, including the two new ones.

Run: `cd frontend && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Board.jsx frontend/tests/board.spec.js
git commit -m "feat: export a board as CSV or JSON"
```

---

### Task 6: Import on the Boards page

**Files:**
- Modify: `frontend/src/pages/Boards.jsx`
- Test: `frontend/tests/board.spec.js`

**Interfaces:**
- Consumes: `parseBoardFile` (Task 3), `matchPlayers` (Task 4), `apiGet` /
  `apiPost` / `apiPut` from `frontend/src/lib/api`.
- Produces: nothing later tasks use.

The flow, using only routes that already exist:

1. Read the file's text and `parseBoardFile` it.
2. `apiPost("/boards", { name, format, season })` → the new board's id.
3. `apiGet("/boards/{id}")` → `rows`, which is the live pool reconciled onto an
   empty board, i.e. every eligible player.
4. `matchPlayers(parsed, rows)` → the order.
5. `apiPut("/boards/{id}", { order, version })`, using the version the
   created board came back with rather than assuming 1.
6. Navigate to the new board, carrying any report in router state.

- [ ] **Step 1: Add the import control and flow**

In `frontend/src/pages/Boards.jsx`, add the imports:

```js
import { useRef } from "react";
import { apiGet, apiPost, apiPut, apiDelete } from "../lib/api";
import { parseBoardFile } from "../lib/boardFile";
import { matchPlayers } from "../lib/boardMatch";
```

(`useRef` joins the existing React import; `apiGet` and `apiPut` join the
existing `apiPost, apiDelete` import.)

Inside the component, beside the other state:

```js
  const fileRef = useRef(null);

  const importBoard = async (file) => {
    setErr("");
    let parsed;
    try {
      parsed = parseBoardFile(await file.text());
    } catch (e) {
      setErr(e.message);
      return;
    }

    try {
      const { boardId } = await apiPost("/boards", {
        name: `${parsed.meta.name} (imported)`,
        format: parsed.meta.format,
        season: parsed.meta.season,
      });

      // A new board reconciles to the whole eligible pool, so these rows are
      // the pool -- exactly what the file's names have to be matched against.
      const created = await apiGet(`/boards/${boardId}`);
      const result = matchPlayers(parsed.players, created.rows);

      if (result.order.length === 0) {
        setErr("None of those players are in this season's pool, so there was nothing to import.");
        return;
      }

      await apiPut(`/boards/${boardId}`, { order: result.order, version: created.version });
      nav(`/board/${boardId}`, {
        state: { importReport: { matched: result.order.length, total: parsed.players.length, ...result } },
      });
    } catch (e) {
      setErr(e.message || "Could not import that board");
    }
  };
```

Add the control beside the create button, before it:

```jsx
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            data-testid="import-file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared so choosing the same file twice fires onChange twice --
              // otherwise a failed import cannot be retried without picking a
              // different file first.
              e.target.value = "";
              if (file) importBoard(file);
            }}
          />
          <button
            type="button"
            data-testid="import-board"
            onClick={() => fileRef.current?.click()}
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-600"
          >
            Import board
          </button>
```

- [ ] **Step 2: Show the report on the board page**

In `frontend/src/pages/Board.jsx`, read the router state and render a
dismissible notice. Add to the imports:

```js
import { useLocation } from "react-router-dom";
```

Inside the component:

```js
  const location = useLocation();
  const [report, setReport] = useState(location.state?.importReport ?? null);
```

And above the rows list, after the existing error line:

```jsx
      {report && report.matched < report.total && (
        <div
          data-testid="import-report"
          className="mb-4 rounded-2xl border border-cyan-800/40 bg-cyan-950/20 px-4 py-3 text-sm text-cyan-200"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p>Imported {report.matched} of {report.total} players.</p>
              {/*
                Named, not counted. "3 could not be imported" makes the reader
                wonder which three, and the answer is already known here.
              */}
              {report.notFound.length > 0 && <p className="mt-1">Not found: {report.notFound.join(", ")}.</p>}
              {report.ambiguous.length > 0 && (
                <p className="mt-1">More than one player shares each of these names, so they were skipped: {report.ambiguous.join(", ")}.</p>
              )}
              {report.duplicates.length > 0 && <p className="mt-1">Listed more than once, kept at the first position: {report.duplicates.join(", ")}.</p>}
            </div>
            <button
              type="button"
              onClick={() => setReport(null)}
              data-testid="import-report-dismiss"
              className="shrink-0 text-xs text-cyan-300 hover:text-cyan-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
```

- [ ] **Step 3: Write the end-to-end tests**

Add to `frontend/tests/board.spec.js`:

```js
const API = "http://localhost:9999";

async function mockImport(page, { rows, onOrder }) {
  await page.route("**/me/boards", (r) => r.fulfill({ json: { boards: [] } }));
  await page.route(`${API}/boards`, (r) =>
    r.fulfill({ json: { boardId: "b-imported" } })
  );
  await page.route(`${API}/boards/b-imported`, (r) => {
    if (r.request().method() === "PUT") {
      onOrder?.(r.request().postDataJSON().order);
      return r.fulfill({ json: { ok: true, version: 2 } });
    }
    return r.fulfill({
      json: { boardId: "b-imported", name: "Imported", sport: "nfl", format: "ppr", season: 2026, version: 1, rows, changelog: [] },
    });
  });
}

const POOL_ROWS = [
  { playerId: "p1", name: "Christian McCaffrey", position: "RB", team: "SF", myRank: 1, consensusRank: 1, delta: 0 },
  { playerId: "p2", name: "Justin Jefferson", position: "WR", team: "MIN", myRank: 2, consensusRank: 2, delta: 0 },
];

test("importing a CSV creates a board in the file's order", async ({ page }) => {
  let sent = null;
  await mockImport(page, { rows: POOL_ROWS, onOrder: (o) => { sent = o; } });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("import-file").setInputFiles({
    name: "board.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("rank,player,playerId\n1,Justin Jefferson,p2\n2,Christian McCaffrey,p1\n"),
  });

  await expect(page).toHaveURL(/\/board\/b-imported$/);
  expect(sent).toEqual(["p2", "p1"]);
});

test("a player who is not in the pool is named, not silently dropped", async ({ page }) => {
  await mockImport(page, { rows: POOL_ROWS });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("import-file").setInputFiles({
    name: "board.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("rank,player\n1,Christian McCaffrey\n2,Rob Gronkowski\n"),
  });

  await expect(page.getByTestId("import-report")).toContainText("Imported 1 of 2");
  await expect(page.getByTestId("import-report")).toContainText("Rob Gronkowski");
});

test("a clean import shows no report at all", async ({ page }) => {
  await mockImport(page, { rows: POOL_ROWS });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("import-file").setInputFiles({
    name: "board.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("rank,player,playerId\n1,Christian McCaffrey,p1\n2,Justin Jefferson,p2\n"),
  });

  await expect(page).toHaveURL(/\/board\/b-imported$/);
  await expect(page.getByTestId("import-report")).toHaveCount(0);
});

test("a file that is not a board says so and creates nothing", async ({ page }) => {
  let created = false;
  await page.route("**/me/boards", (r) => r.fulfill({ json: { boards: [] } }));
  await page.route(`${API}/boards`, (r) => { created = true; return r.fulfill({ json: { boardId: "x" } }); });
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("import-file").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("just some notes I wrote"),
  });

  await expect(page.getByText(/no player column/i)).toBeVisible();
  expect(created).toBe(false);
});
```

- [ ] **Step 4: Run**

Run: `cd frontend && npx playwright test tests/board.spec.js --reporter=list`
Expected: all pass.

Run: `cd frontend && npm run lint && npm run test:unit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Boards.jsx frontend/src/pages/Board.jsx frontend/tests/board.spec.js
git commit -m "feat: import a board file into a new board"
```

---

### Task 7: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document it**

Add to the feature list, in the existing voice:

```markdown
- **Export and import boards** — download a board as CSV or JSON and hand it to
  someone. They import it and get their own copy to edit. The file carries
  player names as well as ids, so it is readable on its own and survives a
  player id changing between seasons. Players who have since retired are
  reported by name rather than silently dropped.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: board export and import"
```

---

## Final Verification

- [ ] `cd frontend && npm run lint` — clean.
- [ ] `cd frontend && npm run test:unit` — all unit tests, including the new
      `boardFile` and `boardMatch` suites.
- [ ] `cd frontend && npm test` — the full Playwright suite.
- [ ] `cd backend/src && npm test` — unchanged at 271, since nothing backend
      moved. If this number differs, something was touched that should not have
      been.
- [ ] `git status --short` — clean.

**Deploying** is frontend only: `cd frontend && npm run deploy`. No backend
deploy, because no backend file changed.
