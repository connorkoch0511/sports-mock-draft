import { test, expect } from "@playwright/test";
import { API_BASE, DRAFT_ID, makeDraftState, mockDraftApis } from "./fixtures.js";
import { signIn, ID_TOKEN } from "./auth.js";

test.describe("signed out", () => {
  // This used to be the point of the test: a shared draft link needs no
  // account. This branch put the whole app behind sign-in, so /draft/:id no
  // longer renders for a visitor at all -- it renders the gate instead. The
  // assertion is rewritten to prove that, rather than quietly dropping it.
  test("a shared draft link now prompts for an account instead of opening", async ({ page }) => {
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("auth-gate")).toBeVisible();
    await expect(page.getByTestId("auth-gate-signin")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Big Board" })).toHaveCount(0);
  });

  // Superseded by the gate itself: a signed-out visitor to /draft/:id now
  // never reaches Draft.jsx, so there is no request left to inspect a header
  // on. Rewritten to pin that stronger guarantee -- no draft-data request is
  // made at all -- rather than a header check that nothing would ever hit.
  test("no draft-data request is made at all", async ({ page }) => {
    let requested = false;
    mockDraftApis(page, makeDraftState({ currentIndex: 0 }));
    // Registered after mockDraftApis's own players route, so it wins:
    // Playwright matches the most-recently-added handler first.
    await page.route(`${API_BASE}/players*`, (route) => {
      requested = true;
      return route.fulfill({ json: { players: [] } });
    });

    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("auth-gate")).toBeVisible();
    expect(requested).toBe(false);
  });

  // Boards.jsx's own "Sign in to create" fallback is still in the code for
  // an unconfigured build (no Cognito variables), but /boards is wrapped in
  // RequireAuth now, so a configured, signed-out visitor is stopped by the
  // gate before Boards.jsx ever renders that button. Rewritten to prove the
  // gate is what actually stops the creation, not Boards.jsx's own copy.
  test("creating a board is gated before the page ever renders", async ({ page }) => {
    let posted = false;
    // Scoped to the API origin: an unscoped "**/boards" glob also matches the
    // SPA's own /boards page navigation, so the app's index.html itself gets
    // "fulfilled" with the mock JSON body instead of loading.
    await page.route(`${API_BASE}/boards`, (route) => {
      posted = true;
      return route.fulfill({ json: { boardId: "b1" } });
    });

    await page.goto("/boards");
    await expect(page.getByTestId("auth-gate")).toBeVisible();
    await expect(page.getByTestId("create-board")).toHaveCount(0);
    expect(posted).toBe(false);
  });

  // Same reasoning as the board-creation rewrite above: /draft/new is now
  // wrapped in RequireAuth, so NewDraft.jsx's own "Sign in to draft" fallback
  // is unreachable for a configured, signed-out visitor.
  test("creating a draft is gated before the page ever renders", async ({ page }) => {
    await page.goto("/draft/new");
    await expect(page.getByTestId("auth-gate")).toBeVisible();
    await expect(page.getByTestId("start-draft")).toHaveCount(0);
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
    await expect(page.getByTestId("auth-user")).toHaveText("you@example.com");
  });

  // Intercepts the SECOND of Draft.jsx's two sequential requests, and that
  // matters: AuthProvider resolves manager.getUser() asynchronously while
  // load() fires its first apiGet immediately on mount, so the token is not
  // necessarily in place for request one. Reordering Draft.jsx's calls would
  // break this test for a reason that has nothing to do with auth.
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

});
