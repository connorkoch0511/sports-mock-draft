import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { DRAFT_ID, makeDraftState, mockDraftApis, MOCK_GAME_LOG } from "./fixtures.js";

const API = "http://localhost:9999";
const SCREENSHOTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../screenshots"
);
const MCCAFFREY = "Christian McCaffrey";

const rowFor = (page, name) =>
  page.getByTestId("big-board-row").filter({ hasText: name });

async function openDraft(page, state = makeDraftState({ currentIndex: 0 })) {
  mockDraftApis(page, state);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
}

test.describe("player drill-down", () => {
  test("clicking a row opens the player, and never drafts him", async ({ page }) => {
    let picks = 0;
    await page.route(`${API}/drafts/${DRAFT_ID}/pick`, (r) => {
      picks += 1;
      return r.fulfill({ json: { ok: true } });
    });
    await openDraft(page);

    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();

    const modal = page.getByTestId("player-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(MCCAFFREY);
    expect(picks, "opening a player must send no pick").toBe(0);
  });

  test("the Draft button is the only thing that drafts", async ({ page }) => {
    let picks = 0;
    await page.route(`${API}/drafts/${DRAFT_ID}/pick`, (r) => {
      picks += 1;
      return r.fulfill({ json: { ok: true } });
    });
    // Deliberately NOT paused: pausing disables picking, so the click under
    // test would be swallowed by a disabled button rather than proving
    // anything.
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    await page.goto(`/draft/${DRAFT_ID}`);

    await rowFor(page, MCCAFFREY).getByTestId("draft-player").click();

    await expect(() => expect(picks).toBe(1)).toPass();
    await expect(page.getByTestId("player-modal")).toHaveCount(0);
  });

  test("the game log shows a week he played", async ({ page }) => {
    await openDraft(page);
    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();

    const log = page.getByTestId("player-modal-log");
    await expect(log).toBeVisible();

    // Week 4 from the fixture: 21 carries, 140 yards, 2 TD, 41.5 PPR.
    const wk4 = log.locator('[data-week="4"]');
    await expect(wk4).toContainText("140");
    await expect(wk4).toContainText("41.5");
  });

  // The distinction the whole log rests on. A missed week must read as a gap,
  // not as a week he played and did nothing.
  test("a week he missed reads as did not play, not as zeroes", async ({ page }) => {
    await openDraft(page);
    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();

    const gaps = page.getByTestId("game-log-gap");
    await expect(gaps.first()).toContainText("did not play");
    // Weeks 1, 2 and 4 were played. That leaves week 3 alone, and 5-18 as one
    // run -- two gap rows, not fifteen.
    await expect(gaps).toHaveCount(2);
    await expect(gaps.nth(0)).toContainText("3");
    await expect(gaps.nth(1)).toContainText("5-18");

    const played = page.getByTestId("game-log-week");
    await expect(played).toHaveCount(MOCK_GAME_LOG.length);
  });

  // Week 2 has no rushing TD and no receiving TD in the fixture. He played,
  // so those are real zeroes -- blanks would claim we do not know.
  test("a stat he did not record in a week he played shows as 0", async ({ page }) => {
    await openDraft(page);
    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();

    const wk2 = page.getByTestId("player-modal-log").locator('[data-week="2"]');
    await expect(wk2).toContainText("25");
    await expect(wk2).toContainText("4.9");
  });

  test("snap share is a percentage of the team's snaps", async ({ page }) => {
    await openDraft(page);
    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();

    // Week 1: 40 of 62 offensive snaps.
    const wk1 = page.getByTestId("player-modal-log").locator('[data-week="1"]');
    await expect(wk1).toContainText("65%");
  });

  test("escape closes it and focus returns to the row", async ({ page }) => {
    await openDraft(page);
    const opener = rowFor(page, MCCAFFREY).getByTestId("open-player");
    await opener.click();
    await expect(page.getByTestId("player-modal")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByTestId("player-modal")).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("clicking the backdrop closes it, clicking inside does not", async ({ page }) => {
    await openDraft(page);
    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();

    // Inside first: if this closed the dialog, the backdrop assertion below
    // would pass for the wrong reason. Aimed at the heading rather than the
    // dialog's own corner -- rounded-3xl leaves the backdrop showing through
    // the first few pixels, so a corner click lands outside the shape.
    await page.getByRole("heading", { name: MCCAFFREY }).click();
    await expect(page.getByTestId("player-modal")).toBeVisible();

    // A real click at the top-left of the viewport, which is backdrop and
    // nothing else. Clicking the backdrop locator by position fails
    // actionability -- it is a full-screen element whose centre is the dialog.
    await page.mouse.click(5, 5);
    await expect(page.getByTestId("player-modal")).toHaveCount(0);
  });

  test("the dialog is announced as one", async ({ page }) => {
    await openDraft(page);
    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();

    const modal = page.getByTestId("player-modal");
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal).toHaveAttribute("aria-modal", "true");
    await expect(page.getByRole("dialog")).toContainText(MCCAFFREY);
  });

  test("a player with no game log says so instead of showing an empty table", async ({ page }) => {
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    await page.route(`${API}/players/*`, (r) =>
      r.fulfill({ json: { player: { id: "p1", name: MCCAFFREY, position: "RB", team: "SF" } } })
    );
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();

    await expect(page.getByTestId("player-modal-no-log")).toBeVisible();
    await expect(page.getByTestId("player-modal-log")).toHaveCount(0);
  });

  test("a failed fetch says the log is missing, keeping what the row knew", async ({ page }) => {
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    await page.route(`${API}/players/*`, (r) => r.fulfill({ status: 500, json: { error: "nope" } }));
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();

    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();

    await expect(page.getByTestId("player-modal-log-error")).toBeVisible();
    // The row's own data survives, so the dialog still identifies the player.
    await expect(page.getByTestId("player-modal")).toContainText(MCCAFFREY);
    await expect(page.getByTestId("player-modal")).toContainText("RB");
  });

  test("searching while the dialog is open does not close it", async ({ page }) => {
    await openDraft(page);
    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();
    await expect(page.getByTestId("player-modal")).toBeVisible();

    // McCaffrey is filtered out of the list, but the dialog is not a row.
    await page.getByPlaceholder("Search player…").fill("Kelce");

    await expect(page.getByTestId("player-modal")).toContainText(MCCAFFREY);
  });

  test("a quarterback's log shows passing columns, a back's shows rushing", async ({ page }) => {
    await openDraft(page);

    await rowFor(page, "Josh Allen").getByTestId("open-player").click();
    const qb = page.getByTestId("player-modal-log");
    await expect(qb.locator("th").filter({ hasText: "INT" })).toBeVisible();
    await page.getByTestId("player-modal-close").click();

    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();
    const rb = page.getByTestId("player-modal-log");
    await expect(rb.locator("th").filter({ hasText: "CAR" })).toBeVisible();
    await expect(rb.locator("th").filter({ hasText: "INT" })).toHaveCount(0);
  });

  // The dialog is opened from inside a panel carrying `backdrop-blur`, and a
  // backdrop-filter ancestor becomes the containing block for fixed-position
  // descendants. Rendered in place the overlay measured 418x518 inside the Big
  // Board column instead of covering the viewport -- visibly broken, and
  // invisible to every other assertion here, all of which passed against it.
  test("the overlay covers the viewport, not just the panel it opened from", async ({ page }) => {
    await openDraft(page);
    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();
    await expect(page.getByTestId("player-modal")).toBeVisible();

    const box = await page.evaluate(() => {
      const b = document
        .querySelector('[data-testid="player-modal-backdrop"]')
        .getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight };
    });

    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(Math.round(box.w)).toBe(box.vw);
    expect(Math.round(box.h)).toBe(box.vh);
  });

  test("screenshot — player drill-down", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDraft(page);
    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();
    await expect(page.getByTestId("player-modal-log")).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOTS}/player.png`, fullPage: false });
  });

  // Mid-season the later weeks have not happened. They must not be listed as
  // games this player missed.
  test("a mid-season log stops at the last week played", async ({ page }) => {
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    await page.route(`${API}/players/*`, (r) =>
      r.fulfill({
        json: {
          player: {
            id: "p1", name: MCCAFFREY, position: "RB", team: "SF",
            gameLog: MOCK_GAME_LOG, gameLogSeason: 2025, gameLogThrough: 5,
          },
        },
      })
    );
    await page.goto(`/draft/${DRAFT_ID}`);
    await page.getByRole("button", { name: "Pause" }).click();
    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();

    const log = page.getByTestId("player-modal-log");
    // Weeks 1-5 only: three played, weeks 3 and 5 genuinely missed.
    await expect(log.locator('[data-week="5"]')).toHaveCount(1);
    await expect(log.locator('[data-week="6"]')).toHaveCount(0);
    await expect(page.getByTestId("game-log-gap")).toHaveCount(2);
  });

  test("the card and the dialog both show where the player started", async ({ page }) => {
    await openDraft(page);
    await rowFor(page, MCCAFFREY).getByTestId("open-player").click();

    const start = page.getByTestId("player-modal").getByTestId("starting-point");
    await expect(start).toBeVisible();
    // He is first in the order, so he starts 1st and the base costs nothing.
    await expect(start).toContainText("Starts 1st");
    await expect(start).toContainText("0");
  });

  test("a player further down starts lower, and says by how much", async ({ page }) => {
    await openDraft(page);
    await rowFor(page, "Travis Kelce").getByTestId("open-player").click();

    const start = page.getByTestId("player-modal").getByTestId("starting-point");
    await expect(start).toBeVisible();
    // Kelce is 10th in the pool, so he starts 10th at a base of -9.
    await expect(start).toContainText("Starts 10th");
    await expect(start).toContainText("-9");
  });
});