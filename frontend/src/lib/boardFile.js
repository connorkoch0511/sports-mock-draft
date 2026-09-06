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
