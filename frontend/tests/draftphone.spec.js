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
    // Wait for the board's own note before measuring. The board fetch resolves
    // after the page is interactive and adds height to the panel, so measuring
    // on tab-bar alone races it -- this test failed once in a full-suite run
    // and passed in isolation, which is exactly that shape.
    await expect(page.getByTestId("board-active-note")).toBeVisible();

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
    await expect(page.getByTestId("panel-queue")).toBeHidden();

    await page.getByTestId("tab-draft").click();
    await expect(page.getByTestId("panel-draft-board")).toBeVisible();
    await expect(page.getByTestId("panel-big-board")).toBeHidden();

    await page.getByTestId("tab-rosters").click();
    await expect(page.getByTestId("panel-rosters")).toBeVisible();
    await expect(page.getByTestId("panel-draft-board")).toBeHidden();

    await page.getByTestId("tab-queue").click();
    await expect(page.getByTestId("panel-queue")).toBeVisible();
    await expect(page.getByTestId("panel-rosters")).toBeHidden();
  });

  // TabBar.jsx was laid out for exactly this: grid-cols-3 becomes
  // grid-cols-4 and a fourth destination joins the other three, on the same
  // per-seat, private queue Task 1 already wired into the backend.
  test("the tab bar has four tabs, and Queue shows its own panel", async ({ page }) => {
    await openDraft(page);

    await expect(page.getByTestId("tab-board")).toBeVisible();
    await expect(page.getByTestId("tab-draft")).toBeVisible();
    await expect(page.getByTestId("tab-rosters")).toBeVisible();
    await expect(page.getByTestId("tab-queue")).toBeVisible();

    await page.getByTestId("tab-queue").click();
    await expect(page.getByTestId("panel-queue")).toBeVisible();
    await expect(page.getByTestId("panel-big-board")).toBeHidden();

    // Same floor the page-fits test above holds everywhere else -- a fourth
    // tab is exactly the kind of addition that could quietly push the page
    // back past one screen.
    const { scrollHeight, clientHeight } = await scroller(page);
    expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 8);
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
      { tab: "tab-queue", panel: "panel-queue" },
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

    for (const t of ["tab-board", "tab-draft", "tab-rosters", "tab-queue"]) {
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
  // A reader on a large accessibility font. Measured at a 24px root before
  // this was fixed: the strip was 176px tall -- a fifth of the screen -- and
  // "⏱ 60s · your pick" had broken onto THREE lines, 46px wide, with the
  // separator stranded alone on the middle one.
  //
  // Neither existing strip test can see that. One asserts the label CONTAINS
  // "your pick"; the other that Pause is VISIBLE. Both are true of a strip
  // with its clock in ribbons.
  //
  // The thresholds are computed from the font being tested rather than written
  // as pixels. A test that hard-codes 44 or 52 while guarding against
  // hard-coded sizes embodies the bug it exists to catch.
  // Applied AFTER the draft has loaded, deliberately. An addInitScript version
  // of this -- setting it at document-start and again on DOMContentLoaded --
  // never landed at all: the root reported 16px with no inline style set,
  // after signIn, after goto, and after the tab bar rendered. Nothing in the
  // app overwrites it; the early write simply does not survive. Applied here it
  // holds through a settle and through a clock tick, and body inherits it.
  //
  // The `expect(root).toBe(24)` in each test is what caught that. Without it
  // both tests would have measured the 16px layout -- where the label does fit
  // on one line -- and passed against the broken page.
  async function setRootFontSize(page, px) {
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = `${size}px`;
    }, px);
    // One frame for layout to settle at the new size before anything is read.
    await page.waitForTimeout(150);
  }

  test("the clock stays on one line at a large accessibility font", async ({ page }) => {
    await openDraft(page);
    await setRootFontSize(page, 24);

    const m = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="strip-status"]');
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
      return {
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        height: Math.round(el.getBoundingClientRect().height),
        width: Math.round(el.getBoundingClientRect().width),
        line: Math.round(line),
        text: el.textContent.trim(),
      };
    });

    // The test must actually be testing a 24px page. Without this it would
    // silently measure the 16px layout and pass against the broken code.
    expect(m.root, "root font size actually applied").toBe(24);
    expect(m.text).toContain("your pick");

    // One line, with room for descenders -- not two, and certainly not the
    // three it used to take.
    expect(
      m.height,
      `clock label is ${m.height}px tall over a ${m.line}px line, ${m.width}px wide -- it has wrapped`
    ).toBeLessThan(m.line * 2);
  });

  // The assertion that catches what the two height checks above cannot.
  //
  // `whitespace-nowrap` stopped the clock breaking onto three lines -- and at a
  // 24px root it then OVERFLOWED its own 33px-wide button instead, painting
  // "60s · your pick" straight through Team 1 and the Pause button. Measured
  // height stayed healthy at 30px and both height tests passed while the strip
  // was illegible. The failure had moved from the vertical axis to the
  // horizontal one, and nothing was looking there.
  //
  // Controls in a row must not overlap. That is true at every font size, it is
  // what a reader actually experiences, and it cannot be satisfied by text
  // spilling out of its box.
  test("the clock does not spill out of its own box at a large accessibility font", async ({ page }) => {
    await openDraft(page);
    await setRootFontSize(page, 24);

    const m = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="strip-status"]');
      return {
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
        text: el.textContent.trim(),
      };
    });

    expect(m.root, "root font size actually applied").toBe(24);

    // A box-intersection version of this test was written first and could not
    // fail: with whitespace-nowrap the BOXES stay tidily side by side while the
    // TEXT paints outside one of them. Measured at a 24px root, the clock's box
    // was 33px wide holding 162px of content, and rect intersection reported no
    // overlap at all -- while the render showed "60s · your pick" written
    // straight across Team 1 and the Pause button.
    //
    // Content versus container is the axis that actually fails here.
    expect(
      m.scrollW,
      `"${m.text}" needs ${m.scrollW}px in a ${m.clientW}px box -- it is painting over its neighbours`
    ).toBeLessThanOrEqual(m.clientW + 1);
  });

  test("the strip stays proportionate at a large accessibility font", async ({ page }) => {
    await openDraft(page);
    await setRootFontSize(page, 24);

    const m = await page.evaluate(() => ({
      root: parseFloat(getComputedStyle(document.documentElement).fontSize),
      strip: Math.round(document.querySelector('[data-testid="status-strip"]').getBoundingClientRect().height),
      dots: Math.round(document.querySelector('[data-testid="open-controls"]').getBoundingClientRect().height),
      viewport: window.innerHeight,
    }));

    expect(m.root, "root font size actually applied").toBe(24);

    // Measured against its own contents, not against the screen.
    //
    // The first version of this assertion bounded the strip at a quarter of the
    // viewport -- 211px of 844 -- and the broken strip is 176px, so it passed
    // against the very defect it names. A threshold the bug already satisfies
    // is not a test.
    //
    // The bound is ~three rows, not one, and that is deliberate. At a 24px root
    // the strip's contents need 361px of a 306px row, so it WRAPS to two rows
    // by design -- that is what keeps the clock whole and stops it painting
    // over its neighbours. A one-row bound would now contradict the fix. What
    // this still catches is the runaway it was written for: 176px of
    // three-line wrapped label around a 50px control.
    expect(
      m.strip,
      `strip is ${m.strip}px around a ${m.dots}px control, on a ${m.viewport}px screen -- that is more than it can need`
    ).toBeLessThan(m.dots * 3);
  });

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

// A phone turned sideways. 844x390 was measured as unusable and written down
// rather than fixed: the Big Board's player list rendered 167px past its own
// panel and 93px off the bottom of the screen, only 4 of 79 rows were
// tappable, and nothing scrolled -- the page pins itself to the viewport
// height, and 390px cannot hold the nav, the status strip, a panel header,
// the suggested-pick card, a usable list AND the tab bar.
//
// The fix is to stop pinning the height below 35rem and let the page be
// longer than the screen. Length is not the failure mode on a phone;
// unreachable content is. These tests pin both halves of that: the rows
// become reachable, and the two pieces of chrome that must not scroll away
// with them do not.
test.describe("the draft page in landscape", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  async function openLandscape(page) {
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("panel-big-board")).toBeVisible();
  }

  // Finds the element the page actually scrolls. NOT documentElement: this
  // app scrolls an inner wrapper, so document.scrollingElement's scrollHeight
  // equals its clientHeight even with content overflowing inside it -- the
  // same trap that makes "the document does not scroll" a vacuous assertion
  // elsewhere in this suite.
  const SCROLLER = `() => {
    let el = document.querySelector('[data-testid="panel-big-board"]');
    while (el) {
      if (el.scrollHeight > el.clientHeight + 1 &&
          /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
      el = el.parentElement;
    }
    return document.scrollingElement;
  }`;

  test("the player list does not render outside its own panel", async ({ page }) => {
    await openLandscape(page);

    const spill = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="panel-big-board"]').getBoundingClientRect();
      const list = document.querySelector('[data-testid="scroll-big-board"]').getBoundingClientRect();
      return Math.round(list.bottom - panel.bottom);
    });
    // Was +167. Negative means the list ends inside the panel that owns it.
    expect(spill, "list spill past its panel").toBeLessThanOrEqual(0);
  });

  test("every player row can be reached by scrolling", async ({ page }) => {
    await openLandscape(page);

    const reached = await page.evaluate(async (src) => {
      const scroller = eval("(" + src + ")")();
      const rows = () => [...document.querySelectorAll('[data-testid="scroll-big-board"] button')];
      const total = rows().length;
      const seen = new Set();
      // Walk the whole scroll range a screen at a time and record every row
      // that is fully on screen at some point along the way.
      for (let top = 0; top <= scroller.scrollHeight; top += Math.floor(window.innerHeight / 2)) {
        scroller.scrollTop = top;
        await new Promise((r) => requestAnimationFrame(r));
        const vh = window.innerHeight;
        rows().forEach((r, i) => {
          const b = r.getBoundingClientRect();
          if (b.top >= 0 && b.bottom <= vh && b.height > 0) seen.add(i);
        });
      }
      return { total, seen: seen.size };
    }, SCROLLER);

    expect(reached.total, "rows rendered").toBeGreaterThan(20);
    // Was 4 of 79, with no scroll to reach the rest.
    expect(reached.seen, "rows reachable by scrolling").toBe(reached.total);
  });

  test("the clock and the tabs stay on screen while the list scrolls", async ({ page }) => {
    await openLandscape(page);

    const pinned = await page.evaluate(async (src) => {
      const scroller = eval("(" + src + ")")();
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((r) => setTimeout(r, 120));
      const vh = window.innerHeight;
      const on = (id) => {
        const b = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), onScreen: b.top >= -1 && b.bottom <= vh + 1 };
      };
      return { scrolled: Math.round(scroller.scrollTop), strip: on("status-strip"), tabs: on("tab-bar") };
    }, SCROLLER);

    // The assertion is only meaningful if the page actually scrolled a long
    // way -- at scrollTop 0 everything is trivially on screen.
    expect(pinned.scrolled, "scrolled far enough for this to mean anything").toBeGreaterThan(500);
    expect(pinned.strip.onScreen, `status strip at ${pinned.strip.top}`).toBe(true);
    expect(pinned.tabs.onScreen, `tab bar at ${pinned.tabs.top}`).toBe(true);
    // And pinned to the edges rather than merely visible because we happened
    // to stop somewhere they were: at the bottom of a 3,000px scroll a static
    // tab bar also lands on screen, so "visible" alone proves nothing. The
    // strip must ride the top third and the tabs the bottom third.
    expect(pinned.strip.top, "strip is pinned near the top").toBeLessThan(390 / 3);
    expect(pinned.tabs.bottom, "tabs are pinned near the bottom").toBeGreaterThan((390 * 2) / 3);
  });
});
