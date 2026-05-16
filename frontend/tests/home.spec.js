import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";
import { DRAFT_ID } from "./fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");

const API = "http://localhost:9999";

test.describe("Home page", () => {
  test("renders hero and draft controls", async ({ page }) => {
    await page.route(`${API}/drafts`, async (route) => {
      await route.fulfill({ json: { draftId: DRAFT_ID } });
    });

    await page.goto("/");

    await expect(page.getByRole("heading", { name: /Draft smarter/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Start Mock Draft/i })).toBeVisible();
    await expect(page.getByText("PerfectPick • Mock Draft Simulator")).toBeVisible();
  });

  test("default form values are 12 teams, 15 rounds, standard format", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByLabel("Teams")).toHaveValue("12");
    await expect(page.getByLabel("Rounds")).toHaveValue("15");
    await expect(page.getByLabel("ADP Format")).toHaveValue("standard");
  });

  test("user can change teams, rounds, and format", async ({ page }) => {
    await page.goto("/");

    await page.getByLabel("Teams").fill("8");
    await page.getByLabel("Rounds").fill("10");
    await page.getByLabel("ADP Format").selectOption("ppr");

    await expect(page.getByLabel("Teams")).toHaveValue("8");
    await expect(page.getByLabel("Rounds")).toHaveValue("10");
    await expect(page.getByLabel("ADP Format")).toHaveValue("ppr");
  });

  test("feature cards are visible", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("Big Board + Search", { exact: true })).toBeVisible();
    await expect(page.getByText("Snake Draft Engine", { exact: true })).toBeVisible();
    await expect(page.getByText("Smart Auto Picks", { exact: true })).toBeVisible();
  });

  test("clicking Start Mock Draft navigates to draft page", async ({ page }) => {
    await page.route(`${API}/drafts`, async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ json: { draftId: DRAFT_ID } });
      }
    });

    await page.goto("/");
    await page.getByRole("button", { name: /Start Mock Draft/i }).click();
    await expect(page).toHaveURL(`/draft/${DRAFT_ID}`);
  });

  test("shows error message when API call fails", async ({ page }) => {
    await page.route(`${API}/drafts`, async (route) => {
      await route.fulfill({ status: 500, json: { error: "Server error" } });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /Start Mock Draft/i }).click();

    await expect(page.getByText(/Server error|Failed to create draft/i)).toBeVisible();
  });

  test("screenshot — home page", async ({ page }) => {
    await page.route(`${API}/drafts`, async (route) => {
      await route.fulfill({ json: { draftId: DRAFT_ID } });
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Draft smarter/i })).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOTS}/home.png`, fullPage: false });
  });
});
