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
