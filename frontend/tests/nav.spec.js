import { test, expect } from "@playwright/test";
import { BOARD_ID, makeBoardState } from "./fixtures.js";
import { signIn } from "./auth.js";

// The nav (the ☰ toggle and everything it opens) only renders when
// showAppLinks is true, and NavBar.jsx computes that as !mustSignIn(...) --
// signed out, every app link would lead to the same sign-in prompt, so it
// renders nothing at all rather than a row of identical doors. Every test
// below is about that nav, so every one of them needs an account first, even
// the ones opening "/" itself (which is not gated).

test("the menu is closed until the toggle is clicked", async ({ page }) => {
  await signIn(page);
  await page.goto("/");

  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toBeVisible();
});

test("the toggle closes an open menu", async ({ page }) => {
  await signIn(page);
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toBeVisible();
  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

test("the toggle reports its state to assistive tech", async ({ page }) => {
  await signIn(page);
  await page.goto("/");

  const toggle = page.getByTestId("nav-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("Boards navigates to the boards page", async ({ page }) => {
  await signIn(page);
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "Boards" }).click();

  await expect(page).toHaveURL(/\/boards$/);
});

test("the menu closes after navigating", async ({ page }) => {
  await signIn(page);
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "Boards" }).click();

  await expect(page).toHaveURL(/\/boards$/);
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

test("Escape closes the menu and returns focus to the toggle", async ({ page }) => {
  await signIn(page);
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toBeVisible();

  // Move focus off the toggle and into the menu, as a keyboard user would,
  // so that returning focus to the toggle on Escape is actually exercised
  // rather than incidentally already true from the click that opened it.
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("nav-menu").getByRole("link", { name: "Home" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
  await expect(page.getByTestId("nav-toggle")).toBeFocused();
});

test("clicking outside closes the menu", async ({ page }) => {
  await signIn(page);
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toBeVisible();

  // Click far from both the menu and the toggle.
  await page.mouse.click(20, 500);
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

test("the current route is marked for assistive tech", async ({ page }) => {
  await signIn(page);
  await page.goto("/boards");

  await page.getByTestId("nav-toggle").click();
  const boardsLink = page.getByTestId("nav-menu").getByRole("link", { name: "Boards" });
  await expect(boardsLink).toHaveAttribute("aria-current", "page");
});

test("navigation is reachable from a board — the dead-end regression", async ({ page }) => {
  // /board/:boardId previously had no navigation at all: browser back was the
  // only way out. This is the test for that bug.
  await page.route(`**/boards/${BOARD_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeBoardState()),
    })
  );
  await signIn(page);
  await page.goto(`/board/${BOARD_ID}`);
  await expect(page.getByTestId("board-row").first()).toBeVisible();

  await page.getByTestId("nav-toggle").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "Home" }).click();

  await expect(page).toHaveURL(/\/$/);
});

test("New Draft navigates to the draft setup page", async ({ page }) => {
  await signIn(page);
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "New Draft" }).click();

  await expect(page).toHaveURL(/\/draft\/new$/);
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

test("the menu is anchored to the toggle that opens it", async ({ page }) => {
  // The brand link sits ahead of the toggle in the header, so the header can
  // no longer be trusted as the menu's positioning context -- if the toggle
  // and the menu ever lose their shared wrapper, the menu drifts left under
  // the brand instead of hanging off the toggle. A tolerance, not an exact
  // match, because sub-pixel rounding is not the failure this guards.
  await signIn(page);
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  const toggleBox = await page.getByTestId("nav-toggle").boundingBox();
  const menuBox = await page.getByTestId("nav-menu").boundingBox();

  expect(Math.abs(menuBox.x - toggleBox.x)).toBeLessThanOrEqual(8);
});

test("the menu drops just below the toggle that opens it", async ({ page }) => {
  // top-full used to measure from the 68px header; now that the toggle and
  // menu share their own positioning wrapper, top-full alone lands the menu
  // flush against the toggle's own bottom edge (a 0px gap) rather than the
  // ~16px drop the old, header-relative top-full used to give it for free.
  // mt-4 on the menu restores that drop.
  //
  // This is a floor, not a closeness band: with mt-4 removed, the rendered
  // gap collapses to 0, which is *closer* to the toggle's bottom edge than
  // the correct ~16px drop is, so asserting "close to the toggle's bottom
  // edge" can never fail this regression -- 0 is always within any
  // tolerance of itself. Asserting a minimum real gap instead is pinned to
  // the toggle's own rendered geometry, not the number 16, so it still
  // catches the day some other header child overtakes the toggle as the
  // header's tallest and the compensation stops being exactly right.
  await signIn(page);
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  const toggleBox = await page.getByTestId("nav-toggle").boundingBox();
  const menuBox = await page.getByTestId("nav-menu").boundingBox();

  expect(menuBox.y - (toggleBox.y + toggleBox.height)).toBeGreaterThanOrEqual(8);
});

test("the account controls sit at the header's right edge", async ({ page }) => {
  // Regression guard for the ml-auto that pushes sign-in/out to the right of
  // the header, alongside the brand link that now leads it.
  await signIn(page);
  await page.goto("/");

  const headerBox = await page.locator("header").boundingBox();
  const authBox = await page.getByTestId("auth-controls").boundingBox();

  const headerRight = headerBox.x + headerBox.width;
  const authRight = authBox.x + authBox.width;

  expect(Math.abs(authRight - headerRight)).toBeLessThanOrEqual(8);
});
