import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";
import { DRAFT_ID, makeCompletedDraft } from "./fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");

const API = "http://localhost:9999";

test.describe("Results page", () => {
  test.beforeEach(async ({ page }) => {
    const draft = makeCompletedDraft();
    await page.route(`${API}/drafts/${DRAFT_ID}`, async (route) => {
      await route.fulfill({ json: draft });
    });
  });

  test("renders Draft Results heading and draft metadata", async ({ page }) => {
    await page.goto(`/draft/${DRAFT_ID}/results`);

    await expect(page.getByRole("heading", { name: "Draft Results" })).toBeVisible();
    await expect(page.getByText(/4 teams.*3 rounds/i)).toBeVisible();
    await expect(page.getByText(/STANDARD/i)).toBeVisible();
  });

  test("shows Pick Log table with all picks", async ({ page }) => {
    await page.goto(`/draft/${DRAFT_ID}/results`);

    await expect(page.getByRole("heading", { name: "Pick Log" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "#1", exact: true })).toBeVisible();
    // Player names appear in table cells
    await expect(page.getByRole("cell", { name: /Christian McCaffrey/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Justin Jefferson/ })).toBeVisible();
  });

  test("shows team roster sections", async ({ page }) => {
    await page.goto(`/draft/${DRAFT_ID}/results`);

    await expect(page.getByRole("heading", { name: "Team 1" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Team 2" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Team 3" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Team 4" })).toBeVisible();
  });

  test("players appear in correct team rosters", async ({ page }) => {
    await page.goto(`/draft/${DRAFT_ID}/results`);

    // Pick #1 overall is Team 1 — should find McCaffrey in the roster panel
    const team1Roster = page.locator(".rounded-3xl").filter({ hasText: /^Team 1/ }).last();
    await expect(team1Roster.getByText("Christian McCaffrey").first()).toBeVisible();
  });

  test("Copy Share Link button triggers clipboard write", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/draft/${DRAFT_ID}/results`);

    await page.getByRole("button", { name: "Copy Share Link" }).click();

    await expect(page.getByRole("button", { name: /Copied/i })).toBeVisible();
  });

  test("Export CSV button triggers a download", async ({ page }) => {
    await page.goto(`/draft/${DRAFT_ID}/results`);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export CSV" }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/perfectpick.*\.csv/);
  });

  test("Export JSON button triggers a download", async ({ page }) => {
    await page.goto(`/draft/${DRAFT_ID}/results`);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export JSON" }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/perfectpick.*\.json/);
  });

  test("Back to Draft link navigates to draft page", async ({ page }) => {
    await page.goto(`/draft/${DRAFT_ID}/results`);

    await page.getByRole("link", { name: "Back to Draft" }).click();
    await expect(page).toHaveURL(`/draft/${DRAFT_ID}`);
  });

  test("New Draft link navigates to home page", async ({ page }) => {
    await page.goto(`/draft/${DRAFT_ID}/results`);

    await page.getByRole("link", { name: "New Draft" }).click();
    await expect(page).toHaveURL("/");
  });

  test("screenshot — results page", async ({ page }) => {
    await page.goto(`/draft/${DRAFT_ID}/results`);

    await expect(page.getByRole("heading", { name: "Draft Results" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Christian McCaffrey/ })).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOTS}/results.png`, fullPage: false });
  });
});
