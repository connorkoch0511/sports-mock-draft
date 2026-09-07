/**
 * Deciding whether two references mean the same player.
 *
 * The only module that answers that question, so "the same player" cannot come
 * to mean one thing here and something else somewhere else. It is also the
 * module where a wrong answer is invisible: a parser that fails throws, but a
 * matcher that guesses wrong simply puts the wrong player on your board at a
 * rank you did not choose, and nothing says so.
 */

// Stripped only as whole trailing words, so a surname that merely contains
// these letters survives. A regex over the raw string would turn "Bryce Ivy"
// into "Bryce", the "iv" having been read as a suffix.
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

export function normaliseName(name) {
  const words = String(name ?? "")
    // NFD splits an accented letter into its base plus a combining mark, and
    // the strip below then removes the mark along with the punctuation -- so
    // "Peña" and "Pena" land in the same place without a second pass. An
    // explicit accent-stripping regex here would be dead weight, and one
    // written with literal combining marks is a copy-paste away from silently
    // matching nothing.
    .normalize("NFD")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "") // apostrophes, periods, hyphens, combining marks
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
  const byId = new Map();
  const byName = new Map();
  for (const p of pool) {
    const id = p.playerId == null ? "" : String(p.playerId);
    // A board's order is a list of ids, so a pool player without one cannot go
    // on a board at all. Indexing it would only let it match a row and then
    // push the string "undefined" into the order.
    if (!id) continue;

    // null poisons a key claimed by two pool players, by id or by name: the
    // key then identifies neither of them, and keeping whichever was seen last
    // would put a player nobody chose on the board, silently. A poisoned id is
    // falsy on lookup, so its row falls through to the name -- which may be
    // unambiguous, and is then the better answer.
    byId.set(id, byId.has(id) ? null : p);
    const key = normaliseName(p.name);
    if (key) byName.set(key, byName.has(key) ? null : p);
  }

  const order = [];
  const taken = new Set();
  const notFound = [];
  const ambiguous = [];
  const duplicates = [];

  for (const row of parsed) {
    // An exact id wins even when the name is shared, because the id is not
    // ambiguous -- only the name is.
    let hit = row.playerId ? byId.get(String(row.playerId)) : undefined;

    if (!hit) {
      const key = normaliseName(row.name);
      const named = key ? byName.get(key) : undefined;
      if (named === null) {
        ambiguous.push(row.name);
        continue;
      }
      hit = named;
    }

    if (!hit) {
      notFound.push(row.name || row.playerId);
      continue;
    }

    const id = String(hit.playerId);
    // PUT /boards/{id} rejects a duplicate order with a 400, so a repeat is
    // caught here, where it can be explained, rather than as a server error
    // the person cannot act on.
    if (taken.has(id)) {
      duplicates.push(hit.name);
      continue;
    }
    taken.add(id);
    order.push(id);
  }

  return { order, notFound, ambiguous, duplicates };
}
