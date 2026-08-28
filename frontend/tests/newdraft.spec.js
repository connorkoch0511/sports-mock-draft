import { test, expect } from "@playwright/test";
import { DRAFT_ID } from "./fixtures.js";

const API = "http://localhost:9999";

test.describe("New Draft page", () => {
  test("default form values are 12 teams, 15 rounds, standard format", async ({ page }) => {
    await page.goto("/draft/new");

    await expect(page.getByLabel("Teams")).toHaveValue("12");
    await expect(page.getByLabel("Rounds")).toHaveValue("15");
    await expect(page.getByLabel("ADP Format")).toHaveValue("standard");
  });

  test("user can change teams, rounds, and format", async ({ page }) => {
    await page.goto("/draft/new");

    await page.getByLabel("Teams").fill("8");
    await page.getByLabel("Rounds").fill("10");
    await page.getByLabel("ADP Format").selectOption("ppr");

    await expect(page.getByLabel("Teams")).toHaveValue("8");
    await expect(page.getByLabel("Rounds")).toHaveValue("10");
    await expect(page.getByLabel("ADP Format")).toHaveValue("ppr");
  });

  test("clicking Start Mock Draft navigates to draft page", async ({ page }) => {
    await page.route(`${API}/drafts`, async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ json: { draftId: DRAFT_ID } });
      }
    });

    await page.goto("/draft/new");
    await page.getByRole("button", { name: /Start Mock Draft/i }).click();
    await expect(page).toHaveURL(`/draft/${DRAFT_ID}`);
  });

  test("shows error message when API call fails", async ({ page }) => {
    await page.route(`${API}/drafts`, async (route) => {
      await route.fulfill({ status: 500, json: { error: "Server error" } });
    });

    await page.goto("/draft/new");
    await page.getByRole("button", { name: /Start Mock Draft/i }).click();

    await expect(page.getByText(/Server error|Failed to create draft/i)).toBeVisible();
  });
});
