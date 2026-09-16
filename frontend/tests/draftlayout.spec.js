import { test, expect } from "@playwright/test";
import { DRAFT_ID, makeDraftState, mockDraftApis } from "./fixtures.js";
import { signIn } from "./auth.js";

// Pausing stops the auto-pick timer so the layout is measured against a
// stable DOM rather than one mutating between the two boundingBox() calls.
async function openPausedDraft(page, overrides = {}) {
  mockDraftApis(page, makeDraftState({ currentIndex: 0, ...overrides }));
  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await page.getByRole("button", { name: "Pause" }).click();
  // Big Board rather than rosters: below xl the page is tabbed and only the
  // active tab's panel is visible, and Big Board is the one that opens. At
  // desktop widths all three are up, so this is a readiness signal that holds
  // in both layouts.
  await expect(page.getByTestId("panel-big-board")).toBeVisible();
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
  // This ran at 1600 and 1728 only, back when those were the sole widths the
  // page was height-bound at. It is bound wherever the columns apply now, so
  // the loop runs from the first of those widths -- and 1280 is the
  // interesting entry, not the two widest and most forgiving ones. A test
  // that only ever sees the case with the most room to spare is not guarding
  // anything: 1280 is where the three tracks are tightest, and the bottom of
  // a band is where a proportional grid fails first.
  for (const width of [1280, 1440, 1600, 1728]) {
    test(`panels stay inside the viewport at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPausedDraft(page);

      const documentScrolls = await page.evaluate(
        () => document.documentElement.scrollHeight > window.innerHeight + 2
      );
      expect(documentScrolls).toBe(false);

      for (const id of ["panel-big-board", "panel-draft-board", "panel-rosters", "panel-queue"]) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box.y + box.height, `${id} bottom edge`).toBeLessThanOrEqual(902);
        // A panel collapsed to nothing would satisfy the bound above, so
        // require it to still be a real one. The queue is a capped strip by
        // design, so it gets its own floor rather than the panels'.
        const floor = id === "panel-queue" ? 80 : 200;
        expect(box.height, `${id} height`).toBeGreaterThan(floor);
      }
    });
  }

  // The guard that was missing. The queue arrives as a fourth item in a
  // three-track grid between lg and 3xl; with the page height bound there, the
  // grid split it across two rows, halved all three original panels, and
  // painted the queue over the Big Board's search field. Every test passed --
  // the viewport loop above did not list panel-queue, its floor was 200px
  // against panels cut to ~370, and toBeVisible() does not mean on screen.
  //
  // 1280x720 is the size the suite itself runs at, not an overridden height.
  for (const width of [1280, 1440, 1536, 1600, 1728]) {
    test(`the queue never lands on top of another panel at ${width}px`, async ({ page }) => {
      // 900, a real laptop height. The floor below is calibrated against it:
      // the strip legitimately costs the panels ~130px, so a 720-tall window
      // leaves them ~336 and a floor written for the strip-less layout would
      // fail for the wrong reason.
      await page.setViewportSize({ width, height: 900 });
      await openPausedDraft(page);

      const boxes = await page.evaluate(() => {
        const r = (id) => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          const b = el.getBoundingClientRect();
          return { id, top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height };
        };
        return ["panel-big-board", "panel-draft-board", "panel-rosters", "panel-queue"].map(r);
      });

      const queue = boxes.find((b) => b.id === "panel-queue");
      for (const other of boxes.filter((b) => b.id !== "panel-queue")) {
        const apart =
          queue.bottom <= other.top + 1 ||
          queue.top >= other.bottom - 1 ||
          queue.right <= other.left + 1 ||
          queue.left >= other.right - 1;
        expect(apart, `queue overlaps ${other.id} at ${width}px`).toBe(true);
      }

      // And the three original panels keep a real height rather than being
      // halved to make room for a wrapped row.
      for (const other of boxes.filter((b) => b.id !== "panel-queue")) {
        // ~516 with the strip at this height. Halved by a wrapped row -- the
        // failure this guards -- would be ~250, so 400 separates them cleanly.
        expect(other.h, `${other.id} height at ${width}px`).toBeGreaterThan(400);
      }
    });
  }

  // The queue is a strip under the three columns at every desktop width, not
  // a fourth column above 1600 and a below-the-fold afterthought under it.
  // These asserted the old shape -- "not in viewport, scroll to reach" -- and
  // now assert the point of replacing it: during a live draft your queue is
  // on screen without scrolling, on a 1280 laptop as much as a 1728 monitor.
  //
  // The cap alone was a one-sided bound, and one-sided bounds are how a strip
  // becomes a title bar without anything going red: crushing the cap to 24px
  // -- too short for a single chip -- left all five of these green. So the
  // strip is now pinned from both ends, and by the thing it exists to show
  // rather than by its own height: a queued player has to be fully inside the
  // scrolling area, which is false at any height that cannot hold a chip.
  for (const width of [1280, 1440, 1536, 1728]) {
    test(`the queue is on screen without scrolling at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPausedDraft(page, { yourQueue: ["p1", "p2"] });

      await expect(page.getByTestId("panel-queue")).toBeInViewport();

      // And it is a strip, not a panel: if it ever grows into a full row it
      // takes the height back out of the three panels above it, which is the
      // failure that broke this page once already.
      const h = await page
        .getByTestId("panel-queue")
        .evaluate((el) => Math.round(el.getBoundingClientRect().height));
      expect(h, `queue strip height at ${width}px`).toBeLessThanOrEqual(140);

      const fit = await page.getByTestId("scroll-queue").evaluate((box) => {
        const chip = box.querySelector('[data-testid="queue-row"]');
        if (!chip) return { hasChip: false };
        const b = box.getBoundingClientRect();
        const c = chip.getBoundingClientRect();
        return { hasChip: true, overflow: Math.round(c.bottom - b.bottom) };
      });
      expect(fit.hasChip, `a queued chip renders at ${width}px`).toBe(true);
      expect(fit.overflow, `queued chip clipped at ${width}px`).toBeLessThanOrEqual(1);
    });
  }

  test("panels scroll their own overflowing content", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
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

  // This guarded a real bug: binding the shell's height at small widths used to
  // compress each stacked panel to a fraction of the viewport, collapsing the
  // Big Board to 0px at 390px with no player clickable.
  //
  // The premise has since changed and the guard has not. Below lg the height
  // IS bound now, deliberately -- the page is tabbed, shows one panel at a
  // time and fits one screen, which is what stops it running 8.2 screens deep
  // on a phone (see docs/superpowers/specs/2026-09-13-draft-page-phone-design.md).
  // What survives is the assertion that actually mattered: however the layout
  // is arranged at these widths, the Big Board still lists players you can
  // reach. All three of these are tabbed now, 1024 included.
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

  // The panel boxes are `overflow: visible`, so content that does not fit
  // them does not clip -- it paints straight through whatever is beneath.
  // Height-binding the desktop layout at lg made that reachable: at 1280x720
  // the Big Board's own content ran 178px past its bottom edge and drew over
  // the queue strip and off the screen, which is what the README screenshot
  // caught. A panel whose scrollHeight exceeds its clientHeight is spilling;
  // a scroll container inside it (scroll-big-board) is allowed to, and does.
  for (const [width, height] of [
    [1280, 720],
    [1280, 800],
    [1440, 900],
  ]) {
    test(`no panel paints outside its own box at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openPausedDraft(page);

      for (const id of ["panel-big-board", "panel-draft-board", "panel-rosters", "panel-queue"]) {
        const spill = await page
          .getByTestId(id)
          .evaluate((el) => el.scrollHeight - el.clientHeight);
        expect(spill, `${id} content past its own bottom edge`).toBeLessThanOrEqual(1);
      }
    });
  }

  // Nothing asserted WHERE the tabs stop and the columns start, so the
  // boundary could drift a breakpoint in either direction in silence. It
  // matters at both ends: one pixel below, every panel must be reachable
  // through the tab bar, and one pixel above, all three must be on screen at
  // once. 1279 and 1280 are the two widths that can tell those apart.
  //
  // It sits at xl and not lg because three columns at 1024 gave the Big Board
  // a 277px track and a 36px search box -- narrower than two characters --
  // while the Draft Board's table ran 52% behind a horizontal scroll. Tabbed,
  // the same panel measures 936px there.
  for (const [width, tabbed] of [
    [1279, true],
    [1280, false],
  ]) {
    test(`at ${width}px the page is ${tabbed ? "tabbed" : "three columns"}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPausedDraft(page, { yourQueue: ["p1"] });

      const bar = page.getByTestId("tab-bar");
      if (tabbed) {
        await expect(bar).toBeVisible();
        // Tabbed means one panel at a time, and it gets the whole width --
        // which is the entire reason the boundary moved up to xl.
        const board = await page.getByTestId("panel-big-board").boundingBox();
        expect(board.width, "tabbed panel width").toBeGreaterThan(width * 0.8);
        await expect(page.getByTestId("panel-draft-board")).toBeHidden();
      } else {
        await expect(bar).toBeHidden();
        for (const id of ["panel-big-board", "panel-draft-board", "panel-rosters", "panel-queue"]) {
          await expect(page.getByTestId(id)).toBeVisible();
        }
      }
    });
  }

  // The queue strip's cap used to be `xl:max-h-[132px]` -- a pixel cap around
  // contents measured entirely in rem (p-4 padding, a text-lg heading, the
  // chips). Raise the browser's default font and the cap did not move, so the
  // box inside it was eaten from both ends: measured at 1440px wide, the
  // scrolling area fell from 58px at a 16px root to 40px at 20 and 22px at
  // 24, while its content still wanted 45 and 43. With xl:overflow-y-hidden
  // on that box, that is not a scroll -- it is a clip, and the position line
  // under each chip simply vanished for anyone using Large text.
  //
  // This is the same px-beside-rem drift the phone work went out of its way
  // to avoid one file over, which is why it gets a test rather than a note.
  for (const rootPx of [16, 20, 24]) {
    test(`a queued chip is not clipped at a ${rootPx}px root font`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openPausedDraft(page, { yourQueue: ["p1", "p2"] });
      await page.evaluate((px) => {
        document.documentElement.style.fontSize = `${px}px`;
      }, rootPx);
      // One frame for the new rem values to lay out before measuring.
      await page.waitForTimeout(150);

      const m = await page.getByTestId("scroll-queue").evaluate((box) => {
        const chip = box.querySelector('[data-testid="queue-row"]');
        const b = box.getBoundingClientRect();
        const c = chip ? chip.getBoundingClientRect() : null;
        return {
          hasChip: !!chip,
          clipped: box.scrollHeight - box.clientHeight,
          chipOverflow: c ? Math.round(c.bottom - b.bottom) : null,
        };
      });

      expect(m.hasChip, `a chip renders at ${rootPx}px root`).toBe(true);
      // The box is overflow-y-hidden at this width, so anything the content
      // wants beyond clientHeight is cut off with no way to reach it.
      expect(m.clipped, `content clipped at ${rootPx}px root`).toBeLessThanOrEqual(1);
      expect(m.chipOverflow, `chip past the box at ${rootPx}px root`).toBeLessThanOrEqual(1);
    });
  }

  // The suggested-pick card yields height and scrolls when the panel is
  // short, which is the right behaviour -- but macOS overlay scrollbars give
  // it a 2px track that is invisible until you already know to look.
  // Measured at 1280x720: the card showed 74px of the 268 it wanted, hiding
  // 72% of itself and ALL FOUR reasons. The advice was there and
  // unadvertised, which is the same as not being there.
  test("a short advice card says how much of itself is hidden", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openPausedDraft(page);

    const hidden = await page
      .getByTestId("advice-scroll")
      .evaluate((el) => el.scrollHeight - el.clientHeight);
    // The premise: at this size the card really is cut off. If a layout change
    // ever makes it fit here, this test is measuring nothing and should be
    // pointed at a shorter viewport rather than quietly passing.
    expect(hidden, "the card is actually overflowing at 1280x720").toBeGreaterThan(20);

    const cue = page.getByTestId("advice-more");
    await expect(cue).toBeVisible();
    // Not just "something is there": it names the count, because "there is
    // more" and "you cannot see three of the four reasons" are different
    // facts and only the second tells you whether to bother.
    await expect(cue).toHaveText(/\d+ more reasons? ↓/);

    // And it works: clicking moves the card's own scroll.
    const before = await page.getByTestId("advice-scroll").evaluate((el) => el.scrollTop);
    await cue.click();
    await page.waitForTimeout(400);
    const after = await page.getByTestId("advice-scroll").evaluate((el) => el.scrollTop);
    expect(after, "clicking the cue scrolls the card").toBeGreaterThan(before);
  });

  // The other end: with room to show everything, there is no cue. A cue that
  // is always on is not a cue, and this is what stops the assertion above
  // from passing against an unconditional badge.
  test("a card with room for all its reasons shows no cue", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await openPausedDraft(page);

    const reasons = await page.getByTestId("advice-reason").count();
    expect(reasons, "reasons rendered").toBeGreaterThan(0);
    const allInside = await page.getByTestId("advice-scroll").evaluate((el) => {
      const b = el.getBoundingClientRect();
      return [...el.querySelectorAll('[data-testid="advice-reason"]')].every(
        (r) => r.getBoundingClientRect().bottom <= b.bottom + 1
      );
    });
    expect(allInside, "every reason fits at 1100px tall").toBe(true);
    await expect(page.getByTestId("advice-more")).toHaveCount(0);
  });
});
