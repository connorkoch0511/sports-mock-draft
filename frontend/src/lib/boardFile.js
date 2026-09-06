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
