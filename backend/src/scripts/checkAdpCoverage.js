// How much of the pool each ADP source actually joins onto.
//
// Run by hand after touching an adapter or its lookup tables. A wrong team or
// position id is invisible in unit tests -- it produces a miss, not an error --
// and shows up here as a coverage number falling off a cliff.
//
//   cd backend/src && node scripts/checkAdpCoverage.js

const { fetchEspnAdp, buildEspnMap } = require("../sync/adpEspn");
const { fetchYahooAdp, buildYahooMap } = require("../sync/adpYahoo");
const { normName, normTeam, toAppPos, isSleeperDefense } = require("../sync/normalize");

const FLOOR = 0.8; // of the top 200 Sleeper skill-position players, ordered by search_rank

// Defences a sanity floor below which the source's own draft-rank data has
// gone missing rather than merely thin -- 22 (ESPN) and 19 (Yahoo) measured
// live on 7 Sep 2026, so 15 has slack on both sides without being toothless.
const DEF_FLOOR = 15;

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

  // Sleeper never sets search_rank on a team-defence record, so the pool
  // filter above excludes every DEF -- the skill-position loop below can
  // never see one. That makes it blind to exactly the join a wrong ESPN team
  // id would break: defences match by team code (defByTeam), not by name, and
  // that path is entirely separate from the byStrict join skill positions use.
  // So defences get their own pool and their own pass.
  const defTeams = new Set(
    Object.values(dump)
      .filter((p) => p.active && p.team && isSleeperDefense(p))
      .map((p) => normTeam(p.team))
  );

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

  // The assertion here is equality, not a percentage, because the two kinds
  // of shortfall look completely different and only one of them is a defect.
  // A source simply not ranking every defence (its draft-rank feed stops
  // before the bottom of the league) shrinks defByTeam.size itself -- nothing
  // to catch, and a percentage would only muddy it. A wrong team id, by
  // contrast, leaves defByTeam.size unchanged but puts that entry's ADP under
  // a team code no real Sleeper defence carries, so it can never be found --
  // hits drops below defByTeam.size while the map's own size stays put. Only
  // the second case is the bug this check exists for, and hits === size is
  // exactly the condition that isolates it.
  for (const [source, m] of Object.entries(maps)) {
    let hit = 0;
    for (const team of m.defByTeam.keys()) {
      if (defTeams.has(team)) hit++;
    }
    const size = m.defByTeam.size;
    console.log(`${source} defences: ${hit}/${size} join a real Sleeper team`);
    if (hit !== size) {
      console.error(
        `  ${source} has a defence ADP keyed on a team code no Sleeper defence carries -- check its team lookup table.`
      );
      bad = true;
    }
    if (size < DEF_FLOOR) {
      console.error(`  ${source} only ranks ${size} defences, below the sanity floor of ${DEF_FLOOR}.`);
      bad = true;
    }
  }

  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
