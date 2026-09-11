import { test, expect } from "@playwright/test";
import { signIn } from "./auth.js";

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
  await signIn(page);
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
  await signIn(page);
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

  await signIn(page);
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

  await signIn(page);
  await page.goto("/draft/new");
  await page.getByRole("button", { name: /Start Mock Draft/i }).click();

  await expect.poll(() => posted?.teams).toBe(12);
  expect(posted.rosterSlots).toBeUndefined();
});

test("an unknown username shows an error and leaves the form alone", async ({ page }) => {
  await mockSleeper(page, { user: false });
  await signIn(page);
  await page.goto("/draft/new");

  await page.getByTestId("sleeper-username").fill("nobody");
  await page.getByTestId("sleeper-find").click();

  await expect(page.getByTestId("sleeper-error")).toBeVisible();
  await expect(page.getByLabel("Teams")).toHaveValue("12");
  await expect(page.getByTestId("roster-summary")).toHaveCount(0);
});

test("a user with no leagues shows an error", async ({ page }) => {
  await mockSleeper(page, { leagues: [] });
  await signIn(page);
  await page.goto("/draft/new");

  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();

  await expect(page.getByTestId("sleeper-error")).toContainText("No 2026 leagues");
});

const SLEEPER_API = "https://api.sleeper.app/v1";

async function importFirstLeague(page) {
  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();
  await page.getByTestId("sleeper-leagues").getByRole("button").first().click();
}

test("a rookie draft explains why rounds and roster slots differ", async ({ page }) => {
  await mockSleeper(page);
  // Registered after mockSleeper, so this handler wins: a 5-round rookie
  // draft against the fixture league's 16 roster slots.
  await page.route(`${SLEEPER_API}/draft/*`, (route) =>
    route.fulfill({
      json: { type: "snake", settings: { rounds: 5, teams: 12 }, draft_order: {} },
    })
  );

  await signIn(page);
  await page.goto("/draft/new");
  await importFirstLeague(page);

  await expect(page.getByLabel("Rounds")).toHaveValue("5");
  const note = page.getByTestId("roster-rounds-note");
  await expect(note).toBeVisible();
  // Pin which number is attributed to which field — both "5" and "16" would
  // still appear if the implementation swapped rounds and rosterSlots.length.
  await expect(note).toContainText("This draft is 5 rounds");
  await expect(note).toContainText("roster holds 16 slots");
});

test("no explanation when rounds and roster slots agree", async ({ page }) => {
  // The default fixture is 16 rounds against 16 roster slots.
  await mockSleeper(page);

  await signIn(page);
  await page.goto("/draft/new");
  await importFirstLeague(page);

  await expect(page.getByTestId("roster-summary")).toBeVisible();
  await expect(page.getByTestId("roster-rounds-note")).toHaveCount(0);
});

test("explains when a draft runs more rounds than the roster has slots", async ({ page }) => {
  await mockSleeper(page);
  // Registered after mockSleeper, so this handler wins: a 20-round dynasty
  // startup draft against the fixture league's 16 named roster slots (taxi
  // squad picks aren't represented as named roster slots in Sleeper).
  await page.route(`${SLEEPER_API}/draft/*`, (route) =>
    route.fulfill({
      json: { type: "snake", settings: { rounds: 20, teams: 12 }, draft_order: {} },
    })
  );

  await signIn(page);
  await page.goto("/draft/new");
  await importFirstLeague(page);

  await expect(page.getByLabel("Rounds")).toHaveValue("20");
  const note = page.getByTestId("roster-rounds-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("This draft is 20 rounds");
  await expect(note).toContainText("roster holds 16 slots");
});

test("editing Rounds after import updates the note live", async ({ page }) => {
  await mockSleeper(page);
  await signIn(page);
  await page.goto("/draft/new");
  await importFirstLeague(page);

  // The default fixture is 16 rounds against 16 roster slots — no note yet.
  await expect(page.getByLabel("Rounds")).toHaveValue("16");
  await expect(page.getByTestId("roster-rounds-note")).toHaveCount(0);

  await page.getByLabel("Rounds").fill("5");
  const note = page.getByTestId("roster-rounds-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("This draft is 5 rounds");
  await expect(note).toContainText("roster holds 16 slots");

  await page.getByLabel("Rounds").fill("16");
  await expect(page.getByTestId("roster-rounds-note")).toHaveCount(0);
});

test("an imported league's pick timer is offered and sent", async ({ page }) => {
  let posted = null;
  await mockSleeper(page);
  // Registered after mockSleeper, so this handler wins: a league whose
  // timer is not one of our presets.
  await page.route(`${SLEEPER}/draft/*`, (route) =>
    route.fulfill({
      json: {
        type: "snake",
        settings: { rounds: 16, teams: 12, pick_timer: 45 },
        draft_order: { [USER_ID]: 7 },
      },
    })
  );
  await page.route("http://localhost:9999/drafts", async (route) => {
    posted = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ json: { draftId: "abc" } });
  });

  await signIn(page);
  await page.goto("/draft/new");
  await page.getByTestId("sleeper-username").fill("ck15");
  await page.getByTestId("sleeper-find").click();
  await page.getByTestId("sleeper-leagues").getByRole("button").first().click();
  await expect(page.getByTestId("roster-summary")).toBeVisible();

  // Offered as its own option, selected, and not snapped to 30 or 60.
  await expect(page.getByTestId("pick-seconds")).toHaveValue("45");
  // Labelled with the same formatting the draft page's clock uses, not the
  // raw second count.
  await expect(page.getByTestId("pick-seconds").locator("option:checked")).toHaveText(
    "45s · from your league"
  );

  await page.getByRole("button", { name: /Start Mock Draft/i }).click();
  await expect.poll(() => posted?.pickSeconds).toBe(45);
});

// 45s (above) is short enough that raw seconds and formatCountdown's output
// happen to look almost alike. A real Sleeper "slow draft" timer is nowhere
// near that short -- this pins the case the raw-seconds label was actually
// unreadable for.
test("a multi-hour imported pick timer is labelled as a clock, not raw seconds", async ({ page }) => {
  await mockSleeper(page);
  await page.route(`${SLEEPER}/draft/*`, (route) =>
    route.fulfill({
      json: {
        type: "snake",
        settings: { rounds: 16, teams: 12, pick_timer: 10800 },
        draft_order: { [USER_ID]: 7 },
      },
    })
  );

  await signIn(page);
  await page.goto("/draft/new");
  await importFirstLeague(page);
  await expect(page.getByTestId("roster-summary")).toBeVisible();

  await expect(page.getByTestId("pick-seconds")).toHaveValue("10800");
  await expect(page.getByTestId("pick-seconds").locator("option:checked")).toHaveText(
    "3:00:00 · from your league"
  );
});

// The only end-to-end check that applyConfig's `cfg.pickSeconds != null`
// guard does not clobber a user's own choice: Sleeper writes 0 for "no
// timer" on this league's draft, and toDraftConfig maps that to null (see
// sleeper.test.js) -- so importing it must leave the select exactly where it
// already was, not snap it to 0 or to some other default.
test("a league with no pick timer leaves the select on 1 minute", async ({ page }) => {
  await mockSleeper(page);
  // Registered after mockSleeper, so this handler wins: Sleeper's own
  // "no timer" value.
  await page.route(`${SLEEPER}/draft/*`, (route) =>
    route.fulfill({
      json: {
        type: "snake",
        settings: { rounds: 16, teams: 12, pick_timer: 0 },
        draft_order: { [USER_ID]: 7 },
      },
    })
  );

  await signIn(page);
  await page.goto("/draft/new");
  await expect(page.getByTestId("pick-seconds")).toHaveValue("60");

  await importFirstLeague(page);
  await expect(page.getByTestId("roster-summary")).toBeVisible();

  await expect(page.getByTestId("pick-seconds")).toHaveValue("60");
});
