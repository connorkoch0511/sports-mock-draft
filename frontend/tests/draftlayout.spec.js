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

  // The panel-bottom assertion is the load-bearing one. Once the routes
  // wrapper scrolls, documentElement.scrollHeight equals innerHeight even
  // when content overflows inside it -- so "the document does not scroll"
  // alone would pass with the layout still broken.
  for (const width of [1280, 1440, 1536]) {
    test(`panels stay inside the viewport at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPausedDraft(page);

      const documentScrolls = await page.evaluate(
        () => document.documentElement.scrollHeight > window.innerHeight + 2
      );
      expect(documentScrolls).toBe(false);

      for (const id of ["panel-big-board", "panel-draft-board", "panel-rosters"]) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box.y + box.height, `${id} bottom edge`).toBeLessThanOrEqual(902);
        // A panel collapsed to nothing would satisfy the bound above, so
        // require it to still be a real panel.
        expect(box.height, `${id} height`).toBeGreaterThan(200);
      }
    });
  }

  test("panels scroll their own overflowing content", async ({ page }) => {
    await openPausedDraft(page);

    // Both lists paginate at 25 rows, which is more than fits in a 900px
    // viewport, so each of these must be clipped and internally scrollable.
    for (const id of ["scroll-big-board", "scroll-draft-board"]) {
      const metrics = await page
        .getByTestId(id)
        .evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      expect(metrics.scroll, `${id} scrollHeight`).toBeGreaterThan(metrics.client);
    }
  });

  test("a long page still scrolls after the shell gains a fixed height", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      const boards = Array.from({ length: 50 }, (_, i) => ({
        id: `layout-b${i}`,
        name: `Board ${i}`,
        format: "ppr",
        updatedAt: Date.now() - i,
      }));
      localStorage.setItem("perfectpick.myBoards", JSON.stringify(boards));
    });

    await page.goto("/boards");
    await expect(page.getByTestId("board-list")).toBeVisible();

    // Reachability, not documentElement.scrollHeight: with the shell at a
    // fixed height the routes wrapper scrolls, not the document. What must
    // hold is that the last board can still be scrolled to and seen.
    const last = page.getByRole("button", { name: "Board 49", exact: true });
    await expect(last).not.toBeInViewport();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
  });
});
