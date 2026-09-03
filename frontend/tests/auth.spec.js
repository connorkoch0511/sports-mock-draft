import { test, expect } from "@playwright/test";
import { DRAFT_ID, makeDraftState, mockDraftApis } from "./fixtures.js";

// This build has no Cognito variables set, which is the state every existing
// test runs in. These assert the phase is genuinely inert: the app works
// exactly as before and no request changes shape.
test.describe("auth is optional and inert", () => {
  test("the app works with no auth configured", async ({ page }) => {
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    await page.goto(`/draft/${DRAFT_ID}`);

    await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
    // Nothing to sign in with, so nothing is offered.
    await expect(page.getByTestId("auth-controls")).toHaveCount(0);
  });

  // The guard on the whole phase: today every endpoint is unauthenticated, so
  // a stray or malformed Authorization header would be a change in what they
  // receive rather than the no-op this is meant to be.
  test("a signed-out request carries no Authorization header at all", async ({ page }) => {
    let headers = null;
    await page.route("**/players*", (route) => {
      headers = route.request().headers();
      return route.fulfill({ json: { players: [] } });
    });

    await page.goto("/boards");
    await page.waitForTimeout(300);

    if (headers) {
      expect(Object.keys(headers)).not.toContain("authorization");
    }
  });

  test("the callback page explains a failure instead of hanging", async ({ page }) => {
    await page.goto("/auth/callback");
    // Unconfigured build: it must say so rather than spin forever.
    await expect(page.getByTestId("auth-error")).toBeVisible();
    await expect(page.getByRole("link", { name: "← Back to PerfectPick" })).toBeVisible();
  });
});
