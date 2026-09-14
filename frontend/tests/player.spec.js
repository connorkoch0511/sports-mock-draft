import { test, expect } from "@playwright/test";
import { MOCK_GAME_LOG, ALL_ZERO_GAME_LOG } from "./fixtures.js";

const API = "http://localhost:9999";
const PLAYER = {
  id: "9221",
  name: "Jahmyr Gibbs",
  position: "RB",
  team: "DET",
  adp: 1.5,
  rank: 1,
  tier: 1,
};

async function mockPlayer(page, over = {}) {
  await page.route(`${API}/players/*`, (r) =>
    r.fulfill({
      json: {
        player: {
          ...PLAYER,
          gameLogs: { 2025: MOCK_GAME_LOG },
          gameLogThrough: { 2025: 18 },
          ...over,
        },
      },
    })
  );
}

test.describe("the player page", () => {
  test("opens cold from a link, with nothing but the id", async ({ page }) => {
    await mockPlayer(page);
    await page.goto(`/player/${PLAYER.id}`);

    await expect(page.getByTestId("player-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: PLAYER.name })).toBeVisible();
    await expect(page.getByTestId("player-page")).toContainText("RB");
    await expect(page.getByTestId("player-page")).toContainText("DET");
  });

  // No browser test had ever loaded a half-PPR league, which is how a table
  // keyed on "half" instead of the app's own "half-ppr" survived: the unit
  // test asserted a format string the application never produces, and every
  // Playwright case used ppr or the standard default.
  test("a half-PPR league is scored as half-PPR", async ({ page }) => {
    await mockPlayer(page, {
      stats: { gp: 10, pts_ppr: 150, pts_half_ppr: 120, pts_std: 90, off_snp: 100, tm_off_snp: 200 },
    });
    await page.goto(`/player/${PLAYER.id}?format=half-ppr`);

    // 120 / 10, not 150 / 10 and not 90 / 10. The wrong one renders a number
    // that looks perfectly reasonable, which is why this asserts the value.
    await expect(page.getByTestId("kpi-fpts")).toContainText("12.0");
  });

  // Fifteen bars of zero height is mathematically right and reads as an empty
  // box -- indistinguishable from having no data at all. Those are different
  // claims, and conflating them is the exact failure this app once spent a day
  // fixing in the advice panel. The marks stay; the words say which it is.
  test("a season of zeros says so, rather than looking empty", async ({ page }) => {
    const zeros = Array.from({ length: 15 }, (_, i) => ({
      wk: i + 1,
      rec: 0, rec_tgt: 0, rec_yd: 0, rec_td: 0, pts_ppr: 0,
      off_snp: [3, 5, 9, 2, 7, 4, 10, 1, 6, 8, 2, 5, 3, 9, 4][i],
      tm_off_snp: 62,
    }));
    await mockPlayer(page, {
      stats: { gp: 15, off_snp: 78, tm_off_snp: 930, pts_ppr: 0, pts_std: 0 },
      gameLogs: { 2025: zeros },
      gameLogThrough: { 2025: 18 },
    });
    await page.goto(`/player/${PLAYER.id}`);

    await expect(page.getByTestId("chart-all-zero")).toContainText("No points in 15 games");
    // The marks are still there: the count of them is the season he played.
    await expect(page.getByTestId("chart-mark")).not.toHaveCount(0);
  });

  // The KPI row is the glanceable answer and belongs above the tabs, not
  // inside one of them -- Yahoo and Sleeper both pin their equivalent there.
  // Without this assertion the row can drift back inside Summary and every
  // other test still passes, which is exactly what happened once.
  test("the KPI row stays put when you change tabs", async ({ page }) => {
    await mockPlayer(page);
    await page.goto(`/player/${PLAYER.id}`);

    await expect(page.getByTestId("player-kpis")).toBeVisible();
    const onSummary = await page.getByTestId("kpi-fpts").textContent();

    await page.getByTestId("tab-gamelog").click();
    await expect(page.getByTestId("player-modal-log")).toBeVisible();

    await expect(page.getByTestId("player-kpis")).toBeVisible();
    expect(await page.getByTestId("kpi-fpts").textContent()).toBe(onSummary);
  });

  test("shows the same game log the dialog does", async ({ page }) => {
    await mockPlayer(page);
    await page.goto(`/player/${PLAYER.id}`);

    // The table now lives behind the Game Log tab; Summary opens first.
    await page.getByTestId("tab-gamelog").click();
    const log = page.getByTestId("player-modal-log");
    await expect(log).toBeVisible();
    await expect(log.locator('[data-week="4"]')).toContainText("140");
    // Collapsed gaps behave the same here as in the dialog.
    await expect(page.getByTestId("game-log-gap")).toHaveCount(2);
  });

  test("passes the format through to the request", async ({ page }) => {
    let seen = "";
    await page.route(`${API}/players/*`, (r) => {
      seen = r.request().url();
      return r.fulfill({ json: { player: PLAYER } });
    });

    await page.goto(`/player/${PLAYER.id}?format=ppr`);
    await expect(page.getByTestId("player-page")).toBeVisible();
    await expect.poll(() => seen).toContain("format=ppr");
  });

  // The engine's reasons are about a decision at a particular pick in a
  // particular draft. This page has neither, so attaching them would answer a
  // question nobody asked.
  test("carries no draft advice", async ({ page }) => {
    await mockPlayer(page);
    await page.goto(`/player/${PLAYER.id}`);
    await expect(page.getByTestId("player-page")).toBeVisible();

    await expect(page.getByTestId("starting-point")).toHaveCount(0);
    await expect(page.getByTestId("advice-reason")).toHaveCount(0);
  });

  test("it is a page, not a dialog", async ({ page }) => {
    await mockPlayer(page);
    await page.goto(`/player/${PLAYER.id}`);
    await expect(page.getByTestId("player-page")).toBeVisible();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("player-modal-backdrop")).toHaveCount(0);
    await expect(page.getByTestId("player-modal-close")).toHaveCount(0);
  });

  test("an unknown player says the log is missing rather than showing nothing", async ({ page }) => {
    await page.route(`${API}/players/*`, (r) =>
      r.fulfill({ status: 404, json: { error: "Player not found" } })
    );
    await page.goto(`/player/nobody`);

    await page.getByTestId("tab-gamelog").click();
    await expect(page.getByTestId("player-modal-log-error")).toBeVisible();
  });

  // The drill-down used to lead with ADP, rank and tier -- draft-position
  // numbers that are an em dash for most of the pool. It now leads with what
  // the player actually did.
  test("leads with production for a player with a game log", async ({ page }) => {
    await mockPlayer(page, {
      stats: { gp: 10, pts_ppr: 150, pos_rank_ppr: 4, off_snp: 120, tm_off_snp: 400 },
    });
    await page.goto(`/player/${PLAYER.id}?format=ppr`);

    const kpis = page.getByTestId("player-kpis");
    await expect(kpis).toBeVisible();
    await expect(page.getByTestId("kpi-fpts")).toContainText("15.0");
    await expect(page.getByTestId("kpi-posrank")).toContainText("4");
    await expect(page.getByTestId("kpi-snapshare")).toContainText("30%");
  });

  // Latu's case: a player with no stats at all must read as "no data" on all
  // three, never as three zeroes -- a zero would claim he played and scored
  // nothing, which is a different fact than not knowing.
  test("shows three em dashes, not three zeroes, for a player with no stats", async ({ page }) => {
    await mockPlayer(page, { stats: undefined });
    await page.goto(`/player/${PLAYER.id}`);

    const kpis = page.getByTestId("player-kpis");
    await expect(kpis).toBeVisible();
    await expect(page.getByTestId("kpi-fpts")).toHaveText("FPTS/GAME—");
    await expect(page.getByTestId("kpi-posrank")).toHaveText("POS RANK—");
    await expect(page.getByTestId("kpi-snapshare")).toHaveText("SNAP SHARE—");
  });

  // The drill-down used to be one long scroll -- KPIs, draft numbers, an
  // advice card, then the log. Summary now carries everything but the log,
  // and it is what a visitor sees first.
  test("the summary tab is the opening tab and holds the ADP trio and tier", async ({ page }) => {
    await mockPlayer(page);
    await page.goto(`/player/${PLAYER.id}`);

    await expect(page.getByTestId("tab-summary")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("player-page")).toContainText("ADP");
    await expect(page.getByTestId("player-page")).toContainText("Tier");
    await expect(page.getByTestId("player-modal-log")).toHaveCount(0);
  });

  test("the game log tab holds the table", async ({ page }) => {
    await mockPlayer(page);
    await page.goto(`/player/${PLAYER.id}`);

    await expect(page.getByTestId("player-modal-log")).toHaveCount(0);
    await page.getByTestId("tab-gamelog").click();
    await expect(page.getByTestId("player-modal-log")).toBeVisible();
  });

  test("switching tabs and back keeps the selected year", async ({ page }) => {
    await mockPlayer(page, {
      gameLogs: { 2025: MOCK_GAME_LOG, 2024: MOCK_GAME_LOG },
      gameLogThrough: { 2025: 18, 2024: 18 },
    });
    await page.goto(`/player/${PLAYER.id}`);

    await page.getByTestId("tab-gamelog").click();
    await page.getByTestId("season-select").selectOption("2024");
    await page.getByTestId("tab-summary").click();
    await page.getByTestId("tab-gamelog").click();

    await expect(page.getByTestId("season-select")).toHaveValue("2024");
  });

  test("the season selector lists exactly the seasons present in gameLogs", async ({ page }) => {
    await mockPlayer(page, {
      gameLogs: { 2025: MOCK_GAME_LOG, 2023: MOCK_GAME_LOG },
      gameLogThrough: { 2025: 18, 2023: 18 },
    });
    await page.goto(`/player/${PLAYER.id}`);
    await page.getByTestId("tab-gamelog").click();

    const options = await page
      .getByTestId("season-select")
      .locator("option")
      .allTextContents();
    expect(options).toEqual(["2025", "2023"]);
  });

  // The spec's explicit choice: default to the current calendar season even
  // though draft season opens it on a nearly-empty year. Matches Yahoo and
  // Sleeper.
  //
  // 2027 is fabricated -- no real player has a log for a season that has not
  // been played -- but it is what makes this test load-bearing. Sorted
  // descending, 2027 is `seasons[0]`; if the rule ever degraded to "the most
  // recent season available" it would win, and picking 2026 instead is what
  // proves the code checks for the CURRENT season by name rather than just
  // taking the top of the sorted list.
  test("opens on the current calendar season when it has games", async ({ page }) => {
    await mockPlayer(page, {
      gameLogs: { 2025: MOCK_GAME_LOG, 2026: MOCK_GAME_LOG, 2027: MOCK_GAME_LOG },
      gameLogThrough: { 2025: 18, 2026: 3, 2027: 1 },
    });
    await page.goto(`/player/${PLAYER.id}`);
    await page.getByTestId("tab-gamelog").click();

    await expect(page.getByTestId("season-select")).toHaveValue("2026");
  });

  // The one exception: an empty current season is not a useful default, even
  // though the selector still offers it.
  test("falls back to the most recent season when the current one has no games", async ({ page }) => {
    await mockPlayer(page); // only 2025 is stored
    await page.goto(`/player/${PLAYER.id}`);
    await page.getByTestId("tab-gamelog").click();

    await expect(page.getByTestId("season-select")).toHaveValue("2025");
  });

  // Latu's case: fifteen weeks of real zeroes and two he did not play at
  // all. A table that abridged either kind of week would look identical to
  // one that abridged the other, so every one of the seventeen must render.
  test("the game log tab renders every week for an all-zero player, including gaps", async ({ page }) => {
    await mockPlayer(page, {
      gameLogs: { 2025: ALL_ZERO_GAME_LOG },
      gameLogThrough: { 2025: 17 },
    });
    await page.goto(`/player/${PLAYER.id}`);
    await page.getByTestId("tab-gamelog").click();

    await expect(page.getByTestId("game-log-week")).toHaveCount(15);
    await expect(page.getByTestId("game-log-gap")).toHaveCount(2);

    const wk1 = page.getByTestId("player-modal-log").locator('[data-week="1"]');
    await expect(wk1).toContainText("0");
    await expect(wk1).toContainText("1%");
  });

  // The rule this whole feature rests on: a chart is more convincing than
  // prose, so it is more dangerous to get wrong. A mark for a week nobody
  // played would visually assert a game that never happened.
  test.describe("summary tab charts", () => {
    test("the weekly points chart draws one bar per played week, not one per week in the season", async ({ page }) => {
      // MOCK_GAME_LOG plays weeks 1, 2 and 4 of an 18-week season -- three
      // played weeks, one real gap (week 3) sitting between two of them.
      await mockPlayer(page);
      await page.goto(`/player/${PLAYER.id}`);

      const chart = page.getByTestId("weekly-points-chart");
      await expect(chart).toBeVisible();
      await expect(chart.getByTestId("chart-mark")).toHaveCount(MOCK_GAME_LOG.length);
      // Week 3 is the gap in the fixture: it must produce no mark at all,
      // not a mark sitting at zero.
      await expect(chart.locator('[data-week="3"]')).toHaveCount(0);
    });

    test("the snap share chart draws one point per played week", async ({ page }) => {
      await mockPlayer(page);
      await page.goto(`/player/${PLAYER.id}`);

      const chart = page.getByTestId("snap-share-chart");
      await expect(chart).toBeVisible();
      await expect(chart.getByTestId("chart-mark")).toHaveCount(MOCK_GAME_LOG.length);
    });

    // Latu's case again: fifteen played weeks, every one of them a real
    // zero. A chart that dropped these marks would look identical to one
    // for a player who never took the field, which is a different fact.
    test("an all-zero player still gets a bar at zero height for every played week, axis intact", async ({ page }) => {
      await mockPlayer(page, {
        gameLogs: { 2025: ALL_ZERO_GAME_LOG },
        gameLogThrough: { 2025: 17 },
      });
      await page.goto(`/player/${PLAYER.id}`);

      const chart = page.getByTestId("weekly-points-chart");
      const marks = chart.getByTestId("chart-mark");
      await expect(marks).toHaveCount(ALL_ZERO_GAME_LOG.length);

      const heights = await marks.evaluateAll((els) => els.map((el) => Number(el.getAttribute("height"))));
      expect(heights.every((h) => h === 0)).toBe(true);

      // toBeVisible() is unreliable for a thin SVG <line>: Chromium's
      // bounding box for the stroke is non-empty but Playwright's hit-test
      // at its center still misses a 1px horizontal stroke. Presence in the
      // DOM is the actual claim under test -- the axis is drawn, not erased
      // because every value is zero.
      await expect(chart.getByTestId("chart-axis")).toHaveCount(1);
    });

    test("each chart names the season it covers", async ({ page }) => {
      await mockPlayer(page);
      await page.goto(`/player/${PLAYER.id}`);

      await expect(page.getByTestId("weekly-points-chart")).toContainText("2025");
      await expect(page.getByTestId("snap-share-chart")).toContainText("2025");
    });
  });
});
