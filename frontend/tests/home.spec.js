import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";
import { DRAFT_ID } from "./fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");

const API = "http://localhost:9999";

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
    await page.route(`${API}/drafts`, async (route) => {
      await route.fulfill({ json: { draftId: DRAFT_ID } });
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Draft smarter/i })).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOTS}/home.png`, fullPage: false });
  });
});
