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
  // Flattened before interpolating. Every per-row field is quoted against
  // newlines, but the comment line cannot be quoted -- it is not a CSV field --
  // so a newline in the name would split it in two and shift the header, and
  // every row after it, down by a line. Nothing in the UI can produce one
  // today; this module is a pure string function with no say in who calls it.
  const oneLineName = String(board.name ?? "").replace(/[\r\n]+/g, " ");
  const lines = [
    `# PerfectPick board · ${oneLineName} · ${board.format} · ${board.season}`,
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
      // ?? null, not bare: JSON.stringify omits keys whose value is
      // undefined, so a row missing a team would produce a player object with
      // no team key at all while its neighbours kept theirs. The parser would
      // then have to tell "key absent" from "key present but empty" for no
      // reason. null keeps the shape uniform, and matches the CSV, where a
      // missing field is an empty column rather than a missing one.
      players: rows.map((r, i) => ({
        rank: i + 1,
        playerId: r.playerId == null ? null : String(r.playerId),
        name: r.name ?? null,
        position: r.position ?? null,
        team: r.team ?? null,
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

const DEFAULT_META = { name: "Imported board", format: "ppr", season: 2026 };

// Header names accepted for each column we care about. A hand-made file is
// likelier to say "name" than "player", and being strict about that would
// reject a file for no reason a user could see.
const NAME_HEADERS = ["player", "name", "playername"];
const ID_HEADERS = ["playerid", "id"];

// A bare rank, and a rank used to number a hand-typed line. The separator set
// is wide on purpose: "1 - Name" is as common a way to number a list as "1. ",
// and matching only the digit would strip the number and leave the dash behind
// on every name. Nobody's name begins with a digit, so this cannot eat one.
const RANK_FIELD = /^\d+\.?$/;
const RANK_PREFIX = /^\d+\s*[.):\-\u2013\u2014]?\s+/;

function everyRow(rows, col, re) {
  return rows.every((r) => re.test(String(r[col] ?? "").trim()));
}

/**
 * The whole file into rows of fields, quote-aware.
 *
 * Splitting on newlines first and parsing quotes per line is the obvious
 * approach and it is wrong: a quoted field may legally CONTAIN a newline, and
 * this module's own writer emits exactly that. Splitting first tore such a
 * field in half, dropped the id that belonged to its row, and corrupted the
 * following row as the stray quote leaked across the boundary -- silently, as
 * wrong data rather than an error, which is the worse failure.
 *
 * So a newline ends a row only when it is not inside an open quote.
 */
function csvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let openedAt = -1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
      openedAt = i;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  // Reaching the end still inside a quote means every row after the stray one
  // was swallowed into a single field. Left alone this is the worst kind of
  // failure: the file parses, the swallowed players are silently gone, and the
  // report cheerfully counts what survived. Better to refuse the file and say
  // where to look.
  if (inQuotes) {
    const line = text.slice(0, openedAt).split(/\r\n|\r|\n/).length;
    throw new Error(
      `That CSV has a quotation mark on line ${line} that is never closed, so everything after it ran together. Look for a stray " and try again.`
    );
  }

  row.push(field);
  rows.push(row);

  // A row of one empty field is a blank line.
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/**
 * Comment lines come off the front by physical line, before tokenising.
 *
 * They are not CSV rows: the board name is interpolated unquoted, so it may
 * contain commas that would tokenise into fields. It cannot contain a newline
 * -- the writer flattens it for exactly this reason -- so reading them a line
 * at a time is safe in a way that reading the body that way is not.
 */
function peelComments(text) {
  const comments = [];
  let rest = text;
  while (rest.startsWith("#")) {
    const end = rest.search(/\r?\n/);
    if (end === -1) { comments.push(rest); rest = ""; break; }
    comments.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\r?\n/, "");
  }
  return { comments, rest };
}

function metaFromComment(comment) {
  // "# PerfectPick board · <name> · <format> · <season>"
  const parts = comment.replace(/^#\s*/, "").split(" · ");
  if (parts.length < 4) return { ...DEFAULT_META };
  return {
    // Rejoined, so a name that itself contains the separator survives.
    name: parts.slice(1, -2).join(" · ") || DEFAULT_META.name,
    format: parts[parts.length - 2] || DEFAULT_META.format,
    season: Number(parts[parts.length - 1]) || DEFAULT_META.season,
  };
}

function parseCsv(text) {
  const { comments, rest } = peelComments(text);
  const meta = comments.length > 0 ? metaFromComment(comments[0]) : { ...DEFAULT_META };

  // A comment further down is tolerated and skipped. Its commas may have
  // tokenised into several fields; skipping the row discards all of them.
  const body = csvRows(rest).filter((r) => !String(r[0] ?? "").startsWith("#"));
  if (body.length === 0) throw new Error("That file has no players in it.");

  const headers = body[0].map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  let nameAt = headers.findIndex((h) => NAME_HEADERS.includes(h));
  let idAt = headers.findIndex((h) => ID_HEADERS.includes(h));

  // The file someone typed by hand is the one likeliest to carry no header at
  // all, and it is the file this feature exists to accept, so infer the shape
  // rather than refuse it. Two rows is the floor: with a single row there is
  // nothing to tell a header-only file, a stray line of prose and a one-player
  // list apart, and guessing wrong on prose would create a board out of
  // somebody's shopping list.
  const numberedRows = everyRow(body, 0, RANK_FIELD);
  const headerless =
    nameAt === -1 && idAt === -1 && body.length >= 2 &&
    // One column is a list of names. More than one is only recognisable when
    // the first is a rank in every row -- otherwise "alpha,beta" would import
    // two players called alpha and 1. Inferring names out of arbitrary columns
    // is worse than refusing the file, because the refusal says what to fix
    // and the guess quietly produces a board of nonsense.
    (body[0].length === 1 || numberedRows);
  if (headerless) {
    // Ids are never inferred: unlike a rank they have no shape to recognise,
    // and a wrong guess puts the wrong player on the board.
    nameAt = numberedRows && body[0].length > 1 ? 1 : 0;
    idAt = -1;
  } else if (nameAt === -1 && idAt === -1) {
    throw new Error("That CSV has no player column. Expected a column named player or playerId.");
  }

  // "1. Christian McCaffrey" is how a person numbers a list they are typing.
  // Only stripped when every row carries the prefix, so a name is never eaten
  // on the strength of one odd-looking row.
  const numbered = headerless && everyRow(body, nameAt, RANK_PREFIX);

  const players = [];
  for (const fields of headerless ? body : body.slice(1)) {
    let name = nameAt === -1 ? "" : (fields[nameAt] ?? "").trim();
    if (numbered) name = name.replace(RANK_PREFIX, "");
    const playerId = idAt === -1 ? null : ((fields[idAt] ?? "").trim() || null);
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
