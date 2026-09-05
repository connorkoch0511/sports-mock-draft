import { test, expect } from "@playwright/test";
import { DRAFT_ID, makeDraftState, mockDraftApis } from "./fixtures.js";
import { signIn } from "./auth.js";

// Pausing stops the auto-pick timer so the layout is measured against a
// stable DOM rather than one mutating between the two boundingBox() calls.
async function openPausedDraft(page) {
  mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("panel-rosters")).toBeVisible();
}

test.describe("Draft layout", () => {
  test("roster panel sits beside the other columns at 1440px", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
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
    await page.setViewportSize({ width: 1440, height: 900 });
    await openPausedDraft(page);

    // Both lists paginate at 25 rows, which is more than fits in a 900px
    // viewport, so each of these must be clipped and internally scrollable.
    for (const id of ["scroll-big-board", "scroll-draft-board"]) {
      const metrics = await page
        .getByTestId(id)
        .evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      expect(metrics.scroll, `${id} scrollHeight`).toBeGreaterThan(metrics.client);
      // A collapsed panel (clientHeight 0) would satisfy the assertion above
      // vacuously -- require it to still be a real, visible panel.
      expect(metrics.client, `${id} clientHeight`).toBeGreaterThan(100);
    }
  });

  // The shell is h-dvh, and nothing outside it may impose a taller floor:
  // a floor taller than the shell makes the document scrollable behind it,
  // giving a second scrollbar and a clipped first paint.
  //
  // Scope, stated honestly: headless Chromium has no dynamic browser
  // toolbar, so 100dvh and 100vh resolve to the same number here. This
  // test therefore CANNOT catch a regression from h-dvh back to h-screen,
  // nor a re-added `min-height: 100vh` on body or #root -- both measure
  // identical to correct in this environment (verified: restoring those
  // floors leaves this test green). It catches any floor LARGER than the
  // viewport (verified: 120vh fails it) and anything else that makes the
  // shell, #root, or body taller than the visible area. The vh-vs-dvh
  // difference is only observable on a real mobile browser.
  test("the shell is exactly viewport height, with nothing forcing it taller", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const m = await page.evaluate(() => {
      const shell = document.querySelector("#root > div");
      return {
        shell: Math.round(shell.getBoundingClientRect().height),
        root: Math.round(document.querySelector("#root").getBoundingClientRect().height),
        body: Math.round(document.body.getBoundingClientRect().height),
        inner: window.innerHeight,
      };
    });

    expect(m.shell, "shell height").toBe(m.inner);
    expect(m.root, "#root height").toBe(m.inner);
    expect(m.body, "body height").toBe(m.inner);
  });

  // Boards.jsx used to read this list from localStorage, seeded here
  // directly. It now reads GET /me/boards from the server, so the mock
  // below stands in for it.
  test("a long page still scrolls after the shell gains a fixed height", async ({ page }) => {
    await signIn(page);
    const boards = Array.from({ length: 50 }, (_, i) => ({
      id: `layout-b${i}`,
      name: `Board ${i}`,
      format: "ppr",
      season: 2026,
      updatedAt: Date.now() - i,
    }));
    await page.route("**/me/boards", (route) => route.fulfill({ json: { boards } }));

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

  // Below xl the three-column layout does not apply, so the height must NOT be
  // bound -- the page falls back to document flow and the routes wrapper
  // scrolls it. Binding the height at these widths compresses each stacked
  // panel to a fraction of the viewport; at 390px it collapsed the Big Board
  // to 0px and no player was clickable.
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1024, 768],
  ]) {
    test(`big board still lists players at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openPausedDraft(page);

      const visibleRows = await page.getByTestId("scroll-big-board").evaluate((el) => {
        const panel = el.getBoundingClientRect();
        return Array.from(el.querySelectorAll("button")).filter((b) => {
          const r = b.getBoundingClientRect();
          return r.bottom > panel.top && r.top < panel.bottom;
        }).length;
      });

      expect(visibleRows, "player rows visible in the Big Board").toBeGreaterThan(2);
    });
  }
});
