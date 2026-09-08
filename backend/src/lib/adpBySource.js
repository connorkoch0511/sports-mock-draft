/**
 * Whether to include a player's per-source ADP map in an API response.
 *
 * A source with no number for a player must be ABSENT from the map -- never
 * null, never 0, never present as an empty object. That rule has to be
 * enforced here, in code, not merely assumed: `map ? { adpBySource: map } :
 * {}` looks like it enforces it, but {} is truthy, so an empty map sails
 * straight through the check untouched. Once an empty map reaches the
 * client, it reads as "this source was consulted and had no opinion" --
 * when the truth is the source was never consulted at all -- and a stray
 * `0` inside it would render as a real ADP, making an unranked player look
 * like the first pick of the draft.
 *
 * This checks Object.keys().length, not the truthiness of the map's values,
 * on purpose: a source can legitimately report an ADP of 0 for a player, and
 * that 0 is a genuine stored value that must still pass through -- only a
 * map with zero *keys* counts as empty. Filtering by value truthiness would
 * mistake that 0 for "no data" and strip the whole map.
 */
function withAdpBySource(adpBySource) {
  return adpBySource && Object.keys(adpBySource).length > 0
    ? { adpBySource }
    : {};
}

module.exports = { withAdpBySource };
