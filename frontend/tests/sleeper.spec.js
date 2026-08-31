import { test, expect } from "@playwright/test";

const SLEEPER = "https://api.sleeper.app/v1";
const USER_ID = "865123803410374656";

const LEAGUE = {
  league_id: "1388274573291560960",
  name: "Average Joes 26'",
  total_rosters: 12,
  roster_positions: ["QB","RB","RB","WR","WR","WR","TE","FLEX","K","DEF","BN","BN","BN","BN","BN","BN"],
  scoring_settings: { rec: 0.5 },
  settings: { draft_rounds: 3 },
};

async function mockSleeper(page, { user = true, leagues = [LEAGUE] } = {}) {
  await page.route(`${SLEEPER}/user/*`, (route) =>
    user
      ? route.fulfill({ json: { user_id: USER_ID, username: "ck15" } })
      : route.fulfill({ status: 404, body: "null" })
  );
  await page.route(`${SLEEPER}/user/*/leagues/nfl/*`, (route) =>
    route.fulfill({ json: leagues })
  );
  await page.route(`${SLEEPER}/league/*/drafts`, (route) =>
    route.fulfill({ json: [{ draft_id: "d1" }] })
  );
  await page.route(`${SLEEPER}/draft/*`, (route) =>
    route.fulfill({
      json: {
        type: "snake",
        settings: { rounds: 16, teams: 12 },
        draft_order: { [USER_ID]: 7 },
      },
    })
  );
}

test("importing a league fills the form from its real settings", async ({ page }) => {
  await mockSleeper(page);
  await page.goto("/draft/new");

  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();

  await expect(page.getByTestId("sleeper-leagues")).toContainText("Average Joes 26'");
  await page.getByTestId("sleeper-leagues").getByRole("button").first().click();

  await expect(page.getByLabel("Teams")).toHaveValue("12");
  await expect(page.getByLabel("Rounds")).toHaveValue("16");
  await expect(page.getByLabel("ADP Format")).toHaveValue("half-ppr");
  await expect(page.getByTestId("slot-select")).toHaveValue("7");
  await expect(page.getByTestId("roster-summary")).toContainText("FLEX");
});

test("imported values remain editable", async ({ page }) => {
  await mockSleeper(page);
  await page.goto("/draft/new");

  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();
  await page.getByTestId("sleeper-leagues").getByRole("button").first().click();
  await expect(page.getByLabel("Teams")).toHaveValue("12");

  await page.getByLabel("Teams").fill("10");
  await expect(page.getByLabel("Teams")).toHaveValue("10");
});

test("the imported roster is sent when the draft is created", async ({ page }) => {
  let posted = null;
  await mockSleeper(page);
  await page.route("http://localhost:9999/drafts", async (route) => {
    posted = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ json: { draftId: "abc" } });
  });

  await page.goto("/draft/new");
  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();
  await page.getByTestId("sleeper-leagues").getByRole("button").first().click();
  await expect(page.getByTestId("roster-summary")).toBeVisible();

  await page.getByRole("button", { name: /Start Mock Draft/i }).click();

  await expect.poll(() => posted?.rosterSlots?.length).toBe(16);
  expect(posted.userTeam).toBe(7);
  expect(posted.rounds).toBe(16);
  expect(posted.format).toBe("half-ppr");
});

test("a draft created without importing sends no rosterSlots", async ({ page }) => {
  let posted = null;
  await page.route("http://localhost:9999/drafts", async (route) => {
    posted = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ json: { draftId: "abc" } });
  });

  await page.goto("/draft/new");
  await page.getByRole("button", { name: /Start Mock Draft/i }).click();

  await expect.poll(() => posted?.teams).toBe(12);
  expect(posted.rosterSlots).toBeUndefined();
});

test("an unknown username shows an error and leaves the form alone", async ({ page }) => {
  await mockSleeper(page, { user: false });
  await page.goto("/draft/new");

  await page.getByTestId("sleeper-username").fill("nobody");
  await page.getByTestId("sleeper-find").click();

  await expect(page.getByTestId("sleeper-error")).toBeVisible();
  await expect(page.getByLabel("Teams")).toHaveValue("12");
  await expect(page.getByTestId("roster-summary")).toHaveCount(0);
});

test("a user with no leagues shows an error", async ({ page }) => {
  await mockSleeper(page, { leagues: [] });
  await page.goto("/draft/new");

  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();

  await expect(page.getByTestId("sleeper-error")).toContainText("No 2026 leagues");
});
