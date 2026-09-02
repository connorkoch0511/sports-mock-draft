import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");

test.describe("Home page", () => {
  test("renders hero and calls to action", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("PerfectPick • Mock Draft Simulator")).toBeVisible();
    await expect(page.getByTestId("cta-new-draft")).toBeVisible();
    await expect(page.getByTestId("cta-boards")).toBeVisible();

    // The draft form moved to /draft/new. If it is still here, the extraction
    // duplicated it instead of moving it.
    await expect(page.getByLabel("Teams")).toHaveCount(0);
    await expect(page.getByTestId("slot-select")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start Mock Draft" })).toHaveCount(0);
  });

  test("feature cards are visible", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("Big Board + Search", { exact: true })).toBeVisible();
    await expect(page.getByText("Snake Draft Engine", { exact: true })).toBeVisible();
    await expect(page.getByText("Smart Auto Picks", { exact: true })).toBeVisible();
  });

  test("screenshot — home page", async ({ page }) => {
  // fullPage is inert here: the shell is h-dvh and the routes wrapper is the
  // scroller, so the document is always exactly viewport height. Size the
  // viewport to the page's own content instead, or the image is clipped.
  await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Draft smarter/i })).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOTS}/home.png`, fullPage: false });
  });
});
