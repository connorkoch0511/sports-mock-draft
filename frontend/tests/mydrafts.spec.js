import { test, expect } from "@playwright/test";

const IN_PROGRESS = {
  id: "draft-in-progress",
  teams: 12,
  rounds: 15,
  format: "ppr",
  userTeam: 4,
  boardId: null,
  completed: false,
  updatedAt: Date.now(),
};

const COMPLETED = {
  id: "draft-completed",
  teams: 10,
  rounds: 12,
  format: "standard",
  userTeam: 2,
  boardId: "board-1",
  completed: true,
  updatedAt: Date.now() - 60_000,
};

async function seed(page, drafts, boards = []) {
  await page.goto("/");
  await page.evaluate(
    ([d, b]) => {
      localStorage.setItem("perfectpick.myDrafts", JSON.stringify(d));
      localStorage.setItem("perfectpick.myBoards", JSON.stringify(b));
    },
    [drafts, boards]
  );
}

test("shows an empty state when nothing is stored", async ({ page }) => {
  await seed(page, []);
  await page.goto("/drafts");

  await expect(page.getByTestId("my-drafts-list")).toHaveCount(0);
  await expect(page.getByText(/no drafts yet/i)).toBeVisible();
});

test("lists stored drafts, newest first", async ({ page }) => {
  await seed(page, [IN_PROGRESS, COMPLETED]);
  await page.goto("/drafts");

  const rows = page.getByTestId("draft-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(/12 teams/i);
});

test("an in-progress draft opens the draft page", async ({ page }) => {
  await seed(page, [IN_PROGRESS]);
  await page.goto("/drafts");

  await page.getByTestId("draft-row").first().getByRole("link").first().click();

  await expect(page).toHaveURL(/\/draft\/draft-in-progress$/);
});

test("a completed draft opens its results", async ({ page }) => {
  await seed(page, [COMPLETED]);
  await page.goto("/drafts");

  await page.getByTestId("draft-row").first().getByRole("link").first().click();

  await expect(page).toHaveURL(/\/draft\/draft-completed\/results$/);
});

test("a draft driven by one of your boards names it", async ({ page }) => {
  await seed(page, [COMPLETED], [{ id: "board-1", name: "My PPR Board", format: "ppr" }]);
  await page.goto("/drafts");

  await expect(page.getByTestId("draft-row").first()).toContainText("My PPR Board");
});

test("a board you do not have locally shows a generic label, not an id", async ({ page }) => {
  await seed(page, [COMPLETED], []);
  await page.goto("/drafts");

  const row = page.getByTestId("draft-row").first();
  await expect(row).toContainText(/custom board/i);
  await expect(row).not.toContainText("board-1");
});

test("forget removes the row and it stays gone after a reload", async ({ page }) => {
  await seed(page, [IN_PROGRESS, COMPLETED]);
  await page.goto("/drafts");

  await page.getByTestId("draft-row").first().getByTestId("forget-draft").click();
  await expect(page.getByTestId("draft-row")).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId("draft-row")).toHaveCount(1);
});

test("the nav links to My Drafts", async ({ page }) => {
  await seed(page, []);
  await page.goto("/");

  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("link", { name: "My Drafts" }).click();

  await expect(page).toHaveURL(/\/drafts$/);
});

const DRAFT_ID = "linked-draft-xyz";
const API = "http://localhost:9999";

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

test("opening a draft by link records it, so it is listed afterwards", async ({ page }) => {
  await seed(page, []);
  await page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: [] } }));
  await page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: draftState() }));

  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();

  await page.goto("/drafts");
  const row = page.getByTestId("draft-row").first();
  await expect(row).toContainText(/4 teams/i);
  await expect(row).toContainText(/in progress/i);
});

test("a completed draft is recorded as completed", async ({ page }) => {
  await seed(page, []);
  await page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: [] } }));
  await page.route(`${API}/drafts/${DRAFT_ID}`, (r) =>
    r.fulfill({ json: draftState({ completed: true }) })
  );

  await page.goto(`/draft/${DRAFT_ID}/results`);
  await expect(page.getByRole("heading", { name: "Draft Results" })).toBeVisible();

  await page.goto("/drafts");
  await expect(page.getByTestId("draft-row").first()).toContainText(/completed/i);
});

test("loading a draft does not write to storage once per render", async ({ page }) => {
  await seed(page, []);
  await page.route(`${API}/players*`, (r) => r.fulfill({ json: { players: [] } }));

  // A draft where userTeam is out of range, so it is never the user's turn
  // and the page's auto-pick effect fires continuously with no need to wait
  // on the 60s pick timer. Each auto-pick advances `picksMade`, and the GET
  // mock reflects it, so every reload after a pick hands React a brand-new
  // draft object — ending in completed: true once all slots are filled.
  const TEAMS = 4;
  const ROUNDS = 3;
  const TOTAL_PICKS = TEAMS * ROUNDS; // 12 auto-pick cycles
  let picksMade = 0;

  const advancingState = () => {
    const completed = picksMade >= TOTAL_PICKS;
    const picks = Array.from({ length: TOTAL_PICKS }, (_, i) => ({
      overall: i + 1,
      round: Math.floor(i / TEAMS) + 1,
      team: (i % TEAMS) + 1,
      playerId: null,
      player: null,
    }));
    return {
      draftId: DRAFT_ID,
      sport: "nfl",
      format: "ppr",
      year: 2025,
      teams: TEAMS,
      rounds: ROUNDS,
      userTeam: 99, // no team is ever 99, so it is never the user's turn
      rosterSlots: [],
      boardId: null,
      picked: [],
      currentIndex: completed ? TOTAL_PICKS : picksMade,
      currentRound: completed ? ROUNDS : Math.floor(picksMade / TEAMS) + 1,
      currentPick: completed ? TOTAL_PICKS : (picksMade % TEAMS) + 1,
      currentTeam: completed ? null : (picksMade % TEAMS) + 1,
      completed,
      picks,
    };
  };

  await page.route(`${API}/drafts/${DRAFT_ID}`, (r) => r.fulfill({ json: advancingState() }));
  await page.route(`${API}/drafts/${DRAFT_ID}/auto-pick`, (r) => {
    picksMade = Math.min(picksMade + 1, TOTAL_PICKS);
    r.fulfill({ json: { ok: true } });
  });

  await page.addInitScript(() => {
    window.__writes = 0;
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === "perfectpick.myDrafts") window.__writes += 1;
      return real.call(this, k, v);
    };
  });

  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();

  // Let the bot draft to completion, then wait for something observable
  // that proves all TOTAL_PICKS cycles actually happened, rather than a
  // fixed sleep: "View Results" only renders once draft.completed is true.
  await expect(page.getByRole("link", { name: /view results/i })).toBeVisible({
    timeout: 15000,
  });

  // With the hook keyed on [id, completed]: one write when the id first
  // appears, one when completed flips to true — about 2. A [draft]-keyed
  // effect would write on every one of the TOTAL_PICKS reload cycles above —
  // about a dozen. The threshold below sits well inside that gap.
  const writes = await page.evaluate(() => window.__writes);
  expect(writes, `writes to perfectpick.myDrafts (got ${writes})`).toBeLessThan(6);

  // The write-count check above only bounds writes from above; it says
  // nothing about whether the *last* write actually reflects completion.
  // A hook keyed on [id] alone would satisfy the threshold above while
  // never recording the completed:true write, silently under-writing.
  // Guard that direction too: the registry entry must read as completed,
  // and following it must land on results, not back on the draft page.
  await page.goto("/drafts");
  const row = page.getByTestId("draft-row").first();
  await expect(row).toContainText(/completed/i);
  await expect(row).not.toContainText(/in progress/i);

  await row.getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/draft/${DRAFT_ID}/results$`));
});
