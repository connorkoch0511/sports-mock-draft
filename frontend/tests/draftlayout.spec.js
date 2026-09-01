import { test, expect } from "@playwright/test";
import { MOCK_PLAYERS, DRAFT_ID, makeDraftState } from "./fixtures.js";

const API = "http://localhost:9999";

function mockDraftApis(page, draftState) {
  page.route(`${API}/players*`, async (route) => {
    await route.fulfill({ json: { players: MOCK_PLAYERS } });
  });
  page.route(`${API}/drafts/${DRAFT_ID}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: draftState });
    }
  });
}

// Pausing stops the auto-pick timer so the layout is measured against a
// stable DOM rather than one mutating between the two boundingBox() calls.
async function openPausedDraft(page) {
  mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("panel-rosters")).toBeVisible();
}

test.describe("Draft layout", () => {
  test("roster panel sits beside the other columns at 1440px", async ({ page }) => {
    await openPausedDraft(page);

    const draftBoard = await page.getByTestId("panel-draft-board").boundingBox();
    const rosters = await page.getByTestId("panel-rosters").boundingBox();

    // Three columns: rosters begins to the right of the draft board's right
    // edge. When the layout wraps to two columns, rosters spans the full
    // width on a second row, so its x is at the container's left edge and
    // its top is below the draft board's bottom -- both assertions fail.
    expect(rosters.x).toBeGreaterThan(draftBoard.x + draftBoard.width - 1);
    expect(rosters.y).toBeLessThan(draftBoard.y + draftBoard.height);
  });
});
