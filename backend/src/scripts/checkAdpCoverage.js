// How much of the pool each ADP source actually joins onto.
//
// Run by hand after touching an adapter or its lookup tables. A wrong team or
// position id is invisible in unit tests -- it produces a miss, not an error --
// and shows up here as a coverage number falling off a cliff.
//
//   cd backend/src && node scripts/checkAdpCoverage.js

const { fetchEspnAdp, buildEspnMap } = require("../sync/adpEspn");
const { fetchYahooAdp, buildYahooMap } = require("../sync/adpYahoo");
const { normName, normTeam, toAppPos } = require("../sync/normalize");

const FLOOR = 0.8; // of the top 200 Sleeper players carrying an FFC rank

async function main() {
  const dump = await (await fetch("https://api.sleeper.app/v1/players/nfl")).json();
  // Ordered by Sleeper's own search_rank, NOT by Object.values order. Object
  // keys that look like integers come back in ascending numeric order, so
  // slicing the raw values hands you the 200 lowest player ids -- long-tenured
  // veterans nobody drafts -- and every source then scores about 30%, which
  // reads as a broken join when nothing is broken at all. search_rank is
  // Sleeper's fantasy relevance, so this is genuinely the top of the pool.
  const pool = Object.values(dump)
    .filter(
      (p) =>
        p.active && p.team && p.search_rank != null &&
        ["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.position)
    )
    .sort((a, b) => a.search_rank - b.search_rank)
    .slice(0, 200);

  const maps = {
    espn: buildEspnMap(await fetchEspnAdp({ year: 2026, limit: 300 })),
    yahoo: buildYahooMap(await fetchYahooAdp({ count: 100, pages: 3 })),
  };

  let bad = false;
  for (const [source, m] of Object.entries(maps)) {
    let hit = 0;
    for (const pl of pool) {
      const team = normTeam(pl.team);
      const pos = toAppPos(pl.position);
      const nameKey = normName(pl.full_name || pl.last_name || "");
      const found =
        m.byStrict.get(`${pos}|${team}|${nameKey}`) ??
        (pos === "DEF" ? m.defByTeam.get(team) : undefined) ??
        (pos === "K" ? m.kByName.get(nameKey) : undefined);
      if (found != null) hit++;
    }
    const rate = hit / pool.length;
    console.log(`${source}: ${hit}/${pool.length} (${(rate * 100).toFixed(1)}%)`);
    if (rate < FLOOR) {
      console.error(`  ${source} is below the ${FLOOR * 100}% floor -- check its lookup tables.`);
      bad = true;
    }
  }
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
