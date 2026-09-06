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
        playerId: String(r.playerId),
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
