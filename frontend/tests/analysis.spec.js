import { test, expect } from "@playwright/test";
import { DRAFT_ID, makeCompletedDraft } from "./fixtures.js";

import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");

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

// Derived from makeCompletedDraft() by running analyzeDraft over it, not
// quoted from anywhere: team 1 picks at overall 1, 8 and 9 in a 4-team snake.
// Every structural assertion above passes even if the two cards are swapped or
// a raw pick number is rendered where a delta belongs -- which, on a page whose
// sign convention was stated backwards three times during design, is exactly
// the seam a future inversion lands in. These pin the numbers themselves.
test("the analysis renders the actual computed numbers", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=analysis");
  const panel = page.getByTestId("analysis-panel");

  await expect(panel).toContainText("-0.7");
  await expect(panel).toContainText("4 of 4");

  const best = page.getByTestId("best-vs-adp");
  await expect(best).toContainText("Stefon Diggs");
  await expect(best).toContainText("pick 9");
  await expect(best).toContainText("-0.1");

  const worst = page.getByTestId("worst-vs-adp");
  await expect(worst).toContainText("Davante Adams");
  await expect(worst).toContainText("pick 8");
  await expect(worst).toContainText("-0.4");
});

test("swapping the two cards would be visible: each names its own player", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=analysis");

  await expect(page.getByTestId("best-vs-adp")).not.toContainText("Davante Adams");
  await expect(page.getByTestId("worst-vs-adp")).not.toContainText("Stefon Diggs");
});

test("the longest wait reports the span and the players who went during it", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=analysis");
  const panel = page.getByTestId("analysis-panel");

  // Team 1 picks at 1 then 8, so six players go in between.
  await expect(panel).toContainText("between 1 and 8");
  await expect(panel).toContainText("Justin Jefferson");
});

test("an unrelated query parameter survives switching tabs", async ({ page }) => {
  await page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: makeCompletedDraft() }));
  await page.goto(`/draft/${DRAFT_ID}/results?keep=me`);
  await expect(page.getByRole("heading", { name: "Draft Results" })).toBeVisible();

  await page.getByTestId("view-tab-analysis").click();
  await expect(page).toHaveURL(/keep=me/);
  await expect(page).toHaveURL(/view=analysis/);

  await page.getByTestId("view-tab-picks").click();
  await expect(page).toHaveURL(/keep=me/);
  await expect(page).not.toHaveURL(/view=/);
});

test("the tier haul is shown", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=analysis");
  // The fixture's first twelve players are all tier 1 or 2.
  await expect(page.getByTestId("tier-haul")).toContainText("Tier 1");
});

test("players with no roster slot are named", async ({ page }) => {
  const draft = makeCompletedDraft();
  // One dedicated RB slot, but team 1 drafts three players -- two have nowhere
  // to go, and the page should say so rather than silently dropping them.
  draft.rosterSlots = ["RB"];
  await openResults(page, draft, "?view=analysis");

  await expect(page.getByTestId("roster-extra")).toBeVisible();
});

test("no rank is claimed while the teams have picked unequally", async ({ page }) => {
  const draft = makeCompletedDraft();
  // Strip team 2's picks so the pick counts are uneven.
  draft.picks = draft.picks.filter((p) => p.team !== 2);
  draft.completed = false;

  await openResults(page, draft, "?view=analysis");
  const panel = page.getByTestId("analysis-panel");

  await expect(panel).toContainText(/Ranking waits until/i);
  await expect(panel).not.toContainText(/of 4 in this draft/i);
});

test("a rank is claimed once every team has picked equally", async ({ page }) => {
  await openResults(page, makeCompletedDraft(), "?view=analysis");
  await expect(page.getByTestId("analysis-panel")).toContainText("4 of 4 in this draft");
});

test("screenshot — draft analysis", async ({ page }) => {
  // The shell is h-dvh and the routes wrapper scrolls, so the document is
  // always viewport height and fullPage captures nothing extra. Grow the
  // viewport instead.
  await page.setViewportSize({ width: 1280, height: 1010 });
  await openResults(page, makeCompletedDraft(), "?view=analysis");
  await expect(page.getByTestId("analysis-panel")).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOTS}/analysis.png`, fullPage: false });
});
