import { test, expect } from "@playwright/test";
import { BOARD_ID, makeBoardState } from "./fixtures.js";

test("the menu is closed until the toggle is clicked", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toBeVisible();
});

test("the toggle closes an open menu", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toBeVisible();
  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

test("the toggle reports its state to assistive tech", async ({ page }) => {
  await page.goto("/");

  const toggle = page.getByTestId("nav-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("Boards navigates to the boards page", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "Boards" }).click();

  await expect(page).toHaveURL(/\/boards$/);
});

test("the menu closes after navigating", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "Boards" }).click();

  await expect(page).toHaveURL(/\/boards$/);
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

test("Escape closes the menu and returns focus to the toggle", async ({ page }) => {
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
  await page.goto("/");

  await page.getByTestId("nav-toggle").click();
  await expect(page.getByTestId("nav-menu")).toBeVisible();

  // Click far from both the menu and the toggle.
  await page.mouse.click(20, 500);
  await expect(page.getByTestId("nav-menu")).toHaveCount(0);
});

test("the current route is marked for assistive tech", async ({ page }) => {
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
  await page.goto(`/board/${BOARD_ID}`);
  await expect(page.getByTestId("board-row").first()).toBeVisible();

  await page.getByTestId("nav-toggle").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "Home" }).click();

  await expect(page).toHaveURL(/\/$/);
});
