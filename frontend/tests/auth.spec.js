import { test, expect } from "@playwright/test";
import { API_BASE, DRAFT_ID, makeDraftState, mockDraftApis } from "./fixtures.js";
import { signIn, ID_TOKEN } from "./auth.js";

test.describe("signed out", () => {
  test("viewing a shared draft needs no account", async ({ page }) => {
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
    await expect(page.getByTestId("sign-in")).toBeVisible();
  });

  test("no request carries an Authorization header", async ({ page }) => {
    let headers = null;
    // /boards never issues a GET of its own -- it's a static list plus a
    // create/delete button, so a route on "**/players*" there never fires.
    // A draft page is the thing that actually fetches players, so it's the
    // one real place to observe whether a request carries a token.
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    // Registered after mockDraftApis's own players route, so it wins:
    // Playwright matches the most-recently-added handler first.
    await page.route(`${API_BASE}/players*`, (route) => {
      headers = route.request().headers();
      return route.fulfill({ json: { players: [] } });
    });

    await page.goto(`/draft/${DRAFT_ID}`);
    // Poll rather than guard on `if (headers)`: a request that never fires
    // must fail this test, not pass it silently.
    await expect.poll(() => headers).not.toBeNull();
    expect(Object.keys(headers)).not.toContain("authorization");
  });

  test("creating a board offers sign-in instead of failing", async ({ page }) => {
    let posted = false;
    // Scoped to the API origin: an unscoped "**/boards" glob also matches the
    // SPA's own /boards page navigation, so the app's index.html itself gets
    // "fulfilled" with the mock JSON body instead of loading.
    await page.route(`${API_BASE}/boards`, (route) => {
      posted = true;
      return route.fulfill({ json: { boardId: "b1" } });
    });

    await page.goto("/boards");
    await expect(page.getByTestId("create-board")).toHaveText("Sign in to create");
    // The button is a sign-in, so nothing is created and no 401 is provoked.
    expect(posted).toBe(false);
  });

  test("creating a draft offers sign-in instead of failing", async ({ page }) => {
    await page.goto("/draft/new");
    await expect(page.getByTestId("start-draft")).toHaveText("Sign in to draft");
  });

  test("the callback page explains a failure instead of hanging", async ({ page }) => {
    await page.goto("/auth/callback");
    await expect(page.getByTestId("auth-error")).toBeVisible();
    await expect(page.getByRole("link", { name: "← Back to PerfectPick" })).toBeVisible();
  });
});

test.describe("signed in", () => {
  test("the nav shows who you are", async ({ page }) => {
    await signIn(page);
    await page.goto("/boards");
    await expect(page.getByTestId("auth-user")).toHaveText("me@example.com");
  });

  test("requests carry the bearer token", async ({ page }) => {
    await signIn(page);
    let headers = null;
    // Same reasoning as the signed-out version of this test: /boards makes no
    // GET of its own, so the draft page is where a real request is observed.
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    await page.route(`${API_BASE}/players*`, (route) => {
      headers = route.request().headers();
      return route.fulfill({ json: { players: [] } });
    });

    await page.goto(`/draft/${DRAFT_ID}`);
    await expect.poll(() => headers).not.toBeNull();
    expect(headers["authorization"]).toBe(`Bearer ${ID_TOKEN}`);
  });

  test("creating a board is offered again", async ({ page }) => {
    await signIn(page);
    await page.goto("/boards");
    await expect(page.getByTestId("create-board")).toHaveText("+ New board");
  });

  test("signing in claims the boards this browser already made", async ({ page }) => {
    await signIn(page);
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "perfectpick.myBoards",
        JSON.stringify([{ id: "b-old", name: "Old", format: "ppr" }])
      );
    });

    let claimed = null;
    await page.route("**/me/claim", (route) => {
      claimed = route.request().postDataJSON();
      return route.fulfill({
        json: { claimed: { drafts: [], boards: ["b-old"] }, skipped: { drafts: [], boards: [] } },
      });
    });

    await page.goto("/boards");
    await expect.poll(() => claimed).not.toBeNull();
    expect(claimed.boardIds).toContain("b-old");
  });

  test("a draft opened from someone else's link is not claimed", async ({ page }) => {
    await signIn(page);
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "perfectpick.myDrafts",
        JSON.stringify([
          { id: "d-mine", owned: true, teams: 12, rounds: 15, format: "ppr", userTeam: 1 },
          { id: "d-theirs", owned: false, teams: 12, rounds: 15, format: "ppr", userTeam: 1 },
        ])
      );
    });

    let claimed = null;
    await page.route("**/me/claim", (route) => {
      claimed = route.request().postDataJSON();
      return route.fulfill({
        json: { claimed: { drafts: ["d-mine"], boards: [] }, skipped: { drafts: [], boards: [] } },
      });
    });

    await page.goto("/drafts");
    await expect.poll(() => claimed).not.toBeNull();
    expect(claimed.draftIds).toEqual(["d-mine"]);
  });
});
