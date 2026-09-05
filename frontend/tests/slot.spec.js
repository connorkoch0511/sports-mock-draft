import { test, expect } from "@playwright/test";
import { DRAFT_ID, MOCK_PLAYERS, makeDraftState } from "./fixtures.js";
import { signIn } from "./auth.js";

test("pick schedule updates with the selected slot", async ({ page }) => {
  await signIn(page);
  await page.goto("/draft/new");

  await page.getByTestId("slot-select").selectOption("3");
  await expect(page.getByTestId("pick-schedule")).toContainText("3, 22, 27");
  await expect(page.getByTestId("pick-schedule")).toContainText("19-pick longest wait");
});

test("selected slot is sent when creating a draft", async ({ page }) => {
  let posted = null;
  await page.route("**/drafts", async (route) => {
    posted = JSON.parse(route.request().postData() || "{}");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ draftId: DRAFT_ID }),
    });
  });
  await page.route(`**/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...makeDraftState(), userTeam: 7 }),
    })
  );
  await page.route("**/players*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sport: "nfl", format: "standard", count: MOCK_PLAYERS.length, players: MOCK_PLAYERS }),
    })
  );

  await signIn(page);
  await page.goto("/draft/new");
  await page.getByTestId("slot-select").selectOption("7");
  await page.getByRole("button", { name: "Start Mock Draft" }).click();

  await expect.poll(() => posted?.userTeam).toBe(7);
});

test("random slot disables the selector", async ({ page }) => {
  await signIn(page);
  await page.goto("/draft/new");

  await page.getByTestId("random-slot").click();
  await expect(page.getByTestId("slot-select")).toBeDisabled();
  await expect(page.getByTestId("pick-schedule")).toHaveCount(0);
});

test("the clock belongs to the user's slot, not Team 1", async ({ page }) => {
  const state = { ...makeDraftState({ currentIndex: 6 }), userTeam: 7 };
  await page.route(`**/drafts/${DRAFT_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) })
  );
  await page.route("**/players*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sport: "nfl", format: "standard", count: MOCK_PLAYERS.length, players: MOCK_PLAYERS }),
    })
  );

  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByText("You are on the clock (Team 7)")).toBeVisible();
});
