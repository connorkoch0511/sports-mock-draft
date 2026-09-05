import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");

// "/" used to be a single home page for everyone, with its own hero copy and
// draft form. This branch put the whole app behind sign-in, and "/" became
// two different pages sharing a route: Landing for a visitor, Dashboard for
// an account. landing.spec.js covers the gate and the dashboard's data; this
// file is what is left of the old home-page suite -- the signed-out pitch
// itself, and the screenshot the README ships.
test.describe("Landing page (signed out)", () => {
  test("renders the pitch and a way to sign in", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /Draft off your board/i })).toBeVisible();
    await expect(page.getByText(/Rank the players your way/i)).toBeVisible();
    await expect(page.getByTestId("landing-signin")).toBeVisible();

    // The draft form lives behind sign-in now, at /draft/new. If it is on
    // the landing page too, something is rendering it in both places.
    await expect(page.getByLabel("Teams")).toHaveCount(0);
    await expect(page.getByTestId("slot-select")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start Mock Draft" })).toHaveCount(0);
  });

  test("the three-step pitch is visible", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("Build your board", { exact: true })).toBeVisible();
    await expect(page.getByText("Draft off it", { exact: true })).toBeVisible();
    await expect(page.getByText("See where you disagree", { exact: true })).toBeVisible();
  });

  test("screenshot — home page", async ({ page }) => {
  // fullPage is inert here: the shell is h-dvh and the routes wrapper is the
  // scroller, so the document is always exactly viewport height. Size the
  // viewport to the page's own content instead, or the image is clipped.
  await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Draft off your board/i })).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOTS}/home.png`, fullPage: false });
  });
});
