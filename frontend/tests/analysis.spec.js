import { test, expect } from "@playwright/test";
import { DRAFT_ID, makeCompletedDraft } from "./fixtures.js";

const API = "http://localhost:9999";

async function openResults(page, draft = makeCompletedDraft(), query = "") {
  await page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: draft }));
  await page.goto(`/draft/${DRAFT_ID}/results${query}`);
  await expect(page.getByRole("heading", { name: "Draft Results" })).toBeVisible();
}

test("the pick log is the default view", async ({ page }) => {
  await openResults(page);
  await expect(page.getByRole("heading", { name: "Pick Log" })).toBeVisible();
  await expect(page.getByTestId("analysis-panel")).toHaveCount(0);
});

test("?view=analysis opens the analysis directly", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=analysis");
  await expect(page.getByTestId("analysis-panel")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pick Log" })).toHaveCount(0);
});

test("switching tabs updates the URL, and the URL survives a reload", async ({ page }) => {
  await openResults(page);

  await page.getByTestId("view-tab-analysis").click();
  await expect(page).toHaveURL(/view=analysis/);
  await expect(page.getByTestId("analysis-panel")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("analysis-panel")).toBeVisible();

  await page.getByTestId("view-tab-picks").click();
  await expect(page.getByRole("heading", { name: "Pick Log" })).toBeVisible();
});

test("an unrecognised view falls back to the pick log", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=nonsense");
  await expect(page.getByRole("heading", { name: "Pick Log" })).toBeVisible();
  await expect(page.getByTestId("analysis-panel")).toHaveCount(0);
});

test("the analysis names your team and its rank against the field", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=analysis");

  const panel = page.getByTestId("analysis-panel");
  await expect(panel).toContainText("Team 1");
  await expect(panel).toContainText(/of 4/i);
});

test("the analysis reports how many picks could not be scored", async ({ page }) => {
  const draft = makeCompletedDraft();
  draft.picks[0].player.adp = null;

  await openResults(page, draft, "?view=analysis");

  await expect(page.getByTestId("unscoreable-note")).toContainText("1");
});

test("no unscoreable note when every pick has an ADP", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=analysis");
  await expect(page.getByTestId("unscoreable-note")).toHaveCount(0);
});

test("a completed draft links to its analysis from My Drafts", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "perfectpick.myDrafts",
      JSON.stringify([
        {
          id: "test-draft-abc123",
          teams: 4,
          rounds: 3,
          format: "standard",
          userTeam: 1,
          boardId: null,
          completed: true,
          owned: true,
          updatedAt: Date.now(),
        },
      ])
    )
  );

  await page.goto("/drafts");
  await page.getByTestId("analysis-link").click();

  await expect(page).toHaveURL(/\/draft\/test-draft-abc123\/results\?view=analysis$/);
});

test("an in-progress draft has no analysis link", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "perfectpick.myDrafts",
      JSON.stringify([
        {
          id: "in-progress-1",
          teams: 4,
          rounds: 3,
          format: "standard",
          userTeam: 1,
          boardId: null,
          completed: false,
          owned: true,
          updatedAt: Date.now(),
        },
      ])
    )
  );

  await page.goto("/drafts");
  await expect(page.getByTestId("draft-row")).toHaveCount(1);
  await expect(page.getByTestId("analysis-link")).toHaveCount(0);
});
