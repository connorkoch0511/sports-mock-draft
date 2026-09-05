import { test, expect } from "@playwright/test";
import { signIn } from "./auth.js";
import { DRAFT_ID } from "./fixtures.js";

test.describe("signed out", () => {
  test("the landing page pitches the board", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Draft off your board/i })).toBeVisible();
    await expect(page.getByTestId("landing-signin")).toBeVisible();
  });

  test("the app nav is not offered", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "My Drafts" })).toHaveCount(0);
  });

  test("a gated url prompts in place and keeps the url", async ({ page }) => {
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("auth-gate")).toBeVisible();
    expect(page.url()).toContain(`/draft/${DRAFT_ID}`);
  });

  test("a player page is still public", async ({ page }) => {
    await page.route("**/players/p1", (r) =>
      r.fulfill({ json: { id: "p1", name: "Christian McCaffrey", position: "RB", team: "SF" } })
    );
    await page.goto("/player/p1");
    await expect(page.getByTestId("auth-gate")).toHaveCount(0);
  });
});

test.describe("signed in", () => {
  test("home is the dashboard, from the server", async ({ page }) => {
    await signIn(page);
    await page.route("**/me/drafts", (r) =>
      r.fulfill({ json: { drafts: [
        { id: "d1", teams: 12, rounds: 15, format: "ppr", userTeam: 4, boardId: null, completed: false, createdAt: 2 },
      ] } })
    );
    await page.goto("/");
    await expect(page.getByTestId("dashboard-drafts")).toContainText("12 teams");
  });

  // The point of cross-device history: the list is the account's, not this
  // browser's. Nothing is seeded into localStorage here.
  test("the dashboard shows drafts this browser never made", async ({ page }) => {
    await signIn(page);
    await page.route("**/me/boards", (r) =>
      r.fulfill({ json: { boards: [{ id: "b9", name: "Board From My Phone", format: "ppr", season: 2026, updatedAt: 1 }] } })
    );
    await page.goto("/");
    await expect(page.getByTestId("dashboard-boards")).toContainText("Board From My Phone");
  });
});

// The surfaces the final whole-branch review found had no coverage at all:
// the dashboard's primary CTA, both of its error states, and the loading
// state that exists specifically to stop the wrong page flashing.
test.describe("the dashboard's own states", () => {
  test("the New draft CTA goes to the draft setup page", async ({ page }) => {
    await signIn(page);
    await page.goto("/");
    await page.getByTestId("dashboard-new-draft").click();
    await expect(page).toHaveURL(/\/draft\/new$/);
  });

  test("a failed drafts load says so instead of claiming you have none", async ({ page }) => {
    await signIn(page);
    await page.route("**/me/drafts", (r) =>
      r.fulfill({ status: 500, json: { error: "Server error" } })
    );
    await page.goto("/");
    await expect(page.getByTestId("dashboard-error")).toBeVisible();
    // The lie this replaced: an error banner beside "Nothing in progress".
    await expect(page.getByText(/nothing in progress/i)).toHaveCount(0);
  });

  test("a failed boards load does not take the drafts down with it", async ({ page }) => {
    await signIn(page);
    await page.route("**/me/drafts", (r) =>
      r.fulfill({ json: { drafts: [
        { id: "d1", teams: 12, rounds: 15, format: "ppr", userTeam: 4, boardId: null, completed: false, createdAt: 2 },
      ] } })
    );
    await page.route("**/me/boards", (r) =>
      r.fulfill({ status: 500, json: { error: "Server error" } })
    );
    await page.goto("/");
    // One half failed; the other still shows its real data rather than both
    // collapsing to "you have nothing".
    await expect(page.getByTestId("dashboard-boards-error")).toBeVisible();
    await expect(page.getByTestId("dashboard-drafts")).toContainText("12 teams");
  });

  test("a slow load shows the wait state, never the empty state", async ({ page }) => {
    await signIn(page);
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route("**/me/drafts", async (r) => {
      await held;
      return r.fulfill({ json: { drafts: [] } });
    });

    await page.goto("/");
    // Mid-flight: no "Nothing in progress" claim while the answer is pending.
    await expect(page.getByText(/nothing in progress/i)).toHaveCount(0);
    release();
    await expect(page.getByText(/nothing in progress/i)).toBeVisible();
  });
});
