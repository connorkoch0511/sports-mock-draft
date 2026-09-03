import { test, expect } from "@playwright/test";
import { MOCK_GAME_LOG } from "./fixtures.js";

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
        player: { ...PLAYER, gameLog: MOCK_GAME_LOG, gameLogSeason: 2025, gameLogThrough: 18, ...over },
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

  test("shows the same game log the dialog does", async ({ page }) => {
    await mockPlayer(page);
    await page.goto(`/player/${PLAYER.id}`);

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

    await expect(page.getByTestId("player-modal-log-error")).toBeVisible();
  });
});
