/**
 * The positions this app will accept, in one place.
 *
 * The same six-position Set was defined three times -- `boards.js`, `drafts.js`
 * and `lib/autoPick.js` -- byte-identical in all three. Each genuinely needs
 * it: boards filter imported rows by it, drafts validate a snapshot's position
 * against it, and the pick rule filters the pool with it.
 *
 * Three copies drift more easily than two, and drift here is a wrong-positions
 * bug of the quiet kind: a position added in one place and missed in another
 * lets a player onto a board that the pick rule then refuses to draft, or the
 * reverse. Nothing fails loudly -- the player simply never gets picked.
 */
const ALLOWED_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

module.exports = { ALLOWED_POS };
