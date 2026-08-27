const NO_RANK = Number.MAX_SAFE_INTEGER;

function rankOf(player) {
  return player.consensusRank == null ? NO_RANK : Number(player.consensusRank);
}

function byRankThenId(a, b) {
  const diff = rankOf(a) - rankOf(b);
  return diff !== 0 ? diff : String(a.playerId).localeCompare(String(b.playerId));
}

/**
 * Merge a user's saved board order with the live player pool.
 *
 * Kept players hold their saved order. Newcomers are inserted after the last
 * kept player with a better (lower) consensus rank, so a heavily reordered
 * board never has its top choices displaced. Departed players are dropped.
 */
function reconcile(storedOrder, livePool) {
  const poolById = new Map(livePool.map((p) => [String(p.playerId), p]));

  const kept = [];
  let removed = 0;
  for (const id of storedOrder) {
    const player = poolById.get(String(id));
    if (player) kept.push(player);
    else removed += 1;
  }

  const keptIds = new Set(kept.map((p) => String(p.playerId)));
  const missing = livePool
    .filter((p) => !keptIds.has(String(p.playerId)))
    .sort(byRankThenId);

  const merged = kept.map((player) => ({ player, isNew: false }));

  for (const newcomer of missing) {
    const newcomerRank = rankOf(newcomer);
    let insertAt = 0;
    for (let i = 0; i < merged.length; i++) {
      if (rankOf(merged[i].player) <= newcomerRank) insertAt = i + 1;
    }
    merged.splice(insertAt, 0, { player: newcomer, isNew: true });
  }

  const rows = merged.map(({ player, isNew }, index) => {
    const myRank = index + 1;
    const consensusRank = player.consensusRank == null ? null : Number(player.consensusRank);
    return {
      playerId: String(player.playerId),
      name: player.name,
      position: player.position,
      team: player.team,
      myRank,
      consensusRank,
      delta: consensusRank == null ? null : consensusRank - myRank,
      isNew,
    };
  });

  return { rows, changelog: { added: missing.length, removed } };
}

module.exports = { reconcile };
