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
