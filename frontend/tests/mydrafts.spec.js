import { test, expect } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";
import { signIn } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");

const API = "http://localhost:9999";

// My Drafts and My Boards used to read a client-side registry out of
// localStorage ("perfectpick.myDrafts" / "perfectpick.myBoards"), written by
// the app itself as drafts and boards were created or opened. This branch
// deleted that registry entirely: MyDrafts.jsx and Boards.jsx now read
// GET /me/drafts and GET /me/boards from the server, which is the account's
// list -- the whole point of cross-device history is that it is not tied to
// this browser. Every test below mocks those endpoints instead of seeding
// localStorage. signIn(page) already registers empty-list defaults for both;
// a test that cares about contents registers its own handler afterwards,
// which wins because Playwright matches the most-recently-added handler
// first.

const IN_PROGRESS = {
  id: "draft-in-progress",
  teams: 12,
  rounds: 15,
  format: "ppr",
  userTeam: 4,
  boardId: null,
  completed: false,
  createdAt: Date.now(),
};

const COMPLETED = {
  id: "draft-completed",
  teams: 10,
  rounds: 12,
  format: "standard",
  userTeam: 2,
  boardId: "board-1",
  completed: true,
  createdAt: Date.now() - 60_000,
};

async function mockMyDrafts(page, drafts, boards = []) {
  await page.route("**/me/drafts", (route) => route.fulfill({ json: { drafts } }));
  await page.route("**/me/boards", (route) => route.fulfill({ json: { boards } }));
}

test("shows an empty state when the account has no drafts", async ({ page }) => {
  await signIn(page);
  await mockMyDrafts(page, []);
  await page.goto("/drafts");

  await expect(page.getByTestId("my-drafts-list")).toHaveCount(0);
  await expect(page.getByText(/no drafts yet/i)).toBeVisible();
});

test("lists account drafts, in the order the server returns them", async ({ page }) => {
  await signIn(page);
  await mockMyDrafts(page, [IN_PROGRESS, COMPLETED]);
  await page.goto("/drafts");

  const rows = page.getByTestId("draft-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(/12 teams/i);
});

test("an in-progress draft opens the draft page", async ({ page }) => {
  await signIn(page);
  await mockMyDrafts(page, [IN_PROGRESS]);
  await page.goto("/drafts");

  await page.getByTestId("draft-row").first().getByRole("link").first().click();

  await expect(page).toHaveURL(/\/draft\/draft-in-progress$/);
});

test("a completed draft opens its results", async ({ page }) => {
  await signIn(page);
  await mockMyDrafts(page, [COMPLETED]);
  await page.goto("/drafts");

  await page.getByTestId("draft-row").first().getByRole("link").first().click();

  await expect(page).toHaveURL(/\/draft\/draft-completed\/results$/);
});

test("a draft driven by one of your boards names it", async ({ page }) => {
  await signIn(page);
  await mockMyDrafts(page, [COMPLETED], [{ id: "board-1", name: "My PPR Board", format: "ppr" }]);
  await page.goto("/drafts");

  await expect(page.getByTestId("draft-row").first()).toContainText("My PPR Board");
});

test("a board not on your account shows a generic label, not an id", async ({ page }) => {
  await signIn(page);
  await mockMyDrafts(page, [COMPLETED], []);
  await page.goto("/drafts");

  const row = page.getByTestId("draft-row").first();
  await expect(row).toContainText(/custom board/i);
  await expect(row).not.toContainText("board-1");
});

test("the nav links to My Drafts", async ({ page }) => {
  await signIn(page);
  await mockMyDrafts(page, []);
  await page.goto("/");

  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("link", { name: "My Drafts" }).click();

  await expect(page).toHaveURL(/\/drafts$/);
});

const DRAFT_ID = "linked-draft-xyz";

function draftState({ completed = false } = {}) {
  const picks = Array.from({ length: 4 }, (_, i) => ({
    overall: i + 1,
    round: 1,
    team: i + 1,
    playerId: null,
    player: null,
  }));
  return {
    draftId: DRAFT_ID,
    sport: "nfl",
    format: "ppr",
    year: 2025,
    teams: 4,
    rounds: 1,
    userTeam: 3,
    rosterSlots: [],
    boardId: null,
    picked: [],
    currentIndex: completed ? 4 : 0,
    currentRound: 1,
    currentPick: 1,
    currentTeam: completed ? null : 1,
    completed,
    picks,
  };
}

// Ownership is set once, at creation (POST /drafts sets ownerId to whoever
// is signed in when they create it) and never by viewing. Opening a draft
// somebody else shared with you, or even a link to a draft that happens to
// be yours, issues no write of its own -- your account's list can only
// change through a request that names it, and GET /drafts/:id is not one.
test("opening a shared draft by link does not add it to your account", async ({ page }) => {
  await signIn(page);
  await page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: [] } }));
  await page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: draftState() }));

  let meDraftsRequests = 0;
  await page.route("**/me/drafts", (route) => {
    meDraftsRequests += 1;
    return route.fulfill({ json: { drafts: [] } });
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();

  await page.goto("/drafts");
  await expect(page.getByTestId("my-drafts-list")).toHaveCount(0);
  await expect(page.getByText(/no drafts yet/i)).toBeVisible();
  // The list really was asked for (not just defaulted empty because the
  // route never matched), and it came back empty even though a draft was
  // just viewed.
  expect(meDraftsRequests).toBeGreaterThan(0);
});

test("delete removes the draft server-side and drops the row", async ({ page }) => {
  let deleted = false;
  await signIn(page);
  await page.route("**/me/drafts", (route) =>
    route.fulfill({ json: { drafts: deleted ? [] : [IN_PROGRESS] } })
  );
  await page.route(`${API}/drafts/${IN_PROGRESS.id}`, (route) => {
    if (route.request().method() === "DELETE") {
      deleted = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fallback();
  });
  page.on("dialog", (d) => d.accept());

  await page.goto("/drafts");
  await page.getByTestId("draft-row").first().getByTestId("delete-draft").click();

  await expect(page.getByTestId("draft-row")).toHaveCount(0);
  expect(deleted).toBe(true);
});

test("dismissing the confirmation deletes nothing", async ({ page }) => {
  let called = false;
  await signIn(page);
  await mockMyDrafts(page, [IN_PROGRESS]);
  await page.route(`${API}/drafts/${IN_PROGRESS.id}`, (route) => {
    if (route.request().method() === "DELETE") called = true;
    return route.fulfill({ json: { ok: true } });
  });
  page.on("dialog", (d) => d.dismiss());

  await page.goto("/drafts");
  await page.getByTestId("draft-row").first().getByTestId("delete-draft").click();

  await expect(page.getByTestId("draft-row")).toHaveCount(1);
  expect(called, "no request should be made when the confirmation is dismissed").toBe(false);
});

test("a failed delete leaves the row listed and says so", async ({ page }) => {
  await signIn(page);
  await mockMyDrafts(page, [IN_PROGRESS]);
  await page.route(`${API}/drafts/${IN_PROGRESS.id}`, (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({ status: 500, json: { error: "Server error" } });
    }
    return route.fallback();
  });
  page.on("dialog", (d) => d.accept());

  await page.goto("/drafts");
  await page.getByTestId("draft-row").first().getByTestId("delete-draft").click();

  await expect(page.getByTestId("draft-row")).toHaveCount(1);
  await expect(page.getByTestId("my-drafts-error")).toBeVisible();
});

test("relative time floors rather than rounds", async ({ page }) => {
  // 90 minutes is the case that actually differs: Math.round(90/60) is 2,
  // so the old code said "2h ago" for an hour-and-a-half-old draft.
  // A 45-minute fixture would prove nothing -- it renders "45m ago" either
  // way, because the minutes branch returns before any hour rounding.
  const ninetyMinutes = { ...IN_PROGRESS, createdAt: Date.now() - 90 * 60 * 1000 };
  await signIn(page);
  await mockMyDrafts(page, [ninetyMinutes]);

  await page.goto("/drafts");

  await expect(page.getByTestId("draft-row").first()).toContainText("1h ago");
});

test("relative time does not round a day early", async ({ page }) => {
  // The worst case: 23.5 hours rounded to 24 and rendered "1d ago" for a
  // draft from earlier the same day.
  const almostADay = { ...IN_PROGRESS, createdAt: Date.now() - 23.5 * 60 * 60 * 1000 };
  await signIn(page);
  await mockMyDrafts(page, [almostADay]);

  await page.goto("/drafts");

  await expect(page.getByTestId("draft-row").first()).toContainText("23h ago");
});

test("the delete control describes the draft, not its id", async ({ page }) => {
  await signIn(page);
  await mockMyDrafts(page, [IN_PROGRESS]);
  await page.goto("/drafts");

  const row = page.getByTestId("draft-row").first();
  const label = await row.getByTestId("delete-draft").getAttribute("aria-label");
  expect(label, "delete-draft aria-label").not.toContain(IN_PROGRESS.id);
  expect(label, "delete-draft aria-label").toMatch(/ppr/i);
});

test("two same-shape drafts (same format and team count) get distinct aria-labels", async ({ page }) => {
  // Both are PPR, 12 teams -- the exact collision from the bug report,
  // where the old describe() produced "PPR, 12 teams" for both and
  // getByLabel(...) matched two elements instead of one.
  const twinA = {
    id: "twin-a",
    teams: 12,
    rounds: 15,
    format: "ppr",
    userTeam: 4,
    boardId: null,
    completed: false,
    createdAt: Date.now(),
  };
  const twinB = {
    id: "twin-b",
    teams: 12,
    rounds: 12,
    format: "ppr",
    userTeam: 9,
    boardId: null,
    completed: false,
    createdAt: Date.now() - 5 * 60_000,
  };
  await signIn(page);
  await mockMyDrafts(page, [twinA, twinB]);
  await page.goto("/drafts");

  const rows = page.getByTestId("draft-row");
  await expect(rows).toHaveCount(2);

  const labelA = await rows.nth(0).getByTestId("delete-draft").getAttribute("aria-label");
  const labelB = await rows.nth(1).getByTestId("delete-draft").getAttribute("aria-label");
  expect(labelA).not.toEqual(labelB);

  // The regression this guards against: getByLabel resolving to more than
  // one element because both rows' accessible names collided.
  await expect(page.getByLabel(labelA)).toHaveCount(1);
  await expect(page.getByLabel(labelB)).toHaveCount(1);
});

// A draft created through New Draft ends up owned (POST /drafts sets
// ownerId to whoever is signed in), so it appears in the account's list with
// a working Delete -- there is no longer a second, unowned state to show a
// different control for. The mock below tracks `created` so /me/drafts
// answers the way the real, ownerId-indexed endpoint would once the draft
// exists.
test("a draft created through the New Draft flow appears in My Drafts with delete available", async ({ page }) => {
  const NEW_ID = "new-draft-owned-xyz";
  let created = false;
  await page.route(`${API}/drafts`, async (route) => {
    if (route.request().method() === "POST") {
      created = true;
      await route.fulfill({ json: { draftId: NEW_ID } });
    } else {
      await route.fallback();
    }
  });
  await page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: [] } }));
  await page.route(`${API}/drafts/${NEW_ID}`, (r) =>
    r.fulfill({
      json: {
        draftId: NEW_ID,
        sport: "nfl",
        format: "standard",
        year: 2025,
        teams: 12,
        rounds: 15,
        userTeam: 1,
        rosterSlots: [],
        boardId: null,
        picked: [],
        currentIndex: 0,
        currentRound: 1,
        currentPick: 1,
        currentTeam: 1,
        completed: false,
        picks: [],
      },
    })
  );

  await signIn(page);
  await page.route("**/me/drafts", (route) =>
    route.fulfill({
      json: {
        drafts: created
          ? [{ id: NEW_ID, teams: 12, rounds: 15, format: "standard", userTeam: 1, boardId: null, completed: false, createdAt: Date.now() }]
          : [],
      },
    })
  );

  await page.goto("/draft/new");
  await page.getByRole("button", { name: /Start Mock Draft/i }).click();
  await expect(page).toHaveURL(`/draft/${NEW_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();

  await page.goto("/drafts");
  const row = page.getByTestId("draft-row").first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId("delete-draft")).toBeVisible();
});

test("screenshot — my drafts", async ({ page }) => {
  // fullPage is inert here: the shell is h-dvh and the routes wrapper is the
  // scroller, so the document is always exactly viewport height. Size the
  // viewport to the page's own content instead, or the image is clipped.
  await page.setViewportSize({ width: 1280, height: 760 });
  await signIn(page);
  await mockMyDrafts(page, [IN_PROGRESS, COMPLETED]);
  await page.goto("/drafts");
  await expect(page.getByTestId("my-drafts-list")).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/drafts.png`, fullPage: false });
});
