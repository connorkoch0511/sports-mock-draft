import { test, expect } from "@playwright/test";
import { DRAFT_ID, makeDraftState, mockDraftApis } from "./fixtures.js";
import { signIn } from "./auth.js";

// Everything phone-shaped lives in this file so the rest of the suite keeps
// running at the desktop viewport that is the design's regression net.
test.describe("the draft page on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function openDraft(page) {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("tab-bar")).toBeVisible();
  }

  const scroller = (page) =>
    page.evaluate(() => {
      const el = document.querySelector('[class*="overflow-y-auto"]');
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });

  // The measurement that opened the spec, inverted into an assertion: this
  // page was 6,333px against a 776px screen, 8.2 screens of scrolling.
  test("the page fits its screen instead of running 8 screens deep", async ({ page }) => {
    await openDraft(page);
    const { scrollHeight, clientHeight } = await scroller(page);
    expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 8);
  });

  test("each tab shows its own panel and hides the others", async ({ page }) => {
    await openDraft(page);

    await expect(page.getByTestId("panel-big-board")).toBeVisible();
    await expect(page.getByTestId("panel-draft-board")).toBeHidden();
    await expect(page.getByTestId("panel-rosters")).toBeHidden();

    await page.getByTestId("tab-draft").click();
    await expect(page.getByTestId("panel-draft-board")).toBeVisible();
    await expect(page.getByTestId("panel-big-board")).toBeHidden();

    await page.getByTestId("tab-rosters").click();
    await expect(page.getByTestId("panel-rosters")).toBeVisible();
    await expect(page.getByTestId("panel-draft-board")).toBeHidden();
  });

  // Panels stay mounted precisely so this holds. A "simplification" to
  // conditional rendering, or to visibility/absolute positioning, fails here:
  // both reset scrollTop, while display:none preserves it.
  test("leaving a tab and coming back keeps your place in it", async ({ page }) => {
    await openDraft(page);

    const list = page.getByTestId("scroll-big-board");
    await list.evaluate((el) => { el.scrollTop = 300; });
    const before = await list.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(0);

    await page.getByTestId("tab-rosters").click();
    await expect(page.getByTestId("panel-rosters")).toBeVisible();
    await page.getByTestId("tab-board").click();
    await expect(page.getByTestId("panel-big-board")).toBeVisible();

    expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
  });

  // The wrapper's cross axis is height (row direction, stretch) so height was
  // always right; width is the wrapper's main axis, so a panel that doesn't
  // explicitly claim it sizes to its own content and sits in half the band.
  // Measured on the rosters tab at 390x844: wrapper 334px wide, panel 171px --
  // the Team Rosters panel occupying only the left half of the screen.
  test("each tab's panel fills its band, not just part of it", async ({ page }) => {
    await openDraft(page);

    const tabs = [
      { tab: "tab-board", panel: "panel-big-board" },
      { tab: "tab-draft", panel: "panel-draft-board" },
      { tab: "tab-rosters", panel: "panel-rosters" },
    ];

    const tabBarBox = await page.getByTestId("tab-bar").boundingBox();

    for (const { tab, panel } of tabs) {
      await page.getByTestId(tab).click();
      await expect(page.getByTestId(panel)).toBeVisible();

      const { panelRect, wrapperRect } = await page.getByTestId(panel).evaluate((el) => ({
        panelRect: el.getBoundingClientRect().toJSON(),
        wrapperRect: el.parentElement.getBoundingClientRect().toJSON(),
      }));

      expect(panelRect.width).toBeGreaterThanOrEqual(wrapperRect.width - 4);
      expect(panelRect.bottom).toBeLessThanOrEqual(tabBarBox.y + 4);
    }
  });
});

// The other half of the contract: none of this exists on a desktop.
test("no tab bar at desktop width", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0 });
  mockDraftApis(page, state);
  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
  await expect(page.getByTestId("tab-bar")).toBeHidden();
  await expect(page.getByTestId("panel-draft-board")).toBeVisible();
  await expect(page.getByTestId("panel-rosters")).toBeVisible();
});
