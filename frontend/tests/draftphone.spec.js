import { test, expect } from "@playwright/test";
import { BOARD_ID, DRAFT_ID, makeBoardState, makeDraftState, mockDraftApis } from "./fixtures.js";
import { signIn } from "./auth.js";
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");

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

    // Both axes. The per-panel width checks below catch a panel that
    // overflows, but nothing else on the page was covered -- and the top bar
    // is a flex-wrap row that has burst its bounds twice before.
    const horizontal = await page.evaluate(() => ({
      docScrollWidth: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(horizontal.docScrollWidth).toBeLessThanOrEqual(horizontal.inner);
  });

  // Every other phone test runs a draft with no board attached, which is the
  // one configuration with slack to spare: measured, scroll-big-board sits at
  // about 164px against its own min-h-[160px] floor. A board adds the
  // "drafting off your board" note to a panel with roughly 4px to give, and
  // attaching a board is the app's central feature. If this fails, the fix is
  // inside the panel's density, not a number in this test.
  test("a draft with a board attached still fits the screen", async ({ page }) => {
    const state = { ...makeDraftState({ currentIndex: 0 }), boardId: BOARD_ID };
    mockDraftApis(page, state);
    await page.route(`**/boards/${BOARD_ID}`, (r) => r.fulfill({ json: makeBoardState() }));
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("tab-bar")).toBeVisible();

    const bar = await page.getByTestId("tab-bar").boundingBox();
    expect(bar.y + bar.height).toBeLessThanOrEqual(844);

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
  //
  // Width alone isn't enough, though: a grid item's default min-width is
  // min-content, so without max-lg:min-w-0 the wrapper refuses to shrink
  // below the draft board table's min-w-[620px] and inflates to match it --
  // "panel width equals wrapper width" then holds at 656px in a 390px
  // viewport, both wrong together. The viewport-width check below is what
  // catches that: a fixed offset (root is overflow-x-hidden) rather than an
  // out-of-bounds scroll.
  test("each tab's panel fills its band, not just part of it", async ({ page }) => {
    await openDraft(page);

    const tabs = [
      { tab: "tab-board", panel: "panel-big-board" },
      { tab: "tab-draft", panel: "panel-draft-board" },
      { tab: "tab-rosters", panel: "panel-rosters" },
    ];

    const tabBarBox = await page.getByTestId("tab-bar").boundingBox();
    const viewportWidth = page.viewportSize().width;

    for (const { tab, panel } of tabs) {
      await page.getByTestId(tab).click();
      await expect(page.getByTestId(panel)).toBeVisible();

      const { panelRect, wrapperRect } = await page.getByTestId(panel).evaluate((el) => ({
        panelRect: el.getBoundingClientRect().toJSON(),
        wrapperRect: el.parentElement.getBoundingClientRect().toJSON(),
      }));

      expect(panelRect.width).toBeGreaterThanOrEqual(wrapperRect.width - 4);
      expect(panelRect.width).toBeLessThanOrEqual(viewportWidth);
      expect(panelRect.bottom).toBeLessThanOrEqual(tabBarBox.y + 4);
    }

    // The designed behaviour for a wide table on a narrow screen: the table
    // scrolls horizontally inside its own panel, rather than the panel (or
    // the page) growing to fit it.
    await page.getByTestId("tab-draft").click();
    const { scrollWidth, clientWidth } = await page.getByTestId("scroll-draft-board").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeGreaterThan(clientWidth);
  });

  test("the strip is on every tab, and carries Pause", async ({ page }) => {
    await openDraft(page);

    for (const t of ["tab-board", "tab-draft", "tab-rosters"]) {
      await page.getByTestId(t).click();
      await expect(page.getByTestId("status-strip")).toBeVisible();
      await expect(
        page.getByTestId("status-strip").getByRole("button", { name: /Pause|Resume/ })
      ).toBeVisible();
    }
  });

  // Five wrapped rows of controls was half of what made this page unusable.
  // These are all set-once -- which board drives your auto-pick, whether to
  // notify, who to invite -- so they belong behind the sheet, not in the way.
  // The mirror of the desktop absence test. A header merely hidden on a phone
  // would leave every value the strip shows duplicated in the DOM -- the same
  // hazard, pointed the other way, and the strip gains more in Task 3.
  test("the desktop header is not in the phone DOM at all", async ({ page }) => {
    await openDraft(page);
    await expect(page.getByTestId("desktop-header")).toHaveCount(0);
    await expect(page.getByTestId("status-strip")).toBeVisible();
  });

  // role="dialog" is a promise about behaviour. Escape is the key everyone
  // tries first, and focus has to land inside rather than behind the backdrop.
  test("the sheet takes focus and closes on Escape", async ({ page }) => {
    await openDraft(page);
    await page.getByTestId("open-controls").click();

    const sheet = page.getByTestId("control-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    await expect(sheet).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  // The sheet's own controls have to stay usable for longer than one tick. The
  // focus effect used to take `onClose` -- an inline arrow recreated on every
  // render -- so the 1s countdown re-ran it every second, restoring focus and
  // immediately re-stealing it. Measured before the fix: focus placed on the
  // board select was back on the panel within 1.6s. The existing "takes focus
  // on open" test passed BECAUSE of that bug, since the panel was re-focused
  // whenever it was sampled.
  test("focus stays where you put it inside the sheet", async ({ page }) => {
    await openDraft(page);
    await page.getByTestId("open-controls").click();
    const sheet = page.getByTestId("control-sheet");
    await expect(sheet).toBeVisible();

    const select = sheet.getByTestId("seat-board");
    await select.focus();
    await expect(select).toBeFocused();

    // Longer than the countdown tick that used to steal it.
    await page.waitForTimeout(1600);
    await expect(select).toBeFocused();
  });

  // Every control in the sheet is gated on !completed, so ⋯ would open a sheet
  // holding nothing but its grab handle -- and View Results lived only in the
  // desktop header, leaving a phone user who just finished a draft with no way
  // to its results except leaving the page entirely.
  test("a finished draft offers its results, not an empty sheet", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    const completed = { ...state, currentIndex: state.picks.length, completed: true };
    await page.route("**/players*", (r) => r.fulfill({ json: { players: [] } }));
    await page.route(`**/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: completed }));
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("status-strip")).toBeVisible();

    await expect(page.getByTestId("open-controls")).toHaveCount(0);
    const results = page.getByTestId("strip-results");
    await expect(results).toBeVisible();
    await expect(results).toHaveAttribute("href", `/draft/${DRAFT_ID}/results`);
  });

  test("the setup controls are in the sheet, not the strip", async ({ page }) => {
    await openDraft(page);

    // The header is absent on a phone, so closed there are zero copies of
    // these anywhere -- count, not visibility, is the honest assertion.
    const ids = ["seat-board", "copy-invite", "notify-toggle"];
    for (const id of ids) await expect(page.getByTestId(id)).toBeHidden();
    await expect(page.getByRole("button", { name: "Auto Pick" })).toBeHidden();

    await page.getByTestId("open-controls").click();
    const sheet = page.getByTestId("control-sheet");
    await expect(sheet).toBeVisible();

    // Scoped to the sheet. There is exactly one copy now that the header is
    // absent on a phone, so this is belt-and-braces -- but it keeps the
    // assertion honest if the header ever comes back at this width.
    for (const id of ids) await expect(sheet.getByTestId(id)).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Auto Pick" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Sim to End" })).toBeVisible();

    await page.getByTestId("close-controls").click();
    await expect(page.getByTestId("control-sheet")).toBeHidden();
  });

  // ESPN's clock turns gold when you are up. The strip has to say "you" in a
  // way that survives being glanced at, and it has to be the shortest route
  // to the board -- the notification-to-pick path is one tap.
  test("your turn is visible in the strip, and tapping it goes to the board", async ({ page }) => {
    await openDraft(page);
    await expect(page.getByTestId("strip-status")).toContainText("your pick");
    await expect(page.getByTestId("status-strip")).toHaveAttribute("data-your-turn", "true");

    await page.getByTestId("tab-rosters").click();
    await expect(page.getByTestId("panel-rosters")).toBeVisible();

    await page.getByTestId("strip-status").click();
    await expect(page.getByTestId("panel-big-board")).toBeVisible();
  });

  // The opposite of helpful: moving somebody's view while they are reading.
  // The strip and the push notification already tell them.
  test("the turn changing does not move you off the tab you are on", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 1 });
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("tab-bar")).toBeVisible();

    await page.getByTestId("tab-rosters").click();
    await expect(page.getByTestId("panel-rosters")).toBeVisible();

    // Advance the draft under the page the way the 3s poll would see it.
    state.currentIndex = 0;
    await page.waitForTimeout(4000);

    await expect(page.getByTestId("strip-status")).toContainText("your pick");
    await expect(page.getByTestId("panel-rosters")).toBeVisible();
    await expect(page.getByTestId("panel-big-board")).toBeHidden();
  });
});

test("no strip or sheet button at desktop width", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0 });
  mockDraftApis(page, state);
  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
  // Not just hidden -- absent. A display:none twin would still match these
  // locators, which is exactly what made pre-existing unscoped getByText
  // assertions elsewhere ambiguous; see useIsPhone.js.
  await expect(page.getByTestId("status-strip")).toHaveCount(0);
  await expect(page.getByTestId("open-controls")).toHaveCount(0);
  // The desktop header still has its own controls, in place.
  await expect(page.getByTestId("seat-board")).toBeVisible();
  await expect(page.getByTestId("copy-invite")).toBeVisible();
});

// The other half of the contract: none of this exists on a desktop.
test("no tab bar at desktop width", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0 });
  mockDraftApis(page, state);
  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
  await expect(page.getByTestId("tab-bar")).toHaveCount(0);
  await expect(page.getByTestId("panel-draft-board")).toBeVisible();
  await expect(page.getByTestId("panel-rosters")).toBeVisible();
});

// Belt-and-braces for the whole class of bug: the strip repeated the
// header's text ("✅ Completed", the countdown), and toBeHidden() alone
// wouldn't have caught it -- a display:none element still matches locators,
// so an unscoped getByText elsewhere silently became a strict-mode
// violation. useIsPhone.js keeps this chrome fully out of the desktop DOM,
// not just hidden by a max-lg: class, so it can't recur as Task 3 adds more
// to the strip.
test("the phone chrome is not in the desktop DOM at all", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0 });
  mockDraftApis(page, state);
  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();

  // Not "hidden" -- absent. A display:none twin still matches locators, which
  // is what made two pre-existing unscoped getByText assertions ambiguous.
  await expect(page.getByTestId("status-strip")).toHaveCount(0);
  await expect(page.getByTestId("tab-bar")).toHaveCount(0);
  await expect(page.getByTestId("open-controls")).toHaveCount(0);
  // ...and the header it replaces is present, which is what makes the
  // absences above meaningful rather than a page that failed to render.
  await expect(page.getByTestId("desktop-header")).toHaveCount(1);
});

test.describe("phone screenshot", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("draft page on a phone", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("tab-bar")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/draft-phone.png` });
  });
});
